/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const typeFilter = args && args.type;

let quads;
if (typeFilter) {
  quads = await ctx.query({ predicate: 'type', object: typeFilter });
} else {
  quads = await ctx.query({});
}

const subjects = new Set();
for (const q of quads) {
  subjects.add(q.subject);
}

const result = [...subjects].sort();

// Enrich with types if we did not filter by type
if (!typeFilter) {
  const enriched = [];
  for (const s of result) {
    const typeQuads = await ctx.query({ subject: s, predicate: 'type' });
    const types = typeQuads.map(q => q.object);
    enriched.push({ subject: s, types });
  }
  return enriched;
}

return result.map(s => ({ subject: s, types: [typeFilter] }));
