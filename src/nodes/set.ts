/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const s = args && args.subject;
const p = args && args.predicate;
const o = args && args.object;
const g = (args && args.graph) || '_';
if (!s || !p || o === undefined || o === null) {
  throw new Error('[set] args.subject, args.predicate, and args.object are required');
}
return ctx.set(s, p, o, g);
