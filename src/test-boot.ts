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

    // Test /v1/chat/completions
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
  await testReactiveCompilation(ctx);
  await testSpawnLifecycle(ctx);
  await testSnapshotExportImport(ctx);
  await testSnapshotBackup(ctx);
  await testEmbedNode(ctx);
  await testVectorSearch(ctx);
  await testApiServer(ctx);
  await testWebUi(ctx);
  await testCallWithoutSource(ctx);

  // Summary
  console.log("\n── Summary ──");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup: abort all spawned things
  if (ctx._supervisorControllers) {
    for (const [, ac] of ctx._supervisorControllers) {
      ac.abort();
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
