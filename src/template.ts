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
  "sys:supervisor": `
const controllers = new Map();
const signal = args && args.signal;

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

    const newAc = new AbortController();
    controllers.set(name, newAc);
    ctx.call(name, { signal: newAc.signal }).catch(err => {
      if (err.name !== 'AbortError') console.error('[sys:supervisor] node error:', name, err);
    });
  }
});

// Expose controller registration for spawn node
ctx._supervisorControllers = controllers;

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

// Store controller in supervisor's map if available
if (ctx._supervisorControllers) {
  ctx._supervisorControllers.set(node, ac);
}

const spawnArgs = { ...(args.args || {}), signal: ac.signal };
// Fire and forget — spawned nodes are long-lived
ctx.call(node, spawnArgs).catch(err => {
  if (err.name !== 'AbortError') console.error('[spawn] node error:', node, err);
});

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

console.log('[agent:tools] registered 9 tools');
`,

  // ── agent:loop ─────────────────────────────────────────────────
  // Core agentic loop — maintains conversation, dispatches tool calls.
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
    return { session: sessionId, response: text };
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
      } else {
        // Try calling it as a generic node
        result = JSON.stringify(await ctx.call(toolName, toolInput));
      }
    } catch (err) {
      result = 'Error: ' + (err.message || String(err));
    }

    toolResults.push({
      type: 'tool_result',
      tool_use_id: toolBlock.id,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    });
  }

  // Add tool results as a user message and loop
  const toolResultMsg = { role: 'user', content: toolResults };
  await ctx.assert(sessionId, 'message', JSON.stringify({ seq: seq++, msg: toolResultMsg }), sessionId);
  messages.push(toolResultMsg);
}

return { session: sessionId, response: '[agent:loop] max iterations reached' };
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
        const id = genId();

        // Streaming mode: return SSE
        if (body.stream) {
          const words = responseText.split(/(?<=\\s)/);
          const encoder = new TextEncoder();

          const stream = new ReadableStream({
            async start(controller) {
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
  // Minimal chat + graph explorer WebUI on port 3002.
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
  #graph-panel { width: 360px; display: flex; flex-direction: column; }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid #21262d; font-weight: 600; font-size: 14px; color: #58a6ff; }
  #messages { flex: 1; overflow-y: auto; padding: 16px; }
  .msg { margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; white-space: pre-wrap; word-wrap: break-word; font-size: 14px; line-height: 1.5; }
  .msg.user { background: #1f2937; color: #e5e7eb; }
  .msg.assistant { background: #161b22; color: #c9d1d9; border-left: 3px solid #58a6ff; }
  .msg .role { font-size: 11px; text-transform: uppercase; color: #8b949e; margin-bottom: 4px; }
  #input-row { display: flex; padding: 12px 16px; border-top: 1px solid #21262d; gap: 8px; }
  #input { flex: 1; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 12px; border-radius: 6px; font-size: 14px; font-family: inherit; }
  #input:focus { outline: none; border-color: #58a6ff; }
  #send { background: #238636; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
  #send:hover { background: #2ea043; }
  #send:disabled { opacity: 0.5; cursor: not-allowed; }
  #node-list { flex: 1; overflow-y: auto; padding: 8px; }
  .node-item { padding: 6px 10px; cursor: pointer; border-radius: 4px; font-size: 13px; font-family: monospace; }
  .node-item:hover { background: #161b22; }
  .node-item.selected { background: #1f2937; color: #58a6ff; }
  #node-source { height: 300px; overflow-y: auto; padding: 12px; border-top: 1px solid #21262d; font-size: 12px; font-family: monospace; white-space: pre-wrap; background: #0d1117; color: #8b949e; }
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
  <div class="panel-header">graph nodes</div>
  <div id="node-list"></div>
  <div id="node-source">Click a node to view source</div>
</div>
<script>
const API = 'http://localhost:' + \${apiPort} + '/v1/chat/completions';
const msgDiv = document.getElementById('messages');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const nodeList = document.getElementById('node-list');
const nodeSource = document.getElementById('node-source');

// Persistent session ID for multi-turn conversations
const sessionId = 'webui:' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
const chatHistory = [];

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendBtn.disabled = true;
  addMsg('user', text);
  chatHistory.push({ role: 'user', content: text });

  // Create a placeholder message div for streaming
  const d = document.createElement('div');
  d.className = 'msg assistant';
  d.innerHTML = '<div class="role">assistant</div>';
  const contentSpan = document.createElement('span');
  d.appendChild(contentSpan);
  msgDiv.appendChild(d);

  let fullText = '';

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
          if (delta && delta.content) {
            fullText += delta.content;
            contentSpan.textContent = fullText;
            msgDiv.scrollTop = msgDiv.scrollHeight;
          }
        } catch {}
      }
    }

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

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

sendBtn.onclick = send;
input.onkeydown = (e) => { if (e.key === 'Enter') send(); };

async function loadNodes() {
  try {
    const res = await fetch('http://localhost:' + \${port} + '/api/nodes');
    const nodes = await res.json();
    nodeList.innerHTML = '';
    for (const n of nodes) {
      const el = document.createElement('div');
      el.className = 'node-item';
      el.textContent = n.name;
      el.onclick = () => showSource(n.name, el);
      nodeList.appendChild(el);
    }
  } catch {}
}

async function showSource(name, el) {
  document.querySelectorAll('.node-item').forEach(e => e.classList.remove('selected'));
  el.classList.add('selected');
  try {
    const res = await fetch('http://localhost:' + \${port} + '/api/node/' + encodeURIComponent(name));
    const data = await res.json();
    nodeSource.textContent = data.source || '(no source)';
  } catch { nodeSource.textContent = '(error loading)'; }
}

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
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Serve the SPA
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } });
    }

    // API: list nodes
    if (url.pathname === '/api/nodes') {
      const nodes = await ctx.query({ p: 'type', o: 'Function' });
      const result = nodes.map(n => ({ name: n.s })).sort((a, b) => a.name.localeCompare(b.name));
      return Response.json(result, { headers: corsHeaders });
    }

    // API: get node source
    if (url.pathname.startsWith('/api/node/')) {
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
return { embedding, model: 'text-embedding-3-small', dimensions: embedding.length };
`,

  // ── vector:search ──────────────────────────────────────────────
  // Semantic search over quads using vector embeddings.
  "vector:search": `
const k = (args && args.k) || 10;
let embedding = args && args.embedding;

if (!embedding && args && args.text) {
  const result = await ctx.call('embed', { text: args.text });
  embedding = result.embedding;
} else if (!embedding) {
  throw new Error('[vector:search] args.text or args.embedding is required');
}

// Try vector_top_k — requires vector index support
try {
  const vecStr = '[' + embedding.join(',') + ']';
  const rs = await ctx.query({});  // We'll filter manually if vector search isn't available

  // Try the native vector search first
  // Note: This requires the libsql_vector_idx index to be present
  // If it fails, fall back to brute-force cosine similarity
  throw new Error('fallback'); // Skip native for now — libSQL vector support varies
} catch {
  // Fallback: brute-force cosine similarity over all quads
  // This works without vector index support
  const allQuads = await ctx.query({});

  // For now, compute similarity based on text content of the object field
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
    const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
    results.push({ quad: { s: q.s, p: q.p, o: q.o, g: q.g }, similarity });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, k);
}
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

    } else if (trimmed === '.help') {
      console.log('commands:');
      console.log('  .query {"s":"...","p":"..."}  — query quads by pattern');
      console.log('  .assert s p o                 — assert a quad');
      console.log('  .retract s p o                — retract a quad');
      console.log('  .call name [argsJSON]          — call a node');
      console.log('  .nodes                        — list all Function nodes');
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
  "main": `
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
