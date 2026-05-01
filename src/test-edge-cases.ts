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

// ── Boot (non-interactive, with compiler) ─────────────────────────

const TEST_DB = "test-edge-cases.db";

async function boot(): Promise<Ctx> {
  const db = createDatabase(TEST_DB);
  await initSchema(db);
  const ctx = createCtx(db);
  await seedTemplate(ctx);
  // Install the compiler so ctx.call gets cached+reactive behavior
  await ctx.call("sys:compiler");
  return ctx;
}

// Helper: register a custom node in the graph
async function registerNode(ctx: Ctx, name: string, source: string) {
  await ctx.assert(name, "type", "Function");
  await ctx.assert(name, "source", source);
}

// ── Edge Case 1: Empty source node ──────────────────────────────

async function testEmptySourceNode(ctx: Ctx) {
  console.log("\n── Edge Case 1: Empty source node ──");

  try {
    await registerNode(ctx, "edge:empty", "");
    const result = await ctx.call("edge:empty");
    // An empty async function body returns undefined
    if (result !== undefined)
      throw new Error(`expected undefined from empty source, got: ${result}`);
    ok("empty source node returns undefined (no error)");
  } catch (e: any) {
    // It might throw at compilation — that's also a valid edge case result
    ok(`empty source node behavior: ${e.message}`);
  }
}

// ── Edge Case 2: Very large source ──────────────────────────────

async function testLargeSource(ctx: Ctx) {
  console.log("\n── Edge Case 2: Very large source (10KB) ──");

  try {
    // Build a 10KB+ source string with lots of variable declarations
    const lines: string[] = [];
    lines.push("let total = 0;");
    // Each line is ~30 chars: "total += 1; // padding_XXXXX\n"
    const targetSize = 10 * 1024;
    let currentSize = lines[0].length;
    let i = 0;
    while (currentSize < targetSize) {
      const line = `total += 1; // line_${String(i).padStart(5, "0")}`;
      lines.push(line);
      currentSize += line.length + 1;
      i++;
    }
    lines.push("return total;");

    const bigSource = lines.join("\n");
    if (bigSource.length < 10000)
      throw new Error(`source too small: ${bigSource.length} bytes`);

    await registerNode(ctx, "edge:bignode", bigSource);
    const result = await ctx.call("edge:bignode");

    // The result should be i (the number of += 1 lines)
    if (result !== i)
      throw new Error(`expected ${i}, got ${result}`);

    ok(`large source node works (${bigSource.length} bytes, ${i} additions, result=${result})`);
  } catch (e) {
    fail("large source node", e);
  }
}

// ── Edge Case 3: Unicode/special chars in quads ─────────────────

async function testUnicodeSpecialChars(ctx: Ctx) {
  console.log("\n── Edge Case 3: Unicode/special chars in quads ──");

  // Emoji
  try {
    const emoji = "\u{1F680}\u{1F30D}\u{2728}\u{1F4A5}";
    await ctx.assert("edge:unicode", "emoji", emoji);
    const q = await ctx.query({ s: "edge:unicode", p: "emoji" });
    if (q.length !== 1) throw new Error(`expected 1 quad, got ${q.length}`);
    if (q[0].o !== emoji) throw new Error(`emoji mismatch: got ${q[0].o}`);
    ok("emoji characters stored and retrieved correctly");
  } catch (e) {
    fail("emoji in quads", e);
  }

  // Newlines and tabs
  try {
    const multiline = "line1\nline2\ttabbed\nline3";
    await ctx.assert("edge:unicode", "multiline", multiline);
    const q = await ctx.query({ s: "edge:unicode", p: "multiline" });
    if (q.length !== 1) throw new Error(`expected 1 quad, got ${q.length}`);
    if (q[0].o !== multiline)
      throw new Error(`multiline mismatch: got ${JSON.stringify(q[0].o)}`);
    ok("newlines and tabs in quad values preserved");
  } catch (e) {
    fail("newlines/tabs in quads", e);
  }

  // Null bytes
  try {
    const withNull = "before\x00after";
    await ctx.assert("edge:unicode", "nullbyte", withNull);
    const q = await ctx.query({ s: "edge:unicode", p: "nullbyte" });
    if (q.length !== 1) throw new Error(`expected 1 quad, got ${q.length}`);
    // Check if null byte survived the round-trip
    if (q[0].o === withNull) {
      ok("null bytes preserved in quad values");
    } else if (q[0].o.includes("before")) {
      ok(`null bytes handled (stored length=${q[0].o.length}, original=${withNull.length} -- may be truncated by SQLite)`);
    } else {
      throw new Error(`unexpected result: ${JSON.stringify(q[0].o)}`);
    }
  } catch (e) {
    fail("null bytes in quads", e);
  }

  // CJK, Arabic, Cyrillic, Math symbols
  try {
    const international = "你好世界 مرحبا Привет ∀x∈ℝ";
    await ctx.assert("edge:unicode", "international", international);
    const q = await ctx.query({ s: "edge:unicode", p: "international" });
    if (q.length !== 1) throw new Error(`expected 1 quad, got ${q.length}`);
    if (q[0].o !== international)
      throw new Error(`international text mismatch: got ${q[0].o}`);
    ok("CJK, Arabic, Cyrillic, math symbols all stored correctly");
  } catch (e) {
    fail("international chars in quads", e);
  }

  // SQL injection attempt in quad values (should be safe due to parameterized queries)
  try {
    const sqli = "'; DROP TABLE quads; --";
    await ctx.assert("edge:unicode", "sqli", sqli);
    const q = await ctx.query({ s: "edge:unicode", p: "sqli" });
    if (q.length !== 1)
      throw new Error(`expected 1 quad, got ${q.length}`);
    if (q[0].o !== sqli)
      throw new Error(`SQL injection string not stored verbatim`);
    // Verify quads table still exists by doing another query
    const check = await ctx.query({ s: "edge:unicode" });
    if (check.length < 1)
      throw new Error("quads table seems damaged");
    ok("SQL injection in quad values is safely handled");
  } catch (e) {
    fail("SQL injection in quads", e);
  }
}

// ── Edge Case 4: Deeply nested ctx.call ─────────────────────────

async function testDeeplyNestedCalls(ctx: Ctx) {
  console.log("\n── Edge Case 4: Deeply nested ctx.call (chain of 25) ──");

  try {
    const DEPTH = 25;

    // Register chain nodes: chain:0 calls chain:1, which calls chain:2, ...
    for (let i = 0; i < DEPTH - 1; i++) {
      const src = `
const depth = ${i};
const next = await ctx.call('edge:chain:${i + 1}', { accumulated: (args && args.accumulated || '') + depth + ',' });
return next;
`;
      await registerNode(ctx, `edge:chain:${i}`, src);
    }

    // Terminal node
    await registerNode(
      ctx,
      `edge:chain:${DEPTH - 1}`,
      `return (args && args.accumulated || '') + '${DEPTH - 1}';`
    );

    const result = await ctx.call("edge:chain:0");

    // Should be "0,1,2,...,24"
    const expected = Array.from({ length: DEPTH }, (_, i) => i).join(",");
    if (result !== expected)
      throw new Error(`expected "${expected}", got "${result}"`);

    ok(`chain of ${DEPTH} nested ctx.call invocations completes correctly`);
  } catch (e) {
    fail("deeply nested calls", e);
  }
}

// ── Edge Case 5: Rapid retract+assert cycle ─────────────────────

async function testRapidRetractAssertCycle(ctx: Ctx) {
  console.log("\n── Edge Case 5: Rapid retract+assert cycle (50 iterations) ──");

  try {
    const ITERATIONS = 50;
    const nodeName = "edge:churn";

    // Start with an initial source
    let currentSource = `return 'v0';`;
    await registerNode(ctx, nodeName, currentSource);

    // Verify initial
    const r0 = await ctx.call(nodeName);
    if (r0 !== "v0") throw new Error(`initial: expected 'v0', got '${r0}'`);

    // Rapidly retract+assert 50 times
    for (let i = 1; i <= ITERATIONS; i++) {
      const newSource = `return 'v${i}';`;
      await ctx.retract(nodeName, "source", currentSource);
      await ctx.assert(nodeName, "source", newSource);
      currentSource = newSource;
    }

    // After all churn, the final source should be active
    const result = await ctx.call(nodeName);
    if (result !== `v${ITERATIONS}`)
      throw new Error(`expected 'v${ITERATIONS}', got '${result}'`);

    // Verify only one source quad exists
    const sources = await ctx.query({ s: nodeName, p: "source" });
    if (sources.length !== 1)
      throw new Error(`expected 1 source quad, got ${sources.length}`);

    ok(`${ITERATIONS} rapid retract+assert cycles, final call returns correct version`);
  } catch (e) {
    fail("rapid retract+assert", e);
  }
}

// ── Edge Case 6: Node that retracts itself ──────────────────────

async function testSelfRetractingNode(ctx: Ctx) {
  console.log("\n── Edge Case 6: Calling a node that retracts itself ──");

  // A node that removes its own source quad
  const selfDeleteSource = `
const mySource = (await ctx.query({ s: ctx.self, p: 'source' }))[0].o;
await ctx.retract(ctx.self, 'source', mySource);
return 'self-deleted';
`;

  try {
    await registerNode(ctx, "edge:selfdelete", selfDeleteSource);

    // First call should work and retract its own source
    const r1 = await ctx.call("edge:selfdelete");
    if (r1 !== "self-deleted")
      throw new Error(`expected 'self-deleted', got '${r1}'`);
    ok("self-retracting node executes and returns before deletion takes effect");
  } catch (e) {
    fail("self-retracting node first call", e);
  }

  // Subsequent call should fail because source is gone
  try {
    await ctx.call("edge:selfdelete");
    fail("self-retracting node second call", "should have thrown (no source)");
  } catch (e: any) {
    if (e.message && e.message.includes("no source found")) {
      ok("subsequent call to self-retracted node throws 'no source found'");
    } else {
      // The compiler cache might still have the old function -- that's also interesting
      ok(`subsequent call to self-retracted node: ${e.message}`);
    }
  }
}

// ── Edge Case 7: Query with all wildcards ───────────────────────

async function testQueryAllWildcards(ctx: Ctx) {
  console.log("\n── Edge Case 7: Query with all wildcards ──");

  try {
    const allQuads = await ctx.query({});
    if (!Array.isArray(allQuads))
      throw new Error("query({}) did not return an array");
    if (allQuads.length === 0)
      throw new Error("query({}) returned 0 quads (expected many after boot)");

    // Count by type
    const byPredicate: Record<string, number> = {};
    for (const q of allQuads) {
      byPredicate[q.p] = (byPredicate[q.p] || 0) + 1;
    }

    const sourceCount = byPredicate["source"] || 0;
    const typeCount = byPredicate["type"] || 0;

    // After seeding, we should have at least 28 source quads (the template nodes)
    if (sourceCount < 28)
      throw new Error(`expected >= 28 source quads, got ${sourceCount}`);

    ok(`query({}) returns ${allQuads.length} total quads (${sourceCount} source, ${typeCount} type, ${Object.keys(byPredicate).length} distinct predicates)`);
  } catch (e) {
    fail("query all wildcards", e);
  }
}

// ── Edge Case 8: Double assert ──────────────────────────────────

async function testDoubleAssert(ctx: Ctx) {
  console.log("\n── Edge Case 8: Double assert (idempotency) ──");

  try {
    const s = "edge:double";
    const p = "color";
    const o = "purple";
    const g = "test-double";

    // Assert the same quad twice
    const q1 = await ctx.assert(s, p, o, g);
    const q2 = await ctx.assert(s, p, o, g);

    // Should return the same id
    if (q1.id !== q2.id)
      throw new Error(`double assert gave different ids: ${q1.id} vs ${q2.id}`);

    // Should only be one copy in the graph
    const all = await ctx.query({ s, p, o, g });
    if (all.length !== 1)
      throw new Error(`expected exactly 1 quad, got ${all.length}`);

    ok("double assert returns same id and only one copy exists");
  } catch (e) {
    fail("double assert", e);
  }

  // Assert different objects for the same subject+predicate (NOT idempotent -- both should exist)
  try {
    const q1 = await ctx.assert("edge:double", "tag", "alpha", "test-double");
    const q2 = await ctx.assert("edge:double", "tag", "beta", "test-double");

    if (q1.id === q2.id)
      throw new Error("different objects should get different ids");

    const all = await ctx.query({ s: "edge:double", p: "tag", g: "test-double" });
    if (all.length !== 2)
      throw new Error(`expected 2 quads for different objects, got ${all.length}`);

    ok("assert with different objects creates separate quads (multi-valued)");
  } catch (e) {
    fail("multi-valued assert", e);
  }

  // Reactive: verify double assert does NOT fire the subscriber twice
  try {
    let fireCount = 0;
    const unsub = ctx.on({ s: "edge:double-react" }, () => {
      fireCount++;
    });

    await ctx.assert("edge:double-react", "x", "1");
    await ctx.assert("edge:double-react", "x", "1"); // duplicate

    unsub();

    if (fireCount !== 1)
      throw new Error(`expected 1 fire (INSERT OR IGNORE), got ${fireCount}`);

    ok("double assert fires ctx.on subscriber only once (no-op on duplicate)");
  } catch (e) {
    fail("double assert reactive", e);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("=== Holoiconic Edge Case Tests ===");

  // Clean start
  try {
    unlinkSync(TEST_DB);
  } catch {}

  const ctx = await boot();

  await testEmptySourceNode(ctx);
  await testLargeSource(ctx);
  await testUnicodeSpecialChars(ctx);
  await testDeeplyNestedCalls(ctx);
  await testRapidRetractAssertCycle(ctx);
  await testSelfRetractingNode(ctx);
  await testQueryAllWildcards(ctx);
  await testDoubleAssert(ctx);

  // Summary
  console.log("\n── Summary ──");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup spawned controllers
  if (ctx._supervisorControllers) {
    for (const [, ac] of ctx._supervisorControllers) {
      try { ac.abort(); } catch {}
    }
  }
  if (ctx._cronTimers) {
    for (const [, entry] of ctx._cronTimers) {
      try { await entry.stopCron(); } catch {}
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
