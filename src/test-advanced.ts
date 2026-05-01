import { createDatabase, initSchema } from "./db.ts";
import { createCtx, type Ctx } from "./ctx.ts";
import { seedTemplate } from "./template.ts";
import { unlinkSync } from "node:fs";

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

// ── Boot (non-interactive, with compiler + supervisor) ───────────

const TEST_DB = "test-advanced.db";

async function boot(): Promise<Ctx> {
  const db = createDatabase(TEST_DB);
  await initSchema(db);
  const ctx = createCtx(db);
  await seedTemplate(ctx);
  // Install the compiler (cached + reactive ctx.call)
  await ctx.call("sys:compiler");
  // Spawn the supervisor (manages spawned node lifecycle)
  await ctx.call("spawn", { node: "sys:supervisor" });
  await new Promise((r) => setTimeout(r, 50));
  // Register agent tools (needed for tool quads)
  await ctx.call("agent:tools");
  return ctx;
}

// Helper: register a custom node in the graph
async function registerNode(ctx: Ctx, name: string, source: string) {
  await ctx.assert(name, "type", "Function");
  await ctx.assert(name, "source", source);
}

// ── Test 1: Spawn + Supervisor lifecycle ─────────────────────────

async function testSpawnSupervisorLifecycle(ctx: Ctx) {
  console.log("\n── Spawn + Supervisor lifecycle ──");

  // 1a: Spawn a long-lived node, verify it's running, then abort it
  try {
    await registerNode(
      ctx,
      "adv:longworker",
      `
await ctx.assert('adv:longworker', 'status', 'alive');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
await ctx.assert('adv:longworker', 'status', 'stopped');
`
    );

    await ctx.call("spawn", { node: "adv:longworker" });
    await new Promise((r) => setTimeout(r, 150));

    // Verify it started
    const alive = await ctx.query({ s: "adv:longworker", p: "status", o: "alive" });
    if (alive.length === 0) throw new Error("adv:longworker did not start");

    // Verify it's registered as Spawned
    const spawned = await ctx.query({ s: "adv:longworker", p: "type", o: "Spawned" });
    if (spawned.length === 0) throw new Error("adv:longworker not marked as Spawned");

    ok("spawned long-lived node is alive and marked Spawned");
  } catch (e) {
    fail("spawn long-lived node", e);
  }

  // 1b: Abort the spawned node via supervisor
  try {
    if (ctx._supervisorControllers) {
      const ac = ctx._supervisorControllers.get("adv:longworker");
      if (!ac) throw new Error("no controller for adv:longworker");
      ac.abort();
      await new Promise((r) => setTimeout(r, 200));

      // After abort, the node's post-abort code should run (sets status to 'stopped')
      const stopped = await ctx.query({ s: "adv:longworker", p: "status", o: "stopped" });
      if (stopped.length === 0) throw new Error("adv:longworker did not stop cleanly");
      ok("abort signal stops spawned node cleanly");
    } else {
      fail("abort spawned node", "no _supervisorControllers on ctx");
    }
  } catch (e) {
    fail("abort spawned node", e);
  }

  // 1c: Supervisor retry — node crashes on first 2 calls, succeeds on 3rd
  try {
    await ctx.assert("adv:crasher", "crash_count", "0");
    await registerNode(
      ctx,
      "adv:crasher",
      `
const cq = await ctx.query({ s: 'adv:crasher', p: 'crash_count' });
const count = parseInt(cq[0].o);
const next = count + 1;
await ctx.retract('adv:crasher', 'crash_count', String(count));
await ctx.assert('adv:crasher', 'crash_count', String(next));
if (next <= 2) throw new Error('deliberate crash #' + next);
await ctx.assert('adv:crasher', 'status', 'recovered');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`
    );

    await ctx.call("spawn", { node: "adv:crasher" });
    // Wait for retries: 500ms + 1000ms + margin
    await new Promise((r) => setTimeout(r, 2500));

    const recovered = await ctx.query({ s: "adv:crasher", p: "status", o: "recovered" });
    if (recovered.length === 0) throw new Error("adv:crasher did not recover");

    const countQ = await ctx.query({ s: "adv:crasher", p: "crash_count" });
    const finalCount = parseInt(countQ[0].o);
    if (finalCount < 3)
      throw new Error(`expected >= 3 calls for recovery, got ${finalCount}`);

    ok("supervisor retries crashed node with backoff (recovered after " + finalCount + " attempts)");
  } catch (e) {
    fail("supervisor retry/backoff", e);
  }
}

// ── Test 2: Hot-reload a spawned node ────────────────────────────

async function testHotReload(ctx: Ctx) {
  console.log("\n── Hot-reload spawned node ──");

  try {
    const v1Source = `
await ctx.assert('adv:hotnode', 'output', 'version-1');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`;
    await registerNode(ctx, "adv:hotnode", v1Source);

    // Spawn it
    await ctx.call("spawn", { node: "adv:hotnode" });
    await new Promise((r) => setTimeout(r, 150));

    // Verify v1 is running
    const v1out = await ctx.query({ s: "adv:hotnode", p: "output", o: "version-1" });
    if (v1out.length === 0) throw new Error("v1 did not write output");
    ok("hot-reload: v1 of spawned node is running");

    // Hot-reload: retract old source, assert new source
    const v2Source = `
await ctx.assert('adv:hotnode', 'output', 'version-2');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
`;
    await ctx.retract("adv:hotnode", "source", v1Source);
    await ctx.assert("adv:hotnode", "source", v2Source);

    // Wait for supervisor to restart with new source
    await new Promise((r) => setTimeout(r, 300));

    // Verify v2 is now running
    const v2out = await ctx.query({ s: "adv:hotnode", p: "output", o: "version-2" });
    if (v2out.length === 0) throw new Error("v2 did not write output after hot-reload");

    ok("hot-reload: supervisor restarted node with new source (v2)");
  } catch (e) {
    fail("hot-reload spawned node", e);
  }
}

// ── Test 3: Cron scheduling ──────────────────────────────────────

async function testCronScheduling(ctx: Ctx) {
  console.log("\n── Cron scheduling ──");

  try {
    // Create a counter node
    await ctx.assert("adv:ticker", "tick_count", "0");
    await registerNode(
      ctx,
      "adv:ticker",
      `
const cq = await ctx.query({ s: 'adv:ticker', p: 'tick_count' });
const count = parseInt(cq[0].o);
const next = count + 1;
await ctx.retract('adv:ticker', 'tick_count', String(count));
await ctx.assert('adv:ticker', 'tick_count', String(next));
return next;
`
    );

    // Start cron with 200ms interval
    const ac = new AbortController();
    const cronPromise = ctx.call("cron", {
      node: "adv:ticker",
      interval: 200,
      signal: ac.signal,
    });

    // Let it tick for ~700ms (should get >= 2 ticks)
    await new Promise((r) => setTimeout(r, 700));

    // Stop the cron
    ac.abort();
    await new Promise((r) => setTimeout(r, 100));

    const countQ = await ctx.query({ s: "adv:ticker", p: "tick_count" });
    const count = parseInt(countQ[0].o);
    if (count < 2)
      throw new Error(`expected >= 2 ticks, got ${count}`);

    ok("cron fires node on interval (" + count + " ticks in ~700ms)");
  } catch (e) {
    fail("cron scheduling", e);
  }

  // Verify cron:list shows the job
  try {
    const result = await ctx.call("cron:list");
    if (!Array.isArray(result.jobs))
      throw new Error("expected jobs array from cron:list");

    const tickerJob = result.jobs.find((j: any) => j.node === "adv:ticker");
    if (!tickerJob)
      throw new Error("adv:ticker not found in cron:list");
    if (tickerJob.status !== "stopped")
      throw new Error(`expected status='stopped' after abort, got '${tickerJob.status}'`);

    ok("cron:list shows job with stopped status after abort");
  } catch (e) {
    fail("cron:list", e);
  }
}

// ── Test 4: Snapshot export/import round-trip ─────────────────────

async function testSnapshotRoundTrip(ctx: Ctx) {
  console.log("\n── Snapshot export/import round-trip ──");

  const uniqueId = "adv:snap:" + Date.now();

  try {
    // Assert some unique quads
    await ctx.assert(uniqueId, "color", "blue");
    await ctx.assert(uniqueId, "shape", "circle");
    await ctx.assert(uniqueId, "size", "42");

    // Verify they exist
    const beforeExport = await ctx.query({ s: uniqueId });
    if (beforeExport.length < 3)
      throw new Error(`expected 3 quads, got ${beforeExport.length}`);

    // Export entire graph
    const json = await ctx.call("snapshot:export");
    const allQuads = JSON.parse(json);
    if (!Array.isArray(allQuads) || allQuads.length === 0)
      throw new Error("snapshot:export returned empty");

    // Find our unique quads in the export
    const ourQuads = allQuads.filter((q: any) => q.s === uniqueId);
    if (ourQuads.length < 3)
      throw new Error(`expected 3 of our quads in export, got ${ourQuads.length}`);

    ok("snapshot:export includes our unique quads (" + ourQuads.length + " found)");

    // Retract the unique quads
    await ctx.retract(uniqueId, "color", "blue");
    await ctx.retract(uniqueId, "shape", "circle");
    await ctx.retract(uniqueId, "size", "42");

    // Verify they're gone
    const afterRetract = await ctx.query({ s: uniqueId });
    if (afterRetract.length !== 0)
      throw new Error(`expected 0 quads after retract, got ${afterRetract.length}`);

    ok("quads retracted successfully");

    // Import just our quads back
    const importData = JSON.stringify(ourQuads);
    const importResult = await ctx.call("snapshot:import", { data: importData });
    if (importResult.count !== ourQuads.length)
      throw new Error(`expected import count=${ourQuads.length}, got ${importResult.count}`);

    // Verify restoration
    const restored = await ctx.query({ s: uniqueId });
    if (restored.length < 3)
      throw new Error(`expected 3 restored quads, got ${restored.length}`);

    const colorQ = await ctx.query({ s: uniqueId, p: "color" });
    if (colorQ.length === 0 || colorQ[0].o !== "blue")
      throw new Error("color quad not restored correctly");
    const shapeQ = await ctx.query({ s: uniqueId, p: "shape" });
    if (shapeQ.length === 0 || shapeQ[0].o !== "circle")
      throw new Error("shape quad not restored correctly");

    ok("snapshot:import restores retracted quads (round-trip verified)");
  } catch (e) {
    fail("snapshot round-trip", e);
  }
}

// ── Test 5: Version save/list/restore ────────────────────────────

async function testVersionLifecycle(ctx: Ctx) {
  console.log("\n── Version save/list/restore ──");

  try {
    // Create a node with v1 source
    const v1Source = "return 'original-v1'";
    await registerNode(ctx, "adv:versioned", v1Source);

    // Call it to confirm v1
    const r1 = await ctx.call("adv:versioned");
    if (r1 !== "original-v1")
      throw new Error(`expected 'original-v1', got '${r1}'`);
    ok("version: v1 node returns correct value");
  } catch (e) {
    fail("version v1 setup", e);
  }

  try {
    // Modify the source (retract + assert triggers version:save via sys:compiler)
    const v1Source = "return 'original-v1'";
    const v2Source = "return 'modified-v2'";
    await ctx.retract("adv:versioned", "source", v1Source);
    await ctx.assert("adv:versioned", "source", v2Source);

    // Wait for version:save to complete
    await new Promise((r) => setTimeout(r, 100));

    // Verify new behavior
    const r2 = await ctx.call("adv:versioned");
    if (r2 !== "modified-v2")
      throw new Error(`expected 'modified-v2', got '${r2}'`);

    ok("version: v2 takes effect after source swap");
  } catch (e) {
    fail("version v2 swap", e);
  }

  try {
    // List versions
    const listResult = await ctx.call("version:list", { name: "adv:versioned" });
    if (listResult.count < 1)
      throw new Error(`expected >= 1 version, got ${listResult.count}`);

    // version:list returns seq, timestamp, sourceLength (not full source)
    // The saved version should have the length of the v1 source
    const versions = listResult.versions;
    if (versions.length < 1)
      throw new Error("expected at least 1 version entry");
    // Check that seq=0 exists (the auto-saved v1)
    const v1Version = versions.find((v: any) => v.seq === 0);
    if (!v1Version)
      throw new Error("version with seq=0 not found");
    if (typeof v1Version.sourceLength !== "number" || v1Version.sourceLength <= 0)
      throw new Error(`expected positive sourceLength, got ${v1Version.sourceLength}`);

    ok("version:list shows saved versions (count=" + listResult.count + ", seq0 sourceLength=" + v1Version.sourceLength + ")");
  } catch (e) {
    fail("version:list", e);
  }

  try {
    // Restore to original version (seq=0)
    const restoreResult = await ctx.call("version:restore", {
      name: "adv:versioned",
      seq: 0,
    });
    if (!restoreResult.restored)
      throw new Error("version:restore did not report restored=true");

    // Wait for cache invalidation
    await new Promise((r) => setTimeout(r, 100));

    // Verify behavior reverts
    const r3 = await ctx.call("adv:versioned");
    if (r3 !== "original-v1")
      throw new Error(`expected 'original-v1' after restore, got '${r3}'`);

    ok("version:restore reverts node to original behavior");
  } catch (e) {
    fail("version:restore", e);
  }
}

// ── Test 6: Metrics tracking ─────────────────────────────────────

async function testMetricsTracking(ctx: Ctx) {
  console.log("\n── Metrics tracking ──");

  try {
    // Create a node and call it several times
    await registerNode(ctx, "adv:measured", "return 'tick'");

    // Call it 5 times
    for (let i = 0; i < 5; i++) {
      await ctx.call("adv:measured");
    }

    // Wait for async metrics recording
    await new Promise((r) => setTimeout(r, 150));

    // Check metrics via graph query
    const callsQ = await ctx.query({
      s: "adv:measured",
      p: "metric:calls",
      g: "metrics",
    });
    if (callsQ.length === 0)
      throw new Error("no metrics:calls recorded");

    const calls = parseInt(callsQ[0].o);
    if (calls < 5)
      throw new Error(`expected >= 5 calls recorded, got ${calls}`);

    ok("metrics: sys:compiler auto-records call count (" + calls + " calls)");
  } catch (e) {
    fail("metrics call count", e);
  }

  try {
    // Check duration was recorded (may be 0 for sub-ms calls, that's fine)
    const durationQ = await ctx.query({
      s: "adv:measured",
      p: "metric:duration_ms",
      g: "metrics",
    });
    if (durationQ.length === 0)
      throw new Error("no metric:duration_ms recorded");

    const duration = parseFloat(durationQ[0].o);
    if (duration < 0)
      throw new Error(`expected non-negative duration, got ${duration}`);

    ok("metrics: duration tracked (" + duration.toFixed(1) + "ms total for 5 calls)");
  } catch (e) {
    fail("metrics duration", e);
  }

  try {
    // Use metrics:report to get a formatted report
    const report = await ctx.call("metrics:report", { raw: true });
    if (!report || !Array.isArray(report.nodes))
      throw new Error("metrics:report raw did not return nodes array");

    const measuredNode = report.nodes.find((n: any) => n.name === "adv:measured");
    if (!measuredNode)
      throw new Error("adv:measured not found in metrics report");
    if (measuredNode.calls < 5)
      throw new Error(`expected >= 5 calls in report, got ${measuredNode.calls}`);
    if (typeof measuredNode.avg_ms !== "number" || measuredNode.avg_ms < 0)
      throw new Error(`expected non-negative avg_ms, got ${measuredNode.avg_ms}`);

    ok("metrics:report includes adv:measured with correct stats (calls=" + measuredNode.calls + ", avg=" + measuredNode.avg_ms.toFixed(2) + "ms)");
  } catch (e) {
    fail("metrics:report", e);
  }

  // Verify metrics self-exclusion (metrics node should NOT track itself)
  try {
    const selfMetrics = await ctx.query({
      s: "metrics",
      p: "metric:calls",
      g: "metrics",
    });
    if (selfMetrics.length > 0)
      throw new Error("metrics node should not track itself");

    ok("metrics: self-exclusion confirmed (no infinite recursion)");
  } catch (e) {
    fail("metrics self-exclusion", e);
  }
}

// ── Test 7: Concurrent operations ────────────────────────────────

async function testConcurrentOperations(ctx: Ctx) {
  console.log("\n── Concurrent operations ──");

  try {
    // Register several independent nodes
    await registerNode(ctx, "adv:par-a", "return 'result-a'");
    await registerNode(ctx, "adv:par-b", "return 'result-b'");
    await registerNode(ctx, "adv:par-c", "return args.x * 2");
    await registerNode(ctx, "adv:par-d", `
const q = await ctx.query({ s: 'adv:par-d', p: 'type' });
return q.length;
`);

    // Fire all in parallel
    const results = await Promise.all([
      ctx.call("adv:par-a"),
      ctx.call("adv:par-b"),
      ctx.call("adv:par-c", { x: 21 }),
      ctx.call("adv:par-d"),
    ]);

    if (results[0] !== "result-a") throw new Error(`par-a: expected 'result-a', got '${results[0]}'`);
    if (results[1] !== "result-b") throw new Error(`par-b: expected 'result-b', got '${results[1]}'`);
    if (results[2] !== 42) throw new Error(`par-c: expected 42, got ${results[2]}`);
    if (typeof results[3] !== "number" || results[3] < 1)
      throw new Error(`par-d: expected >= 1, got ${results[3]}`);

    ok("4 concurrent ctx.call invocations all return correct results");
  } catch (e) {
    fail("concurrent basic", e);
  }

  // Test concurrent writes to different graph subjects
  try {
    const N = 20;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(
        ctx.call("set", { s: `adv:conc:${i}`, p: "value", o: `val-${i}` })
      );
    }
    await Promise.all(promises);

    // Verify all 20 writes succeeded
    let verified = 0;
    for (let i = 0; i < N; i++) {
      const q = await ctx.query({ s: `adv:conc:${i}`, p: "value" });
      if (q.length === 1 && q[0].o === `val-${i}`) verified++;
    }
    if (verified !== N)
      throw new Error(`expected ${N} verified writes, got ${verified}`);

    ok(`${N} concurrent set operations all completed correctly`);
  } catch (e) {
    fail("concurrent writes", e);
  }

  // Test concurrent reads don't interfere
  try {
    await registerNode(ctx, "adv:slowish", `
const start = Date.now();
while (Date.now() - start < 5) {} // Burn 5ms
return 'done-' + (args && args.id);
`);

    const N = 10;
    const promises = [];
    for (let i = 0; i < N; i++) {
      promises.push(ctx.call("adv:slowish", { id: i }));
    }
    const results = await Promise.all(promises);

    const allCorrect = results.every((r, i) => r === `done-${i}`);
    if (!allCorrect)
      throw new Error(`some results incorrect: ${JSON.stringify(results)}`);

    ok(`${N} concurrent calls to same node with different args all return correctly`);
  } catch (e) {
    fail("concurrent same-node calls", e);
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  console.log("Advanced Runtime Feature Tests");
  console.log("==============================");

  // Clean up any previous test DB
  try { unlinkSync(TEST_DB); } catch {}

  const ctx = await boot();

  await testSpawnSupervisorLifecycle(ctx);
  await testHotReload(ctx);
  await testCronScheduling(ctx);
  await testSnapshotRoundTrip(ctx);
  await testVersionLifecycle(ctx);
  await testMetricsTracking(ctx);
  await testConcurrentOperations(ctx);

  // Summary
  console.log("\n── Summary ──");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup: abort all spawned things
  if (ctx._supervisorControllers) {
    for (const [, ac] of ctx._supervisorControllers) {
      try { ac.abort(); } catch {}
    }
  }

  // Cleanup: stop any leaked cron timers
  if (ctx._cronTimers) {
    for (const [, entry] of ctx._cronTimers) {
      try { await entry.stopCron(); } catch {}
    }
  }

  // Clean up test db
  try { unlinkSync(TEST_DB); } catch {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
