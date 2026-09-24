// Token lengths of the best chunks N=15 sends to the reranker (RRF top 15, same Step-5 chunk pick).
// usage: bun tokens.ts <db>
import { readFileSync } from 'node:fs'
import { createStore } from '../../src/index.ts'
import { LlamaCpp } from '../../src/llm.ts'

const golden = readFileSync(`${process.env.KB_DIR ?? `${process.env.HOME}/workspace/knowledge-base`}/scripts/eval/golden.jsonl`, 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l))
const store = await createStore({ dbPath: process.argv[2]!, configPath: `${process.env.HOME}/.config/qmd/index.yml` })
console.error("store ready")
const model = await (new LlamaCpp({}) as any).ensureRerankModel()
const lens: number[] = []
for (const g of golden) {
  const res = await store.search({
    queries: [{ type: 'vec', query: g.query }, { type: 'lex', query: g.query }],
    collection: 'kb', limit: 15, rerank: false,
  })
  for (const r of res as any[]) lens.push(model.tokenize(r.bestChunk).length)
  console.error(`${g.id} ${res.length}`)
}
lens.sort((a, b) => a - b)
const q = (p: number) => lens[Math.round(p * (lens.length - 1))]
const over = (n: number) => (lens.filter((x) => x > n).length / lens.length).toFixed(2)
console.log(`n=${lens.length} median=${q(0.5)} p90=${q(0.9)} max=${lens.at(-1)} >128=${over(128)} >256=${over(256)} >512=${over(512)} sum=${lens.reduce((a, b) => a + b, 0)}`)
process.exit(0)
