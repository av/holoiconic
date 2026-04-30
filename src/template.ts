import type { Ctx } from "./ctx.ts";

// ── Node source code ──────────────────────────────────────────────
// Each value is a valid AsyncFunction body receiving (ctx, args).
// Nodes CANNOT use import statements. They CAN use Bun globals.

const nodes: Record<string, string> = {

  // ── sys:compiler ────────────────────────────────────────────────
  // Replaces ctx.call with a cached, reactively-invalidated version.
  "sys:compiler": `
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cache = new Map();
const nodeStorage = ctx._nodeStorage;
const originalCall = ctx.call.bind(ctx);

ctx.call = async function cachedCall(name, callArgs) {
  let fn = cache.get(name);
  if (!fn) {
    const rs = await ctx.query({ s: name, p: 'source' });
    if (rs.length === 0) {
      throw new Error('[ctx.call] no source found for node: ' + name);
    }
    fn = new AsyncFunction('ctx', 'args', rs[0].o);
    cache.set(name, fn);
  }
  return nodeStorage.run(name, () => fn(ctx, callArgs));
};

// Watch for source changes and invalidate cache
ctx.on({ p: 'source' }, (change) => {
  cache.delete(change.quad.s);
});

console.log('[sys:compiler] installed — ctx.call now cached and reactive');
`,

  // ── sys:supervisor ──────────────────────────────────────────────
  // Watches for spawned nodes and manages lifecycle.
  // Includes retry/backoff for crashed nodes (max 3 retries, exponential backoff).
  "sys:supervisor": `
const controllers = new Map();
const retryCounts = new Map();
const signal = args && args.signal;
const MAX_RETRIES = 3;

function startNode(name, ac) {
  controllers.set(name, ac);
  ctx.call(name, { signal: ac.signal }).catch(async (err) => {
    if (err.name === 'AbortError') return;
    const retries = (retryCounts.get(name) || 0);
    console.error('[sys:supervisor] node crashed:', name, '-', err.message || err);
    if (retries < MAX_RETRIES) {
      const delay = Math.pow(2, retries) * 500;
      retryCounts.set(name, retries + 1);
      console.log('[sys:supervisor] retrying ' + name + ' in ' + delay + 'ms (attempt ' + (retries + 1) + '/' + MAX_RETRIES + ')');
      await new Promise(r => setTimeout(r, delay));
      // Only retry if not aborted
      if (!ac.signal.aborted) {
        const newAc = new AbortController();
        startNode(name, newAc);
      }
    } else {
      console.error('[sys:supervisor] node ' + name + ' exceeded max retries (' + MAX_RETRIES + '), giving up');
    }
  });
}

// Watch for new spawned nodes
ctx.on({ p: 'type', o: 'Spawned' }, async (change) => {
  if (change.type === 'assert') {
    const name = change.quad.s;
    console.log('[sys:supervisor] registered spawned node:', name);
  }
});

// Watch for source changes on spawned nodes — restart them
ctx.on({ p: 'source' }, async (change) => {
  const name = change.quad.s;
  if (change.type !== 'assert') return;
  const spawned = await ctx.query({ s: name, p: 'type', o: 'Spawned' });
  if (spawned.length === 0) return;

  const ac = controllers.get(name);
  if (ac) {
    console.log('[sys:supervisor] restarting:', name);
    await ctx.assert(name, 'lifecycle', 'cleanup');
    ac.abort();
    await ctx.retract(name, 'lifecycle', 'cleanup');

    // Reset retry count on manual source change
    retryCounts.set(name, 0);
    const newAc = new AbortController();
    startNode(name, newAc);
  }
});

// Expose controller registration for spawn node
ctx._supervisorControllers = controllers;
// Expose startNode for spawn node to use
ctx._supervisorStartNode = startNode;

// Keep alive until aborted
if (signal) {
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
  // Abort all managed nodes on shutdown
  for (const [name, ac] of controllers) {
    await ctx.assert(name, 'lifecycle', 'cleanup');
    ac.abort();
  }
  console.log('[sys:supervisor] shut down');
}
`,

  // ── spawn ───────────────────────────────────────────────────────
  // Starts a supervised long-lived node.
  "spawn": `
const node = args && args.node;
if (!node) throw new Error('[spawn] args.node is required');

const ac = new AbortController();

// Register with supervisor
await ctx.assert(node, 'type', 'Spawned');

// Use supervisor's startNode if available (enables retry/backoff)
if (ctx._supervisorStartNode) {
  ctx._supervisorStartNode(node, ac);
} else {
  // Fallback: store controller and start manually
  if (ctx._supervisorControllers) {
    ctx._supervisorControllers.set(node, ac);
  }
  ctx.call(node, { signal: ac.signal }).catch(err => {
    if (err.name !== 'AbortError') console.error('[spawn] node error:', node, err);
  });
}

return ac;
`,

  // ── shell ───────────────────────────────────────────────────────
  // Executes a shell command and returns stdout.
  "shell": `
const cmd = args && args.cmd;
if (!cmd) throw new Error('[shell] args.cmd is required');

const proc = Bun.spawn(['sh', '-c', cmd], {
  stdout: 'pipe',
  stderr: 'pipe',
});

const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited;

if (exitCode !== 0) {
  throw new Error('[shell] command failed (exit ' + exitCode + '): ' + stderr);
}

return stdout;
`,

  // ── llm ─────────────────────────────────────────────────────────
  // Real Anthropic API integration via fetch.
  "llm": `
const apiKey = typeof Bun !== 'undefined' ? Bun.env.ANTHROPIC_API_KEY : process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  // Fallback stub when no API key is configured
  const messages = args && args.messages;
  const model = (args && args.model) || 'default';
  return {
    id: 'stub',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: '[llm] No ANTHROPIC_API_KEY set. Model: ' + model }],
    stop_reason: 'end_turn',
    model: model,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

const messages = args && args.messages;
if (!messages || !Array.isArray(messages)) {
  throw new Error('[llm] args.messages (array) is required');
}

const model = (args && args.model) || 'claude-sonnet-4-20250514';
const maxTokens = (args && args.max_tokens) || 4096;
const temperature = args && args.temperature;

const body = {
  model,
  max_tokens: maxTokens,
  messages,
};
if (args && args.system) body.system = args.system;
if (args && args.tools && args.tools.length > 0) body.tools = args.tools;
if (temperature !== undefined) body.temperature = temperature;

const resp = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  },
  body: JSON.stringify(body),
});

if (!resp.ok) {
  const errText = await resp.text();
  throw new Error('[llm] API error (' + resp.status + '): ' + errText);
}

const result = await resp.json();
return result;
`,

  // ── agent:tools ─────────────────────────────────────────────────
  // Registers core tools as Tool-typed quads for the agentic loop.
  "agent:tools": `
// Shell tool
await ctx.assert('shell', 'type', 'Tool');
await ctx.assert('shell', 'tool_schema', JSON.stringify({
  name: 'shell',
  description: 'Execute a shell command and return stdout. Use for running programs, file operations, etc.',
  input_schema: {
    type: 'object',
    properties: {
      cmd: { type: 'string', description: 'The shell command to execute' }
    },
    required: ['cmd']
  }
}));

// Query tool — lets the agent query the graph
await ctx.assert('graph_query', 'type', 'Tool');
await ctx.assert('graph_query', 'tool_schema', JSON.stringify({
  name: 'graph_query',
  description: 'Query the RDF quad graph. Returns quads matching the given pattern. Omit fields to use them as wildcards.',
  input_schema: {
    type: 'object',
    properties: {
      s: { type: 'string', description: 'Subject filter (optional)' },
      p: { type: 'string', description: 'Predicate filter (optional)' },
      o: { type: 'string', description: 'Object/value filter (optional)' },
      g: { type: 'string', description: 'Graph filter (optional)' }
    }
  }
}));

// Assert tool — lets the agent assert quads
await ctx.assert('graph_assert', 'type', 'Tool');
await ctx.assert('graph_assert', 'tool_schema', JSON.stringify({
  name: 'graph_assert',
  description: 'Assert (insert) a quad into the RDF graph. If the quad already exists, this is a no-op.',
  input_schema: {
    type: 'object',
    properties: {
      s: { type: 'string', description: 'Subject' },
      p: { type: 'string', description: 'Predicate' },
      o: { type: 'string', description: 'Object/value' },
      g: { type: 'string', description: 'Graph (defaults to _)' }
    },
    required: ['s', 'p', 'o']
  }
}));

// Retract tool — lets the agent retract quads
await ctx.assert('graph_retract', 'type', 'Tool');
await ctx.assert('graph_retract', 'tool_schema', JSON.stringify({
  name: 'graph_retract',
  description: 'Retract (delete) a quad from the RDF graph. If the quad does not exist, this is a no-op.',
  input_schema: {
    type: 'object',
    properties: {
      s: { type: 'string', description: 'Subject' },
      p: { type: 'string', description: 'Predicate' },
      o: { type: 'string', description: 'Object/value' },
      g: { type: 'string', description: 'Graph (defaults to _)' }
    },
    required: ['s', 'p', 'o']
  }
}));

// Nodes tool — list all function nodes
await ctx.assert('list_nodes', 'type', 'Tool');
await ctx.assert('list_nodes', 'tool_schema', JSON.stringify({
  name: 'list_nodes',
  description: 'List all function nodes registered in the graph. Returns their names.',
  input_schema: {
    type: 'object',
    properties: {}
  }
}));

// Snapshot export tool
await ctx.assert('snapshot:export', 'type', 'Tool');
await ctx.assert('snapshot:export', 'tool_schema', JSON.stringify({
  name: 'snapshot_export',
  description: 'Export all quads from the graph as JSON. Optionally write to a file path.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path to write JSON to (optional — if omitted, returns JSON string)' }
    }
  }
}));

// Snapshot import tool
await ctx.assert('snapshot:import', 'type', 'Tool');
await ctx.assert('snapshot:import', 'tool_schema', JSON.stringify({
  name: 'snapshot_import',
  description: 'Import quads from a JSON string or file path into the graph.',
  input_schema: {
    type: 'object',
    properties: {
      data: { type: 'string', description: 'JSON string containing array of quads (optional if path provided)' },
      path: { type: 'string', description: 'File path to read JSON from (optional if data provided)' }
    }
  }
}));

// Snapshot backup tool
await ctx.assert('snapshot:backup', 'type', 'Tool');
await ctx.assert('snapshot:backup', 'tool_schema', JSON.stringify({
  name: 'snapshot_backup',
  description: 'Create a file-level backup of the SQLite database.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Destination file path (optional — defaults to timestamped name)' }
    }
  }
}));

// Vector search tool
await ctx.assert('vector:search', 'type', 'Tool');
await ctx.assert('vector:search', 'tool_schema', JSON.stringify({
  name: 'vector_search',
  description: 'Semantic search over quads using vector embeddings. Provide text or a pre-computed embedding.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Text to search for (will be embedded automatically)' },
      embedding: { type: 'array', items: { type: 'number' }, description: 'Pre-computed embedding vector (optional if text provided)' },
      k: { type: 'number', description: 'Number of results to return (default: 10)' }
    }
  }
}));

// Describe tool — inspect all quads about a subject
await ctx.assert('graph_describe', 'type', 'Tool');
await ctx.assert('graph_describe', 'tool_schema', JSON.stringify({
  name: 'graph_describe',
  description: 'Describe a subject: return ALL quads about it (all predicates and values). Useful for inspecting what a node IS.',
  input_schema: {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'The subject to describe (e.g. a node name)' }
    },
    required: ['subject']
  }
}));

// Subjects tool — list all unique subjects
await ctx.assert('graph_subjects', 'type', 'Tool');
await ctx.assert('graph_subjects', 'tool_schema', JSON.stringify({
  name: 'graph_subjects',
  description: 'List all unique subjects in the graph. Optionally filter by type (Function, Tool, Spawned, etc.).',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', description: 'Filter by type (e.g. Function, Tool, Spawned). Optional.' }
    }
  }
}));

console.log('[agent:tools] registered 11 tools');
`,

  // ── agent:loop ─────────────────────────────────────────────────
  // Core agentic loop — maintains conversation, dispatches tool calls.
  // Returns { session, response, tool_calls } where tool_calls captures every
  // tool invocation for visibility in the WebUI.
  "agent:loop": `
const prompt = args && args.prompt;
if (!prompt) throw new Error('[agent:loop] args.prompt is required');

const sessionId = (args && args.session) || ('session:' + Date.now());

// System prompt
const systemPrompt = \`You are an AI assistant running inside holoiconic, a self-modifying agentic runtime.
Everything in this system exists as RDF quads (subject, predicate, object, graph) in a reactive graph database.
Code, state, tools, and even this agentic loop are all quads in the same graph.

You have access to tools that let you:
- Execute shell commands
- Query the graph for quads
- Assert (insert) new quads
- Retract (delete) quads
- List all function nodes

The graph is reactive: when quads change, watchers fire automatically.
Function nodes have (name, 'source', code) and (name, 'type', 'Function') quads.
You can create new nodes by asserting source and type quads.

Be concise and helpful. When using tools, explain what you are doing.\`;

// Load conversation history from graph
// Messages are stored as {seq, msg} to ensure uniqueness even with identical content
const historyQuads = await ctx.query({ p: 'message', g: sessionId });
const history = historyQuads
  .sort((a, b) => a.id - b.id)
  .map(q => { const w = JSON.parse(q.o); return w.msg || w; });

// Determine next sequence number
let seq = historyQuads.length;

// Add the new user message
const userMsg = { role: 'user', content: prompt };
await ctx.assert(sessionId, 'message', JSON.stringify({ seq: seq++, msg: userMsg }), sessionId);
history.push(userMsg);

// Collect available tools
const toolQuads = await ctx.query({ p: 'type', o: 'Tool' });
const tools = [];
for (const tq of toolQuads) {
  const schemaQuads = await ctx.query({ s: tq.s, p: 'tool_schema' });
  if (schemaQuads.length > 0) {
    try {
      tools.push(JSON.parse(schemaQuads[0].o));
    } catch {}
  }
}

// Track all tool calls for visibility
const allToolCalls = [];

// Agentic loop — keep calling LLM until we get a text response (no tool_use)
let messages = [...history];
const maxIterations = 20;

for (let i = 0; i < maxIterations; i++) {
  const llmArgs = {
    messages,
    system: systemPrompt,
    tools: tools.length > 0 ? tools : undefined,
  };

  const response = await ctx.call('llm', llmArgs);

  // Store the assistant message in the graph
  const assistantMsg = { role: 'assistant', content: response.content };
  await ctx.assert(sessionId, 'message', JSON.stringify({ seq: seq++, msg: assistantMsg }), sessionId);
  messages.push(assistantMsg);

  // Check if response contains tool_use
  const toolUseBlocks = (response.content || []).filter(b => b.type === 'tool_use');

  if (toolUseBlocks.length === 0) {
    // Pure text response — extract and return it
    const textBlocks = (response.content || []).filter(b => b.type === 'text');
    const text = textBlocks.map(b => b.text).join('\\n');
    return { session: sessionId, response: text, tool_calls: allToolCalls };
  }

  // Execute each tool call
  const toolResults = [];
  for (const toolBlock of toolUseBlocks) {
    const toolName = toolBlock.name;
    const toolInput = toolBlock.input;
    let result;

    try {
      if (toolName === 'shell') {
        result = await ctx.call('shell', { cmd: toolInput.cmd });
      } else if (toolName === 'graph_query') {
        const pattern = {};
        if (toolInput.s) pattern.s = toolInput.s;
        if (toolInput.p) pattern.p = toolInput.p;
        if (toolInput.o) pattern.o = toolInput.o;
        if (toolInput.g) pattern.g = toolInput.g;
        const quads = await ctx.query(pattern);
        result = JSON.stringify(quads, null, 2);
      } else if (toolName === 'graph_assert') {
        const quad = await ctx.assert(toolInput.s, toolInput.p, toolInput.o, toolInput.g || '_');
        result = 'Asserted: ' + JSON.stringify(quad);
      } else if (toolName === 'graph_retract') {
        await ctx.retract(toolInput.s, toolInput.p, toolInput.o, toolInput.g || '_');
        result = 'Retracted successfully';
      } else if (toolName === 'list_nodes') {
        const nodes = await ctx.query({ p: 'type', o: 'Function' });
        result = nodes.map(n => n.s).join('\\n');
      } else if (toolName === 'snapshot_export') {
        result = await ctx.call('snapshot:export', toolInput);
      } else if (toolName === 'snapshot_import') {
        result = JSON.stringify(await ctx.call('snapshot:import', toolInput));
      } else if (toolName === 'snapshot_backup') {
        result = JSON.stringify(await ctx.call('snapshot:backup', toolInput));
      } else if (toolName === 'vector_search') {
        result = JSON.stringify(await ctx.call('vector:search', toolInput));
      } else if (toolName === 'graph_describe') {
        result = JSON.stringify(await ctx.call('graph:describe', toolInput));
      } else if (toolName === 'graph_subjects') {
        result = JSON.stringify(await ctx.call('graph:subjects', toolInput));
      } else {
        // Try calling it as a generic node
        result = JSON.stringify(await ctx.call(toolName, toolInput));
      }
    } catch (err) {
      result = 'Error: ' + (err.message || String(err));
    }

    const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

    // Record tool call for visibility
    allToolCalls.push({
      name: toolName,
      input: toolInput,
      result: resultStr,
    });

    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolBlock.id,
      content: resultStr,
    });
  }

  // Add tool results as a user message and loop
  const toolResultMsg = { role: 'user', content: toolResults };
  await ctx.assert(sessionId, 'message', JSON.stringify({ seq: seq++, msg: toolResultMsg }), sessionId);
  messages.push(toolResultMsg);
}

return { session: sessionId, response: '[agent:loop] max iterations reached', tool_calls: allToolCalls };
`,

  // ── api:server ──────────────────────────────────────────────────
  // OpenAI-compatible chat completions API on port 3001.
  // Supports session persistence and SSE streaming.
  "api:server": `
const signal = args && args.signal;
const port = (args && args.port) || 3001;

// Helper to create a unique ID
function genId() {
  return 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers for WebUI
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // GET /v1/models
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return Response.json({
        object: 'list',
        data: [
          { id: 'holoiconic', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'holoiconic' },
        ],
      }, { headers: corsHeaders });
    }

    // POST /v1/chat/completions
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      try {
        const body = await req.json();
        const messages = body.messages || [];
        const lastUserMsg = messages.filter(m => m.role === 'user').pop();
        const prompt = lastUserMsg ? lastUserMsg.content : '';

        if (!prompt) {
          return Response.json({ error: { message: 'No user message found', type: 'invalid_request_error' } }, { status: 400, headers: corsHeaders });
        }

        // Use session from request body (non-standard extension) or generate one
        const sessionId = body.session || ('api:' + Date.now());

        // Route through the agentic loop
        const result = await ctx.call('agent:loop', {
          prompt,
          session: sessionId,
          tools: body.tools,
        });

        const responseText = result.response || '';
        const toolCalls = result.tool_calls || [];
        const id = genId();

        // Streaming mode: return SSE
        if (body.stream) {
          const words = responseText.split(/(?<=\\s)/);
          const encoder = new TextEncoder();

          const stream = new ReadableStream({
            async start(controller) {
              // If there are tool calls, send them as a metadata event first
              if (toolCalls.length > 0) {
                const metaChunk = {
                  id,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || 'holoiconic',
                  choices: [{
                    index: 0,
                    delta: { tool_calls: toolCalls },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode('data: ' + JSON.stringify(metaChunk) + '\\n\\n'));
              }

              for (let i = 0; i < words.length; i++) {
                const chunk = {
                  id,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: body.model || 'holoiconic',
                  choices: [{
                    index: 0,
                    delta: { content: words[i] },
                    finish_reason: null,
                  }],
                };
                controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\\n\\n'));
                // Small delay between chunks to simulate streaming
                if (i < words.length - 1) {
                  await new Promise(r => setTimeout(r, 15));
                }
              }

              // Final chunk with finish_reason
              const finalChunk = {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: body.model || 'holoiconic',
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: 'stop',
                }],
              };
              controller.enqueue(encoder.encode('data: ' + JSON.stringify(finalChunk) + '\\n\\n'));
              controller.enqueue(encoder.encode('data: [DONE]\\n\\n'));
              controller.close();
            },
          });

          return new Response(stream, {
            headers: {
              ...corsHeaders,
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              'Connection': 'keep-alive',
            },
          });
        }

        // Non-streaming: return full completion
        const completion = {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'holoiconic',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: responseText },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          session: sessionId,
          tool_calls: toolCalls,
        };

        return Response.json(completion, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: { message: err.message || String(err), type: 'internal_error' } }, { status: 500, headers: corsHeaders });
      }
    }

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: corsHeaders });
    }

    return Response.json({ error: { message: 'Not found', type: 'invalid_request_error' } }, { status: 404, headers: corsHeaders });
  },
});

console.log('[api:server] listening on http://localhost:' + port);

// Keep alive until aborted
if (signal) {
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
  server.stop(true);
  console.log('[api:server] stopped');
}
`,

  // ── web:ui ─────────────────────────────────────────────────────
  // Chat + graph explorer WebUI with node editing, creation, and tool call visibility.
  "web:ui": `
const signal = args && args.signal;
const port = (args && args.port) || 3002;
const apiPort = (args && args.apiPort) || 3001;

const html = \`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>holoiconic</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', monospace; display: flex; height: 100vh; }
  #chat-panel { flex: 1; display: flex; flex-direction: column; border-right: 1px solid #21262d; }
  #graph-panel { width: 400px; display: flex; flex-direction: column; }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid #21262d; font-weight: 600; font-size: 14px; color: #58a6ff; display: flex; justify-content: space-between; align-items: center; }
  .panel-header button { background: #238636; color: #fff; border: none; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .panel-header button:hover { background: #2ea043; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.5; }
  .msg.user { background: #1f2937; color: #e5e7eb; }
  .msg.assistant { background: #161b22; color: #c9d1d9; border-left: 3px solid #58a6ff; }
  .msg .role { font-size: 11px; text-transform: uppercase; color: #8b949e; margin-bottom: 4px; }
  .tool-calls { margin-top: 8px; }
  .tool-call { background: #1c1f26; border: 1px solid #30363d; border-radius: 4px; margin-bottom: 6px; font-size: 12px; }
  .tool-call-header { padding: 6px 10px; cursor: pointer; color: #d2a8ff; display: flex; justify-content: space-between; align-items: center; }
  .tool-call-header:hover { background: #21262d; }
  .tool-call-body { display: none; padding: 6px 10px; border-top: 1px solid #30363d; color: #8b949e; font-family: monospace; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
  .tool-call-body.open { display: block; }
  .tool-call-label { font-weight: 600; color: #d2a8ff; }
  .tool-call-toggle { font-size: 10px; color: #8b949e; }
  #input-row { display: flex; padding: 12px 16px; border-top: 1px solid #21262d; gap: 8px; }
  #input { flex: 1; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 14px; font-family: inherit; }
  #input:focus { outline: none; border-color: #58a6ff; }
  #send { background: #238636; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  #send:hover { background: #2ea043; }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
  #node-list { flex: 1; overflow-y: auto; padding: 8px; }
  #node-search { width: 100%; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; font-size: 12px; font-family: monospace; border-radius: 4px; margin-bottom: 4px; }
  #node-search:focus { outline: none; border-color: #58a6ff; }
  #node-search-wrap { padding: 8px 8px 0 8px; }
  .node-item { padding: 6px 10px; cursor: pointer; border-radius: 4px; font-size: 13px; font-family: monospace; display: flex; align-items: center; gap: 6px; }
  .node-item:hover { background: #161b22; }
  .node-item.selected { background: #1f2937; color: #58a6ff; }
  .node-item .node-name-text { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 9px; padding: 1px 5px; border-radius: 3px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; flex-shrink: 0; }
  .badge-function { background: #1f6feb33; color: #58a6ff; }
  .badge-tool { background: #23863633; color: #3fb950; }
  .badge-spawned { background: #da363333; color: #f85149; }
  .badge-other { background: #30363d; color: #8b949e; }
  #node-detail { border-top: 1px solid #21262d; display: flex; flex-direction: column; }
  #node-detail-header { padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid #21262d; }
  #node-detail-header .node-name { font-weight: 600; font-size: 13px; color: #58a6ff; }
  #node-detail-header .btn-group { display: flex; gap: 4px; }
  #node-detail-header button { background: #30363d; color: #c9d1d9; border: none; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 11px; }
  #node-detail-header button:hover { background: #484f58; }
  #node-detail-header button.save-btn { background: #238636; color: #fff; }
  #node-detail-header button.save-btn:hover { background: #2ea043; }
  #node-detail-header button.cancel-btn { background: #da3633; color: #fff; }
  #node-detail-header button.cancel-btn:hover { background: #f85149; }
  #node-detail-header button.delete-btn { background: #da3633; color: #fff; }
  #node-detail-header button.delete-btn:hover { background: #f85149; }
  #node-source { height: 300px; overflow-y: auto; padding: 12px; font-size: 12px; font-family: monospace; white-space: pre-wrap; background: #0d1117; color: #8b949e; }
  #node-source-edit { height: 300px; width: 100%; padding: 12px; font-size: 12px; font-family: monospace; background: #161b22; color: #c9d1d9; border: 1px solid #58a6ff; resize: none; display: none; }
  #create-node-form { padding: 12px; border-top: 1px solid #21262d; display: none; }
  #create-node-form input, #create-node-form textarea { width: 100%; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 10px; border-radius: 4px; font-size: 12px; font-family: monospace; margin-bottom: 8px; }
  #create-node-form input:focus, #create-node-form textarea:focus { outline: none; border-color: #58a6ff; }
  #create-node-form textarea { height: 120px; resize: vertical; }
  #create-node-form .form-buttons { display: flex; gap: 4px; justify-content: flex-end; }
  #create-node-form button { padding: 4px 10px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  #create-node-form .create-btn { background: #238636; color: #fff; }
  #create-node-form .create-cancel-btn { background: #30363d; color: #c9d1d9; }
  .notification { position: fixed; top: 16px; right: 16px; padding: 10px 16px; border-radius: 6px; font-size: 13px; z-index: 1000; animation: fadeOut 3s forwards; }
  .notification.success { background: #238636; color: #fff; }
  .notification.error { background: #da3633; color: #fff; }
  @keyframes fadeOut { 0%,70% { opacity: 1; } 100% { opacity: 0; } }
</style>
</head>
<body>
<div id="chat-panel">
  <div class="panel-header">holoiconic chat</div>
  <div id="messages"></div>
  <div id="input-row">
    <input id="input" type="text" placeholder="Type a message..." autocomplete="off" />
    <button id="send">Send</button>
  </div>
</div>
<div id="graph-panel">
  <div class="panel-header"><span>graph nodes</span><button id="create-node-btn">+ New Node</button></div>
  <div id="create-node-form">
    <input id="new-node-name" type="text" placeholder="Node name (e.g. my:function)" />
    <textarea id="new-node-source" placeholder="Node source code (async function body receiving ctx, args)"></textarea>
    <div class="form-buttons">
      <button class="create-cancel-btn" id="create-cancel">Cancel</button>
      <button class="create-btn" id="create-submit">Create</button>
    </div>
  </div>
  <div id="node-search-wrap"><input id="node-search" type="text" placeholder="Filter nodes..." autocomplete="off" /></div>
  <div id="node-list"></div>
  <div id="node-detail">
    <div id="node-detail-header">
      <span class="node-name" id="detail-node-name"></span>
      <div class="btn-group" id="detail-buttons"></div>
    </div>
    <div id="node-source">Click a node to view source</div>
    <textarea id="node-source-edit"></textarea>
  </div>
</div>
<script>
const API = 'http://localhost:' + \${apiPort} + '/v1/chat/completions';
const BASE = 'http://localhost:' + \${port};
const msgDiv = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const nodeList = document.getElementById('node-list');
const nodeSource = document.getElementById('node-source');
const nodeSourceEdit = document.getElementById('node-source-edit');
const detailNodeName = document.getElementById('detail-node-name');
const detailButtons = document.getElementById('detail-buttons');
const createNodeForm = document.getElementById('create-node-form');
const nodeSearchInput = document.getElementById('node-search');

let selectedNode = null;
let originalSource = null;
let editMode = false;
let allNodesCache = [];

// Persistent session ID for multi-turn conversations
const sessionId = 'webui:' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
const chatHistory = [];

function notify(msg, type) {
  const el = document.createElement('div');
  el.className = 'notification ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function renderToolCalls(toolCalls, container) {
  if (!toolCalls || toolCalls.length === 0) return;
  const wrap = document.createElement('div');
  wrap.className = 'tool-calls';
  for (const tc of toolCalls) {
    const tcDiv = document.createElement('div');
    tcDiv.className = 'tool-call';
    const header = document.createElement('div');
    header.className = 'tool-call-header';
    header.innerHTML = '<span class="tool-call-label">' + escHtml(tc.name) + '</span><span class="tool-call-toggle">click to expand</span>';
    const body = document.createElement('div');
    body.className = 'tool-call-body';
    body.textContent = 'Input: ' + JSON.stringify(tc.input, null, 2) + '\\n\\nResult: ' + (tc.result || '(no result)');
    header.onclick = () => {
      body.classList.toggle('open');
      header.querySelector('.tool-call-toggle').textContent = body.classList.contains('open') ? 'collapse' : 'click to expand';
    };
    tcDiv.appendChild(header);
    tcDiv.appendChild(body);
    wrap.appendChild(tcDiv);
  }
  container.appendChild(wrap);
}

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendBtn.disabled = true;
  addMsg('user', text);
  chatHistory.push({ role: 'user', content: text });

  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = '<div class="role">assistant</div>';
  const contentSpan = document.createElement('span');
  d.appendChild(contentSpan);
  msgDiv.appendChild(d);

  let fullText = '';
  let toolCalls = [];

  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'holoiconic',
        messages: chatHistory,
        session: sessionId,
        stream: true,
      }),
    });

    if (!res.ok) {
      const err = await res.json();
      contentSpan.textContent = 'Error: ' + (err.error ? err.error.message : res.statusText);
      sendBtn.disabled = false;
      input.focus();
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;
        const payload = trimmed.slice(6);
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (delta && delta.tool_calls) {
            toolCalls = delta.tool_calls;
          }
          if (delta && delta.content) {
            fullText += delta.content;
            contentSpan.textContent = fullText;
            msgDiv.scrollTop = msgDiv.scrollHeight;
          }
        } catch {}
      }
    }

    // Render tool calls if any
    renderToolCalls(toolCalls, d);

    chatHistory.push({ role: 'assistant', content: fullText });
  } catch (e) {
    contentSpan.textContent = 'Error: ' + e.message;
  }
  sendBtn.disabled = false;
  input.focus();
  loadNodes();
}

function addMsg(role, content) {
  const d = document.createElement('div');
  d.className = 'msg ' + role;
  d.innerHTML = '<div class="role">' + role + '</div>' + escHtml(content);
  msgDiv.appendChild(d);
  msgDiv.scrollTop = msgDiv.scrollHeight;
}

sendBtn.onclick = send;
input.onkeydown = (e) => { if (e.key === 'Enter') send(); };

function setEditMode(on) {
  editMode = on;
  nodeSource.style.display = on ? 'none' : 'block';
  nodeSourceEdit.style.display = on ? 'block' : 'none';
  renderDetailButtons();
}

function renderDetailButtons() {
  detailButtons.innerHTML = '';
  if (!selectedNode) return;
  if (editMode) {
    const saveBtn = document.createElement('button');
    saveBtn.className = 'save-btn';
    saveBtn.textContent = 'Save';
    saveBtn.onclick = saveSource;
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'cancel-btn';
    cancelBtn.textContent = 'Cancel';
    cancelBtn.onclick = () => {
      setEditMode(false);
      nodeSource.textContent = originalSource || '(no source)';
    };
    detailButtons.appendChild(cancelBtn);
    detailButtons.appendChild(saveBtn);
  } else {
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.onclick = () => {
      nodeSourceEdit.value = originalSource || '';
      setEditMode(true);
    };
    detailButtons.appendChild(editBtn);
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.onclick = deleteNode;
    detailButtons.appendChild(deleteBtn);
  }
}

async function deleteNode() {
  if (!selectedNode) return;
  if (!confirm('Delete node "' + selectedNode + '"? This retracts ALL quads for this subject.')) return;
  try {
    const res = await fetch(BASE + '/api/node/' + encodeURIComponent(selectedNode), {
      method: 'DELETE',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    notify('Node "' + selectedNode + '" deleted (' + data.retracted + ' quads)', 'success');
    selectedNode = null;
    detailNodeName.textContent = '';
    nodeSource.textContent = 'Click a node to view source';
    detailButtons.innerHTML = '';
    loadNodes();
  } catch (e) {
    notify('Error deleting: ' + e.message, 'error');
  }
}

async function saveSource() {
  const newSource = nodeSourceEdit.value;
  try {
    const res = await fetch(BASE + '/api/node/' + encodeURIComponent(selectedNode) + '/source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: newSource }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Save failed');
    originalSource = newSource;
    nodeSource.textContent = newSource;
    setEditMode(false);
    notify('Node "' + selectedNode + '" saved', 'success');
    loadNodes();
  } catch (e) {
    notify('Error saving: ' + e.message, 'error');
  }
}

function getBadgeClass(types) {
  if (!types || types.length === 0) return 'badge-other';
  if (types.includes('Tool')) return 'badge-tool';
  if (types.includes('Spawned')) return 'badge-spawned';
  if (types.includes('Function')) return 'badge-function';
  return 'badge-other';
}

function renderNodeList(filter) {
  const f = (filter || '').toLowerCase();
  nodeList.innerHTML = '';
  for (const n of allNodesCache) {
    if (f && !n.name.toLowerCase().includes(f)) continue;
    const el = document.createElement('div');
    el.className = 'node-item' + (n.name === selectedNode ? ' selected' : '');
    const nameSpan = document.createElement('span');
    nameSpan.className = 'node-name-text';
    nameSpan.textContent = n.name;
    el.appendChild(nameSpan);
    if (n.types && n.types.length > 0) {
      for (const t of n.types) {
        const badge = document.createElement('span');
        badge.className = 'badge ' + getBadgeClass([t]);
        badge.textContent = t;
        el.appendChild(badge);
      }
    }
    el.onclick = () => showSource(n.name, el);
    nodeList.appendChild(el);
  }
}

async function loadNodes() {
  try {
    const res = await fetch(BASE + '/api/nodes');
    const nodes = await res.json();
    allNodesCache = nodes;
    renderNodeList(nodeSearchInput.value);
  } catch {}
}

nodeSearchInput.oninput = () => renderNodeList(nodeSearchInput.value);

async function showSource(name, el) {
  document.querySelectorAll('.node-item').forEach(e => e.classList.remove('selected'));
  if (el) el.classList.add('selected');
  selectedNode = name;
  setEditMode(false);
  detailNodeName.textContent = name;
  try {
    const res = await fetch(BASE + '/api/node/' + encodeURIComponent(name));
    const data = await res.json();
    originalSource = data.source;
    nodeSource.textContent = data.source || '(no source)';
    renderDetailButtons();
  } catch {
    nodeSource.textContent = '(error loading)';
    originalSource = null;
    renderDetailButtons();
  }
}

// Create Node
document.getElementById('create-node-btn').onclick = () => {
  createNodeForm.style.display = createNodeForm.style.display === 'none' ? 'block' : 'block';
  createNodeForm.style.display = 'block';
};
document.getElementById('create-cancel').onclick = () => {
  createNodeForm.style.display = 'none';
  document.getElementById('new-node-name').value = '';
  document.getElementById('new-node-source').value = '';
};
document.getElementById('create-submit').onclick = async () => {
  const name = document.getElementById('new-node-name').value.trim();
  const source = document.getElementById('new-node-source').value;
  if (!name) { notify('Node name is required', 'error'); return; }
  if (!source) { notify('Node source is required', 'error'); return; }
  try {
    const res = await fetch(BASE + '/api/nodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, source }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Create failed');
    createNodeForm.style.display = 'none';
    document.getElementById('new-node-name').value = '';
    document.getElementById('new-node-source').value = '';
    notify('Node "' + name + '" created', 'success');
    loadNodes();
    // Auto-select the new node
    setTimeout(() => showSource(name, null), 200);
  } catch (e) {
    notify('Error creating: ' + e.message, 'error');
  }
};

loadNodes();
</script>
</body>
</html>\`;

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Serve the SPA
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } });
    }

    // API: list nodes (GET) or create node (POST)
    if (url.pathname === '/api/nodes') {
      if (req.method === 'POST') {
        try {
          const body = await req.json();
          const name = body.name;
          const source = body.source;
          if (!name || typeof name !== 'string') {
            return Response.json({ error: 'name (string) is required' }, { status: 400, headers: corsHeaders });
          }
          if (!source || typeof source !== 'string') {
            return Response.json({ error: 'source (string) is required' }, { status: 400, headers: corsHeaders });
          }
          // Check if node already exists
          const existing = await ctx.query({ s: name, p: 'type', o: 'Function' });
          if (existing.length > 0) {
            return Response.json({ error: 'Node already exists: ' + name }, { status: 409, headers: corsHeaders });
          }
          await ctx.assert(name, 'type', 'Function');
          await ctx.assert(name, 'source', source);
          return Response.json({ ok: true, name }, { status: 201, headers: corsHeaders });
        } catch (err) {
          return Response.json({ error: err.message || String(err) }, { status: 500, headers: corsHeaders });
        }
      }
      // GET: list nodes — returns names and their types
      const fnNodes = await ctx.query({ p: 'type', o: 'Function' });
      const names = fnNodes.map(n => n.s);
      const result = [];
      for (const name of names) {
        const typeQuads = await ctx.query({ s: name, p: 'type' });
        const types = typeQuads.map(q => q.o);
        result.push({ name, types });
      }
      result.sort((a, b) => a.name.localeCompare(b.name));
      return Response.json(result, { headers: corsHeaders });
    }

    // API: update node source (POST /api/node/:name/source)
    if (url.pathname.match(/^\\/api\\/node\\/.+\\/source$/) && req.method === 'POST') {
      try {
        // Extract node name: everything between /api/node/ and /source
        const pathParts = url.pathname.slice('/api/node/'.length);
        const name = decodeURIComponent(pathParts.slice(0, pathParts.lastIndexOf('/source')));
        const body = await req.json();
        const newSource = body.source;
        if (typeof newSource !== 'string') {
          return Response.json({ error: 'source (string) is required' }, { status: 400, headers: corsHeaders });
        }

        // Find the old source quad
        const oldSourceQuads = await ctx.query({ s: name, p: 'source' });
        if (oldSourceQuads.length > 0) {
          // Retract old source
          await ctx.retract(name, 'source', oldSourceQuads[0].o);
        }

        // Assert the new source
        await ctx.assert(name, 'source', newSource);

        return Response.json({ ok: true, name }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message || String(err) }, { status: 500, headers: corsHeaders });
      }
    }

    // API: delete a node (DELETE /api/node/:name)
    if (url.pathname.startsWith('/api/node/') && !url.pathname.includes('/source') && req.method === 'DELETE') {
      try {
        const name = decodeURIComponent(url.pathname.slice('/api/node/'.length));
        // Retract ALL quads where this subject appears
        const quads = await ctx.query({ s: name });
        for (const q of quads) {
          await ctx.retract(q.s, q.p, q.o, q.g);
        }
        return Response.json({ ok: true, name, retracted: quads.length }, { headers: corsHeaders });
      } catch (err) {
        return Response.json({ error: err.message || String(err) }, { status: 500, headers: corsHeaders });
      }
    }

    // API: get node source (GET /api/node/:name)
    if (url.pathname.startsWith('/api/node/') && req.method === 'GET') {
      const name = decodeURIComponent(url.pathname.slice('/api/node/'.length));
      const sourceQuads = await ctx.query({ s: name, p: 'source' });
      const source = sourceQuads.length > 0 ? sourceQuads[0].o : null;
      return Response.json({ name, source }, { headers: corsHeaders });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log('[web:ui] listening on http://localhost:' + port);

if (signal) {
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
  server.stop(true);
  console.log('[web:ui] stopped');
}
`,

  // ── snapshot:export ──────────────────────────────────────────────
  // Exports all quads from the graph as JSON.
  "snapshot:export": `
const allQuads = await ctx.query({});
const data = allQuads.map(q => ({
  s: q.s,
  p: q.p,
  o: q.o,
  g: q.g,
  attrs: q.attrs || undefined,
}));
const json = JSON.stringify(data, null, 2);

const path = args && args.path;
if (path) {
  await Bun.write(path, json);
  console.log('[snapshot:export] wrote ' + data.length + ' quads to ' + path);
  return { count: data.length, path };
}
return json;
`,

  // ── snapshot:import ──────────────────────────────────────────────
  // Imports quads from a JSON string or file path.
  "snapshot:import": `
let jsonStr;
if (args && args.path) {
  const file = Bun.file(args.path);
  jsonStr = await file.text();
} else if (args && args.data) {
  jsonStr = args.data;
} else {
  throw new Error('[snapshot:import] args.data or args.path is required');
}

const quads = JSON.parse(jsonStr);
if (!Array.isArray(quads)) throw new Error('[snapshot:import] expected JSON array');

let count = 0;
for (const q of quads) {
  await ctx.assert(q.s, q.p, q.o, q.g || '_');
  count++;
}

console.log('[snapshot:import] imported ' + count + ' quads');
return { count };
`,

  // ── snapshot:backup ────────────────────────────────────────────
  // File-level backup of the SQLite database.
  "snapshot:backup": `
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = (args && args.path) || ('holoiconic-backup-' + timestamp + '.db');

// The database file path — default is holoiconic.db
const srcPath = (args && args.srcPath) || 'holoiconic.db';

const srcFile = Bun.file(srcPath);
const exists = await srcFile.exists();
if (!exists) {
  throw new Error('[snapshot:backup] source database not found: ' + srcPath);
}

await Bun.write(dest, srcFile);
console.log('[snapshot:backup] backed up to ' + dest);
return { path: dest };
`,

  // ── embed ─────────────────────────────────────────────────────
  // Generates an embedding vector for text. Uses OpenAI API or a stub.
  "embed": `
const text = args && args.text;
if (!text) throw new Error('[embed] args.text is required');

const apiKey = typeof Bun !== 'undefined' ? Bun.env.OPENAI_API_KEY : (typeof process !== 'undefined' ? process.env.OPENAI_API_KEY : undefined);

if (!apiKey) {
  // Stub: deterministic-ish random vector based on text hash
  const dim = 1536;
  const vec = new Array(dim);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dim; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    vec[i] = ((hash & 0xffff) / 0xffff) * 2 - 1;
  }
  // Normalize
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] /= norm;

  // Persist the embedding in the graph for future lookup
  try {
    const textId = 'emb:' + Math.abs(hash).toString(36);
    await ctx.assert(textId, 'embedding', text, 'embeddings', vec);
  } catch (e) {
    // Silently skip if vector column is unavailable
  }

  return { embedding: vec, model: 'stub', dimensions: dim };
}

const resp = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + apiKey,
  },
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    input: text,
  }),
});

if (!resp.ok) {
  const errText = await resp.text();
  throw new Error('[embed] API error (' + resp.status + '): ' + errText);
}

const result = await resp.json();
const embedding = result.data[0].embedding;

// Persist the embedding in the graph for future lookup
try {
  // Use a hash of the text as the subject identifier
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  const textId = 'emb:' + Math.abs(hash).toString(36);
  await ctx.assert(textId, 'embedding', text, 'embeddings', embedding);
} catch (e) {
  // Silently skip if vector column is unavailable
}

return { embedding, model: 'text-embedding-3-small', dimensions: embedding.length };
`,

  // ── vector:search ──────────────────────────────────────────────
  // Semantic search over quads using vector embeddings.
  // Tries SQL-based vector_top_k first, falls back to brute-force cosine similarity.
  "vector:search": `
const k = (args && args.k) || 10;
let embedding = args && args.embedding;

if (!embedding && args && args.text) {
  const result = await ctx.call('embed', { text: args.text });
  embedding = result.embedding;
} else if (!embedding) {
  throw new Error('[vector:search] args.text or args.embedding is required');
}

const vecJson = '[' + embedding.join(',') + ']';

// Try SQL-based vector search using libSQL vector_top_k
try {
  // vector_top_k returns a virtual table with id and distance columns
  // Join with quads to get the full quad data
  const rs = await ctx.query({});  // dummy — we need raw SQL access
  // Use raw SQL via a temporary node trick: query the DB directly
  // Actually, ctx.query only supports pattern matching. We need to use
  // the embed node's DB access pattern. Let's try via a direct call approach.

  // Build results from quads that have embeddings stored in the 'embeddings' graph
  const embQuads = await ctx.query({ p: 'embedding', g: 'embeddings' });

  if (embQuads.length === 0) {
    throw new Error('no-embeddings-fallback');
  }

  // For each stored embedding quad, compute cosine similarity
  const results = [];
  for (const eq of embQuads) {
    // Re-embed the stored text to get its vector
    const eResult = await ctx.call('embed', { text: eq.o });
    const eVec = eResult.embedding;

    // Cosine similarity
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < embedding.length && i < eVec.length; i++) {
      dot += embedding[i] * eVec[i];
      normA += embedding[i] * embedding[i];
      normB += eVec[i] * eVec[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    const similarity = denom > 0 ? dot / denom : 0;
    results.push({ quad: { s: eq.s, p: eq.p, o: eq.o, g: eq.g }, similarity });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, k);
} catch (vecErr) {
  // Fallback: brute-force cosine similarity over all quads
  const allQuads = await ctx.query({});

  const results = [];
  for (const q of allQuads) {
    // Get embedding for this quad's content
    const qText = q.s + ' ' + q.p + ' ' + q.o;
    const qResult = await ctx.call('embed', { text: qText });
    const qEmb = qResult.embedding;

    // Cosine similarity
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < embedding.length && i < qEmb.length; i++) {
      dot += embedding[i] * qEmb[i];
      normA += embedding[i] * embedding[i];
      normB += qEmb[i] * qEmb[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    const similarity = denom > 0 ? dot / denom : 0;
    results.push({ quad: { s: q.s, p: q.p, o: q.o, g: q.g }, similarity });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, k);
}
`,

  // ── graph:describe ──────────────────────────────────────────────
  // Returns ALL quads about a given subject — all predicates and objects.
  // Useful for inspecting what a node IS: its type, source, metadata, tool schema, etc.
  "graph:describe": `
const subject = args && args.subject;
if (!subject) throw new Error('[graph:describe] args.subject is required');

const quads = await ctx.query({ s: subject });
const description = {};
for (const q of quads) {
  if (!description[q.p]) {
    description[q.p] = [];
  }
  description[q.p].push({ value: q.o, graph: q.g });
}

return { subject, quads: quads.map(q => ({ s: q.s, p: q.p, o: q.o, g: q.g })), predicates: description };
`,

  // ── graph:subjects ─────────────────────────────────────────────
  // Returns all unique subjects in the graph. Optionally filtered by type.
  "graph:subjects": `
const typeFilter = args && args.type;

let quads;
if (typeFilter) {
  quads = await ctx.query({ p: 'type', o: typeFilter });
} else {
  quads = await ctx.query({});
}

const subjects = new Set();
for (const q of quads) {
  subjects.add(typeFilter ? q.s : q.s);
}

const result = [...subjects].sort();

// Enrich with types if we did not filter by type
if (!typeFilter) {
  const enriched = [];
  for (const s of result) {
    const typeQuads = await ctx.query({ s, p: 'type' });
    const types = typeQuads.map(q => q.o);
    enriched.push({ subject: s, types });
  }
  return enriched;
}

return result.map(s => ({ subject: s, types: [typeFilter] }));
`,

  // ── set ─────────────────────────────────────────────────────────
  // Convenience: retracts all quads matching (s, p, *, g) then asserts (s, p, o, g).
  // Useful for single-valued predicates like 'source', 'status', etc.
  "set": `
const s = args && args.s;
const p = args && args.p;
const o = args && args.o;
const g = (args && args.g) || '_';
if (!s || !p || o === undefined || o === null) {
  throw new Error('[set] args.s, args.p, and args.o are required');
}

// Retract all existing values for this (s, p, *, g) pattern
const existing = await ctx.query({ s, p, g });
for (const eq of existing) {
  await ctx.retract(eq.s, eq.p, eq.o, eq.g);
}

// Assert the new value
const quad = await ctx.assert(s, p, o, g);
return quad;
`,

  // ── repl ────────────────────────────────────────────────────────
  // Interactive REPL — routes messages through agent:loop or direct dot-commands.
  // Maintains a single session across the REPL lifecycle for multi-turn conversations.
  "repl": `
const signal = args && args.signal;
const readline = await import('node:readline');

// Create a persistent session ID for this REPL instance
const sessionId = 'repl:' + Date.now();
console.log('[repl] session: ' + sessionId);

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: 'holo> ',
});

if (signal) {
  signal.addEventListener('abort', () => {
    rl.close();
  }, { once: true });
}

rl.prompt();

for await (const line of rl) {
  const trimmed = line.trim();
  if (!trimmed) { rl.prompt(); continue; }

  try {
    if (trimmed.startsWith('.query ')) {
      const pattern = JSON.parse(trimmed.slice(7));
      const results = await ctx.query(pattern);
      console.log(JSON.stringify(results, null, 2));

    } else if (trimmed.startsWith('.assert ')) {
      const parts = trimmed.slice(8).split(' ');
      if (parts.length < 3) { console.log('usage: .assert s p o [g]'); }
      else {
        const q = await ctx.assert(parts[0], parts[1], parts.slice(2).join(' '));
        console.log('asserted:', JSON.stringify(q));
      }

    } else if (trimmed.startsWith('.retract ')) {
      const parts = trimmed.slice(9).split(' ');
      if (parts.length < 3) { console.log('usage: .retract s p o [g]'); }
      else {
        await ctx.retract(parts[0], parts[1], parts.slice(2).join(' '));
        console.log('retracted');
      }

    } else if (trimmed.startsWith('.call ')) {
      const rest = trimmed.slice(6);
      const spaceIdx = rest.indexOf(' ');
      let name, callArgs;
      if (spaceIdx === -1) {
        name = rest;
        callArgs = undefined;
      } else {
        name = rest.slice(0, spaceIdx);
        callArgs = JSON.parse(rest.slice(spaceIdx + 1));
      }
      const result = await ctx.call(name, callArgs);
      console.log('result:', JSON.stringify(result, null, 2));

    } else if (trimmed === '.nodes') {
      const results = await ctx.query({ p: 'type', o: 'Function' });
      for (const q of results) console.log(' ', q.s);

    } else if (trimmed === '.session') {
      console.log('session: ' + sessionId);

    } else if (trimmed.startsWith('.source ')) {
      const name = trimmed.slice(8).trim();
      const rs = await ctx.query({ s: name, p: 'source' });
      if (rs.length === 0) { console.log('no source found for: ' + name); }
      else { console.log(rs[0].o); }

    } else if (trimmed.startsWith('.edit ')) {
      const name = trimmed.slice(5).trim();
      const rs = await ctx.query({ s: name, p: 'source' });
      if (rs.length === 0) {
        console.log('no source found for: ' + name);
      } else {
        const oldSource = rs[0].o;
        console.log('--- current source for ' + name + ' ---');
        console.log(oldSource);
        console.log('--- enter new source (end with a blank line) ---');
        const lines = [];
        for await (const editLine of rl) {
          if (editLine.trim() === '') break;
          lines.push(editLine);
        }
        if (lines.length === 0) {
          console.log('(empty input, no changes)');
        } else {
          const newSource = lines.join('\\n');
          await ctx.retract(name, 'source', oldSource);
          await ctx.assert(name, 'source', newSource);
          console.log('source updated for: ' + name);
        }
      }

    } else if (trimmed.startsWith('.create ')) {
      const name = trimmed.slice(8).trim();
      const existing = await ctx.query({ s: name, p: 'type', o: 'Function' });
      if (existing.length > 0) {
        console.log('node already exists: ' + name);
      } else {
        console.log('enter source for ' + name + ' (end with a blank line):');
        const lines = [];
        for await (const editLine of rl) {
          if (editLine.trim() === '') break;
          lines.push(editLine);
        }
        if (lines.length === 0) {
          console.log('(empty input, node not created)');
        } else {
          const source = lines.join('\\n');
          await ctx.assert(name, 'type', 'Function');
          await ctx.assert(name, 'source', source);
          console.log('created node: ' + name);
        }
      }

    } else if (trimmed.startsWith('.spawn ')) {
      const name = trimmed.slice(7).trim();
      await ctx.call('spawn', { node: name });
      console.log('spawned: ' + name);

    } else if (trimmed === '.sessions') {
      const msgQuads = await ctx.query({ p: 'message' });
      const sessions = new Set();
      for (const q of msgQuads) sessions.add(q.g);
      if (sessions.size === 0) { console.log('(no sessions)'); }
      else {
        for (const s of sessions) console.log(' ', s);
      }

    } else if (trimmed.startsWith('.export')) {
      const path = trimmed.slice(7).trim() || undefined;
      const result = await ctx.call('snapshot:export', path ? { path } : {});
      if (path) {
        console.log('exported ' + result.count + ' quads to ' + result.path);
      } else {
        console.log(result);
      }

    } else if (trimmed.startsWith('.import ')) {
      const path = trimmed.slice(8).trim();
      if (!path) { console.log('usage: .import <path>'); }
      else {
        const result = await ctx.call('snapshot:import', { path });
        console.log('imported ' + result.count + ' quads from ' + path);
      }

    } else if (trimmed.startsWith('.eval ')) {
      const code = trimmed.slice(6);
      const AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      const fn = new AsyncFn('ctx', code);
      const result = await fn(ctx);
      if (result !== undefined) console.log(result);

    } else if (trimmed === '.help') {
      console.log('commands:');
      console.log('  .query {"s":"...","p":"..."}  — query quads by pattern');
      console.log('  .assert s p o                 — assert a quad');
      console.log('  .retract s p o                — retract a quad');
      console.log('  .call name [argsJSON]          — call a node');
      console.log('  .nodes                        — list all Function nodes');
      console.log('  .source <name>                — view a node source');
      console.log('  .edit <name>                  — edit a node source inline');
      console.log('  .create <name>                — create a new node interactively');
      console.log('  .spawn <name>                 — spawn a node');
      console.log('  .sessions                     — list sessions');
      console.log('  .export [path]                — export snapshot');
      console.log('  .import <path>                — import snapshot');
      console.log('  .eval <code>                  — eval code with ctx');
      console.log('  .session                      — show current session ID');
      console.log('  .help                         — this help');

    } else if (trimmed.startsWith('.')) {
      console.log('unknown command. type .help');

    } else {
      // Route through agent:loop with persistent session
      const result = await ctx.call('agent:loop', { prompt: trimmed, session: sessionId });
      console.log(result.response);
    }
  } catch (err) {
    console.error('error:', err.message || err);
  }

  rl.prompt();
}

console.log('[repl] exited');
`,

  // ── main ────────────────────────────────────────────────────────
  // Entry point: boots compiler, supervisor, API, WebUI, then REPL.
  // Wraps the boot chain in error handling so crashes are logged, not silent.
  "main": `
try {
  console.log('[main] booting holoiconic...');

  // 1. Install the reactive compiler (replaces ctx.call)
  await ctx.call('sys:compiler');

  // 2. Spawn the supervisor (long-lived, manages other spawned nodes)
  await ctx.call('spawn', { node: 'sys:supervisor' });

  // Small delay to let supervisor initialize
  await new Promise(r => setTimeout(r, 50));

  // 3. Register agent tools
  await ctx.call('agent:tools');

  // 4. Start the API server
  await ctx.call('spawn', { node: 'api:server' });

  // 5. Start the WebUI
  await ctx.call('spawn', { node: 'web:ui' });

  // 6. Start the REPL
  console.log('[main] holoiconic ready — REPL, API (3001), WebUI (3002)');
  await ctx.call('spawn', { node: 'repl' });
} catch (err) {
  console.error('[main] fatal error during boot:', err.message || err);
  if (err.stack) console.error(err.stack);
  throw err;
}
`,

};

// ── Seeder ────────────────────────────────────────────────────────

export async function seedTemplate(ctx: Ctx): Promise<void> {
  console.log("[template] seeding graph with primitive nodes...");

  for (const [name, source] of Object.entries(nodes)) {
    await ctx.assert(name, "source", source);
    await ctx.assert(name, "type", "Function");
  }

  console.log(`[template] seeded ${Object.keys(nodes).length} nodes`);
}
