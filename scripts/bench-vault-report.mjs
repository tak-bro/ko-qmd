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
for (const [b, qs] of Object.entries(by)) {
  const hit = qs.filter((q) => q.backends.bm25.recall_at_5 > 0).length
  console.log(`  ${b}: ${hit}/${qs.length} = ${(hit / qs.length).toFixed(3)}`)
}
const miss = j.results.filter((q) => q.backends.bm25.recall_at_5 === 0)
writeFileSync(path.replace('bench.json', 'misses.json'), JSON.stringify(
  miss.map((q) => ({ id: q.id, query: q.query, expected: q.backends.bm25.unmatched_expected_files, top: q.backends.bm25.top_files.slice(0, 3) })), null, 1))
console.log(`misses=${miss.length}`)
