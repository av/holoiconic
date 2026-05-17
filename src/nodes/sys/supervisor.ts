/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const controllers = new Map();
const retryCounts = new Map();
const signal = args && args.signal;
const MAX_RETRIES = 3;

function startNode(name, ac, nodeArgs) {
  const baseArgs = nodeArgs || (ctx._supervisorNodeArgs && ctx._supervisorNodeArgs.get(name)) || {};
  if (ctx._supervisorNodeArgs) ctx._supervisorNodeArgs.set(name, baseArgs);
  controllers.set(name, ac);
  ctx.call(name, { ...baseArgs, signal: ac.signal }).catch(async (err) => {
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
        startNode(name, newAc, baseArgs);
      }
    } else {
      console.error('[sys:supervisor] node ' + name + ' exceeded max retries (' + MAX_RETRIES + '), giving up');
    }
  });
}

// Watch for new spawned nodes
ctx.on({ predicate: 'type', object: 'Spawned' }, async (change) => {
  if (change.type === 'insert') {
    const name = change.quad.subject;
    console.log('[sys:supervisor] registered spawned node:', name);
  }
  // If Spawned quad is retracted, abort the running node to prevent orphans
  if (change.type === 'remove') {
    const name = change.quad.subject;
    const ac = controllers.get(name);
    if (ac && !ac.signal.aborted) {
      console.log('[sys:supervisor] Spawned quad retracted for ' + name + ', aborting node');
      ac.abort();
      controllers.delete(name);
      retryCounts.delete(name);
      if (ctx._supervisorNodeArgs) ctx._supervisorNodeArgs.delete(name);
    }
  }
});

// Watch for source changes on spawned nodes — restart them
ctx.on({ predicate: 'source' }, async (change) => {
  const name = change.quad.subject;
  if (change.type !== 'insert') return;
  const spawned = await ctx.query({ subject: name, predicate: 'type', object: 'Spawned' });
  if (spawned.length === 0) return;

  const ac = controllers.get(name);
  if (ac) {
    console.log('[sys:supervisor] restarting:', name);
    await ctx.insert(name, 'lifecycle', 'cleanup');
    ac.abort();
    await ctx.remove(name, 'lifecycle', 'cleanup');

    // Reset retry count on manual source change
    retryCounts.set(name, 0);
    const newAc = new AbortController();
    startNode(name, newAc);
  }
});

// Expose controller registration for spawn node
ctx._supervisorControllers = controllers;
ctx._supervisorNodeArgs = new Map();
// Expose startNode for spawn node to use
ctx._supervisorStartNode = startNode;

// Keep alive until aborted
if (signal) {
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
  // Abort all managed nodes on shutdown
  for (const [name, ac] of controllers) {
    await ctx.insert(name, 'lifecycle', 'cleanup');
    ac.abort();
  }
  console.log('[sys:supervisor] shut down');
}
