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

const TEST_DB = "test-programs.db";

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

// ── Program 1: Hello World ────────────────────────────────────────

async function testHelloWorld(ctx: Ctx) {
  console.log("\n-- Program 1: Hello World --");

  const source = `return 'Hello, holoiconic world!';`;

  try {
    await registerNode(ctx, "test:hello", source);
    const result = await ctx.call("test:hello");
    if (result !== "Hello, holoiconic world!")
      throw new Error(`expected greeting, got: ${result}`);
    ok("hello world returns correct string");
  } catch (e) {
    fail("hello world", e);
  }

  // Verify ctx.self works inside our node
  try {
    await registerNode(ctx, "test:whoami", `return ctx.self;`);
    const result = await ctx.call("test:whoami");
    if (result !== "test:whoami")
      throw new Error(`expected "test:whoami", got: ${result}`);
    ok("ctx.self returns node name correctly");
  } catch (e) {
    fail("ctx.self inside node", e);
  }
}

// ── Program 2: Arithmetic node ───────────────────────────────────

async function testArithmetic(ctx: Ctx) {
  console.log("\n-- Program 2: Arithmetic --");

  // Factorial
  const factorialSource = `
const n = args && args.n;
if (n === undefined) throw new Error('args.n required');
let result = 1;
for (let i = 2; i <= n; i++) result *= i;
return result;
`;

  try {
    await registerNode(ctx, "math:factorial", factorialSource);
    const r0 = await ctx.call("math:factorial", { n: 0 });
    const r1 = await ctx.call("math:factorial", { n: 1 });
    const r5 = await ctx.call("math:factorial", { n: 5 });
    const r10 = await ctx.call("math:factorial", { n: 10 });
    if (r0 !== 1) throw new Error(`0! = ${r0}, expected 1`);
    if (r1 !== 1) throw new Error(`1! = ${r1}, expected 1`);
    if (r5 !== 120) throw new Error(`5! = ${r5}, expected 120`);
    if (r10 !== 3628800) throw new Error(`10! = ${r10}, expected 3628800`);
    ok("factorial computes correctly for 0, 1, 5, 10");
  } catch (e) {
    fail("factorial", e);
  }

  // Fibonacci
  const fibSource = `
const n = args && args.n;
if (n === undefined) throw new Error('args.n required');
if (n <= 1) return n;
let a = 0, b = 1;
for (let i = 2; i <= n; i++) { [a, b] = [b, a + b]; }
return b;
`;

  try {
    await registerNode(ctx, "math:fibonacci", fibSource);
    const results = [];
    for (let i = 0; i <= 10; i++) {
      results.push(await ctx.call("math:fibonacci", { n: i }));
    }
    const expected = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
    const match = results.every((v, i) => v === expected[i]);
    if (!match) throw new Error(`fib sequence: ${results}, expected: ${expected}`);
    ok("fibonacci computes correct sequence 0..10");
  } catch (e) {
    fail("fibonacci", e);
  }
}

// ── Program 3: State via quads (counter) ─────────────────────────

async function testStateViaQuads(ctx: Ctx) {
  console.log("\n-- Program 3: State via quads (counter) --");

  const counterSource = `
const name = args && args.name || 'default';
const key = 'counter:' + name;

// Read current count from graph
const existing = await ctx.query({ s: key, p: 'count' });
let current = 0;
if (existing.length > 0) {
  current = parseInt(existing[0].o, 10);
  // Retract old value
  await ctx.retract(key, 'count', existing[0].o);
}

// Increment and store
const next = current + 1;
await ctx.assert(key, 'count', String(next));
return next;
`;

  try {
    await registerNode(ctx, "counter:inc", counterSource);

    const v1 = await ctx.call("counter:inc", { name: "alpha" });
    const v2 = await ctx.call("counter:inc", { name: "alpha" });
    const v3 = await ctx.call("counter:inc", { name: "alpha" });

    if (v1 !== 1) throw new Error(`call 1: got ${v1}, expected 1`);
    if (v2 !== 2) throw new Error(`call 2: got ${v2}, expected 2`);
    if (v3 !== 3) throw new Error(`call 3: got ${v3}, expected 3`);
    ok("counter increments correctly over 3 calls");
  } catch (e) {
    fail("counter increment", e);
  }

  // Verify independent counters
  try {
    const vb1 = await ctx.call("counter:inc", { name: "beta" });
    const vb2 = await ctx.call("counter:inc", { name: "beta" });
    const va4 = await ctx.call("counter:inc", { name: "alpha" }); // should continue from 3

    if (vb1 !== 1) throw new Error(`beta call 1: got ${vb1}, expected 1`);
    if (vb2 !== 2) throw new Error(`beta call 2: got ${vb2}, expected 2`);
    if (va4 !== 4) throw new Error(`alpha call 4: got ${va4}, expected 4`);
    ok("independent counters maintain separate state");
  } catch (e) {
    fail("independent counters", e);
  }

  // Verify persistence in graph
  try {
    const alphaQuads = await ctx.query({ s: "counter:alpha", p: "count" });
    if (alphaQuads.length !== 1) throw new Error(`expected 1 quad, got ${alphaQuads.length}`);
    if (alphaQuads[0].o !== "4") throw new Error(`stored value: ${alphaQuads[0].o}, expected "4"`);
    ok("counter state persisted correctly in graph");
  } catch (e) {
    fail("counter persistence", e);
  }
}

// ── Program 4: Node calling node ─────────────────────────────────

async function testNodeCallingNode(ctx: Ctx) {
  console.log("\n-- Program 4: Node calling node --");

  // A "double" node that calls factorial
  const doubleFactorial = `
const n = args && args.n;
const f = await ctx.call('math:factorial', { n });
return f * 2;
`;

  try {
    await registerNode(ctx, "math:doubleFactorial", doubleFactorial);
    const result = await ctx.call("math:doubleFactorial", { n: 5 });
    if (result !== 240) throw new Error(`expected 240, got ${result}`);
    ok("node composes via ctx.call (doubleFactorial(5) = 240)");
  } catch (e) {
    fail("node calling node", e);
  }

  // A pipeline: string transform chain
  const upperSource = `
const text = args && args.text;
if (!text) throw new Error('args.text required');
return text.toUpperCase();
`;
  const exciteSource = `
const text = args && args.text;
if (!text) throw new Error('args.text required');
return text + '!!!';
`;
  const pipelineSource = `
const text = args && args.text;
const step1 = await ctx.call('text:upper', { text });
const step2 = await ctx.call('text:excite', { text: step1 });
return step2;
`;

  try {
    await registerNode(ctx, "text:upper", upperSource);
    await registerNode(ctx, "text:excite", exciteSource);
    await registerNode(ctx, "text:pipeline", pipelineSource);

    const result = await ctx.call("text:pipeline", { text: "hello" });
    if (result !== "HELLO!!!") throw new Error(`expected "HELLO!!!", got "${result}"`);
    ok("pipeline chains 3 nodes correctly");
  } catch (e) {
    fail("pipeline", e);
  }

  // Recursive node (depth-limited)
  const countdownSource = `
const n = args && args.n;
if (n <= 0) return 'done';
return n + ' ' + await ctx.call('test:countdown', { n: n - 1 });
`;

  try {
    await registerNode(ctx, "test:countdown", countdownSource);
    const result = await ctx.call("test:countdown", { n: 5 });
    if (result !== "5 4 3 2 1 done")
      throw new Error(`expected "5 4 3 2 1 done", got "${result}"`);
    ok("recursive node via ctx.call works");
  } catch (e) {
    fail("recursive node", e);
  }
}

// ── Program 5: Reactive watcher ──────────────────────────────────

async function testReactiveWatcher(ctx: Ctx) {
  console.log("\n-- Program 5: Reactive watcher --");

  // Test basic ctx.on subscription
  try {
    const changes: any[] = [];
    const unsub = ctx.on({ s: "reactive:test" }, (change) => {
      changes.push(change);
    });

    await ctx.assert("reactive:test", "color", "red");
    await ctx.assert("reactive:test", "size", "large");

    if (changes.length !== 2)
      throw new Error(`expected 2 changes, got ${changes.length}`);
    if (changes[0].type !== "assert")
      throw new Error(`expected assert, got ${changes[0].type}`);
    if (changes[0].quad.p !== "color")
      throw new Error(`expected color, got ${changes[0].quad.p}`);

    unsub();
    // After unsubscribe, no more notifications
    await ctx.assert("reactive:test", "weight", "heavy");
    if (changes.length !== 2)
      throw new Error(`expected still 2 after unsub, got ${changes.length}`);

    ok("ctx.on fires for assert, unsub stops notifications");
  } catch (e) {
    fail("reactive assert", e);
  }

  // Test retract notifications
  try {
    const retractions: any[] = [];
    const unsub = ctx.on({ s: "reactive:test", p: "color" }, (change) => {
      if (change.type === "retract") retractions.push(change);
    });

    await ctx.retract("reactive:test", "color", "red");

    if (retractions.length !== 1)
      throw new Error(`expected 1 retraction, got ${retractions.length}`);
    if (retractions[0].quad.o !== "red")
      throw new Error(`expected red, got ${retractions[0].quad.o}`);

    unsub();
    ok("ctx.on fires for retract with correct quad data");
  } catch (e) {
    fail("reactive retract", e);
  }

  // Test a node that installs a watcher
  const watcherSource = `
const collected = [];
const unsub = ctx.on({ s: args.watch }, (change) => {
  collected.push({ type: change.type, p: change.quad.p, o: change.quad.o });
});
// Make some changes
await ctx.assert(args.watch, 'x', '1');
await ctx.assert(args.watch, 'y', '2');
await ctx.retract(args.watch, 'x', '1');
unsub();
return collected;
`;

  try {
    await registerNode(ctx, "test:watcher", watcherSource);
    const result = await ctx.call("test:watcher", { watch: "watcher:target" });
    if (result.length !== 3)
      throw new Error(`expected 3 events, got ${result.length}`);
    if (result[0].type !== "assert" || result[0].p !== "x")
      throw new Error(`event 0 wrong: ${JSON.stringify(result[0])}`);
    if (result[2].type !== "retract" || result[2].p !== "x")
      throw new Error(`event 2 wrong: ${JSON.stringify(result[2])}`);
    ok("node that installs watcher collects all events");
  } catch (e) {
    fail("node watcher", e);
  }
}

// ── Program 6: Self-modifying node ───────────────────────────────

async function testSelfModifyingNode(ctx: Ctx) {
  console.log("\n-- Program 6: Self-modifying node --");

  const v1Source = `return 'version-1';`;

  try {
    await registerNode(ctx, "test:evolving", v1Source);
    const r1 = await ctx.call("test:evolving");
    if (r1 !== "version-1") throw new Error(`expected "version-1", got "${r1}"`);
    ok("self-mod: initial version returns 'version-1'");
  } catch (e) {
    fail("self-mod initial", e);
  }

  // Now the node rewrites itself
  const selfRewriteSource = `
// First call: rewrite own source, return current version
const oldSource = (await ctx.query({ s: ctx.self, p: 'source' }))[0].o;
const newSource = "return 'version-2-rewritten';";
if (oldSource !== newSource) {
  await ctx.retract(ctx.self, 'source', oldSource);
  await ctx.assert(ctx.self, 'source', newSource);
  return 'rewrote-self';
}
return 'already-rewritten';
`;

  try {
    // Retract old source, assert new self-rewriting source
    await ctx.retract("test:evolving", "source", v1Source);
    await ctx.assert("test:evolving", "source", selfRewriteSource);

    const r2 = await ctx.call("test:evolving");
    if (r2 !== "rewrote-self") throw new Error(`expected "rewrote-self", got "${r2}"`);

    // Now call again -- should execute the NEW source it wrote
    const r3 = await ctx.call("test:evolving");
    if (r3 !== "version-2-rewritten")
      throw new Error(`expected "version-2-rewritten", got "${r3}"`);

    ok("self-mod: node rewrites own source, new behavior on next call");
  } catch (e) {
    fail("self-mod rewrite", e);
  }

  // Verify the compiler cache was invalidated (the new source is active)
  try {
    const src = await ctx.query({ s: "test:evolving", p: "source" });
    if (src.length !== 1) throw new Error(`expected 1 source quad, got ${src.length}`);
    if (src[0].o !== "return 'version-2-rewritten';")
      throw new Error(`stored source mismatch: ${src[0].o}`);
    ok("self-mod: graph stores the self-written source");
  } catch (e) {
    fail("self-mod persistence", e);
  }
}

// ── Program 7: Error handling ────────────────────────────────────

async function testErrorHandling(ctx: Ctx) {
  console.log("\n-- Program 7: Error handling --");

  // Node that throws
  const throwSource = `throw new Error('intentional kaboom');`;

  try {
    await registerNode(ctx, "test:thrower", throwSource);
    await ctx.call("test:thrower");
    fail("error propagation", "should have thrown");
  } catch (e: any) {
    if (e.message === "intentional kaboom") {
      ok("thrown error propagates with correct message");
    } else {
      fail("error propagation", `wrong message: ${e.message}`);
    }
  }

  // Node that throws a non-Error
  const throwStringSource = `throw 'string-error';`;

  try {
    await registerNode(ctx, "test:throwString", throwStringSource);
    await ctx.call("test:throwString");
    fail("string error propagation", "should have thrown");
  } catch (e: any) {
    if (e === "string-error" || (e.message && e.message.includes("string-error"))) {
      ok("thrown string error propagates");
    } else {
      fail("string error propagation", `unexpected: ${e}`);
    }
  }

  // Node that calls a non-existent node
  const callMissing = `return await ctx.call('nonexistent:node');`;

  try {
    await registerNode(ctx, "test:callMissing", callMissing);
    await ctx.call("test:callMissing");
    fail("missing node error", "should have thrown");
  } catch (e: any) {
    if (e.message && e.message.includes("no source found"))  {
      ok("calling non-existent node throws descriptive error");
    } else {
      fail("missing node error", `wrong message: ${e.message}`);
    }
  }

  // Error in nested call propagates
  const nestErrorSource = `
try {
  await ctx.call('test:thrower');
} catch (e) {
  return 'caught: ' + e.message;
}
`;

  try {
    await registerNode(ctx, "test:catchError", nestErrorSource);
    const result = await ctx.call("test:catchError");
    if (result !== "caught: intentional kaboom")
      throw new Error(`expected "caught: intentional kaboom", got "${result}"`);
    ok("nested call error can be caught by calling node");
  } catch (e) {
    fail("nested error catch", e);
  }
}

// ── Program 8: Graph queries ─────────────────────────────────────

async function testGraphQueries(ctx: Ctx) {
  console.log("\n-- Program 8: Graph queries --");

  const graphNodeSource = `
// Assert a small knowledge graph about animals
await ctx.assert('cat', 'is-a', 'animal', 'animals');
await ctx.assert('dog', 'is-a', 'animal', 'animals');
await ctx.assert('parrot', 'is-a', 'animal', 'animals');
await ctx.assert('cat', 'sound', 'meow', 'animals');
await ctx.assert('dog', 'sound', 'woof', 'animals');
await ctx.assert('parrot', 'sound', 'squawk', 'animals');
await ctx.assert('cat', 'legs', '4', 'animals');
await ctx.assert('dog', 'legs', '4', 'animals');
await ctx.assert('parrot', 'legs', '2', 'animals');

// Query: all animals
const animals = await ctx.query({ p: 'is-a', o: 'animal', g: 'animals' });

// Query: what sound does a dog make?
const dogSound = await ctx.query({ s: 'dog', p: 'sound', g: 'animals' });

// Query: which animals have 4 legs?
const fourLegged = await ctx.query({ p: 'legs', o: '4', g: 'animals' });

// Query: everything about cat
const catFacts = await ctx.query({ s: 'cat', g: 'animals' });

return {
  animalCount: animals.length,
  animalNames: animals.map(q => q.s).sort(),
  dogSound: dogSound[0] && dogSound[0].o,
  fourLeggedNames: fourLegged.map(q => q.s).sort(),
  catFactCount: catFacts.length,
  catPredicates: catFacts.map(q => q.p).sort(),
};
`;

  try {
    await registerNode(ctx, "test:graphQueries", graphNodeSource);
    const r = await ctx.call("test:graphQueries");

    if (r.animalCount !== 3) throw new Error(`expected 3 animals, got ${r.animalCount}`);
    ok("query by predicate+object finds all matching subjects");

    const names = r.animalNames;
    if (names[0] !== "cat" || names[1] !== "dog" || names[2] !== "parrot")
      throw new Error(`unexpected names: ${names}`);
    ok("animal subjects are cat, dog, parrot");

    if (r.dogSound !== "woof") throw new Error(`dog sound: ${r.dogSound}`);
    ok("query by subject+predicate returns correct object");

    if (r.fourLeggedNames.length !== 2) throw new Error(`four-legged: ${r.fourLeggedNames}`);
    if (r.fourLeggedNames[0] !== "cat" || r.fourLeggedNames[1] !== "dog")
      throw new Error(`unexpected four-legged: ${r.fourLeggedNames}`);
    ok("query by predicate+object filters correctly");

    if (r.catFactCount !== 3) throw new Error(`cat facts: ${r.catFactCount}`);
    if (JSON.stringify(r.catPredicates) !== '["is-a","legs","sound"]')
      throw new Error(`cat predicates: ${r.catPredicates}`);
    ok("query by subject returns all predicates for that entity");
  } catch (e) {
    fail("graph queries", e);
  }

  // Test graph isolation (queries in different graph namespaces don't mix)
  try {
    await ctx.assert("cat", "color", "orange", "pets");
    const inAnimals = await ctx.query({ s: "cat", p: "color", g: "animals" });
    const inPets = await ctx.query({ s: "cat", p: "color", g: "pets" });
    if (inAnimals.length !== 0)
      throw new Error(`expected 0 in animals graph, got ${inAnimals.length}`);
    if (inPets.length !== 1)
      throw new Error(`expected 1 in pets graph, got ${inPets.length}`);
    ok("graph parameter isolates quads between namespaces");
  } catch (e) {
    fail("graph isolation", e);
  }

  // Test idempotent assert (INSERT OR IGNORE)
  try {
    const q1 = await ctx.assert("cat", "is-a", "animal", "animals");
    const q2 = await ctx.assert("cat", "is-a", "animal", "animals");
    // Same quad, same id
    if (q1.id !== q2.id)
      throw new Error(`expected same id, got ${q1.id} vs ${q2.id}`);
    // Still only one quad
    const all = await ctx.query({ s: "cat", p: "is-a", o: "animal", g: "animals" });
    if (all.length !== 1) throw new Error(`expected 1, got ${all.length}`);
    ok("assert is idempotent (INSERT OR IGNORE)");
  } catch (e) {
    fail("idempotent assert", e);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  // Clean start
  try {
    unlinkSync(TEST_DB);
  } catch {}

  console.log("=== Holoiconic Custom Program Tests ===");
  const ctx = await boot();

  await testHelloWorld(ctx);
  await testArithmetic(ctx);
  await testStateViaQuads(ctx);
  await testNodeCallingNode(ctx);
  await testReactiveWatcher(ctx);
  await testSelfModifyingNode(ctx);
  await testErrorHandling(ctx);
  await testGraphQueries(ctx);

  // Summary
  console.log("\n── Summary ──");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup spawned controllers
  if (ctx._supervisorControllers) {
    for (const [, ac] of ctx._supervisorControllers) {
      ac.abort();
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
