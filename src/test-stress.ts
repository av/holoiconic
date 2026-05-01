import { createDatabase, initSchema } from "./db.ts";
import { createCtx, type Ctx } from "./ctx.ts";
import { seedTemplate } from "./template.ts";
import { unlinkSync } from "node:fs";

// ── Test harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: string[] = [];
const timings: { scenario: string; metric: string; value: string }[] = [];

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

function timing(scenario: string, metric: string, value: string) {
  timings.push({ scenario, metric, value });
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
// Stress Test 1: Mass Quad Insertion (1000 quads)
// ═════════════════════════════════════════════════════════════════

async function testMassQuadInsertion(ctx: Ctx) {
  console.log("\n── Stress Test 1: Mass Quad Insertion (1000 quads) ──");

  const QUAD_COUNT = 1000;
  const GRAPH = "stress-mass";

  // 1a: Assert 1000 quads in a tight loop and measure time
  let insertTime = 0;
  try {
    const insertStart = performance.now();
    for (let i = 0; i < QUAD_COUNT; i++) {
      await ctx.assert(
        `mass:entity:${i}`,
        "data",
        `value-${i}-${String(i * 7919).padStart(8, "0")}`,
        GRAPH
      );
    }
    insertTime = performance.now() - insertStart;
    timing("Mass Quad Insertion", "1000 inserts", `${insertTime.toFixed(1)}ms (${(insertTime / QUAD_COUNT).toFixed(2)}ms/insert)`);
    ok(`inserted ${QUAD_COUNT} quads in ${insertTime.toFixed(1)}ms (${(insertTime / QUAD_COUNT).toFixed(2)}ms/insert)`);
  } catch (e) {
    fail("insert 1000 quads", e);
  }

  // 1b: Query all 1000 quads back and verify count
  try {
    const queryStart = performance.now();
    const allQuads = await ctx.query({ p: "data", g: GRAPH });
    const queryTime = performance.now() - queryStart;

    if (allQuads.length !== QUAD_COUNT) {
      throw new Error(`expected ${QUAD_COUNT} quads, got ${allQuads.length}`);
    }

    timing("Mass Quad Insertion", "query 1000 quads", `${queryTime.toFixed(2)}ms`);
    ok(`queried all ${QUAD_COUNT} quads back in ${queryTime.toFixed(2)}ms`);
  } catch (e) {
    fail("query 1000 quads", e);
  }

  // 1c: Verify data integrity of specific quads
  try {
    const spot_checks = [0, 499, 999];
    for (const i of spot_checks) {
      const q = await ctx.query({ s: `mass:entity:${i}`, p: "data", g: GRAPH });
      if (q.length !== 1) throw new Error(`entity ${i}: expected 1 quad, got ${q.length}`);
      const expected = `value-${i}-${String(i * 7919).padStart(8, "0")}`;
      if (q[0].o !== expected) throw new Error(`entity ${i}: expected "${expected}", got "${q[0].o}"`);
    }
    ok(`spot-checked quads [0, 499, 999] -- all correct`);
  } catch (e) {
    fail("verify quad integrity", e);
  }

  // 1d: Query with subject filter performance
  try {
    const filterStart = performance.now();
    for (let i = 0; i < 100; i++) {
      await ctx.query({ s: `mass:entity:${i * 10}`, p: "data", g: GRAPH });
    }
    const filterTime = performance.now() - filterStart;
    timing("Mass Quad Insertion", "100 filtered queries", `${filterTime.toFixed(2)}ms (${(filterTime / 100).toFixed(2)}ms/query)`);
    ok(`100 filtered queries in ${filterTime.toFixed(2)}ms (${(filterTime / 100).toFixed(2)}ms/query)`);
  } catch (e) {
    fail("filtered query performance", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 2: Concurrent Node Creation + Execution (50 nodes)
// ═════════════════════════════════════════════════════════════════

async function testConcurrentNodeExecution(ctx: Ctx) {
  console.log("\n── Stress Test 2: Concurrent Node Creation + Execution (50 nodes) ──");

  const NODE_COUNT = 50;

  // 2a: Create 50 nodes in parallel
  try {
    const createStart = performance.now();
    const createPromises = Array.from({ length: NODE_COUNT }, (_, i) =>
      registerNode(
        ctx,
        `concurrent:node:${i}`,
        `return { id: ${i}, square: ${i} * ${i}, name: 'node-${i}', timestamp: Date.now() };`
      )
    );
    await Promise.all(createPromises);
    const createTime = performance.now() - createStart;

    // Verify all exist
    const allNodes = await ctx.query({ p: "type", o: "Function" });
    const concurrentNodes = allNodes.filter((q) => q.s.startsWith("concurrent:node:"));
    if (concurrentNodes.length !== NODE_COUNT) {
      throw new Error(`expected ${NODE_COUNT} concurrent nodes, got ${concurrentNodes.length}`);
    }

    timing("Concurrent Nodes", `create ${NODE_COUNT} in parallel`, `${createTime.toFixed(1)}ms (${(createTime / NODE_COUNT).toFixed(2)}ms/node)`);
    ok(`created ${NODE_COUNT} nodes in parallel in ${createTime.toFixed(1)}ms (${(createTime / NODE_COUNT).toFixed(2)}ms/node)`);
  } catch (e) {
    fail("create 50 nodes in parallel", e);
  }

  // 2b: Call all 50 nodes in parallel
  try {
    const callStart = performance.now();
    const callPromises = Array.from({ length: NODE_COUNT }, (_, i) =>
      ctx.call(`concurrent:node:${i}`)
    );
    const results = await Promise.all(callPromises);
    const callTime = performance.now() - callStart;

    // Verify all results
    for (let i = 0; i < NODE_COUNT; i++) {
      if (results[i].id !== i) throw new Error(`node ${i}: expected id ${i}, got ${results[i].id}`);
      if (results[i].square !== i * i) throw new Error(`node ${i}: expected square ${i * i}, got ${results[i].square}`);
    }

    timing("Concurrent Nodes", `call ${NODE_COUNT} in parallel`, `${callTime.toFixed(1)}ms (${(callTime / NODE_COUNT).toFixed(2)}ms/call)`);
    ok(`called ${NODE_COUNT} nodes in parallel in ${callTime.toFixed(1)}ms -- all results correct`);
  } catch (e) {
    fail("call 50 nodes in parallel", e);
  }

  // 2c: Call all 50 nodes in parallel a second time (cached)
  try {
    const cachedStart = performance.now();
    const cachedPromises = Array.from({ length: NODE_COUNT }, (_, i) =>
      ctx.call(`concurrent:node:${i}`)
    );
    const cachedResults = await Promise.all(cachedPromises);
    const cachedTime = performance.now() - cachedStart;

    for (let i = 0; i < NODE_COUNT; i++) {
      if (cachedResults[i].id !== i) throw new Error(`cached node ${i}: wrong id`);
    }

    timing("Concurrent Nodes", `call ${NODE_COUNT} cached`, `${cachedTime.toFixed(1)}ms (${(cachedTime / NODE_COUNT).toFixed(2)}ms/call)`);
    ok(`called ${NODE_COUNT} cached nodes in ${cachedTime.toFixed(1)}ms (compiler cache warm)`);
  } catch (e) {
    fail("call 50 cached nodes in parallel", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 3: Rapid Hot-Reload (100 retract+assert cycles)
// ═════════════════════════════════════════════════════════════════

async function testRapidHotReload(ctx: Ctx) {
  console.log("\n── Stress Test 3: Rapid Hot-Reload (100 retract+assert cycles) ──");

  const RELOAD_COUNT = 100;
  const NODE_NAME = "stress:hotreload";

  // 3a: Create initial node
  try {
    await registerNode(ctx, NODE_NAME, `return 'version-0';`);
    const initial = await ctx.call(NODE_NAME);
    if (initial !== "version-0") throw new Error(`expected "version-0", got "${initial}"`);
    ok("initial node version-0 works");
  } catch (e) {
    fail("create initial hot-reload node", e);
  }

  // 3b: Retract+assert 100 times, calling after each swap
  try {
    const reloadStart = performance.now();
    let allCorrect = true;

    for (let i = 1; i <= RELOAD_COUNT; i++) {
      // Get current source
      const current = await ctx.query({ s: NODE_NAME, p: "source" });
      if (current.length === 0) throw new Error(`no source found at iteration ${i}`);

      // Retract old source
      await ctx.retract(NODE_NAME, "source", current[0].o);

      // Assert new source
      await ctx.assert(NODE_NAME, "source", `return 'version-${i}';`);

      // Call and verify
      const result = await ctx.call(NODE_NAME);
      if (result !== `version-${i}`) {
        allCorrect = false;
        throw new Error(`iteration ${i}: expected "version-${i}", got "${result}"`);
      }
    }

    const reloadTime = performance.now() - reloadStart;
    timing("Rapid Hot-Reload", `${RELOAD_COUNT} retract+assert+call cycles`, `${reloadTime.toFixed(1)}ms (${(reloadTime / RELOAD_COUNT).toFixed(2)}ms/cycle)`);
    ok(`${RELOAD_COUNT} hot-reloads in ${reloadTime.toFixed(1)}ms (${(reloadTime / RELOAD_COUNT).toFixed(2)}ms/cycle) -- all correct`);
  } catch (e) {
    fail("100 rapid hot-reloads", e);
  }

  // 3c: Verify final version is correct
  try {
    const finalResult = await ctx.call(NODE_NAME);
    if (finalResult !== `version-${RELOAD_COUNT}`) {
      throw new Error(`expected "version-${RELOAD_COUNT}", got "${finalResult}"`);
    }

    // Verify compiler cache was invalidated (the node should not return a stale version)
    const source = await ctx.query({ s: NODE_NAME, p: "source" });
    if (!source[0].o.includes(`version-${RELOAD_COUNT}`)) {
      throw new Error(`source does not contain version-${RELOAD_COUNT}`);
    }

    ok(`final version-${RELOAD_COUNT} is correct, compiler cache properly invalidated through all cycles`);
  } catch (e) {
    fail("verify final hot-reload version", e);
  }

  // 3d: Verify versions were saved (sys:compiler auto-versions on retract)
  try {
    const versions = await ctx.query({ s: NODE_NAME, p: "version" });
    // Each retract triggers version:save, so there should be ~100 versions
    if (versions.length < RELOAD_COUNT - 1) {
      throw new Error(`expected at least ${RELOAD_COUNT - 1} versions, got ${versions.length}`);
    }
    timing("Rapid Hot-Reload", "versions saved", `${versions.length} auto-versioned snapshots`);
    ok(`${versions.length} auto-versioned snapshots saved by sys:compiler`);
  } catch (e) {
    fail("verify auto-versioning", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 4: Deep Composition (50-node chain)
// ═════════════════════════════════════════════════════════════════

async function testDeepComposition(ctx: Ctx) {
  console.log("\n── Stress Test 4: Deep Composition (50-node chain) ──");

  const DEPTH = 50;

  // 4a: Create a chain of 50 nodes where each calls the next
  try {
    const createStart = performance.now();

    for (let i = 0; i < DEPTH - 1; i++) {
      await registerNode(
        ctx,
        `deep:chain:${i}`,
        `
const val = (args && args.value) || 0;
const depth = (args && args.depth) || 0;
return await ctx.call('deep:chain:${i + 1}', { value: val + ${i + 1}, depth: depth + 1 });
`
      );
    }
    // Terminal node returns the accumulated value plus metadata
    await registerNode(
      ctx,
      `deep:chain:${DEPTH - 1}`,
      `
const val = (args && args.value) || 0;
const depth = (args && args.depth) || 0;
return { sum: val + ${DEPTH}, depth: depth + 1, self: ctx.self };
`
    );

    const createTime = performance.now() - createStart;
    timing("Deep Composition", `create ${DEPTH}-node chain`, `${createTime.toFixed(1)}ms`);
    ok(`created ${DEPTH}-node chain in ${createTime.toFixed(1)}ms`);
  } catch (e) {
    fail("create 50-node chain", e);
  }

  // 4b: Call through all 50 levels and verify correctness
  try {
    const callStart = performance.now();
    const result = await ctx.call("deep:chain:0", { value: 0, depth: 0 });
    const callTime = performance.now() - callStart;

    // Sum should be 1+2+3+...+50 = 1275
    const expectedSum = (DEPTH * (DEPTH + 1)) / 2;
    if (result.sum !== expectedSum) {
      throw new Error(`expected sum ${expectedSum}, got ${result.sum}`);
    }
    if (result.depth !== DEPTH) {
      throw new Error(`expected depth ${DEPTH}, got ${result.depth}`);
    }
    if (result.self !== `deep:chain:${DEPTH - 1}`) {
      throw new Error(`expected self "deep:chain:${DEPTH - 1}", got "${result.self}"`);
    }

    timing("Deep Composition", `50-deep chain (cold)`, `${callTime.toFixed(1)}ms (${(callTime / DEPTH).toFixed(2)}ms/level)`);
    ok(`50-deep chain: sum=${result.sum}, depth=${result.depth} in ${callTime.toFixed(1)}ms`);
  } catch (e) {
    fail("call 50-deep chain", e);
  }

  // 4c: Call again to measure compiler cache effect
  try {
    const warmStart = performance.now();
    const warmResult = await ctx.call("deep:chain:0", { value: 0, depth: 0 });
    const warmTime = performance.now() - warmStart;

    const expectedSum = (DEPTH * (DEPTH + 1)) / 2;
    if (warmResult.sum !== expectedSum) throw new Error(`warm call sum wrong: ${warmResult.sum}`);

    timing("Deep Composition", `50-deep chain (warm)`, `${warmTime.toFixed(1)}ms`);
    ok(`50-deep chain (warm cache): ${warmTime.toFixed(1)}ms`);
  } catch (e) {
    fail("warm 50-deep chain", e);
  }

  // 4d: Verify ctx.self is tracked correctly at every level
  try {
    // Modify terminal node to return the full self chain
    const oldSource = (await ctx.query({ s: `deep:chain:${DEPTH - 1}`, p: "source" }))[0].o;
    await ctx.retract(`deep:chain:${DEPTH - 1}`, "source", oldSource);
    await ctx.assert(
      `deep:chain:${DEPTH - 1}`,
      "source",
      `return ctx.self;`
    );

    const selfResult = await ctx.call(`deep:chain:${DEPTH - 1}`);
    if (selfResult !== `deep:chain:${DEPTH - 1}`) {
      throw new Error(`expected ctx.self = "deep:chain:${DEPTH - 1}", got "${selfResult}"`);
    }

    // Restore the original terminal node
    const curSource = (await ctx.query({ s: `deep:chain:${DEPTH - 1}`, p: "source" }))[0].o;
    await ctx.retract(`deep:chain:${DEPTH - 1}`, "source", curSource);
    await ctx.assert(`deep:chain:${DEPTH - 1}`, "source", oldSource);

    ok(`ctx.self correctly resolves at depth ${DEPTH - 1}`);
  } catch (e) {
    fail("ctx.self at depth 50", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 5: Large Data in Quads (100KB string)
// ═════════════════════════════════════════════════════════════════

async function testLargeDataInQuads(ctx: Ctx) {
  console.log("\n── Stress Test 5: Large Data in Quads (100KB) ──");

  const TARGET_SIZE = 100 * 1024; // 100KB
  const GRAPH = "stress-large";

  // 5a: Generate a 100KB string and assert it
  try {
    // Create a string with known, verifiable content (not just repeated chars)
    const chunks: string[] = [];
    const chunkSize = 100;
    for (let i = 0; chunks.join("").length < TARGET_SIZE; i++) {
      chunks.push(`[block-${String(i).padStart(6, "0")}:${String.fromCharCode(65 + (i % 26)).repeat(chunkSize - 20)}]`);
    }
    const largeValue = chunks.join("").slice(0, TARGET_SIZE);

    const storeStart = performance.now();
    await ctx.assert("stress:large:100kb", "payload", largeValue, GRAPH);
    const storeTime = performance.now() - storeStart;

    timing("Large Data", "100KB quad store", `${storeTime.toFixed(1)}ms`);
    ok(`stored 100KB quad in ${storeTime.toFixed(1)}ms (${largeValue.length.toLocaleString()} chars)`);
  } catch (e) {
    fail("store 100KB quad", e);
  }

  // 5b: Query it back and verify integrity
  try {
    const queryStart = performance.now();
    const quads = await ctx.query({ s: "stress:large:100kb", p: "payload", g: GRAPH });
    const queryTime = performance.now() - queryStart;

    if (quads.length !== 1) throw new Error(`expected 1 quad, got ${quads.length}`);
    if (quads[0].o.length !== TARGET_SIZE) {
      throw new Error(`expected ${TARGET_SIZE} chars, got ${quads[0].o.length}`);
    }

    // Verify content integrity: check first block, middle block, and last few chars
    if (!quads[0].o.startsWith("[block-000000:")) {
      throw new Error("first block corrupted");
    }
    // Check a mid-point block exists
    if (!quads[0].o.includes("[block-000500:")) {
      throw new Error("middle block missing or corrupted");
    }

    timing("Large Data", "100KB quad query", `${queryTime.toFixed(2)}ms`);
    ok(`queried 100KB quad back in ${queryTime.toFixed(2)}ms -- content integrity verified`);
  } catch (e) {
    fail("query 100KB quad", e);
  }

  // 5c: Store multiple large quads and query all
  try {
    const LARGE_COUNT = 10;
    const storeStart = performance.now();
    for (let i = 0; i < LARGE_COUNT; i++) {
      const data = `PAYLOAD-${i}-${"X".repeat(10240)}`; // 10KB each
      await ctx.assert(`stress:large:batch:${i}`, "payload", data, GRAPH);
    }
    const storeTime = performance.now() - storeStart;

    const queryStart = performance.now();
    const allLarge = await ctx.query({ p: "payload", g: GRAPH });
    const queryTime = performance.now() - queryStart;

    // 1 (100KB) + 10 (10KB each) = 11 total
    if (allLarge.length !== LARGE_COUNT + 1) {
      throw new Error(`expected ${LARGE_COUNT + 1} large quads, got ${allLarge.length}`);
    }

    timing("Large Data", `${LARGE_COUNT} x 10KB quads`, `store: ${storeTime.toFixed(1)}ms, query all: ${queryTime.toFixed(2)}ms`);
    ok(`stored ${LARGE_COUNT} x 10KB quads in ${storeTime.toFixed(1)}ms, queried all in ${queryTime.toFixed(2)}ms`);
  } catch (e) {
    fail("batch large quads", e);
  }

  // 5d: Store and retrieve a JSON-serialized large object
  try {
    const largeObj = {
      metadata: { version: 1, created: new Date().toISOString() },
      items: Array.from({ length: 1000 }, (_, i) => ({
        id: i,
        name: `item-${i}`,
        tags: [`tag-${i % 10}`, `category-${i % 5}`],
        value: Math.random(),
      })),
    };
    const jsonStr = JSON.stringify(largeObj);

    const storeStart = performance.now();
    await ctx.assert("stress:large:json", "payload", jsonStr, GRAPH);
    const storeTime = performance.now() - storeStart;

    const queryStart = performance.now();
    const result = await ctx.query({ s: "stress:large:json", p: "payload", g: GRAPH });
    const queryTime = performance.now() - queryStart;

    const parsed = JSON.parse(result[0].o);
    if (parsed.items.length !== 1000) throw new Error(`expected 1000 items, got ${parsed.items.length}`);
    if (parsed.items[500].id !== 500) throw new Error(`item 500 has wrong id`);

    timing("Large Data", "JSON object (1000 items)", `store: ${storeTime.toFixed(1)}ms, query+parse: ${queryTime.toFixed(2)}ms, size: ${(jsonStr.length / 1024).toFixed(1)}KB`);
    ok(`JSON object (${(jsonStr.length / 1024).toFixed(1)}KB) stored in ${storeTime.toFixed(1)}ms, queried+parsed in ${queryTime.toFixed(2)}ms`);
  } catch (e) {
    fail("large JSON object", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Stress Test 6: Many Concurrent Watchers (100 ctx.on subscribers)
// ═════════════════════════════════════════════════════════════════

async function testManyConcurrentWatchers(ctx: Ctx) {
  console.log("\n── Stress Test 6: Many Concurrent Watchers (100 subscribers) ──");

  const WATCHER_COUNT = 100;
  const GRAPH = "stress-watchers";

  // 6a: Register 100 subscribers watching the same pattern
  const fireCounts: number[] = new Array(WATCHER_COUNT).fill(0);
  const receivedQuads: any[][] = Array.from({ length: WATCHER_COUNT }, () => []);
  const unsubs: (() => void)[] = [];

  try {
    const regStart = performance.now();
    for (let i = 0; i < WATCHER_COUNT; i++) {
      const idx = i;
      const unsub = ctx.on({ p: "event", g: GRAPH }, (change) => {
        fireCounts[idx]++;
        receivedQuads[idx].push(change);
      });
      unsubs.push(unsub);
    }
    const regTime = performance.now() - regStart;

    timing("Concurrent Watchers", `register ${WATCHER_COUNT} subscribers`, `${regTime.toFixed(2)}ms`);
    ok(`registered ${WATCHER_COUNT} subscribers in ${regTime.toFixed(2)}ms`);
  } catch (e) {
    fail("register 100 subscribers", e);
  }

  // 6b: Trigger a single event and verify all 100 fire
  try {
    const triggerStart = performance.now();
    await ctx.assert("stress:event:1", "event", "triggered", GRAPH);
    const triggerTime = performance.now() - triggerStart;

    const firedCount = fireCounts.filter((c) => c === 1).length;
    if (firedCount !== WATCHER_COUNT) {
      throw new Error(`expected ${WATCHER_COUNT} subscribers to fire, only ${firedCount} did`);
    }

    timing("Concurrent Watchers", `single event -> ${WATCHER_COUNT} subscribers`, `${triggerTime.toFixed(2)}ms`);
    ok(`single event fired all ${WATCHER_COUNT} subscribers in ${triggerTime.toFixed(2)}ms`);
  } catch (e) {
    fail("trigger event for 100 subscribers", e);
  }

  // 6c: Trigger 10 events rapidly, verify all subscribers see all 10
  try {
    const rapidStart = performance.now();
    for (let e = 2; e <= 11; e++) {
      await ctx.assert(`stress:event:${e}`, "event", `event-${e}`, GRAPH);
    }
    const rapidTime = performance.now() - rapidStart;

    // Each subscriber should have fired 11 times total (1 + 10)
    const allCorrect = fireCounts.every((c) => c === 11);
    if (!allCorrect) {
      const counts = fireCounts.reduce((acc, c) => { acc[c] = (acc[c] || 0) + 1; return acc; }, {} as Record<number, number>);
      throw new Error(`not all subscribers fired 11 times: ${JSON.stringify(counts)}`);
    }

    timing("Concurrent Watchers", `10 events x ${WATCHER_COUNT} subscribers`, `${rapidTime.toFixed(2)}ms`);
    ok(`10 rapid events, all ${WATCHER_COUNT} subscribers fired correctly (11 total each) in ${rapidTime.toFixed(2)}ms`);
  } catch (e) {
    fail("10 rapid events", e);
  }

  // 6d: Verify all received correct change objects
  try {
    for (let i = 0; i < WATCHER_COUNT; i++) {
      if (receivedQuads[i].length !== 11) {
        throw new Error(`subscriber ${i}: expected 11 changes, got ${receivedQuads[i].length}`);
      }
      // Check first event
      if (receivedQuads[i][0].type !== "assert") {
        throw new Error(`subscriber ${i}: first change type should be "assert", got "${receivedQuads[i][0].type}"`);
      }
      if (receivedQuads[i][0].quad.o !== "triggered") {
        throw new Error(`subscriber ${i}: first event object should be "triggered"`);
      }
    }
    ok(`all ${WATCHER_COUNT} subscribers received correct change objects with quad data`);
  } catch (e) {
    fail("verify change object integrity", e);
  }

  // 6e: Unsubscribe all and verify no more fires
  try {
    for (const unsub of unsubs) {
      unsub();
    }

    // Reset counters
    fireCounts.fill(0);

    // Trigger another event
    await ctx.assert("stress:event:after-unsub", "event", "should-not-fire", GRAPH);

    const anyFired = fireCounts.some((c) => c > 0);
    if (anyFired) {
      throw new Error("some subscribers still fired after unsubscribe");
    }

    ok(`all ${WATCHER_COUNT} unsubscribed cleanly -- no fires after unsub`);
  } catch (e) {
    fail("unsubscribe 100 watchers", e);
  }

  // 6f: Register watchers with different patterns and verify selective firing
  try {
    const selectiveCounts = { patternA: 0, patternB: 0, patternC: 0 };

    const unsubA = ctx.on({ s: "stress:selective", p: "typeA", g: GRAPH }, () => { selectiveCounts.patternA++; });
    const unsubB = ctx.on({ s: "stress:selective", p: "typeB", g: GRAPH }, () => { selectiveCounts.patternB++; });
    const unsubC = ctx.on({ g: GRAPH }, () => { selectiveCounts.patternC++; });

    await ctx.assert("stress:selective", "typeA", "value-a", GRAPH);
    await ctx.assert("stress:selective", "typeB", "value-b", GRAPH);

    if (selectiveCounts.patternA !== 1) throw new Error(`patternA fired ${selectiveCounts.patternA} times, expected 1`);
    if (selectiveCounts.patternB !== 1) throw new Error(`patternB fired ${selectiveCounts.patternB} times, expected 1`);
    if (selectiveCounts.patternC !== 2) throw new Error(`patternC fired ${selectiveCounts.patternC} times, expected 2`);

    unsubA();
    unsubB();
    unsubC();

    ok("selective pattern matching works correctly across watchers");
  } catch (e) {
    fail("selective watcher patterns", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Main
// ═════════════════════════════════════════════════════════════════

async function main() {
  console.log("=== Holoiconic Stress Tests (Extended) ===");

  // Clean up any previous test DB
  try {
    unlinkSync(TEST_DB);
  } catch {}

  const ctx = await boot();

  await testMassQuadInsertion(ctx);
  await testConcurrentNodeExecution(ctx);
  await testRapidHotReload(ctx);
  await testDeepComposition(ctx);
  await testLargeDataInQuads(ctx);
  await testManyConcurrentWatchers(ctx);

  // Print timing summary
  console.log("\n── Performance Summary ──");
  for (const t of timings) {
    console.log(`  [${t.scenario}] ${t.metric}: ${t.value}`);
  }

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
