/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const cache = new Map();
const nodeStorage = ctx._nodeStorage;
const originalCall = ctx.call.bind(ctx);

// Unsubscribe previous compiler's source watcher to avoid subscriber leaks on re-invocation
if (ctx._compilerUnsub) {
  ctx._compilerUnsub();
}

ctx.call = async function cachedCall(name, callArgs) {
  let fn = cache.get(name);
  if (!fn) {
    const rs = await ctx.query({ subject: name, predicate: 'source' });
    if (rs.length === 0) {
      throw new Error('[ctx.call] no source found for node: ' + name);
    }
    fn = new AsyncFunction('ctx', 'args', rs[0].object);
    cache.set(name, fn);
  }
  // Metrics tracking — skip for metrics node itself to avoid infinite recursion
  if (name === 'metrics' || name === 'metrics:report') {
    return nodeStorage.run(name, () => fn(ctx, callArgs));
  }
  const startTime = Date.now();
  let error = null;
  try {
    const result = await nodeStorage.run(name, () => fn(ctx, callArgs));
    return result;
  } catch (err) {
    error = err.message || String(err);
    throw err;
  } finally {
    const durationMs = Date.now() - startTime;
    try {
      await originalCall('metrics', { record: { name, durationMs, error } });
    } catch (metricsErr) {
      // Metrics node may not exist yet during boot — assert diagnostic quad
      try {
        await ctx.insert('sys:compiler', 'diagnostic', JSON.stringify({ type: 'metrics_unavailable', reason: metricsErr.message || String(metricsErr) }), 'diagnostics');
      } catch {}
    }
  }
};

// Watch for source changes — snapshot old source before invalidating cache.
// On insert, validate compilation before deleting the cached function.
// If the new source has a SyntaxError, log it and keep the old cached
// version active so the node continues to work.
const unsub = ctx.on({ predicate: 'source' }, async (change) => {
  const name = change.quad.subject;

  // When a source is retracted, save it as a version
  if (change.type === 'remove') {
    try {
      await ctx.call('version:save', { name, source: change.quad.object });
    } catch (e) {
      // version:save may not exist yet during boot — assert diagnostic quad
      try {
        await ctx.insert('sys:compiler', 'diagnostic', JSON.stringify({ type: 'version_save_unavailable', reason: e.message || String(e) }), 'diagnostics');
      } catch {}
    }
    return;
  }

  // On insert: validate compilation before invalidating cache
  if (change.type === 'insert') {
    try {
      new AsyncFunction('ctx', 'args', change.quad.object);
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error('[sys:compiler] syntax error in ' + name + ':', err.message);
        return; // keep old cached version active
      }
      throw err;
    }
  }

  cache.delete(name);
});
ctx._compilerUnsub = unsub;

console.log('[sys:compiler] installed — ctx.call now cached and reactive');
