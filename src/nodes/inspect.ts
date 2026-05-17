/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const node = args && args.node;
if (!node) throw new Error('[inspect] args.node is required');

// Get graph:describe info
const description = await ctx.call('graph:describe', { subject: node });

// Get graph:deps info
const deps = await ctx.call('graph:deps', { node });

// Extract specific fields for convenience
const source = description.predicates.source
  ? description.predicates.source[0].value
  : null;
const types = description.predicates.type
  ? description.predicates.type.map(t => t.value)
  : [];
const isSpawned = types.includes('Spawned');
const isFunction = types.includes('Function');
const isTool = types.includes('Tool');

// Get tool schema if it exists
let toolSchema = null;
if (description.predicates.tool_schema) {
  try {
    toolSchema = JSON.parse(description.predicates.tool_schema[0].value);
  } catch {}
}

// Check for lifecycle/status quads
const status = description.predicates.status
  ? description.predicates.status.map(s => s.value)
  : [];
const lifecycle = description.predicates.lifecycle
  ? description.predicates.lifecycle.map(l => l.value)
  : [];

return {
  node,
  exists: description.quads.length > 0,
  types,
  isFunction,
  isSpawned,
  isTool,
  source: source ? source.slice(0, 2000) + (source.length > 2000 ? '...' : '') : null,
  sourceLength: source ? source.length : 0,
  toolSchema,
  dependencies: deps.calls,
  dependents: deps.calledBy,
  status,
  lifecycle,
  quadCount: description.quads.length,
  predicates: Object.keys(description.predicates),
};
