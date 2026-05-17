# holoiconic

Holoiconic is a self-modifying agentic runtime where everything, including code, data, configuration, conversation history, metrics, and versions, lives as RDF quads in a reactive graph database backed by Turso/libSQL. The kernel is small plumbing. Runtime behavior lives in graph-resident nodes that can inspect, modify, and spawn each other.

## Quick start

```bash
bun install
bun start
```

This boots the kernel, seeds an empty graph from the template, installs the reactive compiler, starts the supervisor, API server, WebUI, and REPL.
See "Using custom OpenAI-compatible providers" below for `OPENAI_BASE_URL=...` etc (Groq, Ollama, vLLM...).

## Using custom OpenAI-compatible providers (Groq, Ollama, vLLM, OpenRouter, ...)

Trivial to launch against any OpenAI-compat endpoint via 6 methods.

Precedence (highest wins): CLI flags > config file > environment variables > defaults (`mock:llm` only when neither key nor `baseUrl`).

| Source | Example use | Scope |
|--------|-------------|-------|
| CLI flags | `bun start -- --openai-base-url=...` | per-invocation |
| `.holoiconic.json` (or `holoiconic.config.json`) | persistent file (cwd or `~/`) | across restarts |
| env vars | `OPENAI_BASE_URL=... bun start` | shell / `.env` |
| REPL `.provider` | `.provider set --base ...` | REPL session |
| WebUI form | inline inputs in chat header | browser tab |
| per-request | body fields or `x-openai-*` headers | single API call |

**1. Persistent config file** (`.holoiconic.json` or `holoiconic.config.json` in cwd or home dir):

Copy the ready-to-use documented template (contains Groq, Ollama local, OpenRouter examples + comments + security notes + precedence):
```bash
cp .holoiconic.json.example .holoiconic.json
```
Then edit the copy (valid JSON only; supports the shape below or flat keys). `bun start` loads it automatically from cwd or `~/`.

```json
{
  "provider": {
    "baseUrl": "https://api.groq.com/openai",
    "apiKey": "gsk_...",
    "model": "llama-3.1-70b-versatile"
  }
}
```
(Flat top-level keys like `"baseUrl"` are also accepted, as are snake_case variants.) See `.holoiconic.json.example` for 3 full commented examples.

Override the searched locations (cwd + ~/) with an exact path using env `HOLOICONIC_CONFIG` (or `HOLOICONIC_CONFIG_PATH`) or CLI `--config PATH` (CLI > file > env precedence).

**2. CLI flags** (pass after `--` for `bun start`; direct boot also supports):

```bash
bun start -- --openai-base-url=https://api.groq.com/openai \
  --openai-api-key=gsk_... --model=llama-3.1-8b-instant
# shorts: -b URL -k KEY -m MODEL ; also --provider, --api-port etc.
bun src/boot.ts --help
```

**3. Environment variables** (copy `.env.example` to `.env` and edit):

```bash
OPENAI_BASE_URL=https://api.groq.com/openai \
OPENAI_API_KEY=gsk_... \
HOLOICONIC_MODEL=llama-3.1-70b-versatile \
bun start
```
Supported: `OPENAI_BASE_URL` (or `OPENAI_API_BASE`), `OPENAI_API_KEY`, `HOLOICONIC_MODEL` (or `OPENAI_MODEL` / `MODEL`).

**4. REPL** (per-session override, after boot):

```
holo> .provider set --base https://api.groq.com/openai --key gsk_... --model llama-3.1-70b
holo> .provider show
holo> .provider clear
```

**5. WebUI** (http://localhost:3002): the chat header includes a status badge. Use the compact form right below it (baseUrl, apiKey, model fields + set/clear buttons). Configuration is saved to localStorage and survives reloads; values are forwarded on each send.

**6. Per-request** (overrides everything for one call to the OpenAI-compatible API on :3001):

```bash
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-openai-base-url: https://api.groq.com/openai" \
  -H "x-openai-api-key: gsk_..." \
  -d '{"model":"llama-3.1-70b-versatile","messages":[{"role":"user","content":"hi"}]}'
```
Body also accepts `baseUrl`, `apiKey`, `model` (and snake_case variants). `Authorization: Bearer <key>` works for the key (base from header or body).

**Notes**

- When a `baseUrl` is supplied (any method), a dummy key `sk-local` is used automatically if none provided — this works for local servers (Ollama, llama.cpp, vLLM, etc.) that need no auth.
- Specify the exact model name expected by your target endpoint.
- `bun src/boot.ts --help` (or via `bun start -- --help`) shows the full flag list.
- Custom provider errors are actionable: they report the attempted base URL, the original fetch/HTTP error, verification advice, and the configuration source (CLI / config / env / REPL / per-request / WebUI).
- Cross-references: `.env.example` (detailed vars + snippets), CLAUDE.md ("Environment variables" section), `facts list --section providers --tags spec` (and `facts check --tags "spec"` for the full provider spec).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | For OpenAI-compatible LLMs and embeddings | Used by the default `openai` provider path. |
| `ANTHROPIC_API_KEY` | For Anthropic models | Used when selecting the `anthropic` provider. |
| `TURSO_URL` | For cloud DB | Turso Cloud URL, for example `libsql://db-org.turso.io`. |
| `TURSO_AUTH_TOKEN` | For cloud DB | Turso Cloud auth token. |

Without LLM API keys, `main` spawns the graph-resident `mock:llm` node. It registers a pi-ai faux provider for completions and serves OpenAI-compatible mock embeddings. Without Turso credentials, data is stored locally in `holoiconic.db`. For custom providers see 'Using custom OpenAI-compatible providers' section above (6 methods + table).

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
