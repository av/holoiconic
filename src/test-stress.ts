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

const TEST_DB = "test-stress.db";

async function boot(): Promise<Ctx> {
  const db = createDatabase(TEST_DB);
  await initSchema(db);
  const ctx = createCtx(db);
  await seedTemplate(ctx);
  // Install compiler for cached + reactive ctx.call
  await ctx.call("sys:compiler");
  // Spawn supervisor for long-lived node management
  await ctx.call("spawn", { node: "sys:supervisor" });
  await new Promise((r) => setTimeout(r, 50));
  return ctx;
}

// Helper: register a custom node in the graph
async function registerNode(ctx: Ctx, name: string, source: string) {
  await ctx.assert(name, "type", "Function");
  await ctx.assert(name, "source", source);
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 1: Many Nodes (100 nodes)
// ═════════════════════════════════════════════════════════════════

async function testManyNodes(ctx: Ctx) {
  console.log("\n── Stress Test 1: Many Nodes (100) ──");

  const NODE_COUNT = 100;

  // 1a: Create 100 nodes programmatically
  try {
    const createStart = performance.now();
    for (let i = 0; i < NODE_COUNT; i++) {
      await registerNode(
        ctx,
        `stress:node:${i}`,
        `return 'result-' + ${i} + '-' + (args && args.input || 'default');`
      );
    }
    const createTime = performance.now() - createStart;
    ok(`created ${NODE_COUNT} nodes in ${createTime.toFixed(1)}ms (${(createTime / NODE_COUNT).toFixed(2)}ms/node)`);
  } catch (e) {
    fail("create 100 nodes", e);
  }

  // 1b: Call all 100 nodes and verify results
  try {
    const callStart = performance.now();
    const results: string[] = [];
    for (let i = 0; i < NODE_COUNT; i++) {
      const result = await ctx.call(`stress:node:${i}`, { input: "test" });
      results.push(result);
    }
    const callTime = performance.now() - callStart;

    // Verify each result
    let allCorrect = true;
    for (let i = 0; i < NODE_COUNT; i++) {
      if (results[i] !== `result-${i}-test`) {
        allCorrect = false;
        throw new Error(`node ${i}: expected "result-${i}-test", got "${results[i]}"`);
      }
    }
    if (!allCorrect) throw new Error("some results were incorrect");

    ok(`called ${NODE_COUNT} nodes sequentially in ${callTime.toFixed(1)}ms (${(callTime / NODE_COUNT).toFixed(2)}ms/call)`);
  } catch (e) {
    fail("call 100 nodes", e);
  }

  // 1c: Call all 100 nodes in parallel
  try {
    const parallelStart = performance.now();
    const promises = Array.from({ length: NODE_COUNT }, (_, i) =>
      ctx.call(`stress:node:${i}`, { input: "parallel" })
    );
    const parallelResults = await Promise.all(promises);
    const parallelTime = performance.now() - parallelStart;

    for (let i = 0; i < NODE_COUNT; i++) {
      if (parallelResults[i] !== `result-${i}-parallel`) {
        throw new Error(`parallel node ${i}: expected "result-${i}-parallel", got "${parallelResults[i]}"`);
      }
    }

    ok(`called ${NODE_COUNT} nodes in parallel in ${parallelTime.toFixed(1)}ms (${(parallelTime / NODE_COUNT).toFixed(2)}ms/call)`);
  } catch (e) {
    fail("call 100 nodes in parallel", e);
  }

  // 1d: Verify all nodes exist in the graph
  try {
    const allFunctions = await ctx.query({ p: "type", o: "Function" });
    const stressNodes = allFunctions.filter((q) => q.s.startsWith("stress:node:"));
    if (stressNodes.length !== NODE_COUNT) {
      throw new Error(`expected ${NODE_COUNT} stress nodes, got ${stressNodes.length}`);
    }
    ok(`all ${NODE_COUNT} nodes queryable in graph`);
  } catch (e) {
    fail("query 100 nodes", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 2: Many Quads (1000 quads)
// ═════════════════════════════════════════════════════════════════

async function testManyQuads(ctx: Ctx) {
  console.log("\n── Stress Test 2: Many Quads (1000) ──");

  const QUAD_COUNT = 1000;
  const GRAPH = "stress-quads";

  // 2a: Assert 1000 quads
  try {
    const insertStart = performance.now();
    for (let i = 0; i < QUAD_COUNT; i++) {
      await ctx.assert(
        `entity:${i}`,
        "value",
        `data-${i}-${Math.random().toString(36).slice(2, 10)}`,
        GRAPH
      );
    }
    const insertTime = performance.now() - insertStart;

    ok(`inserted ${QUAD_COUNT} quads in ${insertTime.toFixed(1)}ms (${(insertTime / QUAD_COUNT).toFixed(2)}ms/insert)`);
  } catch (e) {
    fail("insert 1000 quads", e);
  }

  // 2b: Query all 1000 quads back
  try {
    const queryStart = performance.now();
    const allQuads = await ctx.query({ p: "value", g: GRAPH });
    const queryTime = performance.now() - queryStart;

    if (allQuads.length !== QUAD_COUNT) {
      throw new Error(`expected ${QUAD_COUNT} quads, got ${allQuads.length}`);
    }

    ok(`queried ${QUAD_COUNT} quads in ${queryTime.toFixed(1)}ms`);
  } catch (e) {
    fail("query 1000 quads", e);
  }

  // 2c: Query with specific subject filter
  try {
    const filterStart = performance.now();
    const filtered = await ctx.query({ s: "entity:500", p: "value", g: GRAPH });
    const filterTime = performance.now() - filterStart;

    if (filtered.length !== 1) {
      throw new Error(`expected 1 quad for entity:500, got ${filtered.length}`);
    }

    ok(`filtered single quad from ${QUAD_COUNT} in ${filterTime.toFixed(2)}ms`);
  } catch (e) {
    fail("filter single quad", e);
  }

  // 2d: Batch assert with different predicates
  try {
    const batchStart = performance.now();
    const PREDICATES = ["name", "age", "email", "role", "status"];
    for (let i = 0; i < 200; i++) {
      for (const pred of PREDICATES) {
        await ctx.assert(`batch:${i}`, pred, `${pred}-value-${i}`, GRAPH);
      }
    }
    const batchTime = performance.now() - batchStart;
    const totalInserted = 200 * PREDICATES.length;

    ok(`inserted ${totalInserted} multi-predicate quads in ${batchTime.toFixed(1)}ms (${(batchTime / totalInserted).toFixed(2)}ms/insert)`);
  } catch (e) {
    fail("batch multi-predicate insert", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 3: Rapid-Fire Calls (1000 calls)
// ═════════════════════════════════════════════════════════════════

async function testRapidFireCalls(ctx: Ctx) {
  console.log("\n── Stress Test 3: Rapid-Fire Calls (1000) ──");

  const CALL_COUNT = 1000;

  // Create a simple node that does minimal work
  await registerNode(
    ctx,
    "stress:rapidfire",
    `return (args && args.i) * 2;`
  );

  // 3a: Sequential rapid-fire calls
  try {
    const seqStart = performance.now();
    let lastResult = 0;
    for (let i = 0; i < CALL_COUNT; i++) {
      lastResult = await ctx.call("stress:rapidfire", { i });
    }
    const seqTime = performance.now() - seqStart;
    const seqCallsPerSec = Math.round(CALL_COUNT / (seqTime / 1000));

    if (lastResult !== (CALL_COUNT - 1) * 2) {
      throw new Error(`expected ${(CALL_COUNT - 1) * 2}, got ${lastResult}`);
    }

    ok(`${CALL_COUNT} sequential calls in ${seqTime.toFixed(1)}ms (${seqCallsPerSec.toLocaleString()} calls/sec)`);
  } catch (e) {
    fail("rapid-fire sequential", e);
  }

  // 3b: Parallel rapid-fire calls (batches of 100)
  try {
    const parallelStart = performance.now();
    const BATCH_SIZE = 100;
    const BATCHES = CALL_COUNT / BATCH_SIZE;
    let totalCalls = 0;

    for (let batch = 0; batch < BATCHES; batch++) {
      const promises = Array.from({ length: BATCH_SIZE }, (_, j) => {
        const i = batch * BATCH_SIZE + j;
        return ctx.call("stress:rapidfire", { i });
      });
      const batchResults = await Promise.all(promises);
      totalCalls += batchResults.length;

      // Verify last result of each batch
      const lastIdx = (batch + 1) * BATCH_SIZE - 1;
      if (batchResults[BATCH_SIZE - 1] !== lastIdx * 2) {
        throw new Error(`batch ${batch} last result: expected ${lastIdx * 2}, got ${batchResults[BATCH_SIZE - 1]}`);
      }
    }

    const parallelTime = performance.now() - parallelStart;
    const parallelCallsPerSec = Math.round(totalCalls / (parallelTime / 1000));

    ok(`${totalCalls} calls in ${BATCHES} parallel batches in ${parallelTime.toFixed(1)}ms (${parallelCallsPerSec.toLocaleString()} calls/sec)`);
  } catch (e) {
    fail("rapid-fire parallel batches", e);
  }

  // 3c: Full parallel (all 1000 at once)
  try {
    const fullParallelStart = performance.now();
    const allPromises = Array.from({ length: CALL_COUNT }, (_, i) =>
      ctx.call("stress:rapidfire", { i })
    );
    const allResults = await Promise.all(allPromises);
    const fullParallelTime = performance.now() - fullParallelStart;
    const fullParallelCallsPerSec = Math.round(CALL_COUNT / (fullParallelTime / 1000));

    // Verify all results
    let allCorrect = true;
    for (let i = 0; i < CALL_COUNT; i++) {
      if (allResults[i] !== i * 2) {
        allCorrect = false;
        throw new Error(`call ${i}: expected ${i * 2}, got ${allResults[i]}`);
      }
    }

    ok(`${CALL_COUNT} fully parallel calls in ${fullParallelTime.toFixed(1)}ms (${fullParallelCallsPerSec.toLocaleString()} calls/sec)`);
  } catch (e) {
    fail("rapid-fire full parallel", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 4: Parallel Spawn (10 long-lived nodes)
// ═════════════════════════════════════════════════════════════════

async function testParallelSpawn(ctx: Ctx) {
  console.log("\n── Stress Test 4: Parallel Spawn (10 nodes) ──");

  const SPAWN_COUNT = 10;

  // 4a: Create and spawn 10 long-lived nodes simultaneously
  try {
    for (let i = 0; i < SPAWN_COUNT; i++) {
      await registerNode(
        ctx,
        `stress:spawn:${i}`,
        `
await ctx.assert('stress:spawn:${i}', 'status', 'running');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
}
await ctx.assert('stress:spawn:${i}', 'status', 'stopped');
`
      );
    }

    const spawnStart = performance.now();
    // Spawn all 10 simultaneously
    const spawnPromises = Array.from({ length: SPAWN_COUNT }, (_, i) =>
      ctx.call("spawn", { node: `stress:spawn:${i}` })
    );
    await Promise.all(spawnPromises);
    await new Promise((r) => setTimeout(r, 300));
    const spawnTime = performance.now() - spawnStart;

    ok(`spawned ${SPAWN_COUNT} nodes in ${spawnTime.toFixed(1)}ms`);
  } catch (e) {
    fail("spawn 10 nodes", e);
  }

  // 4b: Verify all 10 are running (have Spawned quads)
  try {
    let runningCount = 0;
    let spawnedCount = 0;

    for (let i = 0; i < SPAWN_COUNT; i++) {
      const running = await ctx.query({ s: `stress:spawn:${i}`, p: "status", o: "running" });
      if (running.length > 0) runningCount++;

      const spawned = await ctx.query({ s: `stress:spawn:${i}`, p: "type", o: "Spawned" });
      if (spawned.length > 0) spawnedCount++;
    }

    if (runningCount !== SPAWN_COUNT) {
      throw new Error(`expected ${SPAWN_COUNT} running, got ${runningCount}`);
    }
    if (spawnedCount !== SPAWN_COUNT) {
      throw new Error(`expected ${SPAWN_COUNT} Spawned quads, got ${spawnedCount}`);
    }

    ok(`all ${SPAWN_COUNT} nodes are running with Spawned quads`);
  } catch (e) {
    fail("verify 10 nodes running", e);
  }

  // 4c: Abort all 10 nodes
  try {
    const abortStart = performance.now();

    if (!ctx._supervisorControllers) {
      throw new Error("no _supervisorControllers on ctx");
    }

    for (let i = 0; i < SPAWN_COUNT; i++) {
      const ac = ctx._supervisorControllers.get(`stress:spawn:${i}`);
      if (ac) ac.abort();
    }

    await new Promise((r) => setTimeout(r, 300));
    const abortTime = performance.now() - abortStart;

    // Verify all stopped
    let stoppedCount = 0;
    for (let i = 0; i < SPAWN_COUNT; i++) {
      const stopped = await ctx.query({ s: `stress:spawn:${i}`, p: "status", o: "stopped" });
      if (stopped.length > 0) stoppedCount++;
    }

    if (stoppedCount !== SPAWN_COUNT) {
      throw new Error(`expected ${SPAWN_COUNT} stopped, got ${stoppedCount}`);
    }

    ok(`aborted all ${SPAWN_COUNT} nodes cleanly in ${abortTime.toFixed(1)}ms`);
  } catch (e) {
    fail("abort 10 nodes", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 5: Large Payload (1MB string)
// ═════════════════════════════════════════════════════════════════

async function testLargePayload(ctx: Ctx) {
  console.log("\n── Stress Test 5: Large Payload (1MB string) ──");

  const TARGET_SIZE = 1024 * 1024; // 1MB

  // 5a: Create a node that returns a 1MB string
  try {
    // Node generates a large string by repeating a pattern
    await registerNode(
      ctx,
      "stress:largepayload",
      `
const size = args && args.size || ${TARGET_SIZE};
const chunk = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const repeats = Math.ceil(size / chunk.length);
const result = chunk.repeat(repeats).slice(0, size);
return result;
`
    );

    const callStart = performance.now();
    const result = await ctx.call("stress:largepayload", { size: TARGET_SIZE });
    const callTime = performance.now() - callStart;

    if (typeof result !== "string") {
      throw new Error(`expected string, got ${typeof result}`);
    }
    if (result.length !== TARGET_SIZE) {
      throw new Error(`expected ${TARGET_SIZE} chars, got ${result.length}`);
    }

    ok(`1MB string returned in ${callTime.toFixed(1)}ms (${result.length.toLocaleString()} chars)`);
  } catch (e) {
    fail("1MB string return", e);
  }

  // 5b: Store a large value in a quad and retrieve it
  try {
    const largeValue = "X".repeat(TARGET_SIZE);
    const storeStart = performance.now();
    await ctx.assert("stress:large", "payload", largeValue, "stress-large");
    const storeTime = performance.now() - storeStart;

    const queryStart = performance.now();
    const quads = await ctx.query({ s: "stress:large", p: "payload", g: "stress-large" });
    const queryTime = performance.now() - queryStart;

    if (quads.length !== 1) {
      throw new Error(`expected 1 quad, got ${quads.length}`);
    }
    if (quads[0].o.length !== TARGET_SIZE) {
      throw new Error(`expected ${TARGET_SIZE} chars in quad, got ${quads[0].o.length}`);
    }

    ok(`1MB quad stored in ${storeTime.toFixed(1)}ms, queried in ${queryTime.toFixed(1)}ms`);
  } catch (e) {
    fail("1MB quad storage", e);
  }

  // 5c: Return a large object (not just string)
  try {
    await registerNode(
      ctx,
      "stress:largeobject",
      `
const items = [];
for (let i = 0; i < 10000; i++) {
  items.push({ id: i, name: 'item-' + i, value: Math.random() });
}
return items;
`
    );

    const objStart = performance.now();
    const result = await ctx.call("stress:largeobject");
    const objTime = performance.now() - objStart;

    if (!Array.isArray(result) || result.length !== 10000) {
      throw new Error(`expected 10000-item array, got ${Array.isArray(result) ? result.length : typeof result}`);
    }
    if (result[5000].id !== 5000) {
      throw new Error(`expected item 5000 to have id 5000, got ${result[5000].id}`);
    }

    ok(`10,000-item object array returned in ${objTime.toFixed(1)}ms`);
  } catch (e) {
    fail("large object return", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 6: Deep Composition (50-node chain)
// ═════════════════════════════════════════════════════════════════

async function testDeepComposition(ctx: Ctx) {
  console.log("\n── Stress Test 6: Deep Composition (50-node chain) ──");

  const DEPTH = 50;

  // 6a: Create a chain of 50 nodes where each calls the next
  try {
    const createStart = performance.now();

    // Each node in the chain calls the next, passing an accumulated value
    for (let i = 0; i < DEPTH - 1; i++) {
      await registerNode(
        ctx,
        `stress:chain:${i}`,
        `
const acc = (args && args.accumulated) || '';
const next = acc + (acc ? ',' : '') + '${i}';
return await ctx.call('stress:chain:${i + 1}', { accumulated: next });
`
      );
    }
    // Terminal node -- returns the accumulated value
    await registerNode(
      ctx,
      `stress:chain:${DEPTH - 1}`,
      `
const acc = (args && args.accumulated) || '';
return acc + (acc ? ',' : '') + '${DEPTH - 1}';
`
    );

    const createTime = performance.now() - createStart;
    ok(`created ${DEPTH}-node chain in ${createTime.toFixed(1)}ms`);
  } catch (e) {
    fail("create 50-node chain", e);
  }

  // 6b: Call the first node and verify the result propagates through all 50
  try {
    const callStart = performance.now();
    const result = await ctx.call("stress:chain:0");
    const callTime = performance.now() - callStart;

    // Should be "0,1,2,...,49"
    const expected = Array.from({ length: DEPTH }, (_, i) => i).join(",");
    if (result !== expected) {
      throw new Error(`expected "${expected.slice(0, 50)}...", got "${String(result).slice(0, 50)}..."`);
    }

    ok(`50-deep call chain completed in ${callTime.toFixed(1)}ms (${(callTime / DEPTH).toFixed(2)}ms/level)`);
  } catch (e) {
    fail("50-deep call chain", e);
  }

  // 6c: Call the chain multiple times to verify caching helps
  try {
    const runs = 5;
    const times: number[] = [];

    for (let r = 0; r < runs; r++) {
      const start = performance.now();
      await ctx.call("stress:chain:0");
      times.push(performance.now() - start);
    }

    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const first = times[0];
    const subsequent = times.slice(1).reduce((a, b) => a + b, 0) / (times.length - 1);

    ok(`chain called ${runs}x: first=${first.toFixed(1)}ms, avg subsequent=${subsequent.toFixed(1)}ms (compiler cache effect)`);
  } catch (e) {
    fail("chain caching", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════

async function main() {
  console.log("Holoiconic Stress Tests");
  console.log("=======================");

  // Clean up any previous test DB
  try {
    unlinkSync(TEST_DB);
  } catch {}

  console.log("=== Holoiconic Stress Tests ===");
  const ctx = await boot();

  await testManyNodes(ctx);
  await testManyQuads(ctx);
  await testRapidFireCalls(ctx);
  await testParallelSpawn(ctx);
  await testLargePayload(ctx);
  await testDeepComposition(ctx);

  // Summary
  console.log("\n── Summary ──");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup spawned controllers
  if (ctx._supervisorControllers) {
    for (const [, ac] of ctx._supervisorControllers) {
      try {
        ac.abort();
      } catch {}
    }
  }
  if (ctx._cronTimers) {
    for (const [, entry] of ctx._cronTimers) {
      try {
        await entry.stopCron();
      } catch {}
    }
  }

  // Clean up test db
  try {
    unlinkSync(TEST_DB);
  } catch {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
