/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const node = args && args.node;
const nodeArgs = (args && args.args) || {};
if (!node) throw new Error('[spawn] args.node is required');

// If already spawned, abort the old instance first to prevent leaks
if (ctx._supervisorControllers) {
  const existing = ctx._supervisorControllers.get(node);
  if (existing && !existing.signal.aborted) {
    console.log('[spawn] aborting previous instance of ' + node);
    existing.abort();
  }
}

const ac = new AbortController();

// Register with supervisor
await ctx.insert(node, 'type', 'Spawned');

// Use supervisor's startNode if available (enables retry/backoff)
if (ctx._supervisorStartNode) {
  ctx._supervisorStartNode(node, ac, nodeArgs);
} else {
  // Fallback: store controller and start manually
  if (ctx._supervisorControllers) {
    ctx._supervisorControllers.set(node, ac);
  }
  ctx.call(node, { ...nodeArgs, signal: ac.signal }).catch(err => {
    if (err.name !== 'AbortError') console.error('[spawn] node error:', node, err);
  });
}

return ac;
