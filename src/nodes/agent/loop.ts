/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const piAi = await import('@mariozechner/pi-ai');
const { getModel, complete, stream, getEnvApiKey } = piAi;

const prompt = args && args.prompt;
if (!prompt) throw new Error('[agent:loop] args.prompt is required');

const sessionId = (args && args.session) || ('session:' + Date.now() + ':' + Math.random().toString(36).slice(2, 8));

// System prompt
const systemPrompt = `You are an AI assistant running inside holoiconic, a self-modifying agentic runtime.
Everything in this system exists as RDF quads (subject, predicate, object, graph) in a reactive graph database.
Code, state, tools, and even this agentic loop are all quads in the same graph.

You have access to tools that let you:
- Execute shell commands
- Query the graph for quads
- Insert new quads
- Remove quads
- List all function nodes

The graph is reactive: when quads change, watchers fire automatically.
Function nodes have (name, 'source', code) and (name, 'type', 'Function') quads.
You can create new nodes by inserting source and type quads.

Be concise and helpful. When using tools, explain what you are doing.`;

// Load conversation history from graph
// Messages are stored as {seq, msg} to ensure uniqueness even with identical content
const historyQuads = await ctx.query({ predicate: 'message', graph: sessionId });
const history = [];
for (const q of historyQuads.sort((a, b) => a.id - b.id)) {
  try {
    const w = JSON.parse(q.object);
    history.push(w.msg || w);
  } catch (e) {
    // Malformed message quad — do not crash the loop.
    // Assert a diagnostic quad so corruption is visible in the graph.
    try {
      await ctx.insert('agent:loop', 'diagnostic', JSON.stringify({ type: 'malformed_message', quadId: q.id, subject: q.subject, reason: e.message || String(e) }), 'diagnostics');
    } catch {}
  }
}

// Determine next sequence number
let seq = historyQuads.length;

// Add the new user message — pi-ai UserMessage format
const userMsg = { role: 'user', content: prompt, timestamp: Date.now() };
await ctx.insert(sessionId, 'message', JSON.stringify({ seq: seq++, msg: userMsg }), sessionId);
history.push(userMsg);

// Collect available tools and convert to pi-ai Tool format
const toolQuads = await ctx.query({ predicate: 'type', object: 'Tool' });
const tools = [];
for (const tq of toolQuads) {
  const schemaQuads = await ctx.query({ subject: tq.subject, predicate: 'tool_schema' });
  if (schemaQuads.length > 0) {
    try {
      const schema = JSON.parse(schemaQuads[0].object);
      // Convert from Anthropic tool format to pi-ai Tool format
      tools.push({
        name: schema.name,
        description: schema.description || '',
        parameters: schema.input_schema || schema.parameters || { type: 'object', properties: {} },
      });
    } catch {}
  }
}

// Resolve provider and model — pi-ai supports OpenAI, Anthropic, Google, Mistral, etc.
// Also support env for trivial `bun start` with custom OpenAI URL+Key+Model (OPENAI_BASE_URL, OPENAI_MODEL, HOLOICONIC_MODEL)
const providerName = (args && args.provider) || 'openai';
const envModel = process.env.HOLOICONIC_MODEL || process.env.OPENAI_MODEL || process.env.MODEL;
const modelId = (args && args.model) || envModel || (providerName === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');

// Track all tool calls for visibility
const allToolCalls = [];

// Resolve custom base URL (from args for per-call, or OPENAI_BASE_URL/OPENAI_API_BASE env for trivial launch against local/vLLM/Ollama/etc)
// This makes custom OpenAI-compatible trivial: set envs + bun start (or pass args.baseUrl to llm/agent:loop)
const baseUrl = (args && args.baseUrl) || (providerName === 'openai' ? (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE) : undefined);

// Resolve model: real provider if API key available, mock:llm faux provider otherwise
// But if baseUrl (arg or env) is present, use synthetic real path with dummy key (even if no getEnvApiKey)
let apiKey = (args && args.apiKey) || getEnvApiKey(providerName);
if (!apiKey && baseUrl) {
  apiKey = 'sk-local'; // dummy works for auth-less local OpenAI-compat servers (llama.cpp, etc.)
}
let model;
let callOpts = {};

if (apiKey) {
  // Real provider path (or custom baseUrl synthetic)
  if (baseUrl) {
    // Build synthetic model per spec (gcu) — bypass registry so we can target arbitrary /v1/chat/completions
    model = {
      id: modelId,
      name: modelId,
      api: 'openai-completions',
      provider: providerName,
      baseUrl,
      reasoning: false,
      input: ['text', 'image'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    };
  } else {
    model = getModel(providerName, modelId);
    if (!model) throw new Error('[agent:loop] unknown model: ' + providerName + '/' + modelId);
  }
  callOpts.apiKey = apiKey;
} else {
  const faux = ctx._mockFaux;
  if (!faux) throw new Error('[agent:loop] no API key for ' + providerName + ' and mock:llm is not running');
  model = faux.getModel('mock-1');
}

const useStream = args && args.stream;

// Agentic loop — keep calling LLM until we get a text response (no tool calls)
let messages = [...history];
const maxIterations = 20;

for (let i = 0; i < maxIterations; i++) {
  // Build pi-ai context
  const piContext = {
    systemPrompt,
    messages,
    tools: tools.length > 0 ? tools : undefined,
  };

  let response;
  if (useStream) {
    const eventStream = stream(model, piContext, callOpts);
    for await (const event of eventStream) {
      if (event.type === 'text_delta' && args.onDelta) {
        args.onDelta(event.delta);
      }
    }
    response = await eventStream.result();
  } else {
    response = await complete(model, piContext, callOpts);
  }

  // Store the assistant message in the graph
  const assistantMsg = { role: 'assistant', content: response.content, model: response.model, provider: response.provider, api: response.api, usage: response.usage, stopReason: response.stopReason, timestamp: response.timestamp };
  await ctx.insert(sessionId, 'message', JSON.stringify({ seq: seq++, msg: assistantMsg }), sessionId);
  messages.push(assistantMsg);

  // Check if response contains tool calls (pi-ai uses type: 'toolCall')
  const toolCallBlocks = (response.content || []).filter(b => b.type === 'toolCall');

  if (toolCallBlocks.length === 0) {
    // Pure text response — extract and return it
    const textBlocks = (response.content || []).filter(b => b.type === 'text');
    const text = textBlocks.map(b => b.text).join('\n');
    return { session: sessionId, response: text, tool_calls: allToolCalls };
  }

  // Execute each tool call
  for (const toolBlock of toolCallBlocks) {
    const toolName = toolBlock.name;
    const toolInput = toolBlock.arguments;
    let result;

    try {
      if (toolName === 'shell') {
        result = await ctx.call('shell', { cmd: toolInput.cmd });
      } else if (toolName === 'graph_query') {
        const pattern = {};
        if (toolInput.subject) pattern.subject = toolInput.subject;
        if (toolInput.predicate) pattern.predicate = toolInput.predicate;
        if (toolInput.object) pattern.object = toolInput.object;
        if (toolInput.graph) pattern.graph = toolInput.graph;
        const quads = await ctx.query(pattern);
        result = JSON.stringify(quads, null, 2);
      } else if (toolName === 'graph_insert') {
        const quad = await ctx.insert(toolInput.subject, toolInput.predicate, toolInput.object, toolInput.graph || '_');
        result = 'Inserted: ' + JSON.stringify(quad);
      } else if (toolName === 'graph_remove') {
        await ctx.remove(toolInput.subject, toolInput.predicate, toolInput.object, toolInput.graph || '_');
        result = 'Removed successfully';
      } else if (toolName === 'list_nodes') {
        const nodes = await ctx.query({ predicate: 'type', object: 'Function' });
        result = nodes.map(n => n.subject).join('\n');
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
      } else if (toolName === 'graph_deps') {
        result = JSON.stringify(await ctx.call('graph:deps', toolInput));
      } else if (toolName === 'inspect') {
        result = JSON.stringify(await ctx.call('inspect', toolInput));
      } else if (toolName === 'version_list') {
        result = JSON.stringify(await ctx.call('version:list', toolInput));
      } else if (toolName === 'version_restore') {
        result = JSON.stringify(await ctx.call('version:restore', toolInput));
      } else if (toolName === 'cron_create') {
        const cronResult = await ctx.call('cron', toolInput);
        result = JSON.stringify(cronResult);
      } else if (toolName === 'cron_stop') {
        result = JSON.stringify(await ctx.call('cron:stop', toolInput));
      } else if (toolName === 'cron_list') {
        result = JSON.stringify(await ctx.call('cron:list', toolInput));
      } else if (toolName === 'metrics_report') {
        result = await ctx.call('metrics:report', toolInput);
        if (typeof result !== 'string') result = JSON.stringify(result);
      } else {
        // Try calling it as a generic node (tool names use underscores, node names use colons)
        const nodeName = toolName.replace(/_/g, ':');
        const callResult = await ctx.call(nodeName, toolInput);
        result = callResult === undefined ? '(no return value)' : JSON.stringify(callResult);
      }
    } catch (err) {
      result = 'Error: ' + (err.message || String(err));
    }

    const resultStr = typeof result === 'string' ? result : (result === undefined ? '(no return value)' : JSON.stringify(result));

    // Record tool call for visibility
    allToolCalls.push({
      name: toolName,
      input: toolInput,
      result: resultStr,
    });

    // Build pi-ai ToolResultMessage and append to messages
    const toolResultMsg = {
      role: 'toolResult',
      toolCallId: toolBlock.id,
      toolName: toolName,
      content: [{ type: 'text', text: resultStr }],
      isError: resultStr.startsWith('Error: '),
      timestamp: Date.now(),
    };
    await ctx.insert(sessionId, 'message', JSON.stringify({ seq: seq++, msg: toolResultMsg }), sessionId);
    messages.push(toolResultMsg);
  }
}

return { session: sessionId, response: '[agent:loop] max iterations reached', tool_calls: allToolCalls };
