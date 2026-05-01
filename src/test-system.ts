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

// ── Boot (non-interactive, with compiler + supervisor + tools) ────

const TEST_DB = "test-system.db";

async function boot(): Promise<Ctx> {
  // Remove stale DB
  try {
    unlinkSync(TEST_DB);
  } catch {}
  const db = createDatabase(TEST_DB);
  await initSchema(db);
  const ctx = createCtx(db);
  await seedTemplate(ctx);
  // Install compiler (cached + reactive ctx.call)
  await ctx.call("sys:compiler");
  // Spawn supervisor (manages lifecycle)
  await ctx.call("spawn", { node: "sys:supervisor" });
  await new Promise((r) => setTimeout(r, 50));
  // Register tools
  await ctx.call("agent:tools");
  return ctx;
}

// ── Test 1: Shell node ────────────────────────────────────────────

async function testShell(ctx: Ctx) {
  console.log("\n── Shell node ──");

  // 1a: echo hello — basic stdout capture
  try {
    const result = await ctx.call("shell", { cmd: "echo hello" });
    if (result.trim() !== "hello")
      throw new Error(`expected "hello", got "${result.trim()}"`);
    ok("shell: echo hello returns stdout");
  } catch (e) {
    fail("shell: echo hello returns stdout", e);
  }

  // 1b: date — command that outputs something
  try {
    const result = await ctx.call("shell", { cmd: "date +%Y" });
    const year = result.trim();
    if (!/^\d{4}$/.test(year))
      throw new Error(`expected 4-digit year, got "${year}"`);
    ok("shell: date returns valid output");
  } catch (e) {
    fail("shell: date returns valid output", e);
  }

  // 1c: ls — command with directory listing
  try {
    const result = await ctx.call("shell", { cmd: "ls src/template.ts" });
    if (!result.trim().includes("template.ts"))
      throw new Error(`expected template.ts in output, got "${result.trim()}"`);
    ok("shell: ls returns directory listing");
  } catch (e) {
    fail("shell: ls returns directory listing", e);
  }

  // 1d: command with arguments (wc -c)
  try {
    const result = await ctx.call("shell", {
      cmd: "echo -n 'foobar' | wc -c",
    });
    if (result.trim() !== "6")
      throw new Error(`expected "6", got "${result.trim()}"`);
    ok("shell: command with pipe and arguments");
  } catch (e) {
    fail("shell: command with pipe and arguments", e);
  }

  // 1e: error handling — invalid command
  try {
    await ctx.call("shell", { cmd: "nonexistent_command_xyz_12345" });
    fail("shell: invalid command throws", "did not throw");
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes("[shell] command failed"))
      ok("shell: invalid command throws with exit code");
    else fail("shell: invalid command throws with exit code", e);
  }

  // 1f: missing cmd argument
  try {
    await ctx.call("shell", {});
    fail("shell: missing cmd throws", "did not throw");
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes("args.cmd is required"))
      ok("shell: missing cmd throws descriptive error");
    else fail("shell: missing cmd throws descriptive error", e);
  }
}

// ── Test 2: Graph introspection nodes ─────────────────────────────

async function testGraphDescribe(ctx: Ctx) {
  console.log("\n── graph:describe ──");

  // 2a: Describe sys:compiler — should have source and type predicates
  try {
    const result = await ctx.call("graph:describe", {
      subject: "sys:compiler",
    });
    if (!result.subject || result.subject !== "sys:compiler")
      throw new Error(`expected subject "sys:compiler", got "${result.subject}"`);
    if (!result.quads || !Array.isArray(result.quads) || result.quads.length === 0)
      throw new Error("expected non-empty quads array");
    if (!result.predicates)
      throw new Error("expected predicates object");
    // Should have at least 'source' and 'type' predicates
    if (!result.predicates.source)
      throw new Error("expected 'source' predicate");
    if (!result.predicates.type)
      throw new Error("expected 'type' predicate");
    ok("graph:describe: sys:compiler has source + type predicates");
  } catch (e) {
    fail("graph:describe: sys:compiler has source + type predicates", e);
  }

  // 2b: Describe returns correct quad shape
  try {
    const result = await ctx.call("graph:describe", {
      subject: "sys:compiler",
    });
    const firstQuad = result.quads[0];
    if (
      !("s" in firstQuad) ||
      !("p" in firstQuad) ||
      !("o" in firstQuad) ||
      !("g" in firstQuad)
    )
      throw new Error("quad missing s/p/o/g fields");
    if (firstQuad.s !== "sys:compiler")
      throw new Error(`quad.s expected "sys:compiler", got "${firstQuad.s}"`);
    ok("graph:describe: returned quads have correct shape");
  } catch (e) {
    fail("graph:describe: returned quads have correct shape", e);
  }

  // 2c: Describe a node that has tool_schema
  try {
    const result = await ctx.call("graph:describe", { subject: "shell" });
    if (!result.predicates.tool_schema)
      throw new Error("shell should have tool_schema predicate");
    const schema = JSON.parse(result.predicates.tool_schema[0].value);
    if (schema.name !== "shell")
      throw new Error(`expected tool name "shell", got "${schema.name}"`);
    ok("graph:describe: shell has parseable tool_schema");
  } catch (e) {
    fail("graph:describe: shell has parseable tool_schema", e);
  }

  // 2d: Describe nonexistent subject — returns empty
  try {
    const result = await ctx.call("graph:describe", {
      subject: "does:not:exist",
    });
    if (result.quads.length !== 0)
      throw new Error(`expected empty quads, got ${result.quads.length}`);
    ok("graph:describe: nonexistent subject returns empty quads");
  } catch (e) {
    fail("graph:describe: nonexistent subject returns empty quads", e);
  }
}

async function testGraphSubjects(ctx: Ctx) {
  console.log("\n── graph:subjects ──");

  // 2e: List all subjects (no filter)
  try {
    const result = await ctx.call("graph:subjects", {});
    if (!Array.isArray(result))
      throw new Error("expected array result");
    if (result.length < 10)
      throw new Error(`expected >= 10 subjects, got ${result.length}`);
    // Each entry should have subject and types
    const first = result[0];
    if (!("subject" in first) || !("types" in first))
      throw new Error("entries should have subject and types fields");
    ok(`graph:subjects: lists ${result.length} subjects with types`);
  } catch (e) {
    fail("graph:subjects: lists subjects with types", e);
  }

  // 2f: Filter by type 'Function'
  try {
    const result = await ctx.call("graph:subjects", { type: "Function" });
    if (!Array.isArray(result))
      throw new Error("expected array result");
    // Should have at least the 28 seeded nodes
    if (result.length < 20)
      throw new Error(`expected >= 20 Function subjects, got ${result.length}`);
    // Every entry should have types: ['Function']
    for (const entry of result) {
      if (!entry.types.includes("Function"))
        throw new Error(`subject ${entry.subject} missing Function type`);
    }
    ok(`graph:subjects(Function): ${result.length} function nodes found`);
  } catch (e) {
    fail("graph:subjects(Function): lists function nodes", e);
  }

  // 2g: Filter by type 'Tool'
  try {
    const result = await ctx.call("graph:subjects", { type: "Tool" });
    if (!Array.isArray(result))
      throw new Error("expected array result");
    if (result.length < 10)
      throw new Error(`expected >= 10 Tool subjects, got ${result.length}`);
    ok(`graph:subjects(Tool): ${result.length} tool nodes found`);
  } catch (e) {
    fail("graph:subjects(Tool): lists tool nodes", e);
  }
}

async function testGraphDeps(ctx: Ctx) {
  console.log("\n── graph:deps ──");

  // 2h: Dependencies of main node
  try {
    const result = await ctx.call("graph:deps", { node: "main" });
    if (result.node !== "main")
      throw new Error(`expected node "main", got "${result.node}"`);
    if (!Array.isArray(result.calls))
      throw new Error("expected calls array");
    // main calls at least sys:compiler, spawn, agent:tools
    if (result.calls.length < 3)
      throw new Error(`expected >= 3 calls, got ${result.calls.length}: ${result.calls}`);
    if (!result.calls.includes("sys:compiler"))
      throw new Error("main should call sys:compiler");
    if (!result.calls.includes("spawn"))
      throw new Error("main should call spawn");
    ok(`graph:deps(main): calls ${result.calls.join(", ")}`);
  } catch (e) {
    fail("graph:deps(main): lists dependencies", e);
  }

  // 2i: calledBy — what calls 'shell'?
  try {
    const result = await ctx.call("graph:deps", { node: "shell" });
    if (!Array.isArray(result.calledBy))
      throw new Error("expected calledBy array");
    // agent:loop calls shell
    if (!result.calledBy.includes("agent:loop"))
      throw new Error(`expected agent:loop to call shell, calledBy: ${result.calledBy}`);
    ok(`graph:deps(shell): calledBy includes agent:loop`);
  } catch (e) {
    fail("graph:deps(shell): calledBy includes agent:loop", e);
  }

  // 2j: Dependencies of a leaf node (no outgoing calls)
  try {
    const result = await ctx.call("graph:deps", { node: "set" });
    // set node does retract/assert but no ctx.call
    if (!Array.isArray(result.calls))
      throw new Error("expected calls array");
    ok(`graph:deps(set): calls=[${result.calls}], calledBy=[${result.calledBy}]`);
  } catch (e) {
    fail("graph:deps(set): leaf node deps", e);
  }
}

async function testInspect(ctx: Ctx) {
  console.log("\n── inspect ──");

  // 2k: Inspect sys:compiler — combines describe + deps
  try {
    const result = await ctx.call("inspect", { node: "sys:compiler" });
    if (result.node !== "sys:compiler")
      throw new Error(`expected node "sys:compiler", got "${result.node}"`);
    if (!result.exists)
      throw new Error("expected exists = true");
    if (!result.isFunction)
      throw new Error("expected isFunction = true");
    if (!result.source || result.source.length === 0)
      throw new Error("expected non-empty source");
    if (result.sourceLength === 0)
      throw new Error("expected non-zero sourceLength");
    if (!Array.isArray(result.dependencies))
      throw new Error("expected dependencies array");
    if (!Array.isArray(result.dependents))
      throw new Error("expected dependents array");
    if (!Array.isArray(result.predicates))
      throw new Error("expected predicates array");
    ok("inspect(sys:compiler): complete inspection with all fields");
  } catch (e) {
    fail("inspect(sys:compiler): complete inspection", e);
  }

  // 2l: Inspect a tool node — should have isTool=true and toolSchema
  try {
    const result = await ctx.call("inspect", { node: "shell" });
    if (!result.isTool)
      throw new Error("expected isTool = true for shell");
    if (!result.toolSchema)
      throw new Error("expected toolSchema for shell");
    if (result.toolSchema.name !== "shell")
      throw new Error(`expected tool name "shell", got "${result.toolSchema.name}"`);
    ok("inspect(shell): isTool=true with parsed toolSchema");
  } catch (e) {
    fail("inspect(shell): isTool with toolSchema", e);
  }

  // 2m: Inspect nonexistent node
  try {
    const result = await ctx.call("inspect", { node: "does:not:exist" });
    if (result.exists !== false)
      throw new Error("expected exists = false for nonexistent node");
    if (result.quadCount !== 0)
      throw new Error(`expected quadCount=0, got ${result.quadCount}`);
    ok("inspect(nonexistent): exists=false, quadCount=0");
  } catch (e) {
    fail("inspect(nonexistent): handles missing node", e);
  }
}

// ── Test 3: LLM stub ─────────────────────────────────────────────

async function testLlmStub(ctx: Ctx) {
  console.log("\n── LLM stub ──");

  // 3a: Call llm without API key — should return stub
  try {
    const result = await ctx.call("llm", {
      messages: [{ role: "user", content: "Hello" }],
    });
    if (!result) throw new Error("expected result object");
    if (result.id !== "stub")
      throw new Error(`expected id "stub", got "${result.id}"`);
    if (result.type !== "message")
      throw new Error(`expected type "message", got "${result.type}"`);
    if (result.role !== "assistant")
      throw new Error(`expected role "assistant", got "${result.role}"`);
    if (result.stop_reason !== "end_turn")
      throw new Error(`expected stop_reason "end_turn", got "${result.stop_reason}"`);
    ok("llm stub: returns correct response shape");
  } catch (e) {
    fail("llm stub: returns correct response shape", e);
  }

  // 3b: Verify content structure
  try {
    const result = await ctx.call("llm", {
      messages: [{ role: "user", content: "Hello" }],
    });
    if (!Array.isArray(result.content))
      throw new Error("expected content array");
    if (result.content.length !== 1)
      throw new Error(`expected 1 content block, got ${result.content.length}`);
    if (result.content[0].type !== "text")
      throw new Error(`expected content type "text", got "${result.content[0].type}"`);
    if (!result.content[0].text.includes("No ANTHROPIC_API_KEY"))
      throw new Error(`expected stub message about missing key, got "${result.content[0].text}"`);
    ok("llm stub: content has text block with stub message");
  } catch (e) {
    fail("llm stub: content has text block with stub message", e);
  }

  // 3c: Verify usage field
  try {
    const result = await ctx.call("llm", {
      messages: [{ role: "user", content: "test" }],
    });
    if (!result.usage)
      throw new Error("expected usage object");
    if (result.usage.input_tokens !== 0 || result.usage.output_tokens !== 0)
      throw new Error("expected zero token counts in stub");
    ok("llm stub: usage has zero token counts");
  } catch (e) {
    fail("llm stub: usage has zero token counts", e);
  }

  // 3d: Custom model parameter is reflected
  try {
    const result = await ctx.call("llm", {
      messages: [{ role: "user", content: "test" }],
      model: "my-custom-model",
    });
    if (result.model !== "my-custom-model")
      throw new Error(`expected model "my-custom-model", got "${result.model}"`);
    if (!result.content[0].text.includes("my-custom-model"))
      throw new Error("expected stub text to include model name");
    ok("llm stub: custom model reflected in response");
  } catch (e) {
    fail("llm stub: custom model reflected in response", e);
  }

  // 3e: Default model when none provided
  try {
    const result = await ctx.call("llm", {
      messages: [{ role: "user", content: "test" }],
    });
    if (result.model !== "default")
      throw new Error(`expected model "default" (stub behavior), got "${result.model}"`);
    ok("llm stub: default model is 'default'");
  } catch (e) {
    fail("llm stub: default model is 'default'", e);
  }
}

// ── Test 4: Agent tools registration ──────────────────────────────

async function testAgentTools(ctx: Ctx) {
  console.log("\n── Agent tools registration ──");

  // 4a: Query all Tool-typed quads
  try {
    const toolQuads = await ctx.query({ p: "type", o: "Tool" });
    const toolNames = toolQuads.map((q) => q.s).sort();
    if (toolNames.length !== 18)
      throw new Error(`expected 18 tools, got ${toolNames.length}: ${toolNames.join(", ")}`);
    ok(`agent:tools: 18 tools registered`);
  } catch (e) {
    fail("agent:tools: 18 tools registered", e);
  }

  // 4b: Verify expected tools exist
  try {
    const toolQuads = await ctx.query({ p: "type", o: "Tool" });
    const toolNames = toolQuads.map((q) => q.s);
    const expected = [
      "shell",
      "graph_query",
      "graph_assert",
      "graph_retract",
      "list_nodes",
      "snapshot:export",
      "snapshot:import",
      "snapshot:backup",
      "vector:search",
      "graph_describe",
      "graph_subjects",
      "graph_deps",
      "inspect",
      "version_list",
      "version_restore",
      "cron_create",
      "cron_list",
      "metrics_report",
    ];
    const missing = expected.filter((t) => !toolNames.includes(t));
    if (missing.length > 0)
      throw new Error(`missing tools: ${missing.join(", ")}`);
    ok("agent:tools: all 18 expected tool names present");
  } catch (e) {
    fail("agent:tools: all expected tool names present", e);
  }

  // 4c: Each tool has a valid tool_schema
  try {
    const toolQuads = await ctx.query({ p: "type", o: "Tool" });
    let validSchemas = 0;
    for (const tq of toolQuads) {
      const schemaQuads = await ctx.query({ s: tq.s, p: "tool_schema" });
      if (schemaQuads.length === 0)
        throw new Error(`tool ${tq.s} has no tool_schema`);
      const schema = JSON.parse(schemaQuads[0].o);
      if (!schema.name)
        throw new Error(`tool ${tq.s} schema has no name`);
      if (!schema.input_schema)
        throw new Error(`tool ${tq.s} schema has no input_schema`);
      validSchemas++;
    }
    if (validSchemas !== 18)
      throw new Error(`expected 18 valid schemas, got ${validSchemas}`);
    ok("agent:tools: all 18 tools have valid JSON tool_schema");
  } catch (e) {
    fail("agent:tools: all tools have valid tool_schema", e);
  }
}

// ── Test 5: Agent loop stub ───────────────────────────────────────

async function testAgentLoop(ctx: Ctx) {
  console.log("\n── Agent loop stub ──");

  // 5a: Call agent:loop with a simple prompt (stub LLM, no API key)
  try {
    const result = await ctx.call("agent:loop", {
      prompt: "Hello, what can you do?",
    });
    if (!result) throw new Error("expected result object");
    if (!result.session)
      throw new Error("expected session field");
    if (typeof result.response !== "string")
      throw new Error(`expected response string, got ${typeof result.response}`);
    if (!Array.isArray(result.tool_calls))
      throw new Error("expected tool_calls array");
    ok("agent:loop stub: returns session, response, tool_calls");
  } catch (e) {
    fail("agent:loop stub: returns session, response, tool_calls", e);
  }

  // 5b: Verify stub response contains the stub message
  try {
    const result = await ctx.call("agent:loop", {
      prompt: "test prompt",
    });
    // In stub mode, the LLM returns a text block with the stub message
    // agent:loop extracts text from content blocks
    if (!result.response.includes("No ANTHROPIC_API_KEY"))
      throw new Error(`expected stub message in response, got "${result.response}"`);
    ok("agent:loop stub: response contains stub LLM message");
  } catch (e) {
    fail("agent:loop stub: response contains stub LLM message", e);
  }

  // 5c: Conversation stored in graph
  try {
    const result = await ctx.call("agent:loop", {
      prompt: "graph storage test",
      session: "test:session:storage",
    });
    // Check that messages were stored
    const msgQuads = await ctx.query({
      p: "message",
      g: "test:session:storage",
    });
    if (msgQuads.length < 2)
      throw new Error(`expected >= 2 messages (user + assistant), got ${msgQuads.length}`);
    // Verify the user message is stored
    const messages = msgQuads.map((q) => JSON.parse(q.o));
    const userMsg = messages.find((m) => m.msg && m.msg.role === "user");
    if (!userMsg)
      throw new Error("user message not found in stored messages");
    ok("agent:loop stub: conversation stored in graph");
  } catch (e) {
    fail("agent:loop stub: conversation stored in graph", e);
  }

  // 5d: Missing prompt throws
  try {
    await ctx.call("agent:loop", {});
    fail("agent:loop: missing prompt throws", "did not throw");
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes("args.prompt is required"))
      ok("agent:loop: missing prompt throws descriptive error");
    else fail("agent:loop: missing prompt throws descriptive error", e);
  }
}

// ── Test 6: Embed stub ────────────────────────────────────────────

async function testEmbedStub(ctx: Ctx) {
  console.log("\n── Embed stub ──");

  // 6a: Basic embedding — returns vector
  try {
    const result = await ctx.call("embed", { text: "hello world" });
    if (!result) throw new Error("expected result object");
    if (!Array.isArray(result.embedding))
      throw new Error("expected embedding array");
    if (result.embedding.length !== 1536)
      throw new Error(`expected 1536 dimensions, got ${result.embedding.length}`);
    if (result.model !== "stub")
      throw new Error(`expected model "stub", got "${result.model}"`);
    if (result.dimensions !== 1536)
      throw new Error(`expected dimensions 1536, got ${result.dimensions}`);
    ok("embed stub: returns 1536-dim vector with model=stub");
  } catch (e) {
    fail("embed stub: returns 1536-dim vector", e);
  }

  // 6b: Deterministic — same text produces same vector
  try {
    const r1 = await ctx.call("embed", { text: "determinism test" });
    const r2 = await ctx.call("embed", { text: "determinism test" });
    if (r1.embedding.length !== r2.embedding.length)
      throw new Error("embedding lengths differ");
    let same = true;
    for (let i = 0; i < r1.embedding.length; i++) {
      if (r1.embedding[i] !== r2.embedding[i]) {
        same = false;
        break;
      }
    }
    if (!same)
      throw new Error("same text produced different vectors");
    ok("embed stub: deterministic — same text, same vector");
  } catch (e) {
    fail("embed stub: deterministic — same text, same vector", e);
  }

  // 6c: Different text produces different vector
  try {
    const r1 = await ctx.call("embed", { text: "apple" });
    const r2 = await ctx.call("embed", { text: "banana" });
    let same = true;
    for (let i = 0; i < r1.embedding.length; i++) {
      if (r1.embedding[i] !== r2.embedding[i]) {
        same = false;
        break;
      }
    }
    if (same)
      throw new Error("different text produced same vectors");
    ok("embed stub: different text produces different vectors");
  } catch (e) {
    fail("embed stub: different text produces different vectors", e);
  }

  // 6d: Vector is normalized (unit length)
  try {
    const result = await ctx.call("embed", { text: "normalization test" });
    let norm = 0;
    for (const v of result.embedding) norm += v * v;
    norm = Math.sqrt(norm);
    if (Math.abs(norm - 1.0) > 0.001)
      throw new Error(`expected unit norm ~1.0, got ${norm}`);
    ok("embed stub: vector is normalized (unit length)");
  } catch (e) {
    fail("embed stub: vector is normalized", e);
  }

  // 6e: Missing text throws
  try {
    await ctx.call("embed", {});
    fail("embed: missing text throws", "did not throw");
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes("args.text is required"))
      ok("embed: missing text throws descriptive error");
    else fail("embed: missing text throws descriptive error", e);
  }
}

// ── Test 7: Vector search ─────────────────────────────────────────

async function testVectorSearch(ctx: Ctx) {
  console.log("\n── Vector search ──");

  // 7a: Embed some texts first to populate the embeddings graph
  try {
    await ctx.call("embed", { text: "cats are fluffy pets" });
    await ctx.call("embed", { text: "dogs are loyal companions" });
    await ctx.call("embed", { text: "the weather is sunny today" });
    await ctx.call("embed", { text: "programming in TypeScript is fun" });

    // Verify embeddings were stored in the graph
    const embQuads = await ctx.query({ p: "embedding", g: "embeddings" });
    if (embQuads.length < 4)
      throw new Error(`expected >= 4 embedding quads, got ${embQuads.length}`);
    ok(`vector:search setup: ${embQuads.length} embeddings stored in graph`);
  } catch (e) {
    fail("vector:search setup: embedding storage", e);
  }

  // 7b: Search for similar text — "kittens are cute" should be close to "cats are fluffy pets"
  try {
    const results = await ctx.call("vector:search", {
      text: "kittens are cute",
      k: 4,
    });
    if (!Array.isArray(results))
      throw new Error("expected results array");
    if (results.length === 0)
      throw new Error("expected non-empty results");
    // Each result should have quad and similarity
    const first = results[0];
    if (!first.quad)
      throw new Error("expected quad field in result");
    if (typeof first.similarity !== "number")
      throw new Error("expected numeric similarity");
    // Similarity should be between -1 and 1
    if (first.similarity < -1 || first.similarity > 1.001)
      throw new Error(`similarity ${first.similarity} out of range`);
    ok("vector:search: returns results with quad + similarity");
  } catch (e) {
    fail("vector:search: returns results", e);
  }

  // 7c: Results are sorted by similarity descending
  try {
    const results = await ctx.call("vector:search", {
      text: "pets and animals",
      k: 4,
    });
    if (results.length >= 2) {
      for (let i = 1; i < results.length; i++) {
        if (results[i].similarity > results[i - 1].similarity + 0.0001)
          throw new Error(
            `results not sorted: [${i - 1}]=${results[i - 1].similarity} < [${i}]=${results[i].similarity}`
          );
      }
    }
    ok("vector:search: results sorted by similarity descending");
  } catch (e) {
    fail("vector:search: results sorted by similarity descending", e);
  }

  // 7d: k parameter limits results
  try {
    const results = await ctx.call("vector:search", {
      text: "test query",
      k: 2,
    });
    if (results.length > 2)
      throw new Error(`expected <= 2 results with k=2, got ${results.length}`);
    ok(`vector:search: k=2 limits results to ${results.length}`);
  } catch (e) {
    fail("vector:search: k parameter limits results", e);
  }

  // 7e: Search with pre-computed embedding
  try {
    const embResult = await ctx.call("embed", { text: "sunny weather" });
    const results = await ctx.call("vector:search", {
      embedding: embResult.embedding,
      k: 4,
    });
    if (!Array.isArray(results))
      throw new Error("expected results array");
    ok("vector:search: works with pre-computed embedding");
  } catch (e) {
    fail("vector:search: works with pre-computed embedding", e);
  }

  // 7f: Missing text and embedding throws
  try {
    await ctx.call("vector:search", { k: 5 });
    fail("vector:search: missing text/embedding throws", "did not throw");
  } catch (e: any) {
    const msg = e.message || String(e);
    if (msg.includes("args.text or args.embedding is required"))
      ok("vector:search: missing text/embedding throws descriptive error");
    else fail("vector:search: missing text/embedding throws descriptive error", e);
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("== test-system.ts: System node tests ==\n");

  const ctx = await boot();
  console.log("[boot] ready with compiler + supervisor + tools\n");

  await testShell(ctx);
  await testGraphDescribe(ctx);
  await testGraphSubjects(ctx);
  await testGraphDeps(ctx);
  await testInspect(ctx);
  await testLlmStub(ctx);
  await testAgentTools(ctx);
  await testAgentLoop(ctx);
  await testEmbedStub(ctx);
  await testVectorSearch(ctx);

  // Cleanup: abort supervisor
  const supCtrl = ctx._supervisorControllers?.get("sys:supervisor");
  if (supCtrl) supCtrl.abort();
  await new Promise((r) => setTimeout(r, 100));

  // Summary
  console.log("\n== Summary ==");
  console.log(`  ${passed} passed, ${failed} failed`);

  // Cleanup DB
  try {
    unlinkSync(TEST_DB);
  } catch {}

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results) {
      if (r.includes("FAIL")) console.log(r);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
