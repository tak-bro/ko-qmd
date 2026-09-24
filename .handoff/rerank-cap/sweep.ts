// Offline candidateLimit sweep over a candidateLimit-40 dump; scoring mirrors KB recall.sh.
import { readFileSync } from 'node:fs'
import { blendRerankScore } from '../../src/store.ts'

const rows = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
const stem = (f: string) => f.replace(/.*\//, '').replace(/\.md$/, '')
function score(pick: (r: any) => string[], label: string) {
  let hits = 0, rec = 0; const miss: string[] = []
  for (const r of rows) {
    const rel = r.relevant.map(stem)
    const seen: string[] = []
    for (const s of pick(r)) if (!seen.includes(s)) seen.push(s)
    const top = seen.slice(0, 5)
    const found = rel.filter((x: string) => top.includes(x)).length
    if (found > 0) hits++; else miss.push(r.id)
    rec += found / rel.length
  }
  console.log(`${label.padEnd(8)} Hit@5=${(hits / rows.length).toFixed(2)} (${hits}/${rows.length}) Recall@5=${(rec / rows.length).toFixed(2)} MISS=${miss.join(',')}`)
}
score((r) => [...r.candidates].sort((a: any, b: any) => a.rrfRank - b.rrfRank).map((c: any) => stem(c.file)), 'rrf')
for (const n of [5, 10, 15, 20, 30, 40]) {
  score((r) => r.candidates.filter((c: any) => c.rrfRank <= n)
    .map((c: any) => ({ s: stem(c.file), v: blendRerankScore(c.rrfRank, c.rerankScore, n) }))
    .sort((a: any, b: any) => b.v - a.v).map((c: any) => c.s), `N=${n}`)
}
