# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install              # install dependencies
bun start                # boot the full runtime (REPL + API:3001 + WebUI:3002)
bun run src/test-boot.ts # run integration tests
```

There is no `bun test` glob match — tests live in a single file (`src/test-boot.ts`) with a custom harness (no test framework). To run a subset, comment out test function calls at the bottom of the file.

## Architecture

```
boot.ts (kernel, ~30 lines)
  -> createDatabase() + initSchema()    [src/db.ts]
  -> createCtx(db)                      [src/ctx.ts]
  -> seedTemplate(ctx)                  [src/template.ts]
  -> ctx.call('main')
       -> sys:compiler (replaces ctx.call with cached + reactive version)
       -> spawn sys:supervisor (manages node lifecycle with retry/backoff)
       -> agent:tools (registers tool definitions as Tool-typed quads)
       -> spawn api:server (port 3001)
       -> spawn web:ui (port 3002)
       -> spawn repl (stdin)
```

The kernel has zero policy. All behavior is defined in graph-resident nodes.

Everything is an RDF quad: `(subject, predicate, object, graph)` — all strings, stored in a single `quads` table in Turso/libSQL. Code, data, configuration, conversation history, metrics, versions — all quads.

### Key files

| File | Purpose |
|---|---|
| `src/boot.ts` | Kernel entry point. Connects DB, creates ctx, seeds if empty, calls main. |
| `src/ctx.ts` | The 6 primitives: assert, retract, query, call, set, on. Plus ctx.self via AsyncLocalStorage. |
| `src/db.ts` | Turso/libSQL connection factory + schema init (quads table + optional vector column). |
| `src/template.ts` | All 29 node source strings in the `nodes` record + `seedTemplate()` function. This is the largest and most-edited file. |
| `src/test-boot.ts` | Integration tests with custom harness (no framework). |
| `index.ts` | Re-exports public API. |

### How nodes work

Nodes are AsyncFunction bodies stored as strings in the graph as `(name, 'source', code)` quads, with a `(name, 'type', 'Function')` companion quad. At call time, sys:compiler does:

```js
const fn = new AsyncFunction('ctx', 'args', sourceString);
return nodeStorage.run(name, () => fn(ctx, args));
```

Nodes receive `ctx` (6 primitives + `ctx.self`) and `args` (optional caller-provided object). Nodes cannot use `import` — they run in AsyncFunction scope with access to Bun globals, `process`, and `console`.

### How ctx.call evolves during boot

The naive `ctx.call` in `ctx.ts` recompiles on every call. `sys:compiler` replaces it in-place with a cached version that:
1. Caches compiled functions by name
2. Watches `{ p: 'source' }` changes to invalidate the cache reactively
3. Auto-saves old source as a version on retract (via `version:save`)
4. Records metrics (call count, duration, errors) for every call except metrics nodes

This is why `ctx` has `[key: \`_${string}\`]: any` — nodes like sys:compiler and sys:supervisor store runtime state (caches, controllers, locks) as `ctx._` properties.

### The reactive loop

When a node's source quad is retracted+reasserted: sys:compiler invalidates its cache, version:save snapshots the old source, and if the node is spawned, sys:supervisor aborts the old instance and restarts it with the new source. This is how hot-reload works.

## How to add a new node

1. Add the source string to the `nodes` record in `src/template.ts`.
2. `seedTemplate()` automatically registers it with `(name, 'source', code)` and `(name, 'type', 'Function')` quads.
3. If the node should be an LLM tool: register it in `agent:tools` with an `input_schema`, and add a dispatch handler in `agent:loop`. Tool names use underscores (e.g., `snapshot_export`), node names use colons (`snapshot:export`) — the generic fallback translates between them.
4. Add tests in `src/test-boot.ts`.
5. To auto-start: add `ctx.call('spawn', { node: 'my:node' })` in the `main` node.

## Conventions

- Node names use colon namespacing: `sys:compiler`, `agent:loop`, `version:save`
- Long-lived nodes receive `args.signal` (AbortController signal) for cooperative shutdown
- `ctx.set(s, p, o, g?)` is the primitive for single-valued predicates: atomic delete+insert via `db.batch`
- The `set` node delegates to `ctx.set` — use either depending on whether you're in a node or calling from outside
- sys:supervisor retries crashed nodes with exponential backoff (max 3, delays 500/1000/2000ms)
- Metrics auto-recorded by sys:compiler for every ctx.call (except metrics nodes)
- `ctx.on` subscribers must be unsubscribed to avoid leaks — store the unsub function

## Testing

Tests boot the full system against a local file DB — no mocking. Each test function groups related assertions under a section header. Add new tests by writing a `async function testFoo(ctx: Ctx)` and calling it from the bottom of the file.

## Common operations

- **Reset the graph**: delete `holoiconic.db` and restart. Seed recreates all nodes.
- **Debug a node**: `.source <name>` or `.inspect <name>` in the REPL.
- **Hot-reload a node**: retract+assert its source quad. sys:compiler and sys:supervisor handle the rest.

## Environment variables

Without `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`, `main` spawns the `mock:llm` node — a graph-resident mock server that registers a pi-ai faux provider for LLM completions and runs an HTTP server for OpenAI-compatible embeddings. The `llm`, `agent:loop`, and `embed` nodes route through it automatically. Without `TURSO_URL`/`TURSO_AUTH_TOKEN`, data is stored locally in `holoiconic.db`.

<!-- facts:start -->
## Fact-driven development

This project uses [facts](https://github.com/av/facts) for specification and documentation. All work flows through the fact sheet — it is the source of truth.

**Every change starts with a fact.** Facts are the spec — they define what "done" means. Code that isn't described by a fact is unverifiable and will be treated as incorrect. The skill `facts skills show facts` has the full format spec and command reference.

1. `facts list` — read the current spec to orient. Fact sheets can be large — use filters to focus: `--section "cli/init"`, `--tags "draft"`, `--file api.facts`, `--manual`. Read only the section relevant to your task, not the entire sheet.
2. `facts add` — write facts describing what should be true when done. Each fact is a testable claim. You are not ready to write code until this step is complete.
3. Implement the code to make those facts true
4. `facts check --tags "<tag>"` or `facts get <id>` — verify your changes. Never run bare `facts check` unless asked.
5. `facts edit <id> --add-tag implemented` — mark verified facts done

Step 4 only works if step 2 happened. If you skipped step 2, go back now — you cannot verify work that has no fact.

**Manual facts (`?` in check output):** these have no command, so you verify them by reading the relevant code. For each `?` fact: read what it claims, check the code, report PASS or FAIL with a one-line reason. Reporting "N manual" without verifying each one is not acceptable.

**Lifecycle:** `@draft` → `@spec` → `@implemented`

**Skills** (invoke via `facts skills show <name>`):
- `facts-refine` — sharpen `@draft` facts into `@spec` with the user
- `facts-discover` — scan the codebase and sync facts to reality (only when explicitly asked)
- `facts-implement` — implement `@spec` facts in code, verify, tag `@implemented`
<!-- facts:end -->
