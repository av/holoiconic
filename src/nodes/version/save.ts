/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const name = args && args.name;
const source = args && args.source;
if (!name || !source) throw new Error('[version:save] args.name and args.source are required');

// Determine next sequence number by counting existing versions
const existing = await ctx.query({ subject: name, predicate: 'version', graph: 'versions' });
const seq = existing.length;
const timestamp = new Date().toISOString();

// Store as a unique quad: use seq in the object to ensure uniqueness
const versionData = JSON.stringify({ seq, timestamp, source });
await ctx.insert(name, 'version', versionData, 'versions');

return { name, seq, timestamp };
