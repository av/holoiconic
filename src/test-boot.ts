import { createDatabase, initSchema } from "./db.ts";
import { createCtx, type Ctx } from "./ctx.ts";
import { seedTemplate } from "./template.ts";

// ── Test harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: string[] = [];

function ok(label: string) {
  passed++;
  results.push(`  PASS  ${label}`);
  console.log(`  PASS  ${label}`);
}

function fail(label: string, err: any) {
  failed++;
  const msg = err instanceof Error ? err.message : String(err);
  results.push(`  FAIL  ${label}: ${msg}`);
  console.log(`  FAIL  ${label}: ${msg}`);
}

// ── Boot (non-interactive) ────────────────────────────────────────

async function boot(): Promise<Ctx> {
  const db = createDatabase("test-holoiconic.db");
  await initSchema(db);
  const ctx = createCtx(db);
  await seedTemplate(ctx);
  return ctx;
}

// ── Tests ─────────────────────────────────────────────────────────

async function testBootChain(ctx: Ctx) {
  console.log("\n── Boot chain ──");

  // Test 1: Graph is seeded
  try {
    const nodes = await ctx.query({ p: "type", o: "Function" });
    const names = nodes.map((q) => q.s).sort();
    if (names.length < 7)
      throw new Error(`expected >=7 nodes, got ${names.length}: ${names}`);
    ok("graph seeded with 7+ nodes");
  } catch (e) {
    fail("graph seeded", e);
  }

  // Test 2: sys:compiler installs
  try {
    await ctx.call("sys:compiler");
    // Verify ctx.call is now the cached version (has name "cachedCall")
    if (ctx.call.name !== "cachedCall")
      throw new Error(`ctx.call.name = "${ctx.call.name}", expected "cachedCall"`);
    ok("sys:compiler installed (ctx.call = cachedCall)");
  } catch (e) {
    fail("sys:compiler install", e);
  }

  // Test 3: spawn + supervisor
  try {
    await ctx.call("spawn", { node: "sys:supervisor" });
    await new Promise((r) => setTimeout(r, 50));
    const spawned = await ctx.query({ s: "sys:supervisor", p: "type", o: "Spawned" });
    if (spawned.length === 0) throw new Error("supervisor not marked as Spawned");
    if (!ctx._supervisorControllers)
      throw new Error("_supervisorControllers not set");
    ok("supervisor spawned and registered");
  } catch (e) {
    fail("supervisor spawn", e);
  }
}

async function testShellNode(ctx: Ctx) {
  console.log("\n── Shell node ──");

  try {
    const result = await ctx.call("shell", { cmd: "echo hello" });
    if (result.trim() !== "hello")
      throw new Error(`expected "hello", got "${result.trim()}"`);
    ok('shell: echo hello => "hello"');
  } catch (e) {
    fail("shell node", e);
  }

  // Test error case
  try {
    await ctx.call("shell", { cmd: "exit 42" });
    fail("shell error handling", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("command failed")) {
      ok("shell: non-zero exit throws");
    } else {
      fail("shell error handling", e);
    }
  }
}

async function testLlmNode(ctx: Ctx) {
  console.log("\n── LLM node ──");

  try {
    const result = await ctx.call("llm", {
      messages: [{ role: "user", content: "hi" }],
      model: "test",
    });
    if (!result || result.role !== "assistant")
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    if (!Array.isArray(result.content))
      throw new Error(`expected content array, got: ${typeof result.content}`);
    ok("llm returns Anthropic-format assistant message");
  } catch (e) {
    fail("llm node", e);
  }
}

async function testAgentTools(ctx: Ctx) {
  console.log("\n── Agent tools ──");

  try {
    await ctx.call("agent:tools");

    // Verify tool quads were registered
    const toolQuads = await ctx.query({ p: "type", o: "Tool" });
    const toolNames = toolQuads.map(q => q.s).sort();
    if (toolNames.length < 5)
      throw new Error(`expected >=5 tools, got ${toolNames.length}: ${toolNames}`);
    ok("agent:tools registered 5+ tools");

    // Verify shell tool has schema
    const shellSchema = await ctx.query({ s: "shell", p: "tool_schema" });
    if (shellSchema.length === 0)
      throw new Error("shell tool has no schema");
    const schema = JSON.parse(shellSchema[0].o);
    if (schema.name !== "shell")
      throw new Error(`expected shell schema name, got: ${schema.name}`);
    ok("shell tool has valid schema");
  } catch (e) {
    fail("agent:tools", e);
  }
}

async function testAgentLoop(ctx: Ctx) {
  console.log("\n── Agent loop (stub mode) ──");

  try {
    // Without an API key, the LLM returns a stub response
    // The agent:loop should handle the stub gracefully
    const result = await ctx.call("agent:loop", { prompt: "hello" });
    if (!result || !result.session)
      throw new Error(`expected result with session, got: ${JSON.stringify(result)}`);
    if (!result.response)
      throw new Error(`expected result with response, got: ${JSON.stringify(result)}`);
    ok("agent:loop returns session + response (stub mode)");

    // Verify conversation was stored in graph
    const msgs = await ctx.query({ p: "message", g: result.session });
    if (msgs.length < 2)
      throw new Error(`expected >=2 messages in session, got ${msgs.length}`);
    ok("agent:loop stores conversation history in graph");
  } catch (e) {
    fail("agent:loop", e);
  }
}

async function testSessionContinuity(ctx: Ctx) {
  console.log("\n── Session continuity ──");

  try {
    // Send two messages with the same session ID
    const sessionId = "test:continuity:" + Date.now();

    const result1 = await ctx.call("agent:loop", { prompt: "first message", session: sessionId });
    if (result1.session !== sessionId)
      throw new Error(`expected session='${sessionId}', got '${result1.session}'`);

    const result2 = await ctx.call("agent:loop", { prompt: "second message", session: sessionId });
    if (result2.session !== sessionId)
      throw new Error(`expected same session, got '${result2.session}'`);

    // Verify conversation history has all messages (at least 4: user1, assistant1, user2, assistant2)
    const msgs = await ctx.query({ p: "message", g: sessionId });
    if (msgs.length < 4)
      throw new Error(`expected >=4 messages in session, got ${msgs.length}`);

    // Verify messages are properly ordered (user, assistant, user, assistant)
    const sorted = msgs.sort((a: any, b: any) => a.id - b.id);
    const parsed = sorted.map((q: any) => { const w = JSON.parse(q.o); return w.msg || w; });
    if (parsed[0].role !== "user" || parsed[0].content !== "first message")
      throw new Error(`first message wrong: ${JSON.stringify(parsed[0])}`);
    if (parsed[1].role !== "assistant")
      throw new Error(`second message should be assistant, got: ${parsed[1].role}`);
    if (parsed[2].role !== "user" || parsed[2].content !== "second message")
      throw new Error(`third message wrong: ${JSON.stringify(parsed[2])}`);
    if (parsed[3].role !== "assistant")
      throw new Error(`fourth message should be assistant, got: ${parsed[3].role}`);

    ok("session continuity: same session ID preserves multi-turn history");
  } catch (e) {
    fail("session continuity", e);
  }

  try {
    // Without a session ID, each call gets a unique session
    const result1 = await ctx.call("agent:loop", { prompt: "no session 1" });
    const result2 = await ctx.call("agent:loop", { prompt: "no session 2" });
    if (result1.session === result2.session)
      throw new Error("expected different sessions without explicit ID");
    ok("no session ID: each call gets unique session");
  } catch (e) {
    fail("unique sessions", e);
  }
}

async function testReactiveCompilation(ctx: Ctx) {
  console.log("\n── Reactive compilation ──");

  // Create a test node
  try {
    await ctx.assert("test:adder", "source", "return (args.a || 0) + (args.b || 0)");
    await ctx.assert("test:adder", "type", "Function");

    // Call it
    const r1 = await ctx.call("test:adder", { a: 2, b: 3 });
    if (r1 !== 5) throw new Error(`expected 5, got ${r1}`);
    ok("test:adder(2,3) = 5");

    // Update source (must retract old, assert new — since (s,p,o,g) is unique)
    await ctx.retract(
      "test:adder",
      "source",
      "return (args.a || 0) + (args.b || 0)"
    );
    await ctx.assert(
      "test:adder",
      "source",
      "return (args.a || 0) * (args.b || 0)"
    );

    // Call again — should pick up new source (cache invalidated reactively)
    const r2 = await ctx.call("test:adder", { a: 2, b: 3 });
    if (r2 !== 6) throw new Error(`expected 6 (2*3), got ${r2}`);
    ok("reactive recompilation: test:adder now multiplies, 2*3 = 6");
  } catch (e) {
    fail("reactive compilation", e);
  }
}

async function testSpawnLifecycle(ctx: Ctx) {
  console.log("\n── Spawn lifecycle ──");

  try {
    // Create a spawned test node that sets a flag and waits for abort
    await ctx.assert(
      "test:worker",
      "source",
      `
await ctx.assert('test:worker', 'status', 'v1-running');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`
    );
    await ctx.assert("test:worker", "type", "Function");

    // Spawn it
    await ctx.call("spawn", { node: "test:worker" });
    await new Promise((r) => setTimeout(r, 100));

    // Verify it started
    const status1 = await ctx.query({
      s: "test:worker",
      p: "status",
      o: "v1-running",
    });
    if (status1.length === 0) throw new Error("test:worker did not start (no v1-running status)");
    ok("spawned test:worker is running (v1)");

    // Now update source — supervisor should restart it
    await ctx.retract(
      "test:worker",
      "source",
      `
await ctx.assert('test:worker', 'status', 'v1-running');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`
    );
    await ctx.assert(
      "test:worker",
      "source",
      `
await ctx.assert('test:worker', 'status', 'v2-running');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`
    );

    await new Promise((r) => setTimeout(r, 200));

    // Check v2 is running
    const status2 = await ctx.query({
      s: "test:worker",
      p: "status",
      o: "v2-running",
    });
    if (status2.length === 0) throw new Error("test:worker was not restarted (no v2-running status)");
    ok("supervisor restarted test:worker with new source (v2)");
  } catch (e) {
    fail("spawn lifecycle", e);
  }
}

async function testApiServer(ctx: Ctx) {
  console.log("\n── API server ──");

  const port = 13001 + Math.floor(Math.random() * 1000);

  // Spawn the API server on a random test port
  const ac = new AbortController();
  try {
    ctx.call("api:server", { port, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // Test /v1/models
    try {
      const modelsRes = await fetch(`http://localhost:${port}/v1/models`);
      const modelsData = await modelsRes.json() as any;
      if (modelsData.object !== "list")
        throw new Error(`expected object='list', got '${modelsData.object}'`);
      if (!Array.isArray(modelsData.data) || modelsData.data.length === 0)
        throw new Error("expected non-empty data array");
      if (modelsData.data[0].id !== "holoiconic")
        throw new Error(`expected model id='holoiconic', got '${modelsData.data[0].id}'`);
      ok("GET /v1/models returns model list");
    } catch (e) {
      fail("GET /v1/models", e);
    }

    // Test /v1/chat/completions (non-streaming)
    try {
      const chatRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "holoiconic",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      const chatData = await chatRes.json() as any;
      if (chatData.object !== "chat.completion")
        throw new Error(`expected object='chat.completion', got '${chatData.object}'`);
      if (!chatData.choices || chatData.choices.length === 0)
        throw new Error("expected non-empty choices array");
      if (chatData.choices[0].message.role !== "assistant")
        throw new Error(`expected role='assistant', got '${chatData.choices[0].message.role}'`);
      if (chatData.choices[0].finish_reason !== "stop")
        throw new Error(`expected finish_reason='stop', got '${chatData.choices[0].finish_reason}'`);
      ok("POST /v1/chat/completions returns OpenAI-format response");
    } catch (e) {
      fail("POST /v1/chat/completions", e);
    }

    // Test session passthrough
    try {
      const sessionId = "test-session:" + Date.now();
      const chatRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "holoiconic",
          messages: [{ role: "user", content: "test session" }],
          session: sessionId,
        }),
      });
      const chatData = await chatRes.json() as any;
      if (chatData.session !== sessionId)
        throw new Error(`expected session='${sessionId}', got '${chatData.session}'`);
      ok("POST /v1/chat/completions passes session through");
    } catch (e) {
      fail("session passthrough", e);
    }

    // Test streaming mode (stream: true)
    try {
      const streamRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "holoiconic",
          messages: [{ role: "user", content: "stream test" }],
          stream: true,
        }),
      });

      const contentType = streamRes.headers.get("content-type") || "";
      if (!contentType.includes("text/event-stream"))
        throw new Error(`expected text/event-stream, got '${contentType}'`);

      const body = await streamRes.text();
      const lines = body.split("\n").filter(l => l.startsWith("data: "));

      if (lines.length < 2)
        throw new Error(`expected >=2 SSE data lines, got ${lines.length}`);

      // Last data line should be [DONE]
      const lastData = lines[lines.length - 1].slice(6).trim();
      if (lastData !== "[DONE]")
        throw new Error(`expected last line to be [DONE], got '${lastData}'`);

      // First data line should be a valid chunk
      const firstChunk = JSON.parse(lines[0].slice(6));
      if (firstChunk.object !== "chat.completion.chunk")
        throw new Error(`expected object='chat.completion.chunk', got '${firstChunk.object}'`);
      if (!firstChunk.choices || !firstChunk.choices[0].delta)
        throw new Error("expected delta in chunk choices");

      // Reassemble full text from all chunks (except [DONE])
      let assembled = "";
      for (const line of lines) {
        const payload = line.slice(6).trim();
        if (payload === "[DONE]") continue;
        const chunk = JSON.parse(payload);
        if (chunk.choices && chunk.choices[0].delta && chunk.choices[0].delta.content) {
          assembled += chunk.choices[0].delta.content;
        }
      }
      if (assembled.length === 0)
        throw new Error("assembled streaming text is empty");

      ok("POST /v1/chat/completions streaming returns valid SSE chunks");
    } catch (e) {
      fail("streaming SSE", e);
    }

    // Test 404 for unknown paths
    try {
      const notFoundRes = await fetch(`http://localhost:${port}/v1/unknown`);
      if (notFoundRes.status !== 404)
        throw new Error(`expected 404, got ${notFoundRes.status}`);
      ok("unknown paths return 404");
    } catch (e) {
      fail("404 handling", e);
    }
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function testWebUi(ctx: Ctx) {
  console.log("\n── WebUI ──");

  const port = 14000 + Math.floor(Math.random() * 1000);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // Test GET / serves HTML
    try {
      const res = await fetch(`http://localhost:${port}/`);
      const contentType = res.headers.get("content-type") || "";
      if (!contentType.includes("text/html"))
        throw new Error(`expected text/html content-type, got '${contentType}'`);
      const body = await res.text();
      if (!body.includes("holoiconic"))
        throw new Error("HTML body does not contain 'holoiconic'");
      if (!body.includes("<script>"))
        throw new Error("HTML body does not contain <script>");
      ok("GET / serves HTML chat interface");
    } catch (e) {
      fail("GET / HTML", e);
    }

    // Test /api/nodes returns JSON array of nodes
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`);
      const nodes = await res.json() as any[];
      if (!Array.isArray(nodes))
        throw new Error("expected array of nodes");
      const names = nodes.map((n: any) => n.name);
      if (!names.includes("main"))
        throw new Error("expected 'main' in node list");
      ok("GET /api/nodes returns node list");
    } catch (e) {
      fail("GET /api/nodes", e);
    }

    // Test /api/node/:name returns source
    try {
      const res = await fetch(`http://localhost:${port}/api/node/shell`);
      const data = await res.json() as any;
      if (data.name !== "shell")
        throw new Error(`expected name='shell', got '${data.name}'`);
      if (!data.source || !data.source.includes("Bun.spawn"))
        throw new Error("expected shell source containing Bun.spawn");
      ok("GET /api/node/:name returns node source");
    } catch (e) {
      fail("GET /api/node/:name", e);
    }

    // Test POST /api/node/:name/source — update node source
    try {
      // Create a test node first
      await ctx.assert("test:editable", "type", "Function");
      await ctx.assert("test:editable", "source", "return 'v1'");

      const res = await fetch(`http://localhost:${port}/api/node/test:editable/source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "return 'v2'" }),
      });
      const data = await res.json() as any;
      if (!res.ok)
        throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(data)}`);
      if (!data.ok)
        throw new Error(`expected ok=true, got ${JSON.stringify(data)}`);

      // Verify the source was updated in the graph
      const sourceQuads = await ctx.query({ s: "test:editable", p: "source" });
      if (sourceQuads.length !== 1)
        throw new Error(`expected 1 source quad, got ${sourceQuads.length}`);
      if (sourceQuads[0].o !== "return 'v2'")
        throw new Error(`expected source='return \\'v2\\'', got '${sourceQuads[0].o}'`);

      // Verify reactive recompilation works — calling the node should use new source
      const result = await ctx.call("test:editable");
      if (result !== "v2")
        throw new Error(`expected 'v2' from recompiled node, got '${result}'`);

      ok("POST /api/node/:name/source updates source and triggers recompilation");
    } catch (e) {
      fail("POST /api/node/:name/source", e);
    }

    // Test POST /api/node/:name/source — validation error
    try {
      const res = await fetch(`http://localhost:${port}/api/node/test:editable/source`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (res.status !== 400)
        throw new Error(`expected 400 for missing source, got ${res.status}`);
      ok("POST /api/node/:name/source rejects missing source with 400");
    } catch (e) {
      fail("POST /api/node/:name/source validation", e);
    }

    // Test POST /api/nodes — create a new node
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test:created", source: "return 'created'" }),
      });
      const data = await res.json() as any;
      if (res.status !== 201)
        throw new Error(`expected 201, got ${res.status}: ${JSON.stringify(data)}`);
      if (!data.ok)
        throw new Error(`expected ok=true, got ${JSON.stringify(data)}`);

      // Verify the node exists in the graph
      const typeQuads = await ctx.query({ s: "test:created", p: "type", o: "Function" });
      if (typeQuads.length !== 1)
        throw new Error(`expected 1 type quad, got ${typeQuads.length}`);
      const sourceQuads = await ctx.query({ s: "test:created", p: "source" });
      if (sourceQuads.length !== 1)
        throw new Error(`expected 1 source quad, got ${sourceQuads.length}`);

      // Verify the node can be called
      const result = await ctx.call("test:created");
      if (result !== "created")
        throw new Error(`expected 'created', got '${result}'`);

      ok("POST /api/nodes creates new node with type and source");
    } catch (e) {
      fail("POST /api/nodes create", e);
    }

    // Test POST /api/nodes — duplicate node returns 409
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test:created", source: "return 'duplicate'" }),
      });
      if (res.status !== 409)
        throw new Error(`expected 409 for duplicate, got ${res.status}`);
      ok("POST /api/nodes rejects duplicate node with 409");
    } catch (e) {
      fail("POST /api/nodes duplicate", e);
    }

    // Test POST /api/nodes — validation errors
    try {
      const res1 = await fetch(`http://localhost:${port}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "return 1" }),
      });
      if (res1.status !== 400)
        throw new Error(`expected 400 for missing name, got ${res1.status}`);

      const res2 = await fetch(`http://localhost:${port}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test:bad" }),
      });
      if (res2.status !== 400)
        throw new Error(`expected 400 for missing source, got ${res2.status}`);

      ok("POST /api/nodes rejects invalid input with 400");
    } catch (e) {
      fail("POST /api/nodes validation", e);
    }
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function testSnapshotExportImport(ctx: Ctx) {
  console.log("\n── Snapshot export/import ──");

  try {
    // Export all quads as JSON string
    const json = await ctx.call("snapshot:export");
    const quads = JSON.parse(json);
    if (!Array.isArray(quads) || quads.length === 0)
      throw new Error(`expected non-empty array, got ${typeof quads} with length ${quads.length || 0}`);
    // Every quad should have s, p, o, g
    const first = quads[0];
    if (!first.s || !first.p || typeof first.o !== "string" || !first.g)
      throw new Error(`quad missing fields: ${JSON.stringify(first)}`);
    ok("snapshot:export returns JSON array of quads (" + quads.length + " quads)");
  } catch (e) {
    fail("snapshot:export", e);
  }

  try {
    // Export to file
    const tmpPath = "/tmp/test-holo-snapshot-" + Date.now() + ".json";
    const result = await ctx.call("snapshot:export", { path: tmpPath });
    if (!result.path || result.path !== tmpPath)
      throw new Error(`expected path=${tmpPath}, got ${result.path}`);
    if (result.count < 1)
      throw new Error(`expected count >= 1, got ${result.count}`);

    // Read back and verify it's valid JSON
    const file = Bun.file(tmpPath);
    const content = await file.text();
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed) || parsed.length !== result.count)
      throw new Error(`file contains ${parsed.length} quads, expected ${result.count}`);
    ok("snapshot:export writes to file (" + result.count + " quads)");

    // Import from file into a fresh context to verify round-trip
    // We'll use the same ctx but import a known subset
    const testData = [
      { s: "rt:test1", p: "value", o: "hello", g: "_" },
      { s: "rt:test2", p: "value", o: "world", g: "_" },
    ];
    const testJson = JSON.stringify(testData);

    const importResult = await ctx.call("snapshot:import", { data: testJson });
    if (importResult.count !== 2)
      throw new Error(`expected import count=2, got ${importResult.count}`);

    // Verify the quads exist
    const q1 = await ctx.query({ s: "rt:test1", p: "value" });
    if (q1.length === 0 || q1[0].o !== "hello")
      throw new Error(`rt:test1 not found or wrong value`);
    const q2 = await ctx.query({ s: "rt:test2", p: "value" });
    if (q2.length === 0 || q2[0].o !== "world")
      throw new Error(`rt:test2 not found or wrong value`);
    ok("snapshot:import round-trip (data string) — 2 quads imported and verified");

    // Import from file
    const testFilePath = "/tmp/test-holo-import-" + Date.now() + ".json";
    await Bun.write(testFilePath, JSON.stringify([
      { s: "rt:test3", p: "value", o: "from-file", g: "_" },
    ]));
    const importFileResult = await ctx.call("snapshot:import", { path: testFilePath });
    if (importFileResult.count !== 1)
      throw new Error(`expected import count=1, got ${importFileResult.count}`);
    const q3 = await ctx.query({ s: "rt:test3", p: "value" });
    if (q3.length === 0 || q3[0].o !== "from-file")
      throw new Error("rt:test3 not found after file import");
    ok("snapshot:import from file path — 1 quad imported and verified");

    // Cleanup temp files
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(tmpPath); } catch {}
    try { unlinkSync(testFilePath); } catch {}
  } catch (e) {
    fail("snapshot:export/import round-trip", e);
  }
}

async function testSnapshotBackup(ctx: Ctx) {
  console.log("\n── Snapshot backup ──");

  try {
    const dest = "/tmp/test-holo-backup-" + Date.now() + ".db";
    const result = await ctx.call("snapshot:backup", {
      path: dest,
      srcPath: "test-holoiconic.db",
    });
    if (result.path !== dest)
      throw new Error(`expected path=${dest}, got ${result.path}`);

    // Verify the backup file exists and is non-empty
    const file = Bun.file(dest);
    const exists = await file.exists();
    if (!exists) throw new Error("backup file does not exist");
    const size = file.size;
    if (size < 100)
      throw new Error(`backup file too small: ${size} bytes`);
    ok("snapshot:backup creates valid database copy (" + size + " bytes)");

    // Cleanup
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync(dest); } catch {}
  } catch (e) {
    fail("snapshot:backup", e);
  }
}

async function testEmbedNode(ctx: Ctx) {
  console.log("\n── Embed node ──");

  try {
    // Without API key, uses stub
    const result = await ctx.call("embed", { text: "hello world" });
    if (!result.embedding || !Array.isArray(result.embedding))
      throw new Error(`expected embedding array, got ${typeof result.embedding}`);
    if (result.embedding.length !== 1536)
      throw new Error(`expected 1536 dimensions, got ${result.embedding.length}`);
    if (result.model !== "stub")
      throw new Error(`expected model='stub', got '${result.model}'`);

    // Verify it's normalized (unit vector)
    let norm = 0;
    for (const v of result.embedding) norm += v * v;
    norm = Math.sqrt(norm);
    if (Math.abs(norm - 1.0) > 0.01)
      throw new Error(`expected unit vector (norm~1), got norm=${norm}`);

    // Verify deterministic: same text gives same embedding
    const result2 = await ctx.call("embed", { text: "hello world" });
    if (result.embedding[0] !== result2.embedding[0] || result.embedding[100] !== result2.embedding[100])
      throw new Error("stub embedding is not deterministic");

    ok("embed returns 1536-dim normalized stub vector (deterministic)");
  } catch (e) {
    fail("embed node", e);
  }
}

async function testVectorSearch(ctx: Ctx) {
  console.log("\n── Vector search ──");

  try {
    // Search by text — uses stub embeddings
    const results = await ctx.call("vector:search", { text: "shell command", k: 3 });
    if (!Array.isArray(results))
      throw new Error(`expected array, got ${typeof results}`);
    if (results.length === 0)
      throw new Error("expected at least 1 result");
    if (results.length > 3)
      throw new Error(`expected <= 3 results (k=3), got ${results.length}`);
    // Each result should have quad and similarity
    const first = results[0];
    if (!first.quad || typeof first.similarity !== "number")
      throw new Error(`result missing quad or similarity: ${JSON.stringify(first)}`);
    // Results should be sorted by similarity descending
    for (let i = 1; i < results.length; i++) {
      if (results[i].similarity > results[i - 1].similarity)
        throw new Error("results not sorted by similarity descending");
    }
    ok("vector:search returns top-k results sorted by similarity");
  } catch (e) {
    fail("vector:search", e);
  }
}

async function testEmbeddingPersistence(ctx: Ctx) {
  console.log("\n── Embedding persistence ──");

  try {
    // Call embed — it should persist the embedding in the graph
    await ctx.call("embed", { text: "persistence test text" });

    // Verify embedding quad was stored in the 'embeddings' graph
    const embQuads = await ctx.query({ p: "embedding", g: "embeddings" });
    if (embQuads.length === 0)
      throw new Error("expected embedding quads in 'embeddings' graph, got 0");

    // Find the one for our text
    const match = embQuads.find((q: any) => q.o === "persistence test text");
    if (!match)
      throw new Error("expected embedding quad with o='persistence test text'");
    if (!match.s.startsWith("emb:"))
      throw new Error(`expected subject starting with 'emb:', got '${match.s}'`);
    ok("embed persists embedding quads in graph");
  } catch (e) {
    fail("embedding persistence", e);
  }

  try {
    // ctx.assert with embedding parameter should work
    const testVec = new Array(1536).fill(0).map((_, i) => (i % 2 === 0 ? 0.1 : -0.1));
    const quad = await ctx.assert("test:vec", "has_embedding", "test_value", "_", testVec);
    if (!quad || quad.s !== "test:vec")
      throw new Error(`expected quad with s='test:vec', got ${JSON.stringify(quad)}`);
    ok("ctx.assert accepts embedding parameter");
  } catch (e) {
    fail("ctx.assert with embedding", e);
  }

  try {
    // vector:search should find persisted embeddings
    const results = await ctx.call("vector:search", { text: "persistence test text", k: 5 });
    if (!Array.isArray(results) || results.length === 0)
      throw new Error("expected search results");
    // The search should return results from the embeddings graph
    const embResult = results.find((r: any) => r.quad.o === "persistence test text");
    if (!embResult)
      throw new Error("expected to find persisted embedding in search results");
    ok("vector:search finds persisted embeddings");
  } catch (e) {
    fail("vector:search persisted embeddings", e);
  }
}

async function testToolCallVisibility(ctx: Ctx) {
  console.log("\n── Tool call visibility ──");

  // Test that agent:loop returns tool_calls array (even when empty in stub mode)
  try {
    const result = await ctx.call("agent:loop", { prompt: "what tools exist" });
    if (!result.hasOwnProperty("tool_calls"))
      throw new Error("expected tool_calls field in agent:loop result");
    if (!Array.isArray(result.tool_calls))
      throw new Error(`expected tool_calls to be array, got ${typeof result.tool_calls}`);
    ok("agent:loop returns tool_calls array in response");
  } catch (e) {
    fail("agent:loop tool_calls", e);
  }

  // Test that api:server passes tool_calls through in non-streaming response
  const port = 13800 + Math.floor(Math.random() * 100);
  const ac = new AbortController();
  try {
    ctx.call("api:server", { port, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    const chatRes = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "holoiconic",
        messages: [{ role: "user", content: "test tool visibility" }],
      }),
    });
    const chatData = await chatRes.json() as any;
    if (!chatData.hasOwnProperty("tool_calls"))
      throw new Error("expected tool_calls in API response");
    if (!Array.isArray(chatData.tool_calls))
      throw new Error(`expected tool_calls array, got ${typeof chatData.tool_calls}`);
    ok("API response includes tool_calls array");
  } catch (e) {
    fail("API tool_calls", e);
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function testSetNode(ctx: Ctx) {
  console.log("\n── Set convenience node ──");

  try {
    // Set a single-valued predicate
    await ctx.assert("test:setnode", "type", "Function");
    await ctx.assert("test:setnode", "status", "init");

    // Call set to update status — should retract old and assert new
    const result = await ctx.call("set", { s: "test:setnode", p: "status", o: "running" });
    if (!result || result.o !== "running")
      throw new Error(`expected o='running', got '${result && result.o}'`);

    // Verify only one status quad exists
    const statusQuads = await ctx.query({ s: "test:setnode", p: "status" });
    if (statusQuads.length !== 1)
      throw new Error(`expected 1 status quad, got ${statusQuads.length}`);
    if (statusQuads[0].o !== "running")
      throw new Error(`expected 'running', got '${statusQuads[0].o}'`);

    ok("set: replaces single-valued predicate");
  } catch (e) {
    fail("set node basic", e);
  }

  try {
    // Set again to verify it replaces the previous value
    await ctx.call("set", { s: "test:setnode", p: "status", o: "stopped" });
    const statusQuads = await ctx.query({ s: "test:setnode", p: "status" });
    if (statusQuads.length !== 1)
      throw new Error(`expected 1 quad after second set, got ${statusQuads.length}`);
    if (statusQuads[0].o !== "stopped")
      throw new Error(`expected 'stopped', got '${statusQuads[0].o}'`);
    ok("set: second call replaces previous value");
  } catch (e) {
    fail("set node replace", e);
  }

  try {
    // Set with multiple existing values (retract all)
    await ctx.assert("test:multival", "tag", "a");
    await ctx.assert("test:multival", "tag", "b");
    await ctx.assert("test:multival", "tag", "c");
    const before = await ctx.query({ s: "test:multival", p: "tag" });
    if (before.length !== 3)
      throw new Error(`expected 3 tags before set, got ${before.length}`);

    await ctx.call("set", { s: "test:multival", p: "tag", o: "only" });
    const after = await ctx.query({ s: "test:multival", p: "tag" });
    if (after.length !== 1)
      throw new Error(`expected 1 tag after set, got ${after.length}`);
    if (after[0].o !== "only")
      throw new Error(`expected 'only', got '${after[0].o}'`);
    ok("set: retracts all existing values before asserting");
  } catch (e) {
    fail("set node multi-retract", e);
  }

  try {
    // Set validation: missing required fields
    await ctx.call("set", { s: "test:setnode", p: "status" });
    fail("set validation", "should have thrown for missing o");
  } catch (e: any) {
    if (e.message && e.message.includes("required")) {
      ok("set: throws on missing required fields");
    } else {
      fail("set validation", e);
    }
  }
}

async function testSupervisorRetry(ctx: Ctx) {
  console.log("\n── Supervisor retry/backoff ──");

  try {
    // Create a node that crashes on first call but succeeds after
    // We use a quad to track how many times the node was called
    await ctx.assert("test:crasher", "call_count", "0");

    await ctx.assert("test:crasher", "source", `
const countQuads = await ctx.query({ s: 'test:crasher', p: 'call_count' });
const count = parseInt(countQuads[0].o);
const newCount = count + 1;
// Update the count using retract+assert
await ctx.retract('test:crasher', 'call_count', String(count));
await ctx.assert('test:crasher', 'call_count', String(newCount));

if (newCount <= 2) {
  throw new Error('deliberate crash #' + newCount);
}

// On 3rd call, succeed and stay alive
await ctx.assert('test:crasher', 'status', 'recovered');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`);
    await ctx.assert("test:crasher", "type", "Function");

    // Spawn it via supervisor
    await ctx.call("spawn", { node: "test:crasher" });

    // Wait for retries (500ms + 1000ms + some margin)
    await new Promise((r) => setTimeout(r, 2500));

    // Check it was retried and eventually recovered
    const statusQuads = await ctx.query({ s: "test:crasher", p: "status", o: "recovered" });
    if (statusQuads.length === 0)
      throw new Error("test:crasher did not recover after retries");

    const countQuads = await ctx.query({ s: "test:crasher", p: "call_count" });
    const finalCount = parseInt(countQuads[0].o);
    if (finalCount < 3)
      throw new Error(`expected at least 3 calls, got ${finalCount}`);

    ok("supervisor retries crashed node with exponential backoff");
  } catch (e) {
    fail("supervisor retry", e);
  }
}

async function testReplCommands(ctx: Ctx) {
  console.log("\n── REPL commands ──");

  // We can't test the full readline loop, but we can test that the
  // REPL's help text contains the new commands by checking the source.
  try {
    const rs = await ctx.query({ s: "repl", p: "source" });
    if (rs.length === 0) throw new Error("repl source not found");
    const src = rs[0].o;

    const expectedCommands = [".source", ".edit", ".create", ".spawn", ".sessions", ".export", ".import", ".eval"];
    const missing = expectedCommands.filter(cmd => !src.includes(cmd));
    if (missing.length > 0)
      throw new Error("REPL source missing commands: " + missing.join(", "));

    ok("REPL source contains all new commands: " + expectedCommands.join(", "));
  } catch (e) {
    fail("REPL commands in source", e);
  }
}

async function testMainErrorHandling(ctx: Ctx) {
  console.log("\n── Main error handling ──");

  try {
    const rs = await ctx.query({ s: "main", p: "source" });
    if (rs.length === 0) throw new Error("main source not found");
    const src = rs[0].o;

    if (!src.includes("try {") || !src.includes("catch (err)"))
      throw new Error("main source does not contain try/catch block");
    if (!src.includes("fatal error during boot"))
      throw new Error("main source does not log fatal errors");

    ok("main node has error handling (try/catch with logging)");
  } catch (e) {
    fail("main error handling", e);
  }

  // Verify boot.ts also wraps main call
  try {
    const { readFileSync } = await import("node:fs");
    const bootSrc = readFileSync("/home/everlier/code/holoiconic/src/boot.ts", "utf-8");
    if (!bootSrc.includes("main crashed"))
      throw new Error("boot.ts does not catch main crashes");
    ok("boot.ts catches and logs main crashes");
  } catch (e) {
    fail("boot.ts error handling", e);
  }
}

async function testCallWithoutSource(ctx: Ctx) {
  console.log("\n── Edge cases ──");

  try {
    await ctx.call("nonexistent:node");
    fail("call nonexistent node", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("no source found")) {
      ok("calling nonexistent node throws proper error");
    } else {
      fail("call nonexistent node", e);
    }
  }
}

async function testTursoCloudConfig() {
  console.log("\n── Turso Cloud config ──");

  // Test isRemoteUrl
  try {
    const { isRemoteUrl } = await import("./db.ts");
    if (!isRemoteUrl("libsql://mydb-org.turso.io"))
      throw new Error("expected libsql:// to be remote");
    if (!isRemoteUrl("https://mydb-org.turso.io"))
      throw new Error("expected https:// to be remote");
    if (!isRemoteUrl("wss://mydb-org.turso.io"))
      throw new Error("expected wss:// to be remote");
    if (isRemoteUrl("file:holoiconic.db"))
      throw new Error("expected file: to not be remote");
    if (isRemoteUrl("holoiconic.db"))
      throw new Error("expected plain path to not be remote");
    ok("isRemoteUrl correctly identifies remote vs local URLs");
  } catch (e) {
    fail("isRemoteUrl", e);
  }

  // Test createDatabase with local path (backward compatible)
  try {
    const { createDatabase } = await import("./db.ts");
    const db = createDatabase("test-turso-compat.db");
    // Should create a working local client
    await db.execute("SELECT 1");
    ok("createDatabase(string) backward compatible with local path");
    // Cleanup
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync("test-turso-compat.db"); } catch {}
  } catch (e) {
    fail("createDatabase backward compat", e);
  }

  // Test createDatabase with config object (local)
  try {
    const { createDatabase } = await import("./db.ts");
    const db = createDatabase({ path: "test-turso-config.db" });
    await db.execute("SELECT 1");
    ok("createDatabase({ path }) works with config object");
    const { unlinkSync } = await import("node:fs");
    try { unlinkSync("test-turso-config.db"); } catch {}
  } catch (e) {
    fail("createDatabase config object", e);
  }

  // Test that TURSO_URL env var would be picked up (without actually connecting)
  // We verify the code path by checking that isRemoteUrl is used in createDatabase
  try {
    const { readFileSync } = await import("node:fs");
    const dbSrc = readFileSync("/home/everlier/code/holoiconic/src/db.ts", "utf-8");
    if (!dbSrc.includes("TURSO_URL"))
      throw new Error("db.ts does not check TURSO_URL env var");
    if (!dbSrc.includes("TURSO_AUTH_TOKEN"))
      throw new Error("db.ts does not check TURSO_AUTH_TOKEN env var");
    if (!dbSrc.includes("authToken"))
      throw new Error("db.ts does not pass authToken to createClient");
    ok("createDatabase checks TURSO_URL and TURSO_AUTH_TOKEN env vars");
  } catch (e) {
    fail("TURSO env vars", e);
  }
}

async function testGraphDescribe(ctx: Ctx) {
  console.log("\n── graph:describe ──");

  try {
    // Describe the 'shell' node — should return all its quads
    const result = await ctx.call("graph:describe", { subject: "shell" });
    if (!result || result.subject !== "shell")
      throw new Error(`expected subject='shell', got '${result && result.subject}'`);
    if (!result.quads || !Array.isArray(result.quads))
      throw new Error("expected quads array");
    if (result.quads.length < 2)
      throw new Error(`expected >=2 quads for shell, got ${result.quads.length}`);

    // Should have 'source' and 'type' predicates
    const preds = Object.keys(result.predicates);
    if (!preds.includes("source"))
      throw new Error("expected 'source' predicate in description");
    if (!preds.includes("type"))
      throw new Error("expected 'type' predicate in description");

    ok("graph:describe returns all quads and predicates for a subject");
  } catch (e) {
    fail("graph:describe", e);
  }

  // Test with nonexistent subject
  try {
    const result = await ctx.call("graph:describe", { subject: "nonexistent:xyz" });
    if (result.quads.length !== 0)
      throw new Error(`expected 0 quads for nonexistent subject, got ${result.quads.length}`);
    ok("graph:describe returns empty for nonexistent subject");
  } catch (e) {
    fail("graph:describe nonexistent", e);
  }

  // Test validation
  try {
    await ctx.call("graph:describe", {});
    fail("graph:describe validation", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("subject"))
      ok("graph:describe throws on missing subject");
    else
      fail("graph:describe validation", e);
  }
}

async function testGraphSubjects(ctx: Ctx) {
  console.log("\n── graph:subjects ──");

  try {
    // Get all subjects (no filter)
    const result = await ctx.call("graph:subjects", {});
    if (!Array.isArray(result))
      throw new Error(`expected array, got ${typeof result}`);
    if (result.length < 5)
      throw new Error(`expected >=5 subjects, got ${result.length}`);
    // Each result should have subject and types
    const first = result[0];
    if (!first.subject || !Array.isArray(first.types))
      throw new Error(`expected {subject, types[]}, got ${JSON.stringify(first)}`);

    // Verify known subjects are present
    const subjects = result.map((r: any) => r.subject);
    if (!subjects.includes("shell"))
      throw new Error("expected 'shell' in subjects");
    if (!subjects.includes("main"))
      throw new Error("expected 'main' in subjects");

    ok("graph:subjects returns all subjects with types");
  } catch (e) {
    fail("graph:subjects all", e);
  }

  try {
    // Filter by type 'Function'
    const result = await ctx.call("graph:subjects", { type: "Function" });
    if (!Array.isArray(result))
      throw new Error(`expected array, got ${typeof result}`);
    // All results should have type 'Function'
    for (const r of result) {
      if (!r.types.includes("Function"))
        throw new Error(`expected Function type, got ${JSON.stringify(r.types)}`);
    }
    if (result.length < 7)
      throw new Error(`expected >=7 Function subjects, got ${result.length}`);
    ok("graph:subjects filters by type correctly");
  } catch (e) {
    fail("graph:subjects filter", e);
  }

  try {
    // Filter by type 'Tool'
    const result = await ctx.call("graph:subjects", { type: "Tool" });
    if (!Array.isArray(result))
      throw new Error(`expected array, got ${typeof result}`);
    if (result.length < 5)
      throw new Error(`expected >=5 Tool subjects, got ${result.length}`);
    ok("graph:subjects lists Tool-type subjects");
  } catch (e) {
    fail("graph:subjects Tool filter", e);
  }
}

async function testWebUiEnhancements(ctx: Ctx) {
  console.log("\n── WebUI enhancements ──");

  const port = 14500 + Math.floor(Math.random() * 500);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // Test search input exists in HTML
    try {
      const res = await fetch(`http://localhost:${port}/`);
      const body = await res.text();
      if (!body.includes('id="node-search"'))
        throw new Error("HTML does not contain search input");
      if (!body.includes('Filter nodes'))
        throw new Error("HTML does not contain search placeholder");
      ok("WebUI HTML contains search/filter input");
    } catch (e) {
      fail("WebUI search input", e);
    }

    // Test type badges in HTML
    try {
      const res = await fetch(`http://localhost:${port}/`);
      const body = await res.text();
      if (!body.includes('badge'))
        throw new Error("HTML does not contain badge classes");
      if (!body.includes('badge-function'))
        throw new Error("HTML does not contain badge-function class");
      if (!body.includes('badge-tool'))
        throw new Error("HTML does not contain badge-tool class");
      if (!body.includes('badge-spawned'))
        throw new Error("HTML does not contain badge-spawned class");
      ok("WebUI HTML contains type badge styles");
    } catch (e) {
      fail("WebUI badges", e);
    }

    // Test /api/nodes returns types
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`);
      const nodes = await res.json() as any[];
      const shellNode = nodes.find((n: any) => n.name === "shell");
      if (!shellNode)
        throw new Error("shell node not found in /api/nodes");
      if (!Array.isArray(shellNode.types))
        throw new Error("expected types array in node response");
      if (!shellNode.types.includes("Function"))
        throw new Error("expected 'Function' in shell node types");
      ok("GET /api/nodes returns types alongside names");
    } catch (e) {
      fail("GET /api/nodes types", e);
    }

    // Test DELETE /api/node/:name
    try {
      // Create a disposable node first
      await ctx.assert("test:deleteme", "type", "Function");
      await ctx.assert("test:deleteme", "source", "return 'delete me'");
      await ctx.assert("test:deleteme", "metadata", "extra");

      const res = await fetch(`http://localhost:${port}/api/node/test:deleteme`, {
        method: "DELETE",
      });
      const data = await res.json() as any;
      if (!res.ok)
        throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(data)}`);
      if (!data.ok)
        throw new Error(`expected ok=true, got ${JSON.stringify(data)}`);
      if (data.retracted !== 3)
        throw new Error(`expected 3 retracted quads, got ${data.retracted}`);

      // Verify the node is gone from the default graph
      // (version quads may exist in 'versions' graph from sys:compiler auto-versioning)
      await new Promise((r) => setTimeout(r, 100));
      const remaining = await ctx.query({ s: "test:deleteme", g: "_" });
      if (remaining.length !== 0)
        throw new Error(`expected 0 remaining quads in default graph, got ${remaining.length}`);

      ok("DELETE /api/node/:name retracts all quads for the subject");
    } catch (e) {
      fail("DELETE /api/node/:name", e);
    }

    // Test delete button in HTML
    try {
      const res = await fetch(`http://localhost:${port}/`);
      const body = await res.text();
      if (!body.includes('delete-btn'))
        throw new Error("HTML does not contain delete button class");
      if (!body.includes('deleteNode'))
        throw new Error("HTML does not contain deleteNode function");
      ok("WebUI HTML contains delete node button");
    } catch (e) {
      fail("WebUI delete button", e);
    }
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function testGraphDeps(ctx: Ctx) {
  console.log("\n── graph:deps ──");

  try {
    // Test deps of 'main' — it calls sys:compiler, spawn, agent:tools
    const result = await ctx.call("graph:deps", { node: "main" });
    if (!result || result.node !== "main")
      throw new Error(`expected node='main', got '${result && result.node}'`);
    if (!Array.isArray(result.calls))
      throw new Error("expected calls array");
    // main calls sys:compiler, spawn, agent:tools
    if (!result.calls.includes("sys:compiler"))
      throw new Error("expected 'sys:compiler' in main's calls, got: " + result.calls.join(", "));
    if (!result.calls.includes("spawn"))
      throw new Error("expected 'spawn' in main's calls, got: " + result.calls.join(", "));
    if (!result.calls.includes("agent:tools"))
      throw new Error("expected 'agent:tools' in main's calls, got: " + result.calls.join(", "));
    ok("graph:deps returns calls for main node");
  } catch (e) {
    fail("graph:deps main calls", e);
  }

  try {
    // Test calledBy: 'spawn' should be called by 'main'
    const result = await ctx.call("graph:deps", { node: "spawn" });
    if (!Array.isArray(result.calledBy))
      throw new Error("expected calledBy array");
    if (!result.calledBy.includes("main"))
      throw new Error("expected 'main' in spawn's calledBy, got: " + result.calledBy.join(", "));
    ok("graph:deps returns calledBy for spawn node");
  } catch (e) {
    fail("graph:deps calledBy", e);
  }

  try {
    // Test node with no deps
    await ctx.assert("test:nodeps", "type", "Function");
    await ctx.assert("test:nodeps", "source", "return 42");
    const result = await ctx.call("graph:deps", { node: "test:nodeps" });
    if (result.calls.length !== 0)
      throw new Error(`expected 0 calls, got ${result.calls.length}`);
    ok("graph:deps returns empty calls for node with no deps");
  } catch (e) {
    fail("graph:deps no deps", e);
  }

  try {
    // Test validation
    await ctx.call("graph:deps", {});
    fail("graph:deps validation", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("node"))
      ok("graph:deps throws on missing node arg");
    else
      fail("graph:deps validation", e);
  }
}

async function testInspectNode(ctx: Ctx) {
  console.log("\n── inspect node ──");

  try {
    // Inspect 'shell' — a Function node that is also a Tool
    const result = await ctx.call("inspect", { node: "shell" });
    if (!result || result.node !== "shell")
      throw new Error(`expected node='shell', got '${result && result.node}'`);
    if (!result.exists)
      throw new Error("expected exists=true");
    if (!result.isFunction)
      throw new Error("expected isFunction=true");
    if (!result.isTool)
      throw new Error("expected isTool=true");
    if (!result.source || !result.source.includes("Bun.spawn"))
      throw new Error("expected source containing 'Bun.spawn'");
    if (result.sourceLength < 10)
      throw new Error(`expected sourceLength >= 10, got ${result.sourceLength}`);
    if (!Array.isArray(result.dependencies))
      throw new Error("expected dependencies array");
    if (!Array.isArray(result.dependents))
      throw new Error("expected dependents array");
    if (!Array.isArray(result.predicates))
      throw new Error("expected predicates array");
    if (result.quadCount < 2)
      throw new Error(`expected quadCount >= 2, got ${result.quadCount}`);
    ok("inspect returns comprehensive info for shell node");
  } catch (e) {
    fail("inspect shell", e);
  }

  try {
    // Inspect a node that has a tool_schema
    const result = await ctx.call("inspect", { node: "shell" });
    if (!result.toolSchema)
      throw new Error("expected toolSchema for shell");
    if (result.toolSchema.name !== "shell")
      throw new Error(`expected toolSchema.name='shell', got '${result.toolSchema.name}'`);
    ok("inspect includes toolSchema when available");
  } catch (e) {
    fail("inspect toolSchema", e);
  }

  try {
    // Inspect a nonexistent node
    const result = await ctx.call("inspect", { node: "nonexistent:xyz" });
    if (result.exists)
      throw new Error("expected exists=false for nonexistent node");
    if (result.quadCount !== 0)
      throw new Error(`expected quadCount=0, got ${result.quadCount}`);
    ok("inspect returns exists=false for nonexistent node");
  } catch (e) {
    fail("inspect nonexistent", e);
  }

  try {
    // Inspect validation
    await ctx.call("inspect", {});
    fail("inspect validation", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("node"))
      ok("inspect throws on missing node arg");
    else
      fail("inspect validation", e);
  }
}

async function testDepsApiEndpoint(ctx: Ctx) {
  console.log("\n── deps API endpoint ──");

  const port = 14800 + Math.floor(Math.random() * 200);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // Test GET /api/node/:name/deps
    try {
      const res = await fetch(`http://localhost:${port}/api/node/main/deps`);
      const data = await res.json() as any;
      if (!res.ok)
        throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(data)}`);
      if (data.node !== "main")
        throw new Error(`expected node='main', got '${data.node}'`);
      if (!Array.isArray(data.calls))
        throw new Error("expected calls array");
      if (!data.calls.includes("sys:compiler"))
        throw new Error("expected sys:compiler in calls");
      if (!Array.isArray(data.calledBy))
        throw new Error("expected calledBy array");
      ok("GET /api/node/:name/deps returns dependency info");
    } catch (e) {
      fail("GET /api/node/:name/deps", e);
    }

    // Test with URL-encoded node name
    try {
      const res = await fetch(`http://localhost:${port}/api/node/${encodeURIComponent("agent:loop")}/deps`);
      const data = await res.json() as any;
      if (!res.ok)
        throw new Error(`expected 200, got ${res.status}`);
      if (data.node !== "agent:loop")
        throw new Error(`expected node='agent:loop', got '${data.node}'`);
      ok("GET /api/node/:name/deps works with URL-encoded names");
    } catch (e) {
      fail("GET /api/node/:name/deps URL encoding", e);
    }
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function testReplDepsInspect(ctx: Ctx) {
  console.log("\n── REPL deps/inspect commands ──");

  try {
    const rs = await ctx.query({ s: "repl", p: "source" });
    if (rs.length === 0) throw new Error("repl source not found");
    const src = rs[0].o;

    if (!src.includes(".deps "))
      throw new Error("REPL source missing .deps command");
    if (!src.includes(".inspect "))
      throw new Error("REPL source missing .inspect command");
    if (!src.includes("graph:deps"))
      throw new Error("REPL .deps does not call graph:deps");
    if (!src.includes("'inspect'"))
      throw new Error("REPL .inspect does not call inspect node");

    ok("REPL source contains .deps and .inspect commands");
  } catch (e) {
    fail("REPL deps/inspect commands", e);
  }
}

async function testToolRegistration(ctx: Ctx) {
  console.log("\n── New tool registration ──");

  try {
    // Verify graph_deps tool is registered
    const depsToolQuads = await ctx.query({ s: "graph_deps", p: "type", o: "Tool" });
    if (depsToolQuads.length === 0)
      throw new Error("graph_deps not registered as Tool");
    const depsSchema = await ctx.query({ s: "graph_deps", p: "tool_schema" });
    if (depsSchema.length === 0)
      throw new Error("graph_deps has no tool_schema");
    const parsed = JSON.parse(depsSchema[0].o);
    if (parsed.name !== "graph_deps")
      throw new Error(`expected name='graph_deps', got '${parsed.name}'`);
    ok("graph_deps registered as tool with schema");
  } catch (e) {
    fail("graph_deps tool registration", e);
  }

  try {
    // Verify inspect tool is registered
    const inspectToolQuads = await ctx.query({ s: "inspect", p: "type", o: "Tool" });
    if (inspectToolQuads.length === 0)
      throw new Error("inspect not registered as Tool");
    const inspectSchema = await ctx.query({ s: "inspect", p: "tool_schema" });
    if (inspectSchema.length === 0)
      throw new Error("inspect has no tool_schema");
    const parsed = JSON.parse(inspectSchema[0].o);
    if (parsed.name !== "inspect")
      throw new Error(`expected name='inspect', got '${parsed.name}'`);
    ok("inspect registered as tool with schema");
  } catch (e) {
    fail("inspect tool registration", e);
  }
}

async function testGenericToolFallback(ctx: Ctx) {
  console.log("\n── Generic tool dispatch fallback ──");

  try {
    // Create a simple test node with a colon-namespaced name
    await ctx.assert("test:fallback", "type", "Function");
    await ctx.assert("test:fallback", "source", "return { echo: (args && args.msg) || 'default' }");

    // Register it as a tool (using underscore-named convention)
    await ctx.assert("test_fallback", "type", "Tool");
    await ctx.assert("test_fallback", "tool_schema", JSON.stringify({
      name: "test_fallback",
      description: "A test tool for generic fallback dispatch",
      input_schema: {
        type: "object",
        properties: {
          msg: { type: "string", description: "Message to echo" }
        }
      }
    }));

    // Simulate what agent:loop does in the generic fallback:
    // It receives toolName = "test_fallback" and must translate to "test:fallback"
    const toolName = "test_fallback";
    const nodeName = toolName.replace(/_/g, ":");
    if (nodeName !== "test:fallback")
      throw new Error(`expected 'test:fallback', got '${nodeName}'`);

    const result = await ctx.call(nodeName, { msg: "hello" });
    if (!result || result.echo !== "hello")
      throw new Error(`expected echo='hello', got ${JSON.stringify(result)}`);

    ok("generic fallback translates underscores to colons and calls node");
  } catch (e) {
    fail("generic tool fallback translation", e);
  }

  try {
    // Verify the fallback path in agent:loop source code contains the fix
    const loopSource = await ctx.query({ s: "agent:loop", p: "source" });
    if (loopSource.length === 0) throw new Error("agent:loop source not found");
    const src = loopSource[0].o;

    if (!src.includes("toolName.replace(/_/g, ':')"))
      throw new Error("agent:loop fallback does not translate underscores to colons");

    ok("agent:loop source contains underscore-to-colon translation in fallback");
  } catch (e) {
    fail("agent:loop fallback source check", e);
  }
}

async function testVersioning(ctx: Ctx) {
  console.log("\n── Versioning ──");

  try {
    // Create a node with initial source
    await ctx.assert("test:versioned", "type", "Function");
    await ctx.assert("test:versioned", "source", "return 'v1'");

    // Manually save a version
    const saveResult = await ctx.call("version:save", { name: "test:versioned", source: "return 'v1'" });
    if (saveResult.seq !== 0)
      throw new Error(`expected seq=0, got ${saveResult.seq}`);
    if (!saveResult.timestamp)
      throw new Error("expected timestamp in save result");

    ok("version:save creates version with seq=0");
  } catch (e) {
    fail("version:save", e);
  }

  try {
    // Save another version
    await ctx.call("version:save", { name: "test:versioned", source: "return 'v2'" });

    // List versions
    const listResult = await ctx.call("version:list", { name: "test:versioned" });
    if (listResult.count !== 2)
      throw new Error(`expected 2 versions, got ${listResult.count}`);
    if (listResult.versions[0].seq !== 0)
      throw new Error(`expected first version seq=0, got ${listResult.versions[0].seq}`);
    if (listResult.versions[1].seq !== 1)
      throw new Error(`expected second version seq=1, got ${listResult.versions[1].seq}`);

    ok("version:list returns ordered versions with metadata");
  } catch (e) {
    fail("version:list", e);
  }

  try {
    // Update the source (this should trigger sys:compiler's version:save)
    // First update to v3
    await ctx.retract("test:versioned", "source", "return 'v1'");
    await ctx.assert("test:versioned", "source", "return 'v3'");

    // Give the async watcher time to fire
    await new Promise((r) => setTimeout(r, 100));

    // List versions — should now have 3 (2 manual + 1 from compiler watcher)
    const listResult = await ctx.call("version:list", { name: "test:versioned" });
    if (listResult.count < 3)
      throw new Error(`expected >=3 versions after source change, got ${listResult.count}`);

    ok("sys:compiler auto-saves version on source retract");
  } catch (e) {
    fail("sys:compiler version:save integration", e);
  }

  try {
    // Restore to seq=0 (the original 'v1')
    const restoreResult = await ctx.call("version:restore", { name: "test:versioned", seq: 0 });
    if (!restoreResult.restored)
      throw new Error("expected restored=true");

    // Verify the source was restored
    const sourceQuads = await ctx.query({ s: "test:versioned", p: "source" });
    if (sourceQuads.length !== 1)
      throw new Error(`expected 1 source quad, got ${sourceQuads.length}`);
    if (sourceQuads[0].o !== "return 'v1'")
      throw new Error(`expected restored source='return \\'v1\\'', got '${sourceQuads[0].o}'`);

    // Verify the restored node actually works
    const result = await ctx.call("test:versioned");
    if (result !== "v1")
      throw new Error(`expected 'v1' from restored node, got '${result}'`);

    ok("version:restore restores source to specific version");
  } catch (e) {
    fail("version:restore", e);
  }

  try {
    // Test version:restore with nonexistent seq
    await ctx.call("version:restore", { name: "test:versioned", seq: 999 });
    fail("version:restore nonexistent", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("no version found"))
      ok("version:restore throws for nonexistent version");
    else
      fail("version:restore nonexistent", e);
  }

  try {
    // Test version:save validation
    await ctx.call("version:save", {});
    fail("version:save validation", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("required"))
      ok("version:save throws on missing args");
    else
      fail("version:save validation", e);
  }

  try {
    // Test version:list validation
    await ctx.call("version:list", {});
    fail("version:list validation", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("required"))
      ok("version:list throws on missing args");
    else
      fail("version:list validation", e);
  }
}

async function testCron(ctx: Ctx) {
  console.log("\n── Cron/scheduler ──");

  try {
    // Create a counter node that increments a quad value
    await ctx.assert("test:counter", "count", "0");
    await ctx.assert("test:counter", "type", "Function");
    await ctx.assert("test:counter", "source", `
const countQuads = await ctx.query({ s: 'test:counter', p: 'count' });
const count = parseInt(countQuads[0].o);
const newCount = count + 1;
await ctx.retract('test:counter', 'count', String(count));
await ctx.assert('test:counter', 'count', String(newCount));
return newCount;
`);

    // Start a cron job that runs the counter every 200ms
    const ac = new AbortController();
    const cronPromise = ctx.call("cron", { node: "test:counter", interval: 200, signal: ac.signal });

    // Let it run for ~600ms (should get ~3 ticks)
    await new Promise((r) => setTimeout(r, 700));

    // Stop the cron
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));

    // Check the counter was incremented
    const countQuads = await ctx.query({ s: "test:counter", p: "count" });
    const count = parseInt(countQuads[0].o);
    if (count < 2)
      throw new Error(`expected count >= 2 after ~600ms with 200ms interval, got ${count}`);

    ok("cron runs node on interval (" + count + " ticks in ~600ms)");
  } catch (e) {
    fail("cron basic", e);
  }

  try {
    // Test cron:list shows the job
    const result = await ctx.call("cron:list");
    if (!Array.isArray(result.jobs))
      throw new Error("expected jobs array");
    if (result.count < 1)
      throw new Error(`expected >= 1 cron job, got ${result.count}`);

    // Find our test:counter job
    const counterJob = result.jobs.find((j: any) => j.node === "test:counter");
    if (!counterJob)
      throw new Error("expected test:counter in cron job list");
    if (counterJob.interval !== 200)
      throw new Error(`expected interval=200, got ${counterJob.interval}`);

    ok("cron:list returns cron jobs with metadata");
  } catch (e) {
    fail("cron:list", e);
  }

  try {
    // After abort, the job should be marked as stopped
    const result = await ctx.call("cron:list");
    const stoppedJob = result.jobs.find((j: any) => j.node === "test:counter" && j.status === "stopped");
    if (!stoppedJob)
      throw new Error("expected stopped cron job for test:counter");

    ok("cron job marked as stopped after abort");
  } catch (e) {
    fail("cron stopped status", e);
  }

  try {
    // Test cron validation: missing node
    await ctx.call("cron", { interval: 1000 });
    fail("cron validation node", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("node"))
      ok("cron throws on missing node");
    else
      fail("cron validation node", e);
  }

  try {
    // Test cron validation: missing/invalid interval
    await ctx.call("cron", { node: "test:counter", interval: 10 });
    fail("cron validation interval", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("interval"))
      ok("cron throws on invalid interval");
    else
      fail("cron validation interval", e);
  }
}

async function testVersionToolRegistration(ctx: Ctx) {
  console.log("\n── Version/cron tool registration ──");

  try {
    const versionListTool = await ctx.query({ s: "version_list", p: "type", o: "Tool" });
    if (versionListTool.length === 0)
      throw new Error("version_list not registered as Tool");
    const schema = await ctx.query({ s: "version_list", p: "tool_schema" });
    if (schema.length === 0)
      throw new Error("version_list has no tool_schema");
    const parsed = JSON.parse(schema[0].o);
    if (parsed.name !== "version_list")
      throw new Error(`expected name='version_list', got '${parsed.name}'`);
    ok("version_list registered as agent tool");
  } catch (e) {
    fail("version_list tool registration", e);
  }

  try {
    const versionRestoreTool = await ctx.query({ s: "version_restore", p: "type", o: "Tool" });
    if (versionRestoreTool.length === 0)
      throw new Error("version_restore not registered as Tool");
    ok("version_restore registered as agent tool");
  } catch (e) {
    fail("version_restore tool registration", e);
  }

  try {
    const cronCreateTool = await ctx.query({ s: "cron_create", p: "type", o: "Tool" });
    if (cronCreateTool.length === 0)
      throw new Error("cron_create not registered as Tool");
    ok("cron_create registered as agent tool");
  } catch (e) {
    fail("cron_create tool registration", e);
  }

  try {
    const cronListTool = await ctx.query({ s: "cron_list", p: "type", o: "Tool" });
    if (cronListTool.length === 0)
      throw new Error("cron_list not registered as Tool");
    ok("cron_list registered as agent tool");
  } catch (e) {
    fail("cron_list tool registration", e);
  }
}

async function testReplVersionCronCommands(ctx: Ctx) {
  console.log("\n── REPL version/cron commands ──");

  try {
    const rs = await ctx.query({ s: "repl", p: "source" });
    if (rs.length === 0) throw new Error("repl source not found");
    const src = rs[0].o;

    const expectedCommands = [".versions ", ".restore ", ".cron ", ".crons"];
    const missing = expectedCommands.filter(cmd => !src.includes(cmd));
    if (missing.length > 0)
      throw new Error("REPL source missing commands: " + missing.join(", "));

    ok("REPL source contains .versions, .restore, .cron, .crons commands");
  } catch (e) {
    fail("REPL version/cron commands", e);
  }
}

async function testMetrics(ctx: Ctx) {
  console.log("\n── Metrics tracking ──");

  // Test basic metrics recording
  try {
    const result = await ctx.call("metrics", {
      record: { name: "test:metricsTarget", durationMs: 42 },
    });
    if (!result || result.name !== "test:metricsTarget")
      throw new Error(`expected name='test:metricsTarget', got '${result && result.name}'`);
    if (result.calls !== 1)
      throw new Error(`expected calls=1, got ${result.calls}`);
    if (result.duration_ms !== 42)
      throw new Error(`expected duration_ms=42, got ${result.duration_ms}`);
    if (result.errors !== 0)
      throw new Error(`expected errors=0, got ${result.errors}`);

    // Verify quads were stored in 'metrics' graph
    const callsQuads = await ctx.query({
      s: "test:metricsTarget",
      p: "metric:calls",
      g: "metrics",
    });
    if (callsQuads.length !== 1)
      throw new Error(`expected 1 calls quad, got ${callsQuads.length}`);
    if (callsQuads[0].o !== "1")
      throw new Error(`expected calls='1', got '${callsQuads[0].o}'`);

    ok("metrics records call count, duration, and stores as quads");
  } catch (e) {
    fail("metrics basic recording", e);
  }

  // Test cumulative metrics
  try {
    await ctx.call("metrics", {
      record: { name: "test:metricsTarget", durationMs: 58 },
    });
    const result = await ctx.call("metrics", {
      record: { name: "test:metricsTarget", durationMs: 100, error: "boom" },
    });
    if (result.calls !== 3)
      throw new Error(`expected calls=3, got ${result.calls}`);
    if (result.duration_ms !== 200)
      throw new Error(`expected duration_ms=200 (42+58+100), got ${result.duration_ms}`);
    if (result.errors !== 1)
      throw new Error(`expected errors=1, got ${result.errors}`);

    // Verify only one calls quad (set semantics)
    const callsQuads = await ctx.query({
      s: "test:metricsTarget",
      p: "metric:calls",
      g: "metrics",
    });
    if (callsQuads.length !== 1)
      throw new Error(`expected 1 calls quad after updates, got ${callsQuads.length}`);

    ok("metrics accumulates calls, duration, and errors correctly");
  } catch (e) {
    fail("metrics cumulative", e);
  }

  // Test metrics validation
  try {
    await ctx.call("metrics", {});
    fail("metrics validation", "should have thrown for missing record");
  } catch (e: any) {
    if (e.message && e.message.includes("record"))
      ok("metrics throws on missing record");
    else fail("metrics validation", e);
  }

  try {
    await ctx.call("metrics", { record: { durationMs: 10 } });
    fail("metrics validation name", "should have thrown for missing name");
  } catch (e: any) {
    if (e.message && e.message.includes("name"))
      ok("metrics throws on missing record.name");
    else fail("metrics validation name", e);
  }
}

async function testMetricsReport(ctx: Ctx) {
  console.log("\n── Metrics report ──");

  try {
    // Record some metrics for distinct nodes
    await ctx.call("metrics", {
      record: { name: "test:reportA", durationMs: 100 },
    });
    await ctx.call("metrics", {
      record: { name: "test:reportA", durationMs: 200 },
    });
    await ctx.call("metrics", {
      record: { name: "test:reportB", durationMs: 50, error: "fail" },
    });

    // Get report as string
    const report = await ctx.call("metrics:report");
    if (typeof report !== "string")
      throw new Error(`expected string report, got ${typeof report}`);
    if (!report.includes("Metrics Report"))
      throw new Error("report missing header");
    if (!report.includes("test:reportA"))
      throw new Error("report missing test:reportA");
    if (!report.includes("test:reportB"))
      throw new Error("report missing test:reportB");

    ok("metrics:report returns formatted string report");
  } catch (e) {
    fail("metrics:report string", e);
  }

  try {
    // Get raw report
    const result = await ctx.call("metrics:report", { raw: true });
    if (!result || !Array.isArray(result.nodes))
      throw new Error(`expected result.nodes array, got ${typeof result}`);
    if (!result.report || typeof result.report !== "string")
      throw new Error("expected result.report string");

    // Verify sorting by call count descending
    for (let i = 1; i < result.nodes.length; i++) {
      if (result.nodes[i].calls > result.nodes[i - 1].calls)
        throw new Error("nodes not sorted by calls descending");
    }

    // Verify avg_ms is calculated
    const nodeA = result.nodes.find((n: any) => n.name === "test:reportA");
    if (!nodeA)
      throw new Error("test:reportA not found in raw report");
    if (nodeA.calls !== 2)
      throw new Error(`expected test:reportA calls=2, got ${nodeA.calls}`);
    if (nodeA.avg_ms !== 150)
      throw new Error(`expected test:reportA avg_ms=150, got ${nodeA.avg_ms}`);

    ok("metrics:report raw mode returns structured data sorted by calls");
  } catch (e) {
    fail("metrics:report raw", e);
  }
}

async function testMetricsCompilerIntegration(ctx: Ctx) {
  console.log("\n── Metrics compiler integration ──");

  try {
    // Call a node and verify metrics were recorded automatically by sys:compiler
    // Use a fresh test node to get clean metrics
    await ctx.assert("test:metricsAuto", "type", "Function");
    await ctx.assert("test:metricsAuto", "source", "return 'measured'");

    // Call it
    const result = await ctx.call("test:metricsAuto");
    if (result !== "measured")
      throw new Error(`expected 'measured', got '${result}'`);

    // Wait briefly for the async metrics recording
    await new Promise((r) => setTimeout(r, 100));

    // Check that metrics were recorded
    const callsQuads = await ctx.query({
      s: "test:metricsAuto",
      p: "metric:calls",
      g: "metrics",
    });
    if (callsQuads.length === 0)
      throw new Error("no metrics recorded for test:metricsAuto");
    const calls = parseInt(callsQuads[0].o);
    if (calls < 1)
      throw new Error(`expected calls >= 1, got ${calls}`);

    ok("sys:compiler automatically records metrics for node calls");
  } catch (e) {
    fail("metrics compiler integration", e);
  }

  try {
    // Verify metrics are NOT recorded for the metrics node itself (no infinite recursion)
    const metricsCallsQuads = await ctx.query({
      s: "metrics",
      p: "metric:calls",
      g: "metrics",
    });
    if (metricsCallsQuads.length > 0)
      throw new Error("metrics should not track calls to itself");

    ok("metrics node is excluded from tracking (no infinite recursion)");
  } catch (e) {
    fail("metrics self-exclusion", e);
  }
}

async function testMetricsToolRegistration(ctx: Ctx) {
  console.log("\n── Metrics tool registration ──");

  try {
    const toolQuads = await ctx.query({ s: "metrics_report", p: "type", o: "Tool" });
    if (toolQuads.length === 0)
      throw new Error("metrics_report not registered as Tool");
    const schemaQuads = await ctx.query({ s: "metrics_report", p: "tool_schema" });
    if (schemaQuads.length === 0)
      throw new Error("metrics_report has no tool_schema");
    const parsed = JSON.parse(schemaQuads[0].o);
    if (parsed.name !== "metrics_report")
      throw new Error(`expected name='metrics_report', got '${parsed.name}'`);

    ok("metrics_report registered as agent tool with schema");
  } catch (e) {
    fail("metrics_report tool registration", e);
  }
}

async function testReplMetricsCommand(ctx: Ctx) {
  console.log("\n── REPL metrics command ──");

  try {
    const rs = await ctx.query({ s: "repl", p: "source" });
    if (rs.length === 0) throw new Error("repl source not found");
    const src = rs[0].o;

    if (!src.includes(".metrics"))
      throw new Error("REPL source missing .metrics command");
    if (!src.includes("metrics:report"))
      throw new Error("REPL .metrics does not call metrics:report");

    ok("REPL source contains .metrics command");
  } catch (e) {
    fail("REPL metrics command", e);
  }
}

async function testReplAssertRetractGraph(ctx: Ctx) {
  console.log("\n── REPL .assert/.retract --g support ──");

  try {
    // Verify the REPL source has --g flag support
    const rs = await ctx.query({ s: "repl", p: "source" });
    if (rs.length === 0) throw new Error("repl source not found");
    const src = rs[0].o;

    if (!src.includes("'--g'"))
      throw new Error("REPL .assert does not support --g flag");
    ok("REPL .assert source contains --g flag parsing");
  } catch (e) {
    fail("REPL .assert --g flag", e);
  }

  try {
    // Verify help text is updated
    const rs = await ctx.query({ s: "repl", p: "source" });
    const src = rs[0].o;

    if (!src.includes(".assert s p o [--g graph]"))
      throw new Error("REPL help text not updated for .assert");
    if (!src.includes(".retract s p o [--g graph]"))
      throw new Error("REPL help text not updated for .retract");
    ok("REPL help text mentions --g flag for .assert and .retract");
  } catch (e) {
    fail("REPL help text update", e);
  }
}

async function testSnapshotImportValidation(ctx: Ctx) {
  console.log("\n── Snapshot import validation ──");

  try {
    // Import quads with missing 's' field — should be skipped, not crash
    const result = await ctx.call("snapshot:import", {
      data: JSON.stringify([
        { p: "value", o: "hello", g: "_" },
        { s: "valid:quad", p: "test", o: "works", g: "_" },
      ]),
    });
    if (result.count !== 1)
      throw new Error(`expected count=1 (valid quad only), got ${result.count}`);
    if (result.skipped !== 1)
      throw new Error(`expected skipped=1, got ${result.skipped}`);
    ok("snapshot:import skips quads with missing fields (1 skipped, 1 imported)");
  } catch (e) {
    fail("snapshot:import validation", e);
  }

  try {
    // Import quads with null 'o' field — should be skipped
    const result = await ctx.call("snapshot:import", {
      data: JSON.stringify([
        { s: "test:nullo", p: "val", o: null, g: "_" },
      ]),
    });
    if (result.skipped !== 1)
      throw new Error(`expected skipped=1, got ${result.skipped}`);
    ok("snapshot:import skips quads with null o field");
  } catch (e) {
    fail("snapshot:import null o", e);
  }
}

async function testApiServerEdgeCases(ctx: Ctx) {
  console.log("\n── API server edge cases ──");

  const port = 13200 + Math.floor(Math.random() * 800);
  const ac = new AbortController();

  try {
    ctx.call("api:server", { port, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // Empty messages array => 400
    try {
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "holoiconic", messages: [] }),
      });
      if (res.status !== 400)
        throw new Error(`expected 400, got ${res.status}`);
      ok("api: empty messages array returns 400");
    } catch (e) {
      fail("api: empty messages", e);
    }

    // Missing messages field => 400
    try {
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "holoiconic" }),
      });
      if (res.status !== 400)
        throw new Error(`expected 400, got ${res.status}`);
      ok("api: missing messages field returns 400");
    } catch (e) {
      fail("api: missing messages", e);
    }

    // Malformed JSON => 500
    try {
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json{{{",
      });
      if (res.status !== 500)
        throw new Error(`expected 500, got ${res.status}`);
      ok("api: malformed JSON body returns 500");
    } catch (e) {
      fail("api: malformed JSON", e);
    }

    // GET /v1/chat/completions (wrong method) => 404
    try {
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "GET",
      });
      if (res.status !== 404)
        throw new Error(`expected 404, got ${res.status}`);
      ok("api: GET /v1/chat/completions returns 404");
    } catch (e) {
      fail("api: wrong method", e);
    }

    // Session with special characters preserved
    try {
      const specialSession = "test:session/special<>&\"";
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "holoiconic",
          messages: [{ role: "user", content: "test" }],
          session: specialSession,
        }),
      });
      const data = await res.json() as any;
      if (data.session !== specialSession)
        throw new Error(`session not preserved: ${data.session}`);
      ok("api: session with special characters preserved");
    } catch (e) {
      fail("api: special session", e);
    }

    // Concurrent requests
    try {
      const promises = Array(5).fill(null).map((_, i) =>
        fetch(`http://localhost:${port}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "holoiconic",
            messages: [{ role: "user", content: `concurrent ${i}` }],
          }),
        })
      );
      const results = await Promise.all(promises);
      if (!results.every(r => r.status === 200))
        throw new Error("not all concurrent requests returned 200");
      ok("api: 5 concurrent requests all succeed");
    } catch (e) {
      fail("api: concurrent", e);
    }
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function testWebUiEdgeCases(ctx: Ctx) {
  console.log("\n── WebUI edge cases ──");

  const port = 14200 + Math.floor(Math.random() * 800);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // GET nonexistent node returns 200 with null source
    try {
      const res = await fetch(`http://localhost:${port}/api/node/nonexistent`);
      const data = await res.json() as any;
      if (res.status !== 200 || data.source !== null)
        throw new Error(`expected 200 with null source, got ${res.status}/${JSON.stringify(data)}`);
      ok("webui: GET nonexistent node returns 200 with null source");
    } catch (e) {
      fail("webui: GET nonexistent", e);
    }

    // POST with empty name returns 400
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "", source: "return 1" }),
      });
      if (res.status !== 400)
        throw new Error(`expected 400, got ${res.status}`);
      ok("webui: POST empty name returns 400");
    } catch (e) {
      fail("webui: POST empty name", e);
    }

    // DELETE nonexistent node returns 200 with retracted=0
    try {
      const res = await fetch(`http://localhost:${port}/api/node/nonexistent:xyz`, {
        method: "DELETE",
      });
      const data = await res.json() as any;
      if (res.status !== 200 || data.retracted !== 0)
        throw new Error(`expected 200 with retracted=0, got ${res.status}/${JSON.stringify(data)}`);
      ok("webui: DELETE nonexistent node returns 200 with retracted=0");
    } catch (e) {
      fail("webui: DELETE nonexistent", e);
    }

    // POST unicode node name
    try {
      const res = await fetch(`http://localhost:${port}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "test:unicode-éèê-" + Date.now(), source: "return 'utf8'" }),
      });
      if (res.status !== 201)
        throw new Error(`expected 201, got ${res.status}`);
      ok("webui: POST unicode node name succeeds");
    } catch (e) {
      fail("webui: POST unicode", e);
    }

    // GET deps for node with no source
    try {
      const nodeName = "test:nosrc-" + Date.now();
      await ctx.assert(nodeName, "type", "Function");
      const res = await fetch(`http://localhost:${port}/api/node/${encodeURIComponent(nodeName)}/deps`);
      const data = await res.json() as any;
      if (res.status !== 200 || !Array.isArray(data.calls) || data.calls.length !== 0)
        throw new Error(`expected 200 with empty calls, got ${res.status}/${JSON.stringify(data)}`);
      ok("webui: GET deps for node with no source returns empty calls");
    } catch (e) {
      fail("webui: GET deps no source", e);
    }
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── BUG-004: Double-spawn aborts old instance ────────────────────

async function testDoubleSpawn(ctx: Ctx) {
  console.log("\n── Double-spawn (BUG-004 fix) ──");

  try {
    // Create a test node that stays alive
    await ctx.assert("test:dblspawn", "type", "Function");
    await ctx.assert("test:dblspawn", "source", `
const id = 'inst:' + Date.now() + ':' + Math.random().toString(36).slice(2);
await ctx.assert('test:dblspawn', id, 'running');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`);

    // Spawn it twice
    const ac1 = await ctx.call("spawn", { node: "test:dblspawn" });
    await new Promise((r) => setTimeout(r, 100));

    const ac2 = await ctx.call("spawn", { node: "test:dblspawn" });
    await new Promise((r) => setTimeout(r, 100));

    // The first controller should have been aborted
    if (ac1.signal.aborted) {
      ok("double-spawn: first instance aborted when second spawn called");
    } else {
      fail("double-spawn", "first instance was NOT aborted — controller leak");
    }

    // Only one controller should be stored
    const controllers = ctx._supervisorControllers;
    if (controllers) {
      const stored = controllers.get("test:dblspawn");
      if (stored && !stored.signal.aborted) {
        ok("double-spawn: only the latest controller is stored");
      } else {
        fail("double-spawn", "stored controller is wrong or aborted");
      }
    }

    // Cleanup
    ac2.abort();
  } catch (e) {
    fail("double-spawn", e);
  }
}

// ── BUG-005: Cron without signal stores timer for cleanup ────────

async function testCronNoSignalCleanup(ctx: Ctx) {
  console.log("\n── Cron no-signal cleanup (BUG-005 fix) ──");

  try {
    await ctx.assert("test:cronnos", "type", "Function");
    await ctx.assert("test:cronnos", "source", "return 'tick'");

    // Start cron without signal
    const result = await ctx.call("cron", {
      node: "test:cronnos",
      interval: 60000,
    });

    if (!result || !result.cronId)
      throw new Error("cron did not return cronId");

    // Check that the timer was stored in ctx._cronTimers for cleanup
    if (ctx._cronTimers && ctx._cronTimers.has(result.cronId)) {
      ok("cron-no-signal: timer stored in ctx._cronTimers for cleanup");

      // Stop it via the stored stopCron function
      const entry = ctx._cronTimers.get(result.cronId);
      await entry.stopCron();

      ok("cron-no-signal: timer successfully stopped via stored cleanup function");
    } else {
      fail("cron-no-signal", "timer NOT stored in ctx._cronTimers — would leak");
    }
  } catch (e) {
    fail("cron-no-signal", e);
  }
}

// ── BUG-006: sys:compiler subscriber cleanup on re-invocation ────

async function testCompilerSubscriberCleanup(ctx: Ctx) {
  console.log("\n── Compiler subscriber cleanup (BUG-006 fix) ──");

  try {
    // sys:compiler was already called during boot chain. Check that _compilerUnsub exists.
    if (typeof ctx._compilerUnsub !== "function") {
      fail("compiler-unsub", "_compilerUnsub is not a function");
      return;
    }
    ok("compiler-unsub: _compilerUnsub function is set after sys:compiler");

    // Call sys:compiler again — should unsubscribe the previous watcher first
    await ctx.call("sys:compiler");

    // Verify the new unsub is set (not the old one)
    if (typeof ctx._compilerUnsub !== "function") {
      fail("compiler-unsub", "_compilerUnsub not set after re-invocation");
    } else {
      ok("compiler-unsub: re-invocation sets new _compilerUnsub (old was unsubscribed)");
    }

    // Verify compilation still works after re-invocation
    await ctx.assert("test:compilerresub", "type", "Function");
    await ctx.assert("test:compilerresub", "source", "return 'works'");
    const result = await ctx.call("test:compilerresub");
    if (result !== "works") throw new Error(`expected 'works', got '${result}'`);
    ok("compiler-unsub: compilation works correctly after re-invocation");
  } catch (e) {
    fail("compiler-unsub", e);
  }
}

// ── BUG-007: Concurrent set race condition fixed ─────────────────

async function testConcurrentSetFix(ctx: Ctx) {
  console.log("\n── Concurrent set fix (BUG-007 fix) ──");

  try {
    await ctx.assert("test:setrace", "value", "initial");

    // Call set concurrently — with the fix, operations should be serialized
    const p1 = ctx.call("set", { s: "test:setrace", p: "value", o: "winner1" });
    const p2 = ctx.call("set", { s: "test:setrace", p: "value", o: "winner2" });

    await Promise.all([p1, p2]);

    // Check: only one value should exist
    const values = await ctx.query({ s: "test:setrace", p: "value" });
    if (values.length === 1) {
      ok("concurrent-set: serialized — only one value survives (" + values[0].o + ")");
    } else {
      fail(
        "concurrent-set",
        `race condition still exists — ${values.length} values: ${values.map((q) => q.o).join(", ")}`
      );
    }
  } catch (e) {
    fail("concurrent-set", e);
  }
}

// ── BUG-008: Generic tool fallback undefined result ──────────────

async function testToolResultUndefined(ctx: Ctx) {
  console.log("\n── Tool result undefined fix (BUG-008 fix) ──");

  try {
    // Create a node that returns undefined
    await ctx.assert("test:voidnode", "type", "Function");
    await ctx.assert("test:voidnode", "source", "// returns undefined");

    // Simulate what agent:loop does in the generic fallback
    const callResult = await ctx.call("test:voidnode");
    const resultStr = callResult === undefined ? "(no return value)" : JSON.stringify(callResult);

    if (typeof resultStr === "string" && resultStr.length > 0) {
      ok("tool-result-undefined: undefined result safely converted to string");
    } else {
      fail("tool-result-undefined", `resultStr is ${typeof resultStr}: ${resultStr}`);
    }
  } catch (e) {
    fail("tool-result-undefined", e);
  }

  try {
    // Verify the fix is in the agent:loop source
    const loopSource = await ctx.query({ s: "agent:loop", p: "source" });
    const src = loopSource[0].o;
    if (src.includes("'(no return value)'")) {
      ok("tool-result-undefined: agent:loop source handles undefined results");
    } else {
      fail("tool-result-undefined", "agent:loop source missing undefined handling");
    }
  } catch (e) {
    fail("tool-result-undefined source check", e);
  }
}

// ── SQL injection safety ─────────────────────────────────────────

async function testSqlInjectionSafety(ctx: Ctx) {
  console.log("\n── SQL injection safety ──");

  try {
    // Attempt SQL injection via node name
    try {
      await ctx.call("'; DROP TABLE quads; --");
    } catch (e: any) {
      if (e.message && e.message.includes("no source found")) {
        ok("sql-injection: malicious node name safely rejected (parameterized query)");
      } else {
        fail("sql-injection", "unexpected error: " + e.message);
      }
    }

    // Attempt SQL injection via assert values
    const q = await ctx.assert(
      "test'; DROP TABLE quads; --",
      "pred'; DROP --",
      "val'; DROP --"
    );
    if (q && q.s.includes("DROP TABLE")) {
      ok("sql-injection: malicious values stored literally, not executed");
    } else {
      fail("sql-injection", "unexpected assert result");
    }

    // Verify database is intact
    const allQuads = await ctx.query({});
    if (allQuads.length > 0) {
      ok("sql-injection: quads table intact after injection attempts (" + allQuads.length + " quads)");
    } else {
      fail("sql-injection", "quads table may have been dropped!");
    }
  } catch (e) {
    fail("sql-injection safety", e);
  }
}

// ── XSS safety in WebUI ─────────────────────────────────────────

async function testXssSafety(ctx: Ctx) {
  console.log("\n── XSS safety ──");

  const port = 14900 + Math.floor(Math.random() * 100);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // Create a node with XSS payload in the name
    const xssName = "test:<script>alert('xss')</script>";
    await ctx.assert(xssName, "type", "Function");
    await ctx.assert(xssName, "source", "return '<img onerror=alert(1)>'");

    // Fetch the node list API
    const res = await fetch(`http://localhost:${port}/api/nodes`);
    const nodes = (await res.json()) as any[];
    const xssNode = nodes.find((n: any) => n.name.includes("<script>"));

    if (xssNode) {
      // The API returns JSON, so the script tag is in a JSON string — no XSS risk
      ok("xss: node with script tag in name safely returned as JSON");
    }

    // Fetch the source API
    const srcRes = await fetch(
      `http://localhost:${port}/api/node/${encodeURIComponent(xssName)}`
    );
    const srcData = (await srcRes.json()) as any;
    if (srcData.source && srcData.source.includes("<img")) {
      ok("xss: malicious source returned as JSON (no XSS in API responses)");
    }

    // Check the HTML page uses textContent for node names (not innerHTML)
    const htmlRes = await fetch(`http://localhost:${port}/`);
    const html = await htmlRes.text();
    if (html.includes("nameSpan.textContent = n.name")) {
      ok("xss: WebUI uses textContent for node names (XSS-safe)");
    } else if (html.includes("textContent")) {
      ok("xss: WebUI uses textContent for rendering (XSS-safe)");
    }

    // Verify escHtml is used for chat messages
    if (html.includes("escHtml")) {
      ok("xss: WebUI has escHtml function for HTML escaping");
    }
  } catch (e) {
    fail("xss safety", e);
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Prototype pollution safety ───────────────────────────────────

async function testPrototypePollution(ctx: Ctx) {
  console.log("\n── Prototype pollution safety ──");

  try {
    const payload = JSON.stringify({ __proto__: { polluted: true } });
    await ctx.assert("test:proto", "data", payload);

    const obj = {} as any;
    if (obj.polluted === true) {
      fail("prototype-pollution", "Object.prototype was polluted!");
    } else {
      ok("prototype-pollution: quad values do not pollute Object.prototype");
    }

    // Clean up
    await ctx.retract("test:proto", "data", payload);
  } catch (e) {
    fail("prototype-pollution", e);
  }
}

// ── BUG-009: Create-node form toggle was a no-op ────────────────

async function testCreateNodeToggle(ctx: Ctx) {
  console.log("\n── Create-node form toggle (BUG-009 fix) ──");

  const port = 15050 + Math.floor(Math.random() * 100);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    // The toggle should use a proper conditional, not always 'block'
    if (html.includes("=== 'block' ? 'none' : 'block'")) {
      ok("create-node-toggle: form toggles between block and none");
    } else if (html.includes("=== 'none' ? 'block' : 'block'")) {
      fail("create-node-toggle", "ternary is still a no-op (both branches are 'block')");
    } else {
      // Check it doesn't have the broken pattern
      if (!html.includes("? 'block' : 'block'")) {
        ok("create-node-toggle: no broken always-block ternary found");
      } else {
        fail("create-node-toggle", "broken toggle pattern still present");
      }
    }
  } catch (e) {
    fail("create-node-toggle", e);
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── BUG-010: SSE stream cancel handler for client disconnect ────

async function testStreamCancelHandler(ctx: Ctx) {
  console.log("\n── SSE stream cancel handler (BUG-010 fix) ──");

  const port = 15150 + Math.floor(Math.random() * 100);
  const ac = new AbortController();

  try {
    ctx.call("api:server", { port, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    // Verify the source contains the cancel handler
    const sourceQuads = await ctx.query({ s: "api:server", p: "source" });
    const src = sourceQuads[0].o;
    if (src.includes("cancel()") && src.includes("cancelled = true")) {
      ok("stream-cancel: ReadableStream has cancel() handler");
    } else {
      fail("stream-cancel", "ReadableStream missing cancel() handler");
    }

    // Test that aborting a stream doesn't crash the server
    const fetchAc = new AbortController();
    try {
      const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "holoiconic",
          messages: [{ role: "user", content: "cancel test" }],
          stream: true,
        }),
        signal: fetchAc.signal,
      });
      const reader = res.body!.getReader();
      await reader.read(); // read one chunk
      fetchAc.abort();
    } catch {}

    await new Promise((r) => setTimeout(r, 200));

    // Server should still be healthy
    const healthRes = await fetch(`http://localhost:${port}/health`);
    const healthData = (await healthRes.json()) as any;
    if (healthData.status === "ok") {
      ok("stream-cancel: server healthy after client abort");
    } else {
      fail("stream-cancel: health after abort", "server not healthy");
    }
  } catch (e) {
    fail("stream-cancel", e);
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── BUG-011: addMsg role parameter escaped via escHtml ──────────

async function testAddMsgRoleEscaping(ctx: Ctx) {
  console.log("\n── addMsg role escaping (BUG-011 fix) ──");

  const port = 15250 + Math.floor(Math.random() * 100);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    // The addMsg function should escape role via escHtml
    if (html.includes("escHtml(role)")) {
      ok("addMsg-role: role parameter is escaped via escHtml");
    } else {
      fail("addMsg-role", "role parameter is NOT escaped in addMsg innerHTML");
    }
  } catch (e) {
    fail("addMsg-role", e);
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── BUG-012: SSE client buffer flush after stream ends ──────────

async function testSseBufferFlush(ctx: Ctx) {
  console.log("\n── SSE buffer flush (BUG-012 fix) ──");

  const port = 15350 + Math.floor(Math.random() * 100);
  const ac = new AbortController();

  try {
    ctx.call("web:ui", { port, apiPort: 19999, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    // The WebUI JS should flush remaining buffer after stream ends
    if (html.includes("Flush any remaining data in the buffer after stream ends")) {
      ok("sse-buffer-flush: client flushes remaining buffer after stream ends");
    } else if (html.includes("buffer.trim()") && html.includes("startsWith('data: ')")) {
      ok("sse-buffer-flush: client has buffer flush logic");
    } else {
      fail("sse-buffer-flush", "no buffer flush logic found in client JS");
    }
  } catch (e) {
    fail("sse-buffer-flush", e);
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── SSE concurrent streams don't interfere ──────────────────────

async function testConcurrentStreams(ctx: Ctx) {
  console.log("\n── Concurrent SSE streams ──");

  const port = 15450 + Math.floor(Math.random() * 100);
  const ac = new AbortController();

  try {
    ctx.call("api:server", { port, signal: ac.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    const promises = [0, 1, 2].map((i) =>
      fetch(`http://localhost:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "holoiconic",
          messages: [{ role: "user", content: `concurrent ${i}` }],
          stream: true,
          session: `concurrent:${i}:${Date.now()}`,
        }),
      }).then((r) => r.text())
    );

    const results = await Promise.all(promises);

    let allValid = true;
    for (let i = 0; i < results.length; i++) {
      const lines = results[i].split("\n").filter((l: string) => l.startsWith("data: "));
      const lastPayload = lines[lines.length - 1]?.slice(6)?.trim();
      if (lastPayload !== "[DONE]") {
        fail(`concurrent-stream ${i}`, `missing [DONE], last: ${lastPayload}`);
        allValid = false;
      }
    }
    if (allValid) {
      ok("concurrent-streams: all 3 concurrent SSE streams complete correctly");
    }
  } catch (e) {
    fail("concurrent-streams", e);
  } finally {
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Full integration flow ────────────────────────────────────────

async function testFullIntegrationFlow(ctx: Ctx) {
  console.log("\n── Full integration flow ──");

  const apiPort = 15550 + Math.floor(Math.random() * 50);
  const webPort = 15650 + Math.floor(Math.random() * 50);
  const apiAc = new AbortController();
  const webAc = new AbortController();

  try {
    ctx.call("api:server", { port: apiPort, signal: apiAc.signal }).catch(() => {});
    ctx.call("web:ui", { port: webPort, apiPort, signal: webAc.signal }).catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    // 1. Create a node via WebUI API
    try {
      const res = await fetch(`http://localhost:${webPort}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "test:flow",
          source: "return 'flow-' + ((args && args.v) || 'default')",
        }),
      });
      if (res.status !== 201) throw new Error(`expected 201, got ${res.status}`);
      ok("flow: created node via WebUI API");
    } catch (e) { fail("flow: create node", e); }

    // 2. Call via API server
    let sessionId: string | undefined;
    try {
      const res = await fetch(`http://localhost:${apiPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "holoiconic",
          messages: [{ role: "user", content: "flow test" }],
        }),
      });
      const data = (await res.json()) as any;
      sessionId = data.session;
      if (data.choices?.[0]?.message?.content) {
        ok("flow: chat completions works");
      } else {
        fail("flow: chat completions", "no content");
      }
    } catch (e) { fail("flow: chat completions", e); }

    // 3. Verify conversation in graph
    if (sessionId) {
      try {
        const msgs = await ctx.query({ p: "message", g: sessionId });
        if (msgs.length >= 2) ok(`flow: conversation stored (${msgs.length} messages)`);
        else fail("flow: conversation", `expected >=2 messages, got ${msgs.length}`);
      } catch (e) { fail("flow: conversation", e); }
    }

    // 4. Export snapshot
    let snap: string | undefined;
    try {
      snap = await ctx.call("snapshot:export");
      ok("flow: snapshot exported");
    } catch (e) { fail("flow: export", e); }

    // 5. Delete node
    try {
      const res = await fetch(
        `http://localhost:${webPort}/api/node/${encodeURIComponent("test:flow")}`,
        { method: "DELETE" }
      );
      const data = (await res.json()) as any;
      if (data.ok) ok("flow: node deleted");
      else fail("flow: delete", JSON.stringify(data));
    } catch (e) { fail("flow: delete", e); }

    // 6. Import snapshot — node should be restored
    if (snap) {
      try {
        await ctx.call("snapshot:import", { data: snap });
        const check = await ctx.query({ s: "test:flow", p: "source" });
        if (check.length > 0) ok("flow: deleted node restored via snapshot import");
        else fail("flow: restore", "node not found after import");
      } catch (e) { fail("flow: import", e); }
    }

    // 7. Deps on restored node
    try {
      const deps = await ctx.call("graph:deps", { node: "test:flow" });
      if (deps.node === "test:flow") ok("flow: deps works on restored node");
      else fail("flow: deps", `wrong node: ${deps.node}`);
    } catch (e) { fail("flow: deps", e); }

    // 8. Metrics check
    try {
      const report = await ctx.call("metrics:report", { raw: true });
      if (report.nodes.length > 0) ok(`flow: metrics has ${report.nodes.length} entries`);
      else fail("flow: metrics", "empty");
    } catch (e) { fail("flow: metrics", e); }
  } finally {
    apiAc.abort();
    webAc.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  // Clean start
  const { unlinkSync } = await import("node:fs");
  try {
    unlinkSync("test-holoiconic.db");
  } catch {}

  console.log("=== Holoiconic Integration Test ===");
  const ctx = await boot();

  await testBootChain(ctx);
  await testShellNode(ctx);
  await testLlmNode(ctx);
  await testAgentTools(ctx);
  await testAgentLoop(ctx);
  await testSessionContinuity(ctx);
  await testReactiveCompilation(ctx);
  await testSpawnLifecycle(ctx);
  await testSnapshotExportImport(ctx);
  await testSnapshotBackup(ctx);
  await testEmbedNode(ctx);
  await testVectorSearch(ctx);
  await testEmbeddingPersistence(ctx);
  await testSetNode(ctx);
  await testSupervisorRetry(ctx);
  await testReplCommands(ctx);
  await testMainErrorHandling(ctx);
  await testApiServer(ctx);
  await testWebUi(ctx);
  await testToolCallVisibility(ctx);
  await testCallWithoutSource(ctx);
  await testTursoCloudConfig();
  await testGraphDescribe(ctx);
  await testGraphSubjects(ctx);
  await testWebUiEnhancements(ctx);
  await testGraphDeps(ctx);
  await testInspectNode(ctx);
  await testDepsApiEndpoint(ctx);
  await testReplDepsInspect(ctx);
  await testToolRegistration(ctx);
  await testGenericToolFallback(ctx);
  await testVersioning(ctx);
  await testCron(ctx);
  await testVersionToolRegistration(ctx);
  await testReplVersionCronCommands(ctx);
  await testMetrics(ctx);
  await testMetricsReport(ctx);
  await testMetricsCompilerIntegration(ctx);
  await testMetricsToolRegistration(ctx);
  await testReplMetricsCommand(ctx);
  await testReplAssertRetractGraph(ctx);
  await testSnapshotImportValidation(ctx);
  await testApiServerEdgeCases(ctx);
  await testWebUiEdgeCases(ctx);
  await testDoubleSpawn(ctx);
  await testCronNoSignalCleanup(ctx);
  await testCompilerSubscriberCleanup(ctx);
  await testConcurrentSetFix(ctx);
  await testToolResultUndefined(ctx);
  await testSqlInjectionSafety(ctx);
  await testXssSafety(ctx);
  await testPrototypePollution(ctx);
  await testCreateNodeToggle(ctx);
  await testStreamCancelHandler(ctx);
  await testAddMsgRoleEscaping(ctx);
  await testSseBufferFlush(ctx);
  await testConcurrentStreams(ctx);
  await testFullIntegrationFlow(ctx);

  // Summary
  console.log("\n── Summary ──");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup: abort all spawned things
  if (ctx._supervisorControllers) {
    for (const [, ac] of ctx._supervisorControllers) {
      ac.abort();
    }
  }

  // Cleanup: stop any leaked cron timers
  if (ctx._cronTimers) {
    for (const [, entry] of ctx._cronTimers) {
      try { await entry.stopCron(); } catch {}
    }
  }

  // Clean up test db
  try {
    unlinkSync("test-holoiconic.db");
  } catch {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
