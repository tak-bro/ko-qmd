// Dump the full backend's reranked candidate list per goldset query, with the two
// numbers the blend consumes (RRF rank, reranker score). Search runs once; the blend
// is then swept offline, so a variant costs milliseconds instead of a bench run.
import { readFileSync, writeFileSync } from 'node:fs'
import { createStore } from '../src/index.js'

async function main() {
  const [fixturePath, outPath] = process.argv.slice(2)
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const store = await createStore({
    dbPath: process.env.INDEX_PATH!,
    configPath: `${process.env.QMD_CONFIG_DIR}/index.yml`,
  })
  const out: any[] = []

  for (const [i, q] of fixture.queries.entries()) {
    const t0 = Date.now()
    // limit 40 == the default candidateLimit, so nothing the blend could promote is sliced off.
    const results = await store.search({
      query: q.query, limit: 40, collection: fixture.collection, rerank: true, explain: true,
    })
    out.push({
      id: q.id,
      query: q.query,
      expected: q.expected_files,
      ms: Date.now() - t0,
      candidates: results.map((r) => ({
        file: r.file,
        rrfRank: r.explain?.rrf?.rank ?? null,
        rerankScore: r.explain?.rerankScore ?? null,
      })),
    })
    writeFileSync(outPath, JSON.stringify(out, null, 1))
    console.error(`[${i + 1}/${fixture.queries.length}] ${q.id} ${Date.now() - t0}ms ${results.length} cands`)
  }
  process.exit(0)
}

main()
