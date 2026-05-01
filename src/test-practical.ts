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

const TEST_DB = "test-practical.db";

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
// Scenario 1: Key-Value Store
// ═════════════════════════════════════════════════════════════════

async function testKeyValueStore(ctx: Ctx) {
  console.log("\n── Scenario 1: Key-Value Store ──");

  // kv:set — stores a value for a key in the 'kv' graph namespace
  await registerNode(
    ctx,
    "kv:set",
    `
const key = args && args.key;
const value = args && args.value;
if (!key) throw new Error('[kv:set] args.key is required');
if (value === undefined) throw new Error('[kv:set] args.value is required');

// Retract any existing value for this key
const existing = await ctx.query({ s: key, p: 'value', g: 'kv' });
for (const eq of existing) {
  await ctx.retract(eq.s, eq.p, eq.o, eq.g);
}

// Assert the new value (serialize objects as JSON)
const stored = typeof value === 'object' ? JSON.stringify(value) : String(value);
await ctx.assert(key, 'value', stored, 'kv');
return { key, value: stored };
`
  );

  // kv:get — retrieves a value by key
  await registerNode(
    ctx,
    "kv:get",
    `
const key = args && args.key;
if (!key) throw new Error('[kv:get] args.key is required');
const results = await ctx.query({ s: key, p: 'value', g: 'kv' });
if (results.length === 0) return null;
return results[0].o;
`
  );

  // kv:delete — removes a key from the store
  await registerNode(
    ctx,
    "kv:delete",
    `
const key = args && args.key;
if (!key) throw new Error('[kv:delete] args.key is required');
const existing = await ctx.query({ s: key, p: 'value', g: 'kv' });
if (existing.length === 0) return false;
for (const eq of existing) {
  await ctx.retract(eq.s, eq.p, eq.o, eq.g);
}
return true;
`
  );

  // Test 1a: Basic CRUD
  try {
    await ctx.call("kv:set", { key: "user:1", value: "Alice" });
    const v1 = await ctx.call("kv:get", { key: "user:1" });
    if (v1 !== "Alice") throw new Error(`expected "Alice", got "${v1}"`);
    ok("kv: set and get a string value");
  } catch (e) {
    fail("kv: basic set/get", e);
  }

  // Test 1b: Overwrite existing key
  try {
    await ctx.call("kv:set", { key: "user:1", value: "Bob" });
    const v2 = await ctx.call("kv:get", { key: "user:1" });
    if (v2 !== "Bob") throw new Error(`expected "Bob", got "${v2}"`);

    // Verify only one value exists (no stale data)
    const all = await ctx.query({ s: "user:1", p: "value", g: "kv" });
    if (all.length !== 1) throw new Error(`expected 1 quad, got ${all.length}`);
    ok("kv: overwrite replaces value cleanly");
  } catch (e) {
    fail("kv: overwrite", e);
  }

  // Test 1c: Missing key returns null
  try {
    const missing = await ctx.call("kv:get", { key: "nonexistent:key" });
    if (missing !== null) throw new Error(`expected null, got ${missing}`);
    ok("kv: missing key returns null");
  } catch (e) {
    fail("kv: missing key", e);
  }

  // Test 1d: Delete existing key
  try {
    await ctx.call("kv:set", { key: "temp:data", value: "ephemeral" });
    const deleted = await ctx.call("kv:delete", { key: "temp:data" });
    if (deleted !== true) throw new Error(`expected true, got ${deleted}`);
    const after = await ctx.call("kv:get", { key: "temp:data" });
    if (after !== null) throw new Error(`expected null after delete, got "${after}"`);
    ok("kv: delete removes key and subsequent get returns null");
  } catch (e) {
    fail("kv: delete", e);
  }

  // Test 1e: Delete nonexistent key returns false
  try {
    const deleted = await ctx.call("kv:delete", { key: "ghost:key" });
    if (deleted !== false) throw new Error(`expected false, got ${deleted}`);
    ok("kv: delete nonexistent key returns false");
  } catch (e) {
    fail("kv: delete nonexistent", e);
  }

  // Test 1f: Store structured data (JSON)
  try {
    const obj = { name: "Charlie", age: 30, tags: ["admin", "user"] };
    await ctx.call("kv:set", { key: "user:3", value: obj });
    const raw = await ctx.call("kv:get", { key: "user:3" });
    const parsed = JSON.parse(raw);
    if (parsed.name !== "Charlie" || parsed.age !== 30 || parsed.tags.length !== 2)
      throw new Error(`parsed mismatch: ${raw}`);
    ok("kv: store and retrieve JSON objects");
  } catch (e) {
    fail("kv: JSON storage", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Scenario 2: Pub/Sub Message Bus
// ═════════════════════════════════════════════════════════════════

async function testPubSubMessageBus(ctx: Ctx) {
  console.log("\n── Scenario 2: Pub/Sub Message Bus ──");

  // bus:publish — publishes a message to a topic, stored in the 'bus' graph
  await registerNode(
    ctx,
    "bus:publish",
    `
const topic = args && args.topic;
const message = args && args.message;
if (!topic) throw new Error('[bus:publish] args.topic required');
if (!message) throw new Error('[bus:publish] args.message required');

const msgId = 'msg:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
await ctx.assert(msgId, 'topic', topic, 'bus');
await ctx.assert(msgId, 'body', typeof message === 'object' ? JSON.stringify(message) : String(message), 'bus');
await ctx.assert(msgId, 'timestamp', new Date().toISOString(), 'bus');
return { id: msgId, topic };
`
  );

  // Test 2a: Subscribers on different topics only get relevant messages
  try {
    const topicAMessages: string[] = [];
    const topicBMessages: string[] = [];

    // Subscribe to topic A messages
    const unsubA = ctx.on(
      { p: "body", g: "bus" },
      (change) => {
        if (change.type === "assert") {
          // We need to check if this message belongs to topic A
          // We'll filter by checking the msgId pattern — but since ctx.on
          // only gives us the body quad, we track all and filter later
          topicAMessages.push(change.quad.o);
        }
      }
    );

    // To properly demonstrate topic filtering, we use a smarter pattern:
    // Subscribe via ctx.on to all bus asserts, then filter by correlating msgIds
    const unsubB = ctx.on({ p: "topic", o: "topicB", g: "bus" }, (change) => {
      if (change.type === "assert") {
        topicBMessages.push(change.quad.s); // capture msgId
      }
    });

    // Replace unsubA — use a topic-filtered subscriber for topic A
    unsubA();
    const topicAMsgIds: string[] = [];
    const unsubAFiltered = ctx.on({ p: "topic", o: "topicA", g: "bus" }, (change) => {
      if (change.type === "assert") {
        topicAMsgIds.push(change.quad.s);
      }
    });

    await ctx.call("bus:publish", { topic: "topicA", message: "hello-A-1" });
    await ctx.call("bus:publish", { topic: "topicB", message: "hello-B-1" });
    await ctx.call("bus:publish", { topic: "topicA", message: "hello-A-2" });

    if (topicAMsgIds.length !== 2)
      throw new Error(`topicA subscriber got ${topicAMsgIds.length} messages, expected 2`);
    if (topicBMessages.length !== 1)
      throw new Error(`topicB subscriber got ${topicBMessages.length} messages, expected 1`);

    unsubAFiltered();
    unsubB();
    ok("pubsub: topic-filtered subscribers receive only relevant messages");
  } catch (e) {
    fail("pubsub: topic filtering", e);
  }

  // Test 2b: Messages can be replayed by querying the graph
  try {
    const allTopicA = await ctx.query({ p: "topic", o: "topicA", g: "bus" });
    if (allTopicA.length !== 2)
      throw new Error(`expected 2 topicA messages in graph, got ${allTopicA.length}`);

    // Retrieve the body for each message
    const bodies: string[] = [];
    for (const msg of allTopicA) {
      const bodyQ = await ctx.query({ s: msg.s, p: "body", g: "bus" });
      if (bodyQ.length > 0) bodies.push(bodyQ[0].o);
    }
    if (!bodies.includes("hello-A-1") || !bodies.includes("hello-A-2"))
      throw new Error(`expected bodies to include hello-A-1 and hello-A-2, got: ${bodies}`);
    ok("pubsub: messages persisted in graph and replayable via query");
  } catch (e) {
    fail("pubsub: message replay", e);
  }

  // Test 2c: Messages have timestamps for ordering
  try {
    const allMsgs = await ctx.query({ p: "timestamp", g: "bus" });
    if (allMsgs.length < 3)
      throw new Error(`expected >= 3 timestamped messages, got ${allMsgs.length}`);
    // Verify timestamps are valid ISO dates
    for (const m of allMsgs) {
      const d = new Date(m.o);
      if (isNaN(d.getTime())) throw new Error(`invalid timestamp: ${m.o}`);
    }
    ok("pubsub: all messages have valid ISO timestamps");
  } catch (e) {
    fail("pubsub: timestamps", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Scenario 3: Task Queue with Worker
// ═════════════════════════════════════════════════════════════════

async function testTaskQueue(ctx: Ctx) {
  console.log("\n── Scenario 3: Task Queue ──");

  // queue:push — enqueues a work item with status 'pending'
  await registerNode(
    ctx,
    "queue:push",
    `
const task = args && args.task;
if (!task) throw new Error('[queue:push] args.task required');

const taskId = 'task:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
await ctx.assert(taskId, 'status', 'pending', 'queue');
await ctx.assert(taskId, 'payload', typeof task === 'object' ? JSON.stringify(task) : String(task), 'queue');
await ctx.assert(taskId, 'created', new Date().toISOString(), 'queue');
return taskId;
`
  );

  // queue:worker — long-lived node that polls for pending tasks, processes them,
  // and marks them done. The "processing" is a simple transform: uppercase the payload.
  await registerNode(
    ctx,
    "queue:worker",
    `
const signal = args && args.signal;

while (!signal || !signal.aborted) {
  // Find pending tasks
  const pending = await ctx.query({ p: 'status', o: 'pending', g: 'queue' });

  for (const task of pending) {
    const taskId = task.s;

    // Mark as processing
    await ctx.retract(taskId, 'status', 'pending', 'queue');
    await ctx.assert(taskId, 'status', 'processing', 'queue');

    // Get the payload
    const payloadQ = await ctx.query({ s: taskId, p: 'payload', g: 'queue' });
    const payload = payloadQ.length > 0 ? payloadQ[0].o : '';

    // Process: uppercase the payload as our "work"
    const result = payload.toUpperCase();
    await ctx.assert(taskId, 'result', result, 'queue');

    // Mark as done
    await ctx.retract(taskId, 'status', 'processing', 'queue');
    await ctx.assert(taskId, 'status', 'done', 'queue');
    await ctx.assert(taskId, 'completed', new Date().toISOString(), 'queue');
  }

  // Poll interval
  await new Promise(r => setTimeout(r, 50));
}
`
  );

  // Test 3a: Enqueue tasks
  try {
    const id1 = await ctx.call("queue:push", { task: "process invoice" });
    const id2 = await ctx.call("queue:push", { task: "send email" });
    const id3 = await ctx.call("queue:push", { task: "generate report" });

    // Verify all are pending
    const pending = await ctx.query({ p: "status", o: "pending", g: "queue" });
    if (pending.length !== 3)
      throw new Error(`expected 3 pending tasks, got ${pending.length}`);
    ok("queue: enqueued 3 tasks with pending status");
  } catch (e) {
    fail("queue: enqueue", e);
  }

  // Test 3b: Spawn worker and verify it processes tasks
  try {
    await ctx.call("spawn", { node: "queue:worker" });

    // Wait for the worker to process all tasks
    await new Promise((r) => setTimeout(r, 400));

    const done = await ctx.query({ p: "status", o: "done", g: "queue" });
    if (done.length !== 3)
      throw new Error(`expected 3 done tasks, got ${done.length}`);

    const pending = await ctx.query({ p: "status", o: "pending", g: "queue" });
    if (pending.length !== 0)
      throw new Error(`expected 0 pending tasks, got ${pending.length}`);

    ok("queue: spawned worker processes all 3 tasks to done");
  } catch (e) {
    fail("queue: worker processing", e);
  }

  // Test 3c: Worker produces correct results
  try {
    const results = await ctx.query({ p: "result", g: "queue" });
    const resultValues = results.map((r) => r.o).sort();
    const expected = ["GENERATE REPORT", "PROCESS INVOICE", "SEND EMAIL"];
    if (JSON.stringify(resultValues) !== JSON.stringify(expected))
      throw new Error(`expected ${expected}, got ${resultValues}`);
    ok("queue: worker produced correct uppercase results");
  } catch (e) {
    fail("queue: results", e);
  }

  // Test 3d: New tasks submitted after worker is running get processed too
  try {
    await ctx.call("queue:push", { task: "late addition" });
    await new Promise((r) => setTimeout(r, 300));

    const lateResults = await ctx.query({ p: "result", o: "LATE ADDITION", g: "queue" });
    if (lateResults.length !== 1)
      throw new Error(`expected late task to be processed, got ${lateResults.length} results`);
    ok("queue: worker processes tasks submitted after startup");
  } catch (e) {
    fail("queue: late task", e);
  }

  // Abort the worker
  if (ctx._supervisorControllers) {
    const ac = ctx._supervisorControllers.get("queue:worker");
    if (ac) ac.abort();
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ═════════════════════════════════════════════════════════════════
// Scenario 4: Reactive Pipeline
// ═════════════════════════════════════════════════════════════════

async function testReactivePipeline(ctx: Ctx) {
  console.log("\n── Scenario 4: Reactive Pipeline ──");

  // pipeline:source — writes a value that triggers the chain
  await registerNode(
    ctx,
    "pipeline:source",
    `
const value = args && args.value;
if (value === undefined) throw new Error('[pipeline:source] args.value required');

// Retract any existing source value
const existing = await ctx.query({ s: 'pipeline', p: 'source-value', g: 'pipe' });
for (const eq of existing) {
  await ctx.retract(eq.s, eq.p, eq.o, eq.g);
}

await ctx.assert('pipeline', 'source-value', String(value), 'pipe');
return value;
`
  );

  // pipeline:transform — doubles the value (called reactively)
  await registerNode(
    ctx,
    "pipeline:transform",
    `
const input = args && args.input;
if (input === undefined) throw new Error('[pipeline:transform] args.input required');
const doubled = Number(input) * 2;

// Write transformed result
const existing = await ctx.query({ s: 'pipeline', p: 'transformed-value', g: 'pipe' });
for (const eq of existing) {
  await ctx.retract(eq.s, eq.p, eq.o, eq.g);
}
await ctx.assert('pipeline', 'transformed-value', String(doubled), 'pipe');
return doubled;
`
  );

  // pipeline:sink — writes the final result (called reactively)
  await registerNode(
    ctx,
    "pipeline:sink",
    `
const input = args && args.input;
if (input === undefined) throw new Error('[pipeline:sink] args.input required');
const final = 'RESULT:' + input;

// Write final result
const existing = await ctx.query({ s: 'pipeline', p: 'final-value', g: 'pipe' });
for (const eq of existing) {
  await ctx.retract(eq.s, eq.p, eq.o, eq.g);
}
await ctx.assert('pipeline', 'final-value', final, 'pipe');
return final;
`
  );

  // Wire up the reactive pipeline using ctx.on
  // source-value changes -> trigger transform -> trigger sink
  const unsub1 = ctx.on(
    { s: "pipeline", p: "source-value", g: "pipe" },
    (change) => {
      if (change.type === "assert") {
        ctx.call("pipeline:transform", { input: change.quad.o });
      }
    }
  );

  const unsub2 = ctx.on(
    { s: "pipeline", p: "transformed-value", g: "pipe" },
    (change) => {
      if (change.type === "assert") {
        ctx.call("pipeline:sink", { input: change.quad.o });
      }
    }
  );

  // Test 4a: End-to-end pipeline propagation
  try {
    await ctx.call("pipeline:source", { value: 5 });

    // The reactive chain should have fired synchronously during asserts
    // Give a small delay for any async settling
    await new Promise((r) => setTimeout(r, 100));

    const transformed = await ctx.query({ s: "pipeline", p: "transformed-value", g: "pipe" });
    if (transformed.length !== 1)
      throw new Error(`expected 1 transformed value, got ${transformed.length}`);
    if (transformed[0].o !== "10")
      throw new Error(`expected "10", got "${transformed[0].o}"`);

    const final = await ctx.query({ s: "pipeline", p: "final-value", g: "pipe" });
    if (final.length !== 1) throw new Error(`expected 1 final value, got ${final.length}`);
    if (final[0].o !== "RESULT:10")
      throw new Error(`expected "RESULT:10", got "${final[0].o}"`);

    ok("pipeline: source(5) -> transform(10) -> sink(RESULT:10) propagates");
  } catch (e) {
    fail("pipeline: end-to-end", e);
  }

  // Test 4b: Pipeline re-triggers on new input
  try {
    await ctx.call("pipeline:source", { value: 21 });
    await new Promise((r) => setTimeout(r, 100));

    const transformed = await ctx.query({ s: "pipeline", p: "transformed-value", g: "pipe" });
    if (transformed[0].o !== "42")
      throw new Error(`expected "42", got "${transformed[0].o}"`);

    const final = await ctx.query({ s: "pipeline", p: "final-value", g: "pipe" });
    if (final[0].o !== "RESULT:42")
      throw new Error(`expected "RESULT:42", got "${final[0].o}"`);

    ok("pipeline: new input(21) re-triggers full chain to RESULT:42");
  } catch (e) {
    fail("pipeline: re-trigger", e);
  }

  // Test 4c: Pipeline preserves intermediate values (no stale data)
  try {
    await ctx.call("pipeline:source", { value: 0 });
    await new Promise((r) => setTimeout(r, 100));

    const transformed = await ctx.query({ s: "pipeline", p: "transformed-value", g: "pipe" });
    const final = await ctx.query({ s: "pipeline", p: "final-value", g: "pipe" });

    if (transformed.length !== 1 || final.length !== 1)
      throw new Error(`stale data: ${transformed.length} transformed, ${final.length} final`);
    if (transformed[0].o !== "0")
      throw new Error(`expected "0", got "${transformed[0].o}"`);
    if (final[0].o !== "RESULT:0")
      throw new Error(`expected "RESULT:0", got "${final[0].o}"`);

    ok("pipeline: zero value propagates correctly, no stale data");
  } catch (e) {
    fail("pipeline: zero propagation", e);
  }

  unsub1();
  unsub2();
}

// ═════════════════════════════════════════════════════════════════
// Scenario 5: Simple State Machine (Traffic Light)
// ═════════════════════════════════════════════════════════════════

async function testStateMachine(ctx: Ctx) {
  console.log("\n── Scenario 5: State Machine (Traffic Light) ──");

  // fsm:transition — handles state transitions for a traffic light
  // States: red -> green -> yellow -> red (cycle)
  // Events: 'next' advances the cycle, 'emergency' forces red
  await registerNode(
    ctx,
    "fsm:transition",
    `
const event = args && args.event;
if (!event) throw new Error('[fsm:transition] args.event required');

// Define the state machine transitions
const transitions = {
  red:    { next: 'green',  emergency: 'red' },
  green:  { next: 'yellow', emergency: 'red' },
  yellow: { next: 'red',    emergency: 'red' },
};

// Get current state (default to 'red' if uninitialized)
const stateQ = await ctx.query({ s: 'traffic-light', p: 'state', g: 'fsm' });
const currentState = stateQ.length > 0 ? stateQ[0].o : 'red';

// Look up the transition
const stateTransitions = transitions[currentState];
if (!stateTransitions) throw new Error('unknown state: ' + currentState);

const nextState = stateTransitions[event];
if (!nextState) {
  return { error: 'invalid-event', currentState, event, validEvents: Object.keys(stateTransitions) };
}

// Apply the transition
if (stateQ.length > 0) {
  await ctx.retract('traffic-light', 'state', currentState, 'fsm');
}
await ctx.assert('traffic-light', 'state', nextState, 'fsm');

// Record transition in history
const histId = 'transition:' + Date.now() + ':' + Math.random().toString(36).slice(2, 6);
await ctx.assert(histId, 'from', currentState, 'fsm-history');
await ctx.assert(histId, 'to', nextState, 'fsm-history');
await ctx.assert(histId, 'event', event, 'fsm-history');

return { from: currentState, to: nextState, event };
`
  );

  // Test 5a: Initial state defaults to red, first transition to green
  try {
    const r1 = await ctx.call("fsm:transition", { event: "next" });
    if (r1.from !== "red" || r1.to !== "green")
      throw new Error(`expected red->green, got ${r1.from}->${r1.to}`);
    ok("fsm: initial red -> green on 'next'");
  } catch (e) {
    fail("fsm: initial transition", e);
  }

  // Test 5b: Full cycle: green -> yellow -> red
  try {
    const r2 = await ctx.call("fsm:transition", { event: "next" });
    if (r2.from !== "green" || r2.to !== "yellow")
      throw new Error(`expected green->yellow, got ${r2.from}->${r2.to}`);

    const r3 = await ctx.call("fsm:transition", { event: "next" });
    if (r3.from !== "yellow" || r3.to !== "red")
      throw new Error(`expected yellow->red, got ${r3.from}->${r3.to}`);

    ok("fsm: full cycle green -> yellow -> red");
  } catch (e) {
    fail("fsm: full cycle", e);
  }

  // Test 5c: Emergency from any state forces red
  try {
    // Move to green first
    await ctx.call("fsm:transition", { event: "next" }); // red -> green

    const emergency = await ctx.call("fsm:transition", { event: "emergency" });
    if (emergency.from !== "green" || emergency.to !== "red")
      throw new Error(`expected green->red on emergency, got ${emergency.from}->${emergency.to}`);

    ok("fsm: emergency event forces state to red from any state");
  } catch (e) {
    fail("fsm: emergency", e);
  }

  // Test 5d: Invalid event returns error object (not a throw)
  try {
    const invalid = await ctx.call("fsm:transition", { event: "turbo" });
    if (!invalid.error || invalid.error !== "invalid-event")
      throw new Error(`expected error object, got ${JSON.stringify(invalid)}`);
    if (invalid.currentState !== "red")
      throw new Error(`expected current state 'red', got ${invalid.currentState}`);
    if (!invalid.validEvents.includes("next") || !invalid.validEvents.includes("emergency"))
      throw new Error(`expected valid events, got ${invalid.validEvents}`);
    ok("fsm: invalid event returns error with valid events list");
  } catch (e) {
    fail("fsm: invalid event", e);
  }

  // Test 5e: Transition history is recorded in the graph
  try {
    const history = await ctx.query({ p: "from", g: "fsm-history" });
    if (history.length < 5)
      throw new Error(`expected >= 5 recorded transitions, got ${history.length}`);

    // Verify we can reconstruct the sequence
    const fromStates = history.map((h) => h.o);
    if (!fromStates.includes("red") || !fromStates.includes("green") || !fromStates.includes("yellow"))
      throw new Error(`history missing states: ${fromStates}`);
    ok(`fsm: transition history recorded and queryable (${history.length} transitions)`);
  } catch (e) {
    fail("fsm: transition history", e);
  }
}

// ═════════════════════════════════════════════════════════════════
// Scenario 6: Audit Log
// ═════════════════════════════════════════════════════════════════

async function testAuditLog(ctx: Ctx) {
  console.log("\n── Scenario 6: Audit Log ──");

  // audit:log — records an operation with actor, action, target, and timestamp
  await registerNode(
    ctx,
    "audit:log",
    `
const actor = args && args.actor;
const action = args && args.action;
const target = args && args.target;
const details = args && args.details;

if (!actor || !action) throw new Error('[audit:log] args.actor and args.action required');

const entryId = 'audit:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8);
await ctx.assert(entryId, 'actor', actor, 'audit');
await ctx.assert(entryId, 'action', action, 'audit');
if (target) await ctx.assert(entryId, 'target', target, 'audit');
if (details) await ctx.assert(entryId, 'details', typeof details === 'object' ? JSON.stringify(details) : String(details), 'audit');
await ctx.assert(entryId, 'timestamp', new Date().toISOString(), 'audit');

return entryId;
`
  );

  // audit:query — retrieves audit log entries, optionally filtered
  await registerNode(
    ctx,
    "audit:query",
    `
const actor = args && args.actor;
const action = args && args.action;
const target = args && args.target;

// Start with all entries
let entries;
if (actor) {
  entries = await ctx.query({ p: 'actor', o: actor, g: 'audit' });
} else if (action) {
  entries = await ctx.query({ p: 'action', o: action, g: 'audit' });
} else if (target) {
  entries = await ctx.query({ p: 'target', o: target, g: 'audit' });
} else {
  entries = await ctx.query({ p: 'actor', g: 'audit' }); // all entries
}

// Hydrate each entry
const result = [];
for (const entry of entries) {
  const id = entry.s;
  const quads = await ctx.query({ s: id, g: 'audit' });
  const record = { id };
  for (const q of quads) {
    record[q.p] = q.o;
  }
  result.push(record);
}

// Sort by timestamp descending (newest first)
result.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));
return result;
`
  );

  // audit:wrap — wraps a node call with audit logging
  await registerNode(
    ctx,
    "audit:wrap",
    `
const actor = args && args.actor;
const node = args && args.node;
const nodeArgs = args && args.args;

if (!actor || !node) throw new Error('[audit:wrap] args.actor and args.node required');

// Log the operation
await ctx.call('audit:log', {
  actor,
  action: 'call',
  target: node,
  details: nodeArgs ? JSON.stringify(nodeArgs) : undefined,
});

// Execute the actual operation
const result = await ctx.call(node, nodeArgs);

// Log success
await ctx.call('audit:log', {
  actor,
  action: 'call-success',
  target: node,
  details: typeof result === 'string' ? result : JSON.stringify(result),
});

return result;
`
  );

  // Test 6a: Log operations
  try {
    await ctx.call("audit:log", {
      actor: "alice",
      action: "create",
      target: "document:1",
      details: "Created quarterly report",
    });
    await ctx.call("audit:log", {
      actor: "bob",
      action: "update",
      target: "document:1",
      details: "Revised section 3",
    });
    await ctx.call("audit:log", {
      actor: "alice",
      action: "delete",
      target: "document:2",
    });

    const all = await ctx.query({ p: "actor", g: "audit" });
    if (all.length !== 3) throw new Error(`expected 3 audit entries, got ${all.length}`);
    ok("audit: logged 3 operations from 2 actors");
  } catch (e) {
    fail("audit: log operations", e);
  }

  // Test 6b: Query by actor
  try {
    const aliceOps = await ctx.call("audit:query", { actor: "alice" });
    if (aliceOps.length !== 2)
      throw new Error(`expected 2 alice operations, got ${aliceOps.length}`);
    // Each entry should have actor, action, timestamp
    for (const op of aliceOps) {
      if (op.actor !== "alice") throw new Error(`expected alice, got ${op.actor}`);
      if (!op.timestamp) throw new Error("missing timestamp");
      if (!op.action) throw new Error("missing action");
    }
    ok("audit: query by actor returns correct entries with full metadata");
  } catch (e) {
    fail("audit: query by actor", e);
  }

  // Test 6c: Query by action
  try {
    const deletes = await ctx.call("audit:query", { action: "delete" });
    if (deletes.length !== 1) throw new Error(`expected 1 delete, got ${deletes.length}`);
    if (deletes[0].target !== "document:2")
      throw new Error(`expected target document:2, got ${deletes[0].target}`);
    ok("audit: query by action filters correctly");
  } catch (e) {
    fail("audit: query by action", e);
  }

  // Test 6d: Chronological ordering (newest first)
  try {
    // Add entries with a small delay to ensure timestamp ordering
    await ctx.call("audit:log", { actor: "charlie", action: "login" });
    await new Promise((r) => setTimeout(r, 10));
    await ctx.call("audit:log", { actor: "charlie", action: "logout" });

    const charlieOps = await ctx.call("audit:query", { actor: "charlie" });
    if (charlieOps.length !== 2)
      throw new Error(`expected 2 charlie operations, got ${charlieOps.length}`);
    // Newest first
    if (charlieOps[0].action !== "logout")
      throw new Error(`expected logout first (newest), got ${charlieOps[0].action}`);
    if (charlieOps[1].action !== "login")
      throw new Error(`expected login second (oldest), got ${charlieOps[1].action}`);
    ok("audit: entries sorted chronologically (newest first)");
  } catch (e) {
    fail("audit: chronological ordering", e);
  }

  // Test 6e: Audit-wrapped node call
  try {
    // Register a simple node to wrap
    await registerNode(ctx, "math:double", `return (args && args.n || 0) * 2;`);

    const result = await ctx.call("audit:wrap", {
      actor: "admin",
      node: "math:double",
      args: { n: 7 },
    });

    if (result !== 14) throw new Error(`expected 14, got ${result}`);

    // Check that audit entries were created for the wrapped call
    const adminOps = await ctx.call("audit:query", { actor: "admin" });
    if (adminOps.length < 2)
      throw new Error(`expected >= 2 admin audit entries, got ${adminOps.length}`);

    const callEntry = adminOps.find((e: any) => e.action === "call" && e.target === "math:double");
    const successEntry = adminOps.find(
      (e: any) => e.action === "call-success" && e.target === "math:double"
    );

    if (!callEntry) throw new Error("missing call audit entry");
    if (!successEntry) throw new Error("missing call-success audit entry");
    ok("audit: wrapped call logs operation + result, returns correct value");
  } catch (e) {
    fail("audit: wrapped call", e);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  // Clean start
  try {
    unlinkSync(TEST_DB);
  } catch {}

  console.log("=== Holoiconic Practical Program Tests ===");
  const ctx = await boot();

  await testKeyValueStore(ctx);
  await testPubSubMessageBus(ctx);
  await testTaskQueue(ctx);
  await testReactivePipeline(ctx);
  await testStateMachine(ctx);
  await testAuditLog(ctx);

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
