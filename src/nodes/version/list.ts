/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const name = args && args.name;
if (!name) throw new Error('[version:list] args.name is required');

const versionQuads = await ctx.query({ subject: name, predicate: 'version', graph: 'versions' });
const versions = versionQuads.map(q => {
  const data = JSON.parse(q.object);
  return { seq: data.seq, timestamp: data.timestamp, sourceLength: data.source.length };
}).sort((a, b) => a.seq - b.seq);

return { name, versions, count: versions.length };
