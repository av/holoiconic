# holoiconic

Holoiconic is a self-modifying agentic runtime where everything, including code, data, configuration, conversation history, metrics, and versions, lives as RDF quads in a reactive graph database backed by Turso/libSQL. The kernel is small plumbing. Runtime behavior lives in graph-resident nodes that can inspect, modify, and spawn each other.

## Quick start

```bash
bun install
bun start
```

This boots the kernel, seeds an empty graph from the template, installs the reactive compiler, starts the supervisor, API server, WebUI, and REPL.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | For OpenAI-compatible LLMs and embeddings | Used by the default `openai` provider path. |
| `ANTHROPIC_API_KEY` | For Anthropic models | Used when selecting the `anthropic` provider. |
| `TURSO_URL` | For cloud DB | Turso Cloud URL, for example `libsql://db-org.turso.io`. |
| `TURSO_AUTH_TOKEN` | For cloud DB | Turso Cloud auth token. |

Without LLM API keys, `main` spawns the graph-resident `mock:llm` node. It registers a pi-ai faux provider for completions and serves OpenAI-compatible mock embeddings. Without Turso credentials, data is stored locally in `holoiconic.db`.

## Interfaces

The runtime exposes three interfaces, all started automatically by the `main` node:

- **REPL**: interactive command line at the `holo>` prompt. Natural language input routes through `agent:loop`; dot-commands provide direct graph manipulation.
- **API**: OpenAI-compatible API on `localhost:3001`, including `/v1/chat/completions`, streaming SSE support, `/v1/models`, and `/health`.
- **WebUI**: browser-based chat and graph explorer on `localhost:3002`.

## The ctx primitives

Every node receives a `ctx` object with these primitives:

| Primitive | Signature | Description |
|---|---|---|
| `insert` | `ctx.insert(subject, predicate, object, graph?, embedding?)` | Insert an RDF quad. Idempotent for duplicate `(subject, predicate, object, graph)` values. |
| `remove` | `ctx.remove(subject, predicate, object?, graph?)` | Remove matching quads. Omitting `object` removes all values for `(subject, predicate, graph)`. |
| `query` | `ctx.query({ subject?, predicate?, object?, graph? })` | Pattern-match quads. Omitted fields are wildcards. |
| `call` | `ctx.call(name, args?)` | Execute a graph-resident node by name. |
| `set` | `ctx.set(subject, predicate, object, graph?, embedding?)` | Atomically replace all values for `(subject, predicate, graph)` with one value. |
| `on` | `ctx.on(pattern, callback)` | Subscribe to quad changes matching a pattern. Returns an unsubscribe function. |

`ctx.self` returns the name of the currently executing node via AsyncLocalStorage.

## REPL commands

```text
.query {"subject":"...","predicate":"..."}  query quads by pattern
.insert subject predicate object [--g graph]     insert a quad
.remove subject predicate object [--g graph]     remove a quad
.call name [argsJSON]                            call a node
.nodes                                           list Function nodes
.source <name>                                   view node source
.edit <name>                                     edit node source inline
.create <name>                                   create a node interactively
.spawn <name>                                    spawn a long-lived node
.sessions                                        list conversation sessions
.session                                         show current session ID
.export [path]                                   export graph snapshot JSON
.import <path>                                   import graph snapshot JSON
.deps <name>                                     show node dependencies
.inspect <name>                                  show comprehensive node info
.versions <name>                                 list saved source versions
.restore <name> <seq>                            restore a source version
.cron <name> <interval_ms>                       run a node on a timer
.crons                                           list cron jobs
.metrics                                         show metrics report
.eval <code>                                     eval code with ctx in scope
.help                                            show help
```

Any input not starting with `.` is sent to `agent:loop`.

## Running tests

```bash
bun run src/test-boot.ts
```

The integration test suite uses a custom harness and boots the full runtime against a local file DB.
