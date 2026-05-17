/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const cronQuads = await ctx.query({ predicate: 'type', object: 'CronJob' });
const jobs = [];

for (const cq of cronQuads) {
  const cronId = cq.subject;
  const nodeQuads = await ctx.query({ subject: cronId, predicate: 'cron:node' });
  const intervalQuads = await ctx.query({ subject: cronId, predicate: 'cron:interval' });
  const statusQuads = await ctx.query({ subject: cronId, predicate: 'cron:status' });
  const startedQuads = await ctx.query({ subject: cronId, predicate: 'cron:started' });

  // Always take the last element (ctx.set guarantees <=1, but this is robust
  // against any path that ever does multiple inserts for the same (s,p,g)).
  const last = (qs) => (qs.length > 0 ? qs[qs.length - 1].object : undefined);

  jobs.push({
    cronId,
    node: last(nodeQuads) || 'unknown',
    interval: last(intervalQuads) ? parseInt(last(intervalQuads)) : 0,
    status: last(statusQuads) || 'unknown',
    started: last(startedQuads) || null,
  });
}

return { jobs, count: jobs.length };
