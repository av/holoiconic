/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const record = args && args.record;
if (!record) throw new Error('[metrics] args.record is required');
const name = record.name;
const durationMs = record.durationMs;
const error = record.error;
if (!name) throw new Error('[metrics] record.name is required');
if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs < 0) throw new Error('[metrics] record.durationMs must be a non-negative finite number');

// Serialize per-node metric updates with a proper tail-chained async mutex.
// Prevents lost increments when concurrent calls for the same node interleave
// on the read-modify-write of metric:* quads (ctx.set is atomic per-predicate
// but the preceding queries are not).
if (!ctx._metricsLocks) ctx._metricsLocks = new Map();
const prev = ctx._metricsLocks.get(name) || Promise.resolve();
let release;
const releaseP = new Promise(r => { release = r; });
const nextTail = prev.then(() => releaseP);
ctx._metricsLocks.set(name, nextTail);
await prev; // wait until previous owner releases

try {
  const callsQuads = await ctx.query({ subject: name, predicate: 'metric:calls', graph: 'metrics' });
  const durationQuads = await ctx.query({ subject: name, predicate: 'metric:duration_ms', graph: 'metrics' });

  const prevCalls = callsQuads.length > 0 ? parseInt(callsQuads[0].object) : 0;
  const prevDuration = durationQuads.length > 0 ? parseFloat(durationQuads[0].object) : 0;

  const newCalls = prevCalls + 1;
  const newDuration = prevDuration + durationMs;

  await ctx.set(name, 'metric:calls', String(newCalls), 'metrics');
  await ctx.set(name, 'metric:duration_ms', String(newDuration), 'metrics');

  let newErrors = 0;
  if (error) {
    const errorsQuads = await ctx.query({ subject: name, predicate: 'metric:errors', graph: 'metrics' });
    newErrors = (errorsQuads.length > 0 ? parseInt(errorsQuads[0].object) : 0) + 1;
    await ctx.set(name, 'metric:errors', String(newErrors), 'metrics');
  } else {
    const errorsQuads = await ctx.query({ subject: name, predicate: 'metric:errors', graph: 'metrics' });
    newErrors = errorsQuads.length > 0 ? parseInt(errorsQuads[0].object) : 0;
  }

  return { name, calls: newCalls, duration_ms: newDuration, errors: newErrors };
} finally {
  release();
}
