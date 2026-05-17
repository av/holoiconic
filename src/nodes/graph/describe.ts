/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const subject = args && args.subject;
if (!subject) throw new Error('[graph:describe] args.subject is required');

const quads = await ctx.query({ subject: subject });
const description = {};
for (const q of quads) {
  if (!description[q.predicate]) {
    description[q.predicate] = [];
  }
  description[q.predicate].push({ value: q.object, graph: q.graph });
}

return { subject, quads: quads.map(q => ({ subject: q.subject, predicate: q.predicate, object: q.object, graph: q.graph })), predicates: description };
