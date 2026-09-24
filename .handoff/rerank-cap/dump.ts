// Dump per-query candidates through the same structuredSearch path REST /query uses.
// usage: bun dump.ts <db> <candidateLimit|0=no-rerank> <out.json>
import { readFileSync, writeFileSync } from 'node:fs'
import { createStore } from '../../src/index.ts'

const [db, clArg, out] = process.argv.slice(2)
const cl = Number(clArg)
const golden = readFileSync(`${process.env.KB_DIR ?? `${process.env.HOME}/workspace/knowledge-base`}/scripts/eval/golden.jsonl`, 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l))
const store = await createStore({ dbPath: db!, configPath: `${process.env.HOME}/.config/qmd/index.yml` })
const rows: any[] = []
for (const g of golden) {
  const t0 = performance.now()
  const res = await store.search({
    queries: [{ type: 'vec', query: g.query }, { type: 'lex', query: g.query }],
    collection: 'kb', limit: 40, rerank: cl > 0, explain: true,
    ...(cl > 0 ? { candidateLimit: cl } : {}),
  })
  const ms = performance.now() - t0
  rows.push({
    id: g.id, ms, relevant: g.relevant,
    candidates: res.map((r: any) => ({ file: r.file, rrfRank: r.explain?.rrf?.rank ?? null, rerankScore: r.explain?.rerankScore ?? null })),
  })
  console.error(`${g.id} ${ms.toFixed(0)}ms ${res.length}`)
}
writeFileSync(out!, JSON.stringify(rows, null, 1))
await store.close?.()
process.exit(0)
