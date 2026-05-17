/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const piAi = await import('@mariozechner/pi-ai');
const { getModel, complete, stream, getEnvApiKey } = piAi;

// Resolve provider and model from args, defaulting to OpenAI-compatible
// Also support env for trivial `bun start` with custom OpenAI URL+Key+Model (OPENAI_BASE_URL, OPENAI_MODEL, HOLOICONIC_MODEL)
const providerName = (args && args.provider) || 'openai';
const envModel = process.env.HOLOICONIC_MODEL || process.env.OPENAI_MODEL || process.env.MODEL;
const modelId = (args && args.model) || envModel || (providerName === 'anthropic' ? 'claude-sonnet-4-20250514' : 'gpt-4o');

const messages = args && args.messages;
if (!messages || !Array.isArray(messages)) {
  throw new Error('[llm] args.messages (array) is required');
}

// Build pi-ai context
const piContext = { messages };
if (args && args.system) piContext.systemPrompt = args.system;
if (args && args.tools && args.tools.length > 0) piContext.tools = args.tools;

let apiKey = args && args.apiKey;
let refreshedOAuthCredentials = null;

// Optional pi-ai OAuth credential support. Callers can pass args.oauthCredentials
// as a credentials map, or args.authPath pointing at an auth.json file.
if (!apiKey && args && (args.oauthCredentials || args.authPath)) {
  const oauth = await import('@mariozechner/pi-ai/oauth');
  let credentials = args.oauthCredentials;
  if (!credentials && args.authPath) {
    credentials = JSON.parse(await ctx.call('runtime:adapter', { op: 'readFile', path: args.authPath }));
  }
  const oauthResult = await oauth.getOAuthApiKey(providerName, credentials);
  if (oauthResult && oauthResult.apiKey) {
    apiKey = oauthResult.apiKey;
    refreshedOAuthCredentials = { ...credentials, [providerName]: { type: 'oauth', ...oauthResult.newCredentials } };
    if (args.authPath) {
      await ctx.call('runtime:adapter', { op: 'writeFile', path: args.authPath, content: JSON.stringify(refreshedOAuthCredentials, null, 2) });
    }
  }
}

// Resolve custom base URL (from args for per-call, or OPENAI_BASE_URL/OPENAI_API_BASE env for trivial launch against local/vLLM/Ollama/etc)
// This makes custom OpenAI-compatible trivial: set envs + bun start (or pass args.baseUrl to llm/agent:loop)
const baseUrl = (args && args.baseUrl) || (providerName === 'openai' ? (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE) : undefined);

// Check for API key — if none, route through mock:llm faux provider
// But if baseUrl (arg or env) is present, use synthetic real path with dummy key (even if no getEnvApiKey)
apiKey = apiKey || getEnvApiKey(providerName);
if (!apiKey && baseUrl) {
  apiKey = 'sk-local'; // dummy works for auth-less local OpenAI-compat servers (llama.cpp, etc.)
}

let model;
let opts = {};

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
    if (!model) throw new Error('[llm] unknown model: ' + providerName + '/' + modelId);
  }
  opts.apiKey = apiKey;
} else {
  // Mock provider path — use the faux provider registered by mock:llm
  const faux = ctx._mockFaux;
  if (!faux) throw new Error('[llm] no API key for ' + providerName + ' and mock:llm is not running');
  model = faux.getModel('mock-1');
}

if (args && args.max_tokens) opts.maxTokens = args.max_tokens;
if (args && args.temperature !== undefined) opts.temperature = args.temperature;
if (args && args.signal) opts.signal = args.signal;
if (args && args.sessionId) opts.sessionId = args.sessionId;

if (args && args.stream) {
  let finalMessage = null;
  try {
    for await (const event of stream(model, piContext, opts)) {
      if (event.type === 'text_delta' && typeof args.onDelta === 'function') {
        await args.onDelta(event.delta, event);
      }
      if (event.type === 'done') finalMessage = event.message;
      if (event.type === 'error') {
        let emsg = event.error.errorMessage || '[llm] streaming error';
        if (baseUrl && !emsg.includes(baseUrl)) {
          const launchVia = (args && args.baseUrl) ? 'per-request (REPL .provider / API body or x-*-headers / direct ctx.call args)' : 'env (OPENAI_BASE_URL/OPENAI_API_BASE or CLI flags)';
          emsg = `[llm] Failed calling custom OpenAI-compatible provider (baseUrl: ${baseUrl}, model: ${modelId}). Original: ${emsg}. Verify the base URL, key and model are correct for the target server. Configured via: ${launchVia}.`;
        }
        throw new Error(emsg);
      }
    }
  } catch (err) {
    if (baseUrl && !(err && err.message && err.message.includes('custom OpenAI-compatible provider'))) {
      const launchVia = (args && args.baseUrl) ? 'per-request (REPL .provider / API body or x-*-headers / direct ctx.call args)' : 'env (OPENAI_BASE_URL/OPENAI_API_BASE or CLI flags)';
      const orig = (err && err.message) ? err.message : String(err);
      throw new Error(`[llm] Failed calling custom OpenAI-compatible provider (baseUrl: ${baseUrl}, model: ${modelId}). Original error: ${orig}. Verify the base URL, key and model are correct for the target server. Configured via: ${launchVia}.`);
    }
    throw err;
  }
  if (!finalMessage) throw new Error('[llm] stream ended without a final message');
  if (refreshedOAuthCredentials) finalMessage.oauthCredentials = refreshedOAuthCredentials;
  return finalMessage;
}

let result;
try {
  result = await complete(model, piContext, opts);
} catch (err) {
  if (baseUrl && !(err && err.message && err.message.includes('custom OpenAI-compatible provider'))) {
    const launchVia = (args && args.baseUrl) ? 'per-request (REPL .provider / API body or x-*-headers / direct ctx.call args)' : 'env (OPENAI_BASE_URL/OPENAI_API_BASE or CLI flags)';
    const orig = (err && err.message) ? err.message : String(err);
    throw new Error(`[llm] Failed calling custom OpenAI-compatible provider (baseUrl: ${baseUrl}, model: ${modelId}). Original error: ${orig}. Verify the base URL, key and model are correct for the target server. Configured via: ${launchVia}.`);
  }
  throw err;
}
if (refreshedOAuthCredentials) result.oauthCredentials = refreshedOAuthCredentials;
return result;
