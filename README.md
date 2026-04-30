# holoiconic

Holoiconic is a self-modifying agentic runtime where everything -- code, data, configuration, conversation history -- lives as RDF quads in a reactive graph database backed by Turso/libSQL. The kernel is ~30 lines of boot code; all behavior emerges from 28 graph-resident nodes that can inspect, modify, and spawn each other at runtime through 5 context primitives.

## Quick start

```bash
bun install
bun start
```

This boots the kernel, seeds the graph with all nodes, installs the reactive compiler, starts the supervisor, API server, WebUI, and drops you into the REPL.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | For LLM | Anthropic API key for Claude (agent:loop uses this) |
| `OPENAI_API_KEY` | For embeddings | OpenAI API key for text-embedding-3-small (embed node) |
| `TURSO_URL` | For cloud DB | Turso Cloud URL (e.g. `libsql://db-org.turso.io`) |
| `TURSO_AUTH_TOKEN` | For cloud DB | Turso Cloud auth token |

Without API keys, the LLM and embedding nodes fall back to deterministic stubs. Without Turso credentials, data is stored locally in `holoiconic.db`.

## Interfaces

The runtime exposes three interfaces, all started automatically by the `main` node:

- **REPL** (stdin) -- interactive command line at `holo>` prompt. Natural language input routes through the agentic loop; dot-commands provide direct graph manipulation.
- **API** (localhost:3001) -- OpenAI-compatible `/v1/chat/completions` endpoint with streaming SSE support. Also serves `/v1/models` and `/health`.
- **WebUI** (localhost:3002) -- browser-based chat interface with a graph explorer panel for viewing, editing, creating, and deleting nodes.

## The 5 ctx primitives

Every node receives a `ctx` object with these primitives:

| Primitive | Signature | Description |
|---|---|---|
| `assert` | `ctx.assert(s, p, o, g?)` | Insert an RDF quad (subject, predicate, object, graph). Idempotent. |
| `retract` | `ctx.retract(s, p, o, g?)` | Remove a quad. No-op if not found. |
| `query` | `ctx.query({ s?, p?, o?, g? })` | Pattern-match quads. Omitted fields are wildcards. |
| `call` | `ctx.call(name, args?)` | Execute a graph-resident node by name. |
| `on` | `ctx.on(pattern, callback)` | Subscribe to quad changes matching a pattern. Returns unsubscribe function. |

Additionally, `ctx.self` returns the name of the currently executing node (via AsyncLocalStorage).

## REPL commands

```
.query {"s":"...","p":"..."}  -- query quads by pattern
.assert s p o                 -- assert a quad
.retract s p o                -- retract a quad
.call name [argsJSON]         -- call a node
.nodes                        -- list all Function nodes
.source <name>                -- view a node's source
.edit <name>                  -- edit a node source inline
.create <name>                -- create a new node interactively
.spawn <name>                 -- spawn a long-lived node
.sessions                     -- list conversation sessions
.session                      -- show current session ID
.export [path]                -- export graph snapshot (JSON)
.import <path>                -- import graph snapshot
.deps <name>                  -- show node dependencies
.inspect <name>               -- comprehensive node info
.versions <name>              -- list saved versions of a node
.restore <name> <seq>         -- restore a node to a specific version
.cron <name> <interval_ms>    -- run a node on a timer
.crons                        -- list cron jobs
.metrics                      -- show metrics report
.eval <code>                  -- eval code with ctx in scope
.help                         -- show help
```

Any input not starting with `.` is sent to the agentic loop as a natural language prompt.

## Graph-resident nodes (28)

**Core**: sys:compiler, sys:supervisor, spawn, main, repl, set

**LLM/Agent**: llm, agent:tools, agent:loop

**Servers**: api:server, web:ui

**Shell**: shell

**Graph introspection**: graph:describe, graph:subjects, graph:deps, inspect

**Snapshots**: snapshot:export, snapshot:import, snapshot:backup

**Embeddings**: embed, vector:search

**Versioning**: version:save, version:list, version:restore

**Scheduling**: cron, cron:list

**Observability**: metrics, metrics:report

## Running tests

```bash
bun test
```

This runs 105 integration tests covering the full boot chain, all nodes, reactive compilation, supervisor lifecycle, API endpoints, WebUI, versioning, cron, metrics, and more.
