/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

let jsonStr;
if (args && args.path) {
  jsonStr = await ctx.call('runtime:adapter', { op: 'readFile', path: args.path });
} else if (args && args.data) {
  jsonStr = args.data;
} else {
  throw new Error('[snapshot:import] args.data or args.path is required');
}

const reembed = args && args.reembed;
const quads = JSON.parse(jsonStr);
if (!Array.isArray(quads)) throw new Error('[snapshot:import] expected JSON array');

let count = 0;
let skipped = 0;
let reembedded = 0;
for (const q of quads) {
  if (!q.subject || !q.predicate || (q.object === undefined || q.object === null)) {
    skipped++;
    continue;
  }
  if (reembed && q.graph === 'embeddings' && q.predicate === 'embedding' && q.object) {
    try {
      await ctx.call('embed', { text: String(q.object) });
      reembedded++;
    } catch (e) {
      console.warn('[snapshot:import] re-embed failed for ' + q.subject + ': ' + (e.message || e));
      await ctx.insert(q.subject, q.predicate, String(q.object), q.graph);
    }
    count++;
    continue;
  }
  await ctx.insert(q.subject, q.predicate, String(q.object), q.graph || '_');
  count++;
}

if (skipped > 0) {
  console.warn('[snapshot:import] skipped ' + skipped + ' quads with missing subject/predicate/object fields');
}
if (reembedded > 0) {
  console.log('[snapshot:import] re-embedded ' + reembedded + ' vectors');
}
console.log('[snapshot:import] imported ' + count + ' quads');
return { count, skipped, reembedded };
