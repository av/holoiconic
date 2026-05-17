/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const callsQuads = await ctx.query({ predicate: 'metric:calls', graph: 'metrics' });
const nodes = {};

for (const q of callsQuads) {
  nodes[q.subject] = { name: q.subject, calls: parseInt(q.object), duration_ms: 0, errors: 0 };
}

// Enrich with duration
const durationQuads = await ctx.query({ predicate: 'metric:duration_ms', graph: 'metrics' });
for (const q of durationQuads) {
  if (nodes[q.subject]) nodes[q.subject].duration_ms = parseFloat(q.object);
}

// Enrich with errors
const errorsQuads = await ctx.query({ predicate: 'metric:errors', graph: 'metrics' });
for (const q of errorsQuads) {
  if (nodes[q.subject]) nodes[q.subject].errors = parseInt(q.object);
}

const sorted = Object.values(nodes).sort((a, b) => b.calls - a.calls);

// Calculate averages
for (const n of sorted) {
  n.avg_ms = n.calls > 0 ? Math.round((n.duration_ms / n.calls) * 100) / 100 : 0;
}

// Format report
const lines = ['=== Metrics Report ===', ''];
lines.push('Node'.padEnd(30) + 'Calls'.padStart(8) + 'Total ms'.padStart(12) + 'Avg ms'.padStart(10) + 'Errors'.padStart(8));
lines.push('-'.repeat(68));

for (const n of sorted) {
  lines.push(
    n.name.padEnd(30) +
    String(n.calls).padStart(8) +
    String(Math.round(n.duration_ms)).padStart(12) +
    String(n.avg_ms).padStart(10) +
    String(n.errors).padStart(8)
  );
}

lines.push('');
lines.push('Total nodes: ' + sorted.length);

const report = lines.join('\n');

if (args && args.raw) {
  return { nodes: sorted, report };
}
return report;
