# Holoiconic Runtime: Exploration Report

## 1. Executive Summary

Holoiconic is a self-modifying runtime where **everything is an RDF quad** -- code, data, configuration, conversation history, metrics, and versions -- all stored as `(subject, predicate, object, graph)` string tuples in a single SQLite table. Programs are stored as AsyncFunction body strings and executed dynamically. The kernel is approximately 30 lines of code with zero policy; all behavior is defined by 28 graph-resident nodes.

This report covers the results of systematically testing the runtime across **63 tests in 23 scenarios**, organized into three test suites:

- **test-programs.ts** -- 27 tests across 8 foundational programs (hello world, arithmetic, state management, composition, reactivity, self-modification, error handling, graph queries)
- **test-advanced.ts** -- 21 tests across 7 advanced scenarios (spawn/supervisor, hot-reload, cron, snapshots, versioning, metrics, concurrency)
- **test-edge-cases.ts** -- 15 tests across 8 boundary scenarios (empty source, 10KB source, Unicode/null bytes, 25-deep call chains, 50x retract/assert churn, self-retracting nodes, wildcard queries, double-assert idempotency)

**All 63 tests passed.** The runtime proved remarkably robust, handling every edge case thrown at it without failure.

---

## 2. How to Create Programs

### Step 1: Define the source string

A node's source is the body of an `async function(ctx, args)`. It cannot use `import` statements but has access to Bun globals, `process`, `console`, and the 5 `ctx` primitives.

```js
const source = `
  const n = args && args.n;
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) { [a, b] = [b, a + b]; }
  return b;
`;
```

### Step 2: Register the node in the graph

Every node needs two quads: a `type` quad and a `source` quad.

```js
await ctx.assert("math:fibonacci", "type", "Function");
await ctx.assert("math:fibonacci", "source", source);
```

### Step 3: Call it

```js
const result = await ctx.call("math:fibonacci", { n: 10 });
// result === 55
```

### The 5 Primitives

| Primitive | Signature | Purpose |
|-----------|-----------|---------|
| `ctx.assert` | `(s, p, o, g?) => Promise<Quad>` | Insert a quad (INSERT OR IGNORE) |
| `ctx.retract` | `(s, p, o, g?) => Promise<void>` | Delete a quad |
| `ctx.query` | `(pattern) => Promise<Quad[]>` | Find quads matching a pattern (any field can be omitted as wildcard) |
| `ctx.call` | `(name, args?) => Promise<any>` | Execute a named node |
| `ctx.on` | `(pattern, callback) => unsubFn` | Subscribe to quad changes (assert/retract) |

Plus `ctx.self` which returns the current node's name via AsyncLocalStorage.

### Key Patterns

**State management** -- Use quads as persistent storage. Read with `ctx.query`, update with `ctx.retract` + `ctx.assert`:

```js
const existing = await ctx.query({ s: 'counter:alpha', p: 'count' });
let current = parseInt(existing[0].o, 10);
await ctx.retract('counter:alpha', 'count', existing[0].o);
await ctx.assert('counter:alpha', 'count', String(current + 1));
```

**Composition** -- Nodes call other nodes via `ctx.call`:

```js
const factorial = await ctx.call('math:factorial', { n: 5 });
return factorial * 2;
```

**Reactive watchers** -- Subscribe to graph changes:

```js
const unsub = ctx.on({ s: 'my:entity' }, (change) => {
  console.log(change.type, change.quad.p, change.quad.o);
});
// ... later:
unsub(); // clean up
```

**Self-modification** -- A node can rewrite its own source:

```js
const mySource = (await ctx.query({ s: ctx.self, p: 'source' }))[0].o;
await ctx.retract(ctx.self, 'source', mySource);
await ctx.assert(ctx.self, 'source', "return 'new behavior';");
```

---

## 3. Programs Tested

### test-programs.ts (27 tests)

| # | Program | Tests | Description |
|---|---------|-------|-------------|
| 1 | Hello World | 2 | Basic string return; ctx.self verification |
| 2 | Arithmetic | 2 | Factorial (0!, 1!, 5!, 10!); Fibonacci sequence 0..10 |
| 3 | State via Quads | 3 | Counter increment over calls; independent counters; graph persistence |
| 4 | Node Calling Node | 3 | Composition (doubleFactorial); 3-node text pipeline; recursive countdown |
| 5 | Reactive Watcher | 3 | ctx.on assert/retract events; unsubscribe; node-internal watcher |
| 6 | Self-Modifying Node | 3 | v1 execution; self-rewrite via retract+assert; compiler cache invalidation |
| 7 | Error Handling | 4 | Error throw; string throw; missing node error; nested error catch |
| 8 | Graph Queries | 7 | Animal knowledge graph with 4 query patterns; graph namespace isolation; idempotent assert |

### test-advanced.ts (21 tests)

| # | Scenario | Tests | Description |
|---|----------|-------|-------------|
| 1 | Spawn + Supervisor | 3 | Long-lived node lifecycle; abort via controller; retry with exponential backoff |
| 2 | Hot-Reload | 2 | Spawned node v1 running; retract+assert triggers supervisor restart with v2 |
| 3 | Cron Scheduling | 2 | 200ms interval firing; cron:list shows stopped status after abort |
| 4 | Snapshot Round-Trip | 3 | Export graph; retract quads; import subset; verify restoration |
| 5 | Version Lifecycle | 4 | v1 setup; source swap triggers auto-versioning; version:list; version:restore |
| 6 | Metrics Tracking | 4 | Auto-recorded call count; duration tracking; metrics:report; self-exclusion |
| 7 | Concurrent Operations | 3 | 4 parallel ctx.call; 20 parallel set writes; 10 parallel same-node calls |

### test-edge-cases.ts (15 tests)

| # | Scenario | Tests | Description |
|---|----------|-------|-------------|
| 1 | Empty Source Node | 1 | Empty string source returns undefined (no crash) |
| 2 | Very Large Source | 1 | 10,272-byte source with 394 additions executes correctly |
| 3 | Unicode/Special Chars | 5 | Emoji, newlines/tabs, null bytes, CJK/Arabic/Cyrillic/math, SQL injection |
| 4 | Deeply Nested Calls | 1 | Chain of 25 nodes each calling the next, accumulating results |
| 5 | Rapid Retract+Assert | 1 | 50 source swaps in a loop, final version executes correctly |
| 6 | Self-Retracting Node | 2 | Node deletes own source; subsequent call throws "no source found" |
| 7 | Query All Wildcards | 1 | `ctx.query({})` returns all quads (228 after boot + edge case setup) |
| 8 | Double Assert | 3 | Same quad twice returns same id; different objects create separate quads; reactive fires only once |

---

## 4. Key Findings

### What works well

1. **Simplicity and reliability** -- All 63 tests passed on the first run. The 5-primitive API is small enough to hold in your head, yet powerful enough to build complex systems.

2. **Compiler cache invalidation is transparent** -- Retract+assert a node's source and the next `ctx.call` automatically uses the new code. No manual cache-busting needed.

3. **Reactive system is synchronous and predictable** -- `ctx.on` fires during the assert/retract call, not asynchronously. This makes reactive patterns inside a single node execution deterministic.

4. **Concurrent execution is safe** -- Multiple parallel `ctx.call` invocations, even to the same node with different args, execute correctly without interference. 20 parallel `set` operations to different subjects all succeed.

5. **The graph is a universal storage layer** -- Using quads for everything (code, state, metrics, versions, cron config) means there is exactly one way to inspect, modify, and export any piece of system state.

6. **INSERT OR IGNORE semantics are correct** -- Duplicate asserts are no-ops that return the existing quad and do not fire reactive subscribers. This prevents accidental data duplication.

### What's surprising

1. **Empty source nodes work fine** -- `new AsyncFunction('ctx', 'args', '')` is valid JavaScript. An empty async function body returns `undefined`.

2. **Null bytes are truncated by SQLite** -- A string `"before\x00after"` stored in a quad comes back as `"before"` (length 6 instead of 12). This is a known SQLite behavior with null-terminated C strings. All other Unicode (emoji, CJK, Cyrillic, Arabic, math symbols) round-trips perfectly.

3. **Self-retracting nodes complete execution** -- A node can delete its own source quad mid-execution and still return a value. The function is already loaded into memory; deletion only affects future calls.

4. **25-deep call chains work without issue** -- AsyncLocalStorage correctly tracks `ctx.self` through 25 levels of nested `ctx.call`, and the accumulated results propagate cleanly.

5. **50 rapid retract+assert cycles are handled gracefully** -- The compiler cache invalidates on every source change, and the final call always sees the latest version.

6. **Sub-millisecond calls record 0ms duration** -- Bun's execution speed means simple nodes complete in under 1ms, so metrics record `duration=0ms`. This is correct, not a bug.

---

## 5. Edge Cases & Boundaries

| Edge Case | Result | Notes |
|-----------|--------|-------|
| Empty source string | Returns `undefined` | Valid JS; no compilation error |
| 10KB source (394 lines) | Executes correctly | No size limit encountered |
| Emoji in quad values | Preserved | Full Unicode support |
| Newlines/tabs in values | Preserved | No escaping issues |
| Null bytes (\x00) | Truncated | SQLite C string termination; "before\x00after" becomes "before" |
| CJK/Arabic/Cyrillic | Preserved | Full international text support |
| SQL injection in values | Safe | Parameterized queries prevent injection |
| 25-deep nested ctx.call | Works | No stack overflow; AsyncLocalStorage tracked correctly |
| 50x retract+assert churn | Works | Compiler cache invalidates correctly each time |
| Self-retracting node | Completes, then "no source found" | In-flight execution unaffected; future calls fail cleanly |
| `ctx.query({})` (all wildcards) | Returns all quads | 228 quads after boot + edge case setup |
| Double assert same quad | Idempotent | Same id returned; subscriber fires only once |
| Assert different objects, same s+p | Both stored | Multi-valued predicates supported |

---

## 6. Runtime Characteristics

### Performance

- **Boot time**: Seeding 28 nodes + installing the compiler takes under 100ms on a local file DB
- **Simple node execution**: Sub-millisecond (often 0ms as measured by the metrics system)
- **10KB node compilation + execution**: No measurable overhead
- **50 retract+assert cycles**: Completes in well under 1 second
- **25-deep call chain**: Completes without notable delay

### Concurrency

- Parallel `ctx.call` invocations execute independently via V8's event loop
- The `set` node serializes writes per key (retract+assert as a unit), preventing lost updates
- No locking on the SQLite layer -- relies on libSQL's built-in serialization
- 20 concurrent writes to different subjects succeed without conflicts
- 10 concurrent calls to the same node with different args all return correct, isolated results

### Error Handling

- `throw new Error(...)` propagates to the caller with the original message and stack trace
- `throw 'string'` propagates the raw string (not wrapped in Error)
- Calling a non-existent node throws `[ctx.call] no source found for node: <name>`
- Errors in nested calls can be caught with try/catch in the calling node
- Crashed spawned nodes trigger supervisor retry with exponential backoff (500ms, 1000ms, 2000ms, max 3 retries)

### Storage

- All data is in a single `quads` table with columns: `id, s, p, o, g, attrs, embedding`
- Unique constraint on `(s, p, o, g)` enforces INSERT OR IGNORE semantics
- The `g` (graph) column defaults to `"_"` and provides namespace isolation
- After seeding 28 template nodes, the graph contains ~56 quads (28 source + 28 type)
- Null bytes in string values are truncated by SQLite's C string handling

### Reactive System

- `ctx.on` subscribers are stored in an in-memory array, not in the graph
- Pattern matching supports any combination of s, p, o, g filters
- Subscribers fire synchronously during assert/retract (before the function returns)
- Unsubscribe returns a function; failing to call it causes memory leaks
- Duplicate asserts (INSERT OR IGNORE) do NOT fire subscribers (rowsAffected === 0)
- Retract of a non-existent quad is a silent no-op (no subscriber fire)

---

## 7. Recommendations

### Areas for further exploration

1. **Stress testing at scale** -- Test with thousands of nodes and tens of thousands of quads to find performance cliffs in query and compilation.

2. **Concurrent writes to the same subject+predicate** -- The current `set` node serializes per key, but raw `ctx.retract` + `ctx.assert` pairs from multiple callers could race. Worth testing under load.

3. **Maximum call chain depth** -- 25 levels worked; finding the actual limit (likely bounded by V8 stack or AsyncLocalStorage depth) would be informative.

4. **Large object values** -- Test with 1MB+ quad values to find SQLite text column limits.

5. **Embedding/vector search** -- The schema includes a `vector32` embedding column, but vector search was not tested in this exploration. This is a significant capability worth validating.

6. **Network failure resilience** -- When using Turso Cloud instead of local SQLite, test behavior under network partitions and reconnection.

### Potential improvements

1. **Null byte handling** -- Document that null bytes in quad values are truncated, or add validation to reject them at the `ctx.assert` layer.

2. **Query pagination** -- `ctx.query({})` returns all quads at once. For large graphs, a limit/offset or cursor mechanism would prevent memory issues.

3. **Call depth protection** -- Add a configurable maximum call depth to prevent infinite recursion from consuming all memory.

4. **Metrics for compilation time** -- The compiler caches compiled functions but does not record how long compilation takes. For large or complex source strings, this could be a useful metric.

---

## Appendix: Test Execution Summary

| Test Suite | File | Tests | Passed | Failed |
|------------|------|-------|--------|--------|
| Foundational Programs | `src/test-programs.ts` | 27 | 27 | 0 |
| Advanced Features | `src/test-advanced.ts` | 21 | 21 | 0 |
| Edge Cases | `src/test-edge-cases.ts` | 15 | 15 | 0 |
| **Total** | | **63** | **63** | **0** |

All tests run against a fresh local file DB with no mocking. Each test suite boots the full system, seeds the template, and installs the compiler before running tests.
