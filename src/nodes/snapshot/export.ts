/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const allQuads = await ctx.query({});
const embeddingCount = allQuads.filter(q => q.graph === 'embeddings' && q.predicate === 'embedding').length;
const data = allQuads.map(q => ({
  subject: q.subject,
  predicate: q.predicate,
  object: q.object,
  graph: q.graph,
  attrs: q.attrs || undefined,
}));
const json = JSON.stringify(data, null, 2);

if (embeddingCount > 0) {
  console.warn('[snapshot:export] ' + embeddingCount + ' embedding quad(s) exported without vectors — use reembed:true on import to regenerate');
}

const path = args && args.path;
if (path) {
  await ctx.call('runtime:adapter', { op: 'writeFile', path, content: json });
  console.log('[snapshot:export] wrote ' + data.length + ' quads to ' + path);
  return { count: data.length, path, embeddingsWithoutVectors: embeddingCount };
}
return json;
