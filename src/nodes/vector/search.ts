/** @param {import('../ctx').Ctx} ctx */
/** @param {any} args */

const k = (args && args.k !== undefined && args.k !== null) ? args.k : 10;
let embedding = args && args.embedding;

if (!embedding && args && args.text) {
  const result = await ctx.call('embed', { text: args.text });
  embedding = result.embedding;
} else if (!embedding) {
  throw new Error('[vector:search] args.text or args.embedding is required');
}

// Prefer stored embeddings (persisted as 'embedding_json' quads by embed.ts) for
// zero-re-embed fast path. Fall back to brute-force re-embedding over whole graph
// only when no pre-cached embeddings exist. This makes the "stored embeddings"
// path actually fast and cheap.
const embQuads = await ctx.query({ predicate: 'embedding', graph: 'embeddings' });
const vecJsonQuads = await ctx.query({ predicate: 'embedding_json', graph: 'embeddings' });
const vecById = new Map();
for (const vq of vecJsonQuads) {
  try { vecById.set(vq.subject, JSON.parse(vq.object)); } catch {}
}

if (embQuads.length > 0) {
  // Fast path: use persisted vectors (JSON form, always readable via ctx.query)
  const results = [];
  for (const eq of embQuads) {
    let eVec = vecById.get(eq.subject);
    if (!eVec || eVec.length === 0) {
      // Older entry without JSON vec (or parse fail) — re-embed this one only
      const eResult = await ctx.call('embed', { text: eq.object });
      eVec = eResult.embedding;
    }
    // Cosine similarity (query vec vs stored)
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < embedding.length && i < eVec.length; i++) {
      dot += embedding[i] * eVec[i];
      normA += embedding[i] * embedding[i];
      normB += eVec[i] * eVec[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    const similarity = denom > 0 ? dot / denom : 0;
    results.push({ quad: { subject: eq.subject, predicate: eq.predicate, object: eq.object, graph: eq.graph }, similarity });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, k);
}

// Fallback: brute-force cosine similarity over all quads (expensive, re-embeds everything)
const allQuads = await ctx.query({});

const results = [];
for (const q of allQuads) {
  // Get embedding for this quad's content
  const qText = q.subject + ' ' + q.predicate + ' ' + q.object;
  const qResult = await ctx.call('embed', { text: qText });
  const qEmb = qResult.embedding;

  // Cosine similarity
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < embedding.length && i < qEmb.length; i++) {
    dot += embedding[i] * qEmb[i];
    normA += embedding[i] * embedding[i];
    normB += qEmb[i] * qEmb[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  const similarity = denom > 0 ? dot / denom : 0;
  results.push({ quad: { subject: q.subject, predicate: q.predicate, object: q.object, graph: q.graph }, similarity });
}

results.sort((a, b) => b.similarity - a.similarity);
return results.slice(0, k);
