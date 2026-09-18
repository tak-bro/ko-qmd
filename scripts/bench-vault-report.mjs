import { readFileSync, writeFileSync } from 'node:fs'
const path = process.argv[2]
const j = JSON.parse(readFileSync(path, 'utf8'))
const s = j.summary, g = (b, k) => (s[b] ? s[b][k] : NaN).toFixed(4)
console.log(`RESULT bm25_r5=${g('bm25', 'avg_recall_at_5')} bm25_r1=${g('bm25', 'avg_recall_at_1')} bm25_mrr=${g('bm25', 'avg_mrr')}`)
// The vector backends only carry numbers when the index was embedded (--embed).
if (s['vector'] && s['vector']['avg_recall_at_5'] > 0) {
  console.log(`       vector_r5=${g('vector', 'avg_recall_at_5')} hybrid_r5=${g('hybrid', 'avg_recall_at_5')} full_r5=${g('full', 'avg_recall_at_5')} full_mrr=${g('full', 'avg_mrr')}`)
}
const by = {}
for (const q of j.results) (by[q.id.split('-')[0]] ??= []).push(q)
// Per bucket for every backend that ran, not just bm25: the buckets exist to separate
// query shapes, and which backend wins changes with the shape. Printing one backend's
// numbers under a bare bucket name invites reading them as the whole run's.
const ran = ['bm25', 'vector', 'hybrid', 'full']
  .filter((b) => j.summary[b] && (b === 'bm25' || j.summary[b].avg_recall_at_5 > 0))
for (const [bucket, qs] of Object.entries(by)) {
  const cells = ran.map((b) => {
    const hit = qs.filter((q) => q.backends[b].recall_at_5 > 0).length
    return `${b} ${(hit / qs.length).toFixed(3)}`
  })
  console.log(`  ${bucket} (n=${qs.length}): ${cells.join('  ')}`)
}
// The miss list is the best backend's, since that is the set still unsolved by anything.
const bestBackend = ran[ran.length - 1]
const miss = j.results.filter((q) => q.backends[bestBackend].recall_at_5 === 0)
// Next to the input, never on top of it: `replace('bench.json', …)` was a no-op for any other
// file name, so reporting on a copied result overwrote that result with its own miss list.
const missPath = path.endsWith('bench.json') ? path.replace(/bench\.json$/, 'misses.json') : `${path}.misses.json`
writeFileSync(missPath, JSON.stringify(
  miss.map((q) => ({ id: q.id, query: q.query, expected: q.backends[bestBackend].unmatched_expected_files, top: q.backends[bestBackend].top_files.slice(0, 3) })), null, 1))
console.log(`misses=${miss.length} (${bestBackend})`)
