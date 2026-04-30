# CLAUDE.md -- AI assistant context for holoiconic

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

## Key files

| File | Purpose |
|---|---|
| `src/boot.ts` | Kernel entry point. Connects DB, creates ctx, seeds if empty, calls main. |
| `src/ctx.ts` | The 5 primitives: assert, retract, query, call, on. Plus ctx.self via AsyncLocalStorage. |
| `src/db.ts` | Turso/libSQL connection factory + schema init (quads table + optional vector column). |
| `src/template.ts` | All 28 node source strings in the `nodes` record + `seedTemplate()` function. |
| `src/test-boot.ts` | 105 integration tests. Run with `bun test` or `bun run src/test-boot.ts`. |
| `index.ts` | Re-exports public API (createDatabase, createCtx, seedTemplate, types). |

## How nodes work

Nodes are AsyncFunction bodies stored as strings in the graph as `(name, 'source', code)` quads, with a `(name, 'type', 'Function')` companion quad. At call time, sys:compiler does:

```js
const fn = new AsyncFunction('ctx', 'args', sourceString);
return nodeStorage.run(name, () => fn(ctx, args));
```

Nodes receive two parameters:
- `ctx` -- the context object with 5 primitives + `ctx.self`
- `args` -- optional argument object passed by the caller

Nodes cannot use `import` statements. They can use Bun globals, `process`, `console`, and anything available in the AsyncFunction scope.

## How to add a new node

1. Add the source string to the `nodes` record in `src/template.ts`:
   ```ts
   "my:node": `
     // Your async function body here
     // Has access to ctx and args
     const result = await ctx.call('shell', { cmd: 'echo hello' });
     return result;
   `,
   ```

2. The `seedTemplate()` function automatically registers it with both `(name, 'source', code)` and `(name, 'type', 'Function')` quads.

3. If the node should be a tool (callable by the LLM agent), also register it in the `agent:tools` node source with an `input_schema`, and add a dispatch handler in `agent:loop`.

4. Add tests in `src/test-boot.ts`.

5. To make it start automatically, add a `ctx.call('spawn', { node: 'my:node' })` line in the `main` node.

## Key conventions

- Node names use colon namespacing: `sys:compiler`, `agent:loop`, `version:save`
- Long-lived nodes (servers, REPL) receive `args.signal` (AbortController signal) for cooperative shutdown
- The `set` node is a convenience for single-valued predicates: retracts old value, asserts new
- sys:compiler auto-saves versions on source retract (version:save)
- sys:supervisor retries crashed nodes with exponential backoff (max 3, delays 500/1000/2000ms)
- Metrics are auto-recorded by sys:compiler for every ctx.call (except metrics nodes themselves)

## Testing

Tests are self-contained in `src/test-boot.ts`. They create an in-memory database, boot the full system, and run assertions. No mocking -- everything runs against the real kernel.

```bash
bun test
# or
bun run src/test-boot.ts
```

## Common operations

- **Reset the graph**: delete `holoiconic.db` and restart. The seed will recreate all nodes.
- **Debug a node**: use `.source <name>` in the REPL, or `.inspect <name>` for full metadata.
- **Hot-reload a node**: edit its source (REPL `.edit`, WebUI editor, or retract+assert the source quad). sys:compiler invalidates the cache and sys:supervisor restarts spawned instances.
