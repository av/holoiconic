/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const node = args && args.node;
if (!node) throw new Error('[graph:deps] args.node is required');

// Best-effort static dependency analysis via regex over source strings.
// Limitations (by design, to stay within the 6 ctx primitives and avoid heavy AST):
// - Only detects literal string ctx.call('name') / "name" (and backticks without ${}).
// - Misses: dynamic names (vars, template literals with expr, `ctx.call(nameVar)`),
//   indirect (ctx['call'], wrappers, computed), and any call not textually obvious.
// - calledBy does a full O(total source size) scan of all Function nodes on every call.
// For production-grade deps, extend sys:compiler to pre-compute 'calls' quads on
// source changes (reactive) and store inverse 'calledBy' index. This node is a
// convenient REPL/inspect helper, not a complete static analyzer.

const sourceQuads = await ctx.query({ subject: node, predicate: 'source' });
const source = sourceQuads.length > 0 ? sourceQuads[0].object : '';

// Extract static ctx.call('name') / "name" references
const callsSet = new Set();
const callRegex = /ctx\.call\(\s*['"`]([^'"`]+)['"`]/g;
let match;
while ((match = callRegex.exec(source)) !== null) {
  callsSet.add(match[1]);
}
const calls = Array.from(callsSet);

// For calledBy: scan every other Function's source (best-effort)
const allFnQuads = await ctx.query({ predicate: 'type', object: 'Function' });
const calledBy = [];
const escapedName = node.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const refRegex = new RegExp("ctx\\.call\\(\\s*['\"`]" + escapedName + "['\"`]", "g");
for (const fnQuad of allFnQuads) {
  if (fnQuad.subject === node) continue;
  const fnSourceQuads = await ctx.query({ subject: fnQuad.subject, predicate: 'source' });
  if (fnSourceQuads.length === 0) continue;
  if (refRegex.test(fnSourceQuads[0].object)) {
    calledBy.push(fnQuad.subject);
  }
}

return { node, calls, calledBy };
