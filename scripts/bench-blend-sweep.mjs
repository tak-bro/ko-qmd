// bench-blend-sweep — re-score a candidate dump under different blend formulas.
//
// Usage: node scripts/bench-blend-sweep.mjs <dump.json> [k]
//
// The blend that ranks the full backend's output is a pure function of the RRF rank
// and the reranker score, both captured by bench-dump-candidates.ts. So a blend
// variant costs a millisecond here instead of a bench run, and every variant is
// scored against the same retrieval — the comparison isolates the formula.
import { readFileSync } from 'node:fs'

const dump = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const k = Number(process.argv[3] ?? 5)

const rankWeight = (rank) => (rank <= 3 ? 0.75 : rank <= 10 ? 0.6 : 0.4)

const variants = {
  // Shipping formula: position score is 1/rank, so the gap between rank 1 and rank 2
  // (0.375 at weight 0.75) exceeds everything the reranker term can contribute (0.25).
  current: (rank, rerank) => rankWeight(rank) * (1 / rank) + (1 - rankWeight(rank)) * rerank,
  // Same weights, but the position score decays linearly over the candidate window
  // instead of hyperbolically, so adjacent ranks are separated by a constant the
  // reranker can actually overcome.
  linear: (rank, rerank) => {
    const w = rankWeight(rank)
    return w * (1 - (rank - 1) / 40) + (1 - w) * rerank
  },
  // RRF's own shape (1/(60+rank)) — near-flat across the window, reranker decides.
  rrf60: (rank, rerank) => {
    const w = rankWeight(rank)
    return w * (60 / (60 + rank)) + (1 - w) * rerank
  },
  // No position protection at all: pure reranker order.
  rerankOnly: (_rank, rerank) => rerank,
  // No reranker at all: pure retrieval order (what the hybrid backend does).
  rrfOnly: (rank) => 1 / rank,
  // Reranker decides, with a small linear position tiebreak — keeps retrieval as a
  // tiebreaker between documents the reranker scores alike, without letting it veto.
  'rerank+tie.10': (rank, rerank) => 0.9 * rerank + 0.1 * (1 - (rank - 1) / 40),
  'rerank+tie.25': (rank, rerank) => 0.75 * rerank + 0.25 * (1 - (rank - 1) / 40),
  // Rank-gated weights as shipped, but over the linear position score.
  'linear+gate': (rank, rerank) => {
    const w = rank <= 3 ? 0.4 : rank <= 10 ? 0.25 : 0.1
    return w * (1 - (rank - 1) / 40) + (1 - w) * rerank
  },
}

const score = (fn) => {
  let hitsAtK = 0
  let hitsAt1 = 0
  let mrr = 0
  for (const q of dump) {
    const expected = new Set(q.expected.map((f) => f.replace(/^wiki\//, '')))
    const ranked = [...q.candidates]
      .map((c) => ({ ...c, s: fn(c.rrfRank, c.rerankScore) }))
      .sort((a, b) => b.s - a.s)
    const hit = ranked.findIndex((c) => [...expected].some((e) => c.file.endsWith(e)))
    if (hit >= 0 && hit < k) hitsAtK++
    if (hit === 0) hitsAt1++
    if (hit >= 0) mrr += 1 / (hit + 1)
  }
  const n = dump.length
  return { n, [`r@${k}`]: hitsAtK / n, 'r@1': hitsAt1 / n, mrr: mrr / n }
}

const bucketOf = (id) => id.replace(/-\d+$/, '')
const buckets = [...new Set(dump.map((q) => bucketOf(q.id)))]

for (const [name, fn] of Object.entries(variants)) {
  const all = score(fn)
  const per = buckets
    .map((b) => {
      const sub = dump.filter((q) => bucketOf(q.id) === b)
      const s = scoreSubset(sub, fn)
      return `${b} ${s.toFixed(3)}`
    })
    .join('  ')
  console.log(
    `${name.padEnd(11)} n=${all.n} r@${k}=${all[`r@${k}`].toFixed(3)} r@1=${all['r@1'].toFixed(3)} mrr=${all.mrr.toFixed(3)}   ${per}`,
  )
}

function scoreSubset(sub, fn) {
  let hits = 0
  for (const q of sub) {
    const expected = q.expected.map((f) => f.replace(/^wiki\//, ''))
    const ranked = [...q.candidates]
      .map((c) => ({ ...c, s: fn(c.rrfRank, c.rerankScore) }))
      .sort((a, b) => b.s - a.s)
    const hit = ranked.findIndex((c) => expected.some((e) => c.file.endsWith(e)))
    if (hit >= 0 && hit < k) hits++
  }
  return hits / sub.length
}
