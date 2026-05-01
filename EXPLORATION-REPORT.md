# Holoiconic Runtime: Exploration Report

## 1. Executive Summary

Holoiconic is a self-modifying runtime where **everything is an RDF quad** -- code, data, configuration, conversation history, metrics, and versions -- all stored as `(subject, predicate, object, graph)` string tuples in a single SQLite table. Programs are stored as AsyncFunction body strings and executed dynamically. The kernel is approximately 30 lines of code with zero policy; all behavior is defined by 28 graph-resident nodes.

This report covers the results of systematically testing the runtime across **63 custom tests in 23 scenarios** (plus the original 323-test integration suite), organized into four test suites:

- **test-programs.ts** -- 27 tests across 8 foundational programs (hello world, arithmetic, state management, composition, reactivity, self-modification, error handling, graph queries)
- **test-advanced.ts** -- 21 tests across 7 advanced scenarios (spawn/supervisor, hot-reload, cron, snapshots, versioning, metrics, concurrency)
- **test-edge-cases.ts** -- 15 tests across 8 boundary scenarios (empty source, 10KB source, Unicode/null bytes, 25-deep call chains, 50x retract/assert churn, self-retracting nodes, wildcard queries, double-assert idempotency)
- **test-boot.ts** -- 323 tests across the original integration suite (compiler, supervisor, shell, LLM, agent loop, API server, WebUI, snapshots, versioning, cron, metrics, graph introspection, vector search, security, error quality, HTTP audit, graceful degradation, and more)

**All 386 tests passed (63 custom + 323 integration).** The runtime proved remarkably robust, handling every edge case thrown at it without failure.

---

## 2. Boot Sequence

When you run `bun start`, the following chain executes:

### boot.ts (the kernel, ~35 lines)

```
boot()
  1. createDatabase("holoiconic.db")     -- connects to local libSQL or Turso Cloud
  2. initSchema(db)                       -- creates quads table (idempotent)
  3. createCtx(db)                        -- builds ctx with 5 naive primitives
  4. ctx.query({})                        -- checks if graph is empty
     -> if empty: seedTemplate(ctx)       -- inserts 28 nodes (56 quads: source + type)
  5. ctx.call("main")                     -- enters the main node
```

### main node (the boot chain)

The `main` node is itself a graph-resident program. Its source is:

```js
// 1. Install the reactive compiler (replaces ctx.call)
await ctx.call('sys:compiler');

// 2. Spawn the supervisor (long-lived, manages other spawned nodes)
await ctx.call('spawn', { node: 'sys:supervisor' });

// 3. Register agent tools (18 LLM-callable tools)
await ctx.call('agent:tools');

// 4. Start the API server (OpenAI-compatible, port 3001)
await ctx.call('spawn', { node: 'api:server' });

// 5. Start the WebUI (chat + node editor, port 3002)
await ctx.call('spawn', { node: 'web:ui' });

// 6. Start the REPL (stdin)
await ctx.call('spawn', { node: 'repl' });
```

### What happens at each step

1. **sys:compiler** -- Replaces `ctx.call` in-place with a cached version that: (a) caches compiled AsyncFunctions by name, (b) watches `{ p: 'source' }` changes to invalidate the cache reactively, (c) auto-saves old source as a version on retract via `version:save`, and (d) records metrics (call count, duration, errors) for every call except metrics nodes. After this step, all future `ctx.call` invocations go through the compiler.

2. **spawn + sys:supervisor** -- The supervisor is a long-lived node that watches for `Spawned`-typed quads. It manages lifecycle: when a spawned node crashes, it retries with exponential backoff (500ms, 1000ms, 2000ms, max 3 attempts). When a node's source changes, it aborts the old instance and restarts with new code (hot-reload).

3. **agent:tools** -- Registers 18 tool definitions as `Tool`-typed quads with JSON schemas. These tools are callable by the LLM via the `agent:loop` node, which acts as the AI orchestration layer.

4. **api:server** -- Spawns an HTTP server on port 3001 implementing the OpenAI Chat Completions API (`/v1/chat/completions`, `/v1/models`), with SSE streaming support, CORS headers, and session management.

5. **web:ui** -- Spawns an HTTP server on port 3002 serving a chat interface plus a node editor (view/edit/create/delete nodes, inspect dependencies).

6. **repl** -- Spawns a REPL on stdin with commands like `.source`, `.edit`, `.create`, `.spawn`, `.inspect`, `.deps`, `.versions`, `.metrics`, `.export`, `.import`, `.eval`, etc.

### Boot resilience (verified by tests)

- Re-seeding an already-seeded graph does not duplicate quads (INSERT OR IGNORE)
- If `sys:compiler` fails, `ctx.call` falls back to the naive version (recompiles every call)
- If `main` throws, `boot.ts` catches the error, logs it, and exits with code 1
- Without API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), LLM and embedding nodes use deterministic stubs
- Without `TURSO_URL`, data is stored locally in `holoiconic.db`

---

## 3. How to Create Programs

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

**Spawning a long-lived node** -- Use the `spawn` node to start a node that runs continuously:

```js
// Define the long-lived node
await ctx.assert('my:worker', 'type', 'Function');
await ctx.assert('my:worker', 'source', `
  const signal = args && args.signal;
  while (!signal.aborted) {
    // do work...
    await new Promise(r => setTimeout(r, 1000));
  }
`);

// Spawn it (supervisor manages lifecycle, retries on crash)
await ctx.call('spawn', { node: 'my:worker' });

// To stop it later, the supervisor handles AbortController signals
```

**Hot-reloading a running node** -- Retract and reassert the source; the supervisor automatically restarts:

```js
const old = (await ctx.query({ s: 'my:worker', p: 'source' }))[0].o;
await ctx.retract('my:worker', 'source', old);
await ctx.assert('my:worker', 'source', `
  const signal = args && args.signal;
  while (!signal.aborted) {
    // new behavior!
    await new Promise(r => setTimeout(r, 500));
  }
`);
// sys:compiler invalidates the cache, sys:supervisor aborts old instance and restarts
```

**Using the `set` node for single-valued predicates** -- Atomically replaces the old value:

```js
await ctx.call('set', { s: 'config:app', p: 'theme', o: 'dark' });
// Later:
await ctx.call('set', { s: 'config:app', p: 'theme', o: 'light' });
// Only one 'theme' quad exists; the old value was retracted
```

---

## 4. Programs Tested

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
| 7 | Query All Wildcards | 1 | `ctx.query({})` returns all quads (230 after boot + edge case setup) |
| 8 | Double Assert | 3 | Same quad twice returns same id; different objects create separate quads; reactive fires only once |

---

## 5. Key Findings

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

## 6. Edge Cases & Boundaries

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
| `ctx.query({})` (all wildcards) | Returns all quads | 230 quads after boot + edge case setup (56 source, 57 type, 10 distinct predicates) |
| Double assert same quad | Idempotent | Same id returned; subscriber fires only once |
| Assert different objects, same s+p | Both stored | Multi-valued predicates supported |

---

## 7. Runtime Characteristics

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

## 8. Recommendations

### Areas for further exploration

1. **Stress testing at scale** -- Test with thousands of nodes and tens of thousands of quads to find performance cliffs in query and compilation.

2. **Concurrent writes to the same subject+predicate** -- The current `set` node serializes per key, but raw `ctx.retract` + `ctx.assert` pairs from multiple callers could race. Worth testing under load.

3. **Maximum call chain depth** -- 25 levels worked; finding the actual limit (likely bounded by V8 stack or AsyncLocalStorage depth) would be informative.

4. **Large object values** -- Test with 1MB+ quad values to find SQLite text column limits.

5. **Embedding/vector search at scale** -- The integration suite validates vector search with stub embeddings (1536-dim deterministic vectors). Testing with real embeddings from an actual embedding model and thousands of vectors would reveal performance characteristics of the `F32_BLOB` cosine similarity search.

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
| Original Integration | `src/test-boot.ts` | 323 | 323 | 0 |
| **Total** | | **386** | **386** | **0** |

All tests run against a fresh local file DB with no mocking. Each test suite boots the full system, seeds the template, and installs the compiler before running tests.

### What the original integration suite covers (323 tests)

The `test-boot.ts` suite is exhaustive. Beyond what the custom suites cover, it tests:

- **API server**: OpenAI-compatible endpoints, SSE streaming, CORS, session management, concurrent requests, malformed input handling, HTTP status codes
- **WebUI**: HTML serving, node CRUD API, type badges, search/filter, delete, dependency viewer, XSS safety
- **Security**: SQL injection in node names and values, XSS in API/WebUI responses, prototype pollution via quad values
- **Error message quality**: 23 different error paths verified for specific, actionable messages with `[node]` prefix format
- **HTTP audit**: Status codes (200, 201, 400, 404, 409), content-types, CORS headers across both servers
- **Graceful degradation**: Stub behavior without API keys, local DB fallback without Turso, silent error handling during boot
- **Tool dispatch**: All 18 registered tools verified with schema validation and dispatch handlers, plus generic fallback (underscore-to-colon translation)
- **Performance stress**: 1000 concurrent asserts, 500 cached node calls, 1000 `ctx.on` subscribers
- **Deep audits**: `graph:describe`, `graph:subjects`, `graph:deps`, `inspect`, embed, vector search, set node, snapshot backup/import, version lifecycle, cron edge cases, ctx.self scoping, query result ordering, graph parameter isolation, special characters in node names
