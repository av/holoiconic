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

async function testLlmStub(ctx: Ctx) {
  console.log("\n── LLM stub ──");

  try {
    const result = await ctx.call("llm", {
      messages: [{ role: "user", content: "hi" }],
      model: "test",
    });
    if (!result || result.role !== "assistant")
      throw new Error(`unexpected result: ${JSON.stringify(result)}`);
    ok("llm stub returns assistant message");
  } catch (e) {
    fail("llm stub", e);
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
  await testLlmStub(ctx);
  await testReactiveCompilation(ctx);
  await testSpawnLifecycle(ctx);
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
