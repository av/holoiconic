/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const signal = args && args.signal;
const piAi = await import('@mariozechner/pi-ai');
const { registerFauxProvider, fauxAssistantMessage, fauxText } = piAi;

// ── Deterministic embedding generator (hash-based) ──
function hashEmbed(text) {
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
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ── Register faux provider for LLM completions ──
// The response factory receives the full context and generates contextual responses.
const faux = registerFauxProvider({
  provider: 'mock',
  models: [
    { id: 'mock-1', name: 'Mock Model', reasoning: false, input: ['text', 'image'] },
  ],
});

// Dynamic response factory that echoes context info
const responseFactory = (context, options, state, model) => {
  const lastMsg = context.messages[context.messages.length - 1];
  let prompt = '';
  if (lastMsg && lastMsg.role === 'user') {
    prompt = typeof lastMsg.content === 'string' ? lastMsg.content : lastMsg.content.map(b => b.type === 'text' ? b.text : '').join(' ');
  }
  const text = '[mock] provider=mock model=' + model.id + ' prompt=' + JSON.stringify(prompt);
  return fauxAssistantMessage(text);
};

// Seed unlimited responses via the factory
// The faux provider calls factories in order — one infinite factory suffices
const infiniteResponses = Array.from({ length: 10000 }, () => responseFactory);
faux.setResponses(infiniteResponses);

// Store the faux registration on ctx for other nodes to discover
ctx._mockFaux = faux;

// ── HTTP server for OpenAI-compatible embeddings ──
const port = (args && args.port) || 0; // 0 = auto-assign
const server = await ctx.call('runtime:adapter', {
  op: 'serve',
  port,
  fetch: async (req) => {
    const url = new URL(req.url);

    // CORS
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        },
      });
    }

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Content-Type': 'application/json',
    };

    // GET /v1/models
    if (url.pathname === '/v1/models' && req.method === 'GET') {
      return Response.json({
        object: 'list',
        data: [
          { id: 'mock-1', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'mock' },
          { id: 'text-embedding-3-small', object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'mock' },
        ],
      }, { headers: corsHeaders });
    }

    // POST /v1/embeddings
    if (url.pathname === '/v1/embeddings' && req.method === 'POST') {
      return (async () => {
        const body = await req.json();
        const input = body.input;
        const useBase64 = body.encoding_format === 'base64';
        const texts = Array.isArray(input) ? input : [input];
        const data = texts.map((t, i) => {
          const vec = hashEmbed(String(t));
          let embedding;
          if (useBase64) {
            // Encode as base64 Float32Array (OpenAI SDK default)
            const buf = new Float32Array(vec);
            const bytes = new Uint8Array(buf.buffer);
            let binary = '';
            for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
            embedding = btoa(binary);
          } else {
            embedding = vec;
          }
          return { object: 'embedding', embedding, index: i };
        });
        return Response.json({
          object: 'list',
          data,
          model: body.model || 'text-embedding-3-small',
          usage: { prompt_tokens: 0, total_tokens: 0 },
        }, { headers: corsHeaders });
      })();
    }

    // POST /v1/chat/completions
    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      return (async () => {
        const body = await req.json();
        const msgs = body.messages || [];
        const lastMsg = msgs[msgs.length - 1];
        const prompt = lastMsg ? (lastMsg.content || '') : '';
        const text = '[mock] model=' + (body.model || 'mock-1') + ' prompt=' + JSON.stringify(prompt);
        return Response.json({
          id: 'chatcmpl-mock-' + Date.now(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model || 'mock-1',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: text },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }, { headers: corsHeaders });
      })();
    }

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' }, { headers: corsHeaders });
    }

    return Response.json({ error: 'not found' }, { status: 404, headers: corsHeaders });
  },
});

const actualPort = server.port;
const mockUrl = 'http://localhost:' + actualPort;

// Store config in the graph so other nodes can discover the mock
await ctx.set('mock:llm', 'port', String(actualPort));
await ctx.set('mock:llm', 'url', mockUrl);
await ctx.set('mock:llm', 'status', 'running');
console.log('[mock:llm] running on ' + mockUrl + ' (faux provider + embeddings HTTP)');

// Keep alive until signal
if (signal) {
  await new Promise(resolve => {
    signal.addEventListener('abort', resolve, { once: true });
    if (signal.aborted) resolve(undefined);
  });
  faux.unregister();
  await server.stop();
  await ctx.set('mock:llm', 'status', 'stopped');
} else {
  // Non-spawned call: just return the config
  return { port: actualPort, url: mockUrl, fauxApi: faux.api };
}
