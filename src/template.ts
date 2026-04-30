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

console.log('[agent:tools] registered 5 tools');
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
const historyQuads = await ctx.query({ p: 'message', g: sessionId });
const history = historyQuads
  .sort((a, b) => a.id - b.id)
  .map(q => JSON.parse(q.o));

// Add the new user message
const userMsg = { role: 'user', content: prompt };
await ctx.assert(sessionId, 'message', JSON.stringify(userMsg), sessionId);
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
  await ctx.assert(sessionId, 'message', JSON.stringify(assistantMsg), sessionId);
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
  await ctx.assert(sessionId, 'message', JSON.stringify(toolResultMsg), sessionId);
  messages.push(toolResultMsg);
}

return { session: sessionId, response: '[agent:loop] max iterations reached' };
`,

  // ── api:server ──────────────────────────────────────────────────
  // OpenAI-compatible chat completions API on port 3001.
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

        // Route through the agentic loop
        const sessionId = 'api:' + Date.now();
        const result = await ctx.call('agent:loop', {
          prompt,
          session: sessionId,
          tools: body.tools,
        });

        const responseText = result.response || '';
        const id = genId();

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

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  sendBtn.disabled = true;
  addMsg('user', text);
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'holoiconic', messages: [{ role: 'user', content: text }] }),
    });
    const data = await res.json();
    if (data.error) { addMsg('assistant', 'Error: ' + data.error.message); }
    else { addMsg('assistant', data.choices[0].message.content); }
  } catch (e) { addMsg('assistant', 'Error: ' + e.message); }
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

  // ── repl ────────────────────────────────────────────────────────
  // Interactive REPL — routes messages through agent:loop or direct dot-commands.
  "repl": `
const signal = args && args.signal;
const readline = await import('node:readline');

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

    } else if (trimmed === '.help') {
      console.log('commands:');
      console.log('  .query {"s":"...","p":"..."}  — query quads by pattern');
      console.log('  .assert s p o                 — assert a quad');
      console.log('  .retract s p o                — retract a quad');
      console.log('  .call name [argsJSON]          — call a node');
      console.log('  .nodes                        — list all Function nodes');
      console.log('  .help                         — this help');

    } else if (trimmed.startsWith('.')) {
      console.log('unknown command. type .help');

    } else {
      // Route through agent:loop
      const result = await ctx.call('agent:loop', { prompt: trimmed });
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
