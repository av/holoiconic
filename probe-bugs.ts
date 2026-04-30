import { createDatabase, initSchema } from "./src/db.ts";
import { createCtx, type Ctx } from "./src/ctx.ts";
import { seedTemplate } from "./src/template.ts";

// ── Test harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string) {
  passed++;
  console.log(`  PASS  ${label}`);
}

function fail(label: string, err: any) {
  failed++;
  const msg = err instanceof Error ? err.message : String(err);
  console.log(`  FAIL  ${label}: ${msg}`);
}

// ── Boot ──────────────────────────────────────────────────────────

async function boot(): Promise<Ctx> {
  const db = createDatabase("probe-test.db");
  await initSchema(db);
  const ctx = createCtx(db);
  await seedTemplate(ctx);
  return ctx;
}

// ── Probe 1: ctx.on cleanup ─────────────────────────────────────

async function probeOnCleanup(ctx: Ctx) {
  console.log("\n── Probe 1: ctx.on cleanup ──");

  try {
    let callCount = 0;

    // Subscribe to a specific pattern
    const unsub = ctx.on({ s: "probe:oncleanup", p: "value" }, (change) => {
      callCount++;
    });

    // Assert a matching quad — should fire
    await ctx.assert("probe:oncleanup", "value", "first");
    if (callCount !== 1)
      throw new Error(`expected callCount=1 after first assert, got ${callCount}`);

    // Unsubscribe
    unsub();

    // Assert another matching quad — should NOT fire
    await ctx.assert("probe:oncleanup", "value", "second");
    if (callCount !== 1)
      throw new Error(`expected callCount=1 after unsubscribe, got ${callCount} (callback still firing!)`);

    ok("ctx.on cleanup: callback not called after unsubscribe");
  } catch (e) {
    fail("ctx.on cleanup", e);
  }

  // Test: double unsubscribe should not throw
  try {
    const unsub = ctx.on({ s: "probe:double-unsub" }, () => {});
    unsub();
    unsub(); // second call should be a no-op
    ok("ctx.on double unsubscribe is safe (no error)");
  } catch (e) {
    fail("ctx.on double unsubscribe", e);
  }
}

// ── Probe 2: Concurrent assertions ─────────────────────────────

async function probeConcurrentAssertions(ctx: Ctx) {
  console.log("\n── Probe 2: Concurrent assertions ──");

  try {
    // Assert the same quad from multiple concurrent calls
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(ctx.assert("probe:concurrent", "value", "same-value"));
    }

    // All should succeed without errors
    const results = await Promise.all(promises);

    // Verify exactly one quad exists
    const quads = await ctx.query({ s: "probe:concurrent", p: "value", o: "same-value" });
    if (quads.length !== 1)
      throw new Error(`expected exactly 1 quad, got ${quads.length}`);

    ok("concurrent assertions: no errors, exactly one quad exists");
  } catch (e) {
    fail("concurrent assertions", e);
  }

  // Test concurrent assertions of DIFFERENT values
  try {
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(ctx.assert("probe:concurrent-multi", "value", `val-${i}`));
    }
    await Promise.all(promises);

    const quads = await ctx.query({ s: "probe:concurrent-multi", p: "value" });
    if (quads.length !== 10)
      throw new Error(`expected 10 distinct quads, got ${quads.length}`);

    ok("concurrent assertions of different values: all 10 created");
  } catch (e) {
    fail("concurrent assertions different values", e);
  }
}

// ── Probe 3: Query with all wildcards ───────────────────────────

async function probeQueryWildcard(ctx: Ctx) {
  console.log("\n── Probe 3: Query with all wildcards ──");

  try {
    // ctx.query({}) should return all quads
    const allQuads = await ctx.query({});
    if (!Array.isArray(allQuads))
      throw new Error(`expected array, got ${typeof allQuads}`);
    if (allQuads.length < 50)
      throw new Error(`expected many quads (seeded graph), got ${allQuads.length}`);

    // Verify each quad has expected fields
    for (const q of allQuads.slice(0, 5)) {
      if (typeof q.s !== "string" || typeof q.p !== "string" || typeof q.o !== "string" || typeof q.g !== "string")
        throw new Error(`quad missing fields: ${JSON.stringify(q)}`);
      if (typeof q.id !== "number")
        throw new Error(`quad missing numeric id: ${JSON.stringify(q)}`);
    }

    ok(`ctx.query({}) returns all quads (${allQuads.length} quads)`);
  } catch (e) {
    fail("query all wildcards", e);
  }
}

// ── Probe 4: Query with graph filter ────────────────────────────

async function probeQueryGraphFilter(ctx: Ctx) {
  console.log("\n── Probe 4: Query with graph filter ──");

  try {
    // Assert quads in a specific graph
    await ctx.assert("probe:graph-a", "value", "in-test-graph", "test-graph-1");
    await ctx.assert("probe:graph-b", "value", "in-test-graph", "test-graph-1");
    await ctx.assert("probe:graph-c", "value", "in-default-graph");  // default graph '_'

    // Query with graph filter
    const testGraphQuads = await ctx.query({ g: "test-graph-1" });
    if (!Array.isArray(testGraphQuads))
      throw new Error(`expected array, got ${typeof testGraphQuads}`);
    if (testGraphQuads.length < 2)
      throw new Error(`expected at least 2 quads in test-graph-1, got ${testGraphQuads.length}`);

    // All returned quads should be in the specified graph
    for (const q of testGraphQuads) {
      if (q.g !== "test-graph-1")
        throw new Error(`expected g='test-graph-1', got '${q.g}'`);
    }

    // Verify the default-graph quad is NOT in the test-graph-1 results
    const defaultInTestGraph = testGraphQuads.find(q => q.s === "probe:graph-c");
    if (defaultInTestGraph)
      throw new Error("default-graph quad should not appear in test-graph-1 query");

    ok("ctx.query with graph filter returns only matching graph quads");
  } catch (e) {
    fail("query with graph filter", e);
  }

  // Test combining graph filter with other filters
  try {
    const specific = await ctx.query({ s: "probe:graph-a", g: "test-graph-1" });
    if (specific.length !== 1)
      throw new Error(`expected 1 quad, got ${specific.length}`);
    if (specific[0].o !== "in-test-graph")
      throw new Error(`expected 'in-test-graph', got '${specific[0].o}'`);

    ok("ctx.query combines graph filter with subject filter");
  } catch (e) {
    fail("query combined graph+subject", e);
  }
}

// ── Probe 5: Retract nonexistent quad ───────────────────────────

async function probeRetractNonexistent(ctx: Ctx) {
  console.log("\n── Probe 5: Retract nonexistent quad ──");

  try {
    // Retract a quad that doesn't exist — should be a no-op
    await ctx.retract("probe:nonexistent", "value", "doesnt-exist");
    ok("retract nonexistent quad is a no-op (no error)");
  } catch (e) {
    fail("retract nonexistent quad", e);
  }

  // Verify no callback fires for nonexistent retraction
  try {
    let fired = false;
    const unsub = ctx.on({ s: "probe:nonexistent-retract" }, () => {
      fired = true;
    });

    await ctx.retract("probe:nonexistent-retract", "value", "doesnt-exist");

    if (fired)
      throw new Error("callback should NOT fire for retracting a nonexistent quad");

    unsub();
    ok("no callback fires when retracting nonexistent quad");
  } catch (e) {
    fail("retract nonexistent no callback", e);
  }
}

// ── Probe 6: ctx.self inside nested calls ───────────────────────

async function probeCtxSelfNested(ctx: Ctx) {
  console.log("\n── Probe 6: ctx.self inside nested calls ──");

  // Install sys:compiler first for cached calls
  await ctx.call("sys:compiler");

  try {
    // Create node B that returns its own ctx.self
    await ctx.assert("probe:inner", "type", "Function");
    await ctx.assert("probe:inner", "source", "return ctx.self;");

    // Create node A that calls B and returns both selfs
    await ctx.assert("probe:outer", "type", "Function");
    await ctx.assert("probe:outer", "source", `
const outerSelf = ctx.self;
const innerSelf = await ctx.call('probe:inner');
return { outerSelf, innerSelf };
`);

    const result = await ctx.call("probe:outer");

    if (result.outerSelf !== "probe:outer")
      throw new Error(`expected outerSelf='probe:outer', got '${result.outerSelf}'`);
    if (result.innerSelf !== "probe:inner")
      throw new Error(`expected innerSelf='probe:inner', got '${result.innerSelf}'`);

    ok("ctx.self correctly scoped: outer='probe:outer', inner='probe:inner'");
  } catch (e) {
    fail("ctx.self nested calls", e);
  }

  // Test deeply nested calls (3 levels)
  try {
    await ctx.assert("probe:level3", "type", "Function");
    await ctx.assert("probe:level3", "source", "return ctx.self;");

    await ctx.assert("probe:level2", "type", "Function");
    await ctx.assert("probe:level2", "source", `
const mySelf = ctx.self;
const childSelf = await ctx.call('probe:level3');
return { mySelf, childSelf };
`);

    await ctx.assert("probe:level1", "type", "Function");
    await ctx.assert("probe:level1", "source", `
const mySelf = ctx.self;
const child = await ctx.call('probe:level2');
return { mySelf, child };
`);

    const result = await ctx.call("probe:level1");

    if (result.mySelf !== "probe:level1")
      throw new Error(`expected level1 self, got '${result.mySelf}'`);
    if (result.child.mySelf !== "probe:level2")
      throw new Error(`expected level2 self, got '${result.child.mySelf}'`);
    if (result.child.childSelf !== "probe:level3")
      throw new Error(`expected level3 self, got '${result.child.childSelf}'`);

    ok("ctx.self correctly scoped through 3 nested levels");
  } catch (e) {
    fail("ctx.self deeply nested", e);
  }
}

// ── Probe 7: sys:compiler cache invalidation ────────────────────

async function probeCompilerCacheInvalidation(ctx: Ctx) {
  console.log("\n── Probe 7: sys:compiler cache invalidation ──");

  // sys:compiler should already be installed from probe 6
  try {
    // Create a node
    await ctx.assert("probe:cached", "type", "Function");
    await ctx.assert("probe:cached", "source", "return 'original'");

    // Call it to populate cache
    const r1 = await ctx.call("probe:cached");
    if (r1 !== "original")
      throw new Error(`expected 'original', got '${r1}'`);

    // Update source — triggers cache invalidation via ctx.on watcher
    await ctx.retract("probe:cached", "source", "return 'original'");
    await ctx.assert("probe:cached", "source", "return 'updated'");

    // Call again — should use new source (cache was invalidated)
    const r2 = await ctx.call("probe:cached");
    if (r2 !== "updated")
      throw new Error(`expected 'updated' after cache invalidation, got '${r2}'`);

    ok("sys:compiler cache invalidated after source change");
  } catch (e) {
    fail("sys:compiler cache invalidation", e);
  }

  // Test: retract source but DON'T assert new one — calling should fail
  try {
    await ctx.assert("probe:delete-source", "type", "Function");
    await ctx.assert("probe:delete-source", "source", "return 'exists'");

    const r1 = await ctx.call("probe:delete-source");
    if (r1 !== "exists") throw new Error(`setup failed: got '${r1}'`);

    await ctx.retract("probe:delete-source", "source", "return 'exists'");

    try {
      await ctx.call("probe:delete-source");
      throw new Error("should have thrown for missing source");
    } catch (e: any) {
      if (!e.message.includes("no source found"))
        throw e;
    }

    ok("calling node after source retracted throws 'no source found'");
  } catch (e) {
    fail("cache invalidation after source retract", e);
  }
}

// ── Probe 8: Supervisor with AbortController ────────────────────

async function probeSupervisorAbort(ctx: Ctx) {
  console.log("\n── Probe 8: Supervisor with AbortController ──");

  // Spawn the supervisor
  await ctx.call("spawn", { node: "sys:supervisor" });
  await new Promise(r => setTimeout(r, 50));

  try {
    // Create a node that sets a flag and waits for abort
    await ctx.assert("probe:abortable", "type", "Function");
    await ctx.assert("probe:abortable", "source", `
await ctx.assert('probe:abortable', 'status', 'running');
const signal = args && args.signal;
if (signal) {
  await new Promise(r => signal.addEventListener('abort', r, { once: true }));
  await ctx.assert('probe:abortable', 'status', 'stopped');
}
`);

    // Spawn it
    await ctx.call("spawn", { node: "probe:abortable" });
    await new Promise(r => setTimeout(r, 150));

    // Verify it's running
    const running = await ctx.query({ s: "probe:abortable", p: "status", o: "running" });
    if (running.length === 0)
      throw new Error("probe:abortable did not start");

    // Abort it via the supervisor controller
    const controllers = ctx._supervisorControllers;
    if (!controllers) throw new Error("no _supervisorControllers found");

    const ac = controllers.get("probe:abortable");
    if (!ac) throw new Error("no controller found for probe:abortable");

    ac.abort();
    await new Promise(r => setTimeout(r, 200));

    // Verify it stopped (the node asserts 'stopped' status on abort)
    const stopped = await ctx.query({ s: "probe:abortable", p: "status", o: "stopped" });
    if (stopped.length === 0)
      throw new Error("probe:abortable did not stop after abort");

    ok("spawned node stops when AbortController signal is aborted");
  } catch (e) {
    fail("supervisor abort", e);
  }
}

// ── Additional probes ───────────────────────────────────────────

async function probeEdgeCases(ctx: Ctx) {
  console.log("\n── Additional edge case probes ──");

  // Probe: assert with empty string values
  try {
    const q = await ctx.assert("probe:empty", "value", "");
    if (q.o !== "")
      throw new Error(`expected empty string, got '${q.o}'`);
    const found = await ctx.query({ s: "probe:empty", p: "value", o: "" });
    if (found.length !== 1)
      throw new Error(`expected 1 quad with empty value, got ${found.length}`);
    ok("assert with empty string object value works");
  } catch (e) {
    fail("assert empty string", e);
  }

  // Probe: assert with very long string
  try {
    const longStr = "x".repeat(100000);
    const q = await ctx.assert("probe:long", "value", longStr);
    if (q.o.length !== 100000)
      throw new Error(`expected 100000 chars, got ${q.o.length}`);
    ok("assert with 100K character string works");
  } catch (e) {
    fail("assert long string", e);
  }

  // Probe: assert with special characters (excluding null byte)
  try {
    const special = "hello\nworld\ttab\"quote'single\\backslash";
    const q = await ctx.assert("probe:special", "value", special);
    const found = await ctx.query({ s: "probe:special", p: "value" });
    if (found.length !== 1)
      throw new Error(`expected 1 quad, got ${found.length}`);
    if (found[0].o !== special)
      throw new Error(`special chars round-trip failed: got '${found[0].o}'`);
    ok("assert with special characters round-trips correctly");
  } catch (e) {
    fail("assert special chars", e);
  }

  // Probe: null byte in strings gets truncated by SQLite (known limitation)
  try {
    const withNull = "before\0after";
    await ctx.assert("probe:null-byte", "value", withNull);
    const found = await ctx.query({ s: "probe:null-byte", p: "value" });
    if (found.length !== 1)
      throw new Error(`expected 1 quad, got ${found.length}`);
    // SQLite truncates at null byte - this is a known limitation, not a holoiconic bug
    if (found[0].o === withNull) {
      ok("null byte in strings preserved (unexpected - SQLite usually truncates)");
    } else if (found[0].o === "before") {
      ok("null byte causes SQLite truncation (known limitation, not a holoiconic bug)");
    } else {
      throw new Error(`unexpected result for null byte: '${found[0].o}'`);
    }
  } catch (e) {
    fail("null byte handling", e);
  }

  // Probe: query with only predicate filter
  try {
    const typeQuads = await ctx.query({ p: "type" });
    if (typeQuads.length < 20)
      throw new Error(`expected many type quads, got ${typeQuads.length}`);
    ok(`query with only predicate filter works (${typeQuads.length} results)`);
  } catch (e) {
    fail("query predicate only", e);
  }

  // Probe: assert duplicate quad returns same quad (INSERT OR IGNORE semantics)
  try {
    const q1 = await ctx.assert("probe:dup", "value", "same");
    const q2 = await ctx.assert("probe:dup", "value", "same");
    if (q1.id !== q2.id)
      throw new Error(`expected same id for duplicate assert, got ${q1.id} vs ${q2.id}`);
    ok("duplicate assert returns same quad (idempotent)");
  } catch (e) {
    fail("duplicate assert", e);
  }

  // Probe: ctx.on only fires for matching pattern, not all changes
  try {
    let matchCount = 0;
    let unrelatedCount = 0;

    const unsub1 = ctx.on({ s: "probe:target-only" }, () => { matchCount++; });
    const unsub2 = ctx.on({ s: "probe:unrelated-target" }, () => { unrelatedCount++; });

    await ctx.assert("probe:target-only", "x", "1");
    await ctx.assert("probe:other-subject", "x", "2");

    if (matchCount !== 1) throw new Error(`expected 1 match, got ${matchCount}`);
    if (unrelatedCount !== 0) throw new Error(`expected 0 unrelated, got ${unrelatedCount}`);

    unsub1();
    unsub2();
    ok("ctx.on pattern matching is selective (no false positives)");
  } catch (e) {
    fail("ctx.on pattern selectivity", e);
  }

  // Probe: calling a node with no args — args should be undefined
  try {
    await ctx.assert("probe:no-args", "type", "Function");
    await ctx.assert("probe:no-args", "source", "return typeof args;");
    const result = await ctx.call("probe:no-args");
    if (result !== "undefined")
      throw new Error(`expected typeof args = 'undefined', got '${result}'`);
    ok("calling node without args: args is undefined");
  } catch (e) {
    fail("call without args", e);
  }

  // Probe: retract then re-assert same quad
  try {
    await ctx.assert("probe:re-assert", "value", "original");
    await ctx.retract("probe:re-assert", "value", "original");

    const gone = await ctx.query({ s: "probe:re-assert", p: "value" });
    if (gone.length !== 0)
      throw new Error(`expected 0 quads after retract, got ${gone.length}`);

    await ctx.assert("probe:re-assert", "value", "original");
    const back = await ctx.query({ s: "probe:re-assert", p: "value" });
    if (back.length !== 1)
      throw new Error(`expected 1 quad after re-assert, got ${back.length}`);

    ok("retract then re-assert same quad works");
  } catch (e) {
    fail("retract and re-assert", e);
  }

  // Probe: subscriber error should not crash other subscribers
  try {
    let secondCalled = false;
    const unsub1 = ctx.on({ s: "probe:sub-error" }, () => {
      throw new Error("deliberate subscriber error");
    });
    const unsub2 = ctx.on({ s: "probe:sub-error" }, () => {
      secondCalled = true;
    });

    await ctx.assert("probe:sub-error", "value", "test");

    if (!secondCalled)
      throw new Error("second subscriber was not called after first threw");

    unsub1();
    unsub2();
    ok("subscriber error does not prevent other subscribers from firing");
  } catch (e) {
    fail("subscriber error isolation", e);
  }

  // Probe: multiple on() subscriptions for same pattern
  try {
    let count1 = 0;
    let count2 = 0;
    const unsub1 = ctx.on({ s: "probe:multi-sub" }, () => { count1++; });
    const unsub2 = ctx.on({ s: "probe:multi-sub" }, () => { count2++; });

    await ctx.assert("probe:multi-sub", "value", "test");

    if (count1 !== 1 || count2 !== 1)
      throw new Error(`expected both counts=1, got ${count1} and ${count2}`);

    unsub1();
    unsub2();
    ok("multiple subscriptions for same pattern both fire");
  } catch (e) {
    fail("multiple subscriptions", e);
  }
}

// ── Probe: ctx.on fires for retract too ─────────────────────────

async function probeOnRetract(ctx: Ctx) {
  console.log("\n── Probe: ctx.on fires for retract ──");

  try {
    let assertFired = false;
    let retractFired = false;

    const unsub = ctx.on({ s: "probe:retract-watch" }, (change) => {
      if (change.type === "assert") assertFired = true;
      if (change.type === "retract") retractFired = true;
    });

    await ctx.assert("probe:retract-watch", "value", "present");
    if (!assertFired) throw new Error("assert did not fire");

    await ctx.retract("probe:retract-watch", "value", "present");
    if (!retractFired) throw new Error("retract did not fire callback");

    unsub();
    ok("ctx.on fires for both assert and retract");
  } catch (e) {
    fail("ctx.on retract", e);
  }
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const { unlinkSync } = await import("node:fs");
  try { unlinkSync("probe-test.db"); } catch {}

  console.log("=== Holoiconic Bug Probe ===");
  const ctx = await boot();

  await probeOnCleanup(ctx);
  await probeConcurrentAssertions(ctx);
  await probeQueryWildcard(ctx);
  await probeQueryGraphFilter(ctx);
  await probeRetractNonexistent(ctx);
  await probeCtxSelfNested(ctx);
  await probeCompilerCacheInvalidation(ctx);
  await probeSupervisorAbort(ctx);
  await probeEdgeCases(ctx);
  await probeOnRetract(ctx);

  console.log("\n── Summary ──");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup
  if (ctx._supervisorControllers) {
    for (const [, ac] of ctx._supervisorControllers) {
      ac.abort();
    }
  }

  try { unlinkSync("probe-test.db"); } catch {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
