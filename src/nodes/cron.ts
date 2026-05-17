/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const node = args && args.node;
const interval = args && args.interval;
const cronArgs = args && args.cronArgs;
const signal = args && args.signal;

if (!node) throw new Error('[cron] args.node is required');
if (!interval || typeof interval !== 'number' || interval < 100) {
  throw new Error('[cron] args.interval (number >= 100ms) is required');
}

// Generate a cron job ID
const cronId = 'cron:' + node + ':' + Date.now();

// Register the cron job in the graph
await ctx.insert(cronId, 'type', 'CronJob');
await ctx.insert(cronId, 'cron:node', node);
await ctx.insert(cronId, 'cron:interval', String(interval));
await ctx.insert(cronId, 'cron:status', 'running');
await ctx.insert(cronId, 'cron:started', new Date().toISOString());

let tickCount = 0;
const timer = setInterval(async () => {
  try {
    tickCount++;
    await ctx.call(node, cronArgs);
  } catch (err) {
    console.error('[cron] error running ' + node + ' (tick ' + tickCount + '):', err.message || err);
  }
}, interval);

console.log('[cron] started ' + cronId + ' — runs ' + node + ' every ' + interval + 'ms');

// Always register in the timer map so cron:stop can find it
if (!ctx._cronTimers) ctx._cronTimers = new Map();
const stopCron = async () => {
  clearInterval(timer);
  ctx._cronTimers.delete(cronId);
  try {
    await ctx.set(cronId, 'cron:status', 'stopped');
    await ctx.set(cronId, 'cron:stopped', new Date().toISOString());
    await ctx.set(cronId, 'cron:ticks', String(tickCount));
  } catch {}
  console.log('[cron] stopped ' + cronId + ' after ' + tickCount + ' ticks');
};
ctx._cronTimers.set(cronId, { timer, stopCron });

if (signal) {
  signal.addEventListener('abort', stopCron, { once: true });
  await new Promise((resolve) => {
    signal.addEventListener('abort', resolve, { once: true });
  });
}

return { cronId, node, interval };
