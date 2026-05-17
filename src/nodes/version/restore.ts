/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const name = args && args.name;
const seq = args && args.seq;
if (!name) throw new Error('[version:restore] args.name is required');
if (seq === undefined || seq === null) throw new Error('[version:restore] args.seq is required');

const versionQuads = await ctx.query({ subject: name, predicate: 'version', graph: 'versions' });
const match = versionQuads.find(q => {
  const data = JSON.parse(q.object);
  return data.seq === seq;
});

if (!match) throw new Error('[version:restore] no version found with seq=' + seq + ' for node ' + name);

const versionData = JSON.parse(match.object);
const restoredSource = versionData.source;

await ctx.remove(name, 'source');
await ctx.insert(name, 'source', restoredSource);

return { name, seq, timestamp: versionData.timestamp, restored: true };
