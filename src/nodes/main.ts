/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

try {
  console.log('[main] booting holoiconic...');

  // Small helper: wait (poll) for a readiness quad written by a spawned service
  // instead of fixed magic sleeps. Makes boot deterministic under cold-start,
  // slow embed, port fallback in adapter, etc. (max ~2s per service).
  async function waitForPortQuad(subject, predicate, maxMs = 2000, stepMs = 50) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const qs = await ctx.query({ subject, predicate });
      if (qs.length > 0) return Number(qs[0].object);
      await new Promise(r => setTimeout(r, stepMs));
    }
    return 0;
  }

  // 1. Install the reactive compiler (replaces ctx.call)
  await ctx.call('sys:compiler');

  // 2. Spawn the supervisor (long-lived, manages other spawned nodes)
  await ctx.call('spawn', { node: 'sys:supervisor' });
  // (supervisor wires its _supervisorStartNode hook synchronously on first tick)

  // 3. If no LLM API key is detected, spawn mock:llm for local development
  // But treat OPENAI_BASE_URL (or OPENAI_API_BASE) presence as intent to use custom OpenAI-compat endpoint,
  // so do not spawn mock (user can use dummy key or none + baseUrl; nodes will use synthetic + sk-local)
  const { getEnvApiKey } = await import('@mariozechner/pi-ai');
  const hasKey = getEnvApiKey('openai') || getEnvApiKey('anthropic');
  const hasOpenAIBase = !!( (typeof Bun !== 'undefined' && Bun.env && (Bun.env.OPENAI_BASE_URL || Bun.env.OPENAI_API_BASE)) ||
                            (typeof process !== 'undefined' && process.env && (process.env.OPENAI_BASE_URL || process.env.OPENAI_API_BASE)) );
  if (!hasKey && !hasOpenAIBase) {
    console.log('[main] no API key detected — spawning mock:llm');
    await ctx.call('spawn', { node: 'mock:llm' });
    await waitForPortQuad('mock:llm', 'url', 2000); // readiness signal (its HTTP url)
  } else if (hasOpenAIBase && !hasKey) {
    console.log('[main] OPENAI_BASE_URL detected (no key) — using custom endpoint, skipping mock:llm');
  }

  // 4. Register agent tools
  await ctx.call('agent:tools');

  const apiPort = Number((typeof Bun !== 'undefined' && Bun.env && Bun.env.HOLO_API_PORT) || (typeof process !== 'undefined' && process.env && process.env.HOLO_API_PORT) || 3001);
  const webPort = Number((typeof Bun !== 'undefined' && Bun.env && Bun.env.HOLO_WEB_PORT) || (typeof process !== 'undefined' && process.env && process.env.HOLO_WEB_PORT) || 3002);

  // 5. Start the API server
  await ctx.call('spawn', { node: 'api:server', args: { port: apiPort } });

  // 6. Start the WebUI (adapter may try fallbacks; waits for its 'port' quad)
  await ctx.call('spawn', { node: 'web:ui', args: { port: webPort, apiPort } });
  const actualWebPort = (await waitForPortQuad('web:ui', 'port', 2000)) || webPort;

  // 7. Start the REPL
  console.log('[main] holoiconic ready — REPL, API (' + apiPort + '), WebUI (' + actualWebPort + ')');
  await ctx.call('spawn', { node: 'repl' });
} catch (err) {
  console.error('[main] fatal error during boot:', err.message || err);
  if (err.stack) console.error(err.stack);
  throw err;
}
