/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const cronId = args && args.cronId;
if (!cronId) throw new Error('[cron:stop] args.cronId is required');

if (!ctx._cronTimers) throw new Error('[cron:stop] no cron jobs registered');
const entry = ctx._cronTimers.get(cronId);
if (!entry) throw new Error('[cron:stop] cron job not found or already stopped: ' + cronId);

await entry.stopCron();
return { cronId, stopped: true };
