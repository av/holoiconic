/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const signal = args && args.signal;
const port = (args && args.port) || 3001;

// Helper to create a unique ID
function genId() {
  return 'chatcmpl-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function invalidRequest(message, headers) {
  return Response.json({ error: { message, type: 'invalid_request_error' } }, { status: 400, headers });
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === 'string') return part;
      if (part && part.type === 'text' && typeof part.text === 'string') return part.text;
      return '';
    }).join('');
  }
  if (content === undefined || content === null) return '';
  return String(content);
}

// Extract per-request custom provider config from OpenAI-compatible request.
// Supports body extensions (for direct SDK use with extra fields) and standard/ x- headers
// (for proxying clients). This completes the user-facing trivial launch UX for custom
// OpenAI URL + Key + Model against the HTTP API (both chat and embed paths).
function extractCustomProvider(req, body = {}) {
  const getHeader = (name) => {
    // req.headers is a Headers object in fetch handler (case-insensitive get)
    if (req.headers && typeof req.headers.get === 'function') {
      const v = req.headers.get(name);
      if (v) return v;
    }
    // Fallback for plain object headers (tests etc)
    const lower = name.toLowerCase();
    if (req.headers) {
      return req.headers[lower] || req.headers[name] || null;
    }
    return null;
  };

  let baseUrl = getHeader('x-openai-base-url') || getHeader('x-openai-baseurl') ||
                getHeader('openai-base-url') || getHeader('base-url') ||
                body.baseUrl || body.base_url || body.baseURL || body['baseURL'] || null;
  if (baseUrl && typeof baseUrl === 'string') baseUrl = baseUrl.trim();

  let apiKey = getHeader('x-openai-api-key') || getHeader('x-api-key') ||
               body.apiKey || body.api_key || body['api_key'] || null;
  if (!apiKey) {
    const auth = getHeader('authorization') || getHeader('Authorization');
    if (auth && /^bearer\s+/i.test(String(auth))) {
      apiKey = String(auth).replace(/^bearer\s+/i, '').trim();
    }
  }

  const model = body.model || body.model_id || null;
  const provider = body.provider || body.provider_name || null;

  // Dummy-key handling (symmetric to llm/embed/agent:loop from prior): when custom baseUrl
  // is given (even with no real key), auto-supply 'sk-local' so local servers (Ollama, llama.cpp, vLLM)
  // that don't require auth still work. Matches facts ycp/vlm/hbe.
  if (baseUrl && !apiKey) {
    apiKey = 'sk-local';
  }

  const custom = {};
  if (baseUrl) custom.baseUrl = String(baseUrl);
  if (apiKey) custom.apiKey = String(apiKey);
  if (model) custom.model = String(model);
  if (provider) custom.provider = String(provider);
  return custom;
}

const server = await ctx.call('runtime:adapter', {
  op: 'serve',
  port,
  fetch: async (req) => {
    const url = new URL(req.url);

    // CORS headers for WebUI
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-openai-base-url, x-openai-api-key',
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
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return invalidRequest('Request body must be a JSON object', corsHeaders);
        }
        if (body.messages !== undefined && !Array.isArray(body.messages)) {
          return invalidRequest('messages must be an array', corsHeaders);
        }
        const messages = body.messages || [];
        const lastUserMsg = messages.filter(m => m && m.role === 'user').pop();
        const prompt = lastUserMsg ? textFromContent(lastUserMsg.content) : '';

        if (!prompt) {
          return invalidRequest('No user message found', corsHeaders);
        }

        // Use session from request body (non-standard extension) or generate one
        const sessionId = body.session || ('api:' + Date.now());

        // Per-request custom provider (body or headers) — forwarded to agent:loop which
        // already resolves baseUrl/model/apiKey/provider (with dummy sk-local) per prior facts.
        // This makes hitting API:3001 against custom OpenAI endpoint trivial (no global env needed).
        const custom = extractCustomProvider(req, body);

        // Route through the agentic loop
        const result = await ctx.call('agent:loop', {
          prompt,
          session: sessionId,
          tools: body.tools,
          ...custom,
        });

        const responseText = result.response || '';
        const toolCalls = result.tool_calls || [];
        const id = genId();

        // Streaming mode: return SSE
        if (body.stream) {
          const words = responseText.split(/(?<=\s)/);
          const encoder = new TextEncoder();
          let cancelled = false;

          const stream = new ReadableStream({
            async start(controller) {
              // If there are tool calls, send them as a metadata event first
              if (toolCalls.length > 0 && !cancelled) {
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
                try {
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify(metaChunk) + '\n\n'));
                } catch { return; }
              }

              for (let i = 0; i < words.length; i++) {
                if (cancelled) return;
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
                try {
                  controller.enqueue(encoder.encode('data: ' + JSON.stringify(chunk) + '\n\n'));
                } catch { return; }
                // Small delay between chunks to simulate streaming
                if (i < words.length - 1) {
                  await new Promise(r => setTimeout(r, 15));
                }
              }

              if (cancelled) return;

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
              try {
                controller.enqueue(encoder.encode('data: ' + JSON.stringify(finalChunk) + '\n\n'));
                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                controller.close();
              } catch { /* client disconnected */ }
            },
            cancel() {
              cancelled = true;
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
        // Distinguish client errors (bad JSON, bad input) from server errors
        const isSyntaxError = err instanceof SyntaxError || (err.message && err.message.includes('JSON'));
        const statusCode = isSyntaxError ? 400 : 500;
        const errorType = isSyntaxError ? 'invalid_request_error' : 'internal_error';
        return Response.json({ error: { message: err.message || String(err), type: errorType } }, { status: statusCode, headers: corsHeaders });
      }
    }

    // POST /v1/embeddings — OpenAI-compatible embeddings endpoint (completes embed path for custom providers)
    // Accepts input: string | string[], forwards per-request custom (baseUrl etc) to embed node.
    // Embed node handles single text; we map for array input. Returns standard shape.
    if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
      try {
        const body = await req.json();
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return invalidRequest('Request body must be a JSON object', corsHeaders);
        }
        let inputs = body.input;
        if (inputs === undefined || inputs === null) {
          return invalidRequest('input is required', corsHeaders);
        }
        if (!Array.isArray(inputs)) inputs = [inputs];
        const custom = extractCustomProvider(req, body);

        const data = [];
        for (let i = 0; i < inputs.length; i++) {
          const text = inputs[i];
          if (typeof text !== 'string' || !text) continue;
          const emb = await ctx.call('embed', { text, ...custom });
          data.push({
            object: 'embedding',
            embedding: emb && emb.embedding ? emb.embedding : [],
            index: i,
          });
        }

        return Response.json({
          object: 'list',
          data,
          model: (custom.model || body.model || 'holoiconic'),
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }, { headers: corsHeaders });
      } catch (err) {
        const isSyntaxError = err instanceof SyntaxError || (err.message && err.message.includes('JSON'));
        const statusCode = isSyntaxError ? 400 : 500;
        const errorType = isSyntaxError ? 'invalid_request_error' : 'internal_error';
        return Response.json({ error: { message: err.message || String(err), type: errorType } }, { status: statusCode, headers: corsHeaders });
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
  await server.stop();
  console.log('[api:server] stopped');
}
