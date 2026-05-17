/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const text = args && args.text;
if (!text) throw new Error('[embed] args.text is required');

const { getEnvApiKey } = await import('@mariozechner/pi-ai');
let apiKey = (args && args.apiKey) || getEnvApiKey('openai');

// Support custom OpenAI-compatible for symmetry with llm/agent:loop (trivial launch UX):
// args.baseUrl/args.model/args.apiKey + env OPENAI_BASE_URL/OPENAI_API_BASE + HOLOICONIC_MODEL/OPENAI_MODEL/MODEL
const envModel = process.env.HOLOICONIC_MODEL || process.env.OPENAI_MODEL || process.env.MODEL;
const embModel = (args && args.model) || envModel || 'text-embedding-3-small';

// Resolve base URL: custom (args or env) for OpenAI-compat endpoints (Ollama/vLLM/local/etc) takes precedence;
// mock:llm only when no key AND no baseUrl (so custom base works even without real OPENAI_API_KEY)
const baseUrl = (args && args.baseUrl) || (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE);
let baseURL = undefined;
let effectiveKey = apiKey;
if (baseUrl) {
  baseURL = baseUrl;
  if (!effectiveKey) effectiveKey = 'sk-local'; // dummy works for auth-less local OpenAI-compat embedding servers
} else if (!apiKey) {
  // Route through mock:llm's HTTP embeddings endpoint
  const urlQuads = await ctx.query({ subject: 'mock:llm', predicate: 'url' });
  if (urlQuads.length === 0) throw new Error('[embed] no API key and mock:llm is not running');
  baseURL = urlQuads[0].object + '/v1';
  effectiveKey = 'mock-key'; // OpenAI SDK requires a key, mock server ignores it
}

const OpenAI = (await import('openai')).default;
const clientOpts = { apiKey: effectiveKey };
if (baseURL) clientOpts.baseURL = baseURL;
const client = new OpenAI(clientOpts);

let result;
try {
  result = await client.embeddings.create({
    model: embModel,
    input: text,
  });
} catch (err) {
  if (baseUrl) {
    // Improved error UX for custom OpenAI-compatible: actionable message when unreachable/auth/model fail
    const launchVia = (args && args.baseUrl) ? 'per-request (REPL .provider / API body or x-*-headers / direct ctx.call args)' : 'env (OPENAI_BASE_URL/OPENAI_API_BASE or CLI flags)';
    const modelName = embModel;
    const orig = (err && err.message) ? err.message : String(err);
    throw new Error(`[embed] Failed calling custom OpenAI-compatible provider (baseUrl: ${baseUrl}, model: ${modelName}). Original error: ${orig}. Verify the base URL, key and model are correct for the target server. Configured via: ${launchVia}.`);
  }
  throw err;
}

const embedding = result.data[0].embedding;

// Persist the embedding in the graph (graph='embeddings') for vector:search reuse.
// We always store a JSON copy (queryable via primitives, no BLOB decode needed).
// Additionally try the F32_BLOB column for libSQL vector acceleration when available.
const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
const hashHex = [...new Uint8Array(hashBuf)].map(b => b.toString(16).padStart(2, '0')).join('');
const textId = 'emb:' + hashHex.slice(0, 16);
await ctx.insert(textId, 'embedding_json', JSON.stringify(embedding), 'embeddings');
try {
  await ctx.insert(textId, 'embedding', text, 'embeddings', embedding);
} catch (e) {
  // Silently skip BLOB persist if vector column/index unavailable (e.g. some Turso remotes)
}

return { embedding, model: embModel, dimensions: embedding.length };
