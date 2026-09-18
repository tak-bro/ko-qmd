// bench-vault-summary-apply — build a summary-augmented copy of a vault.
//
// Usage: node scripts/bench-vault-summary-apply.mjs <vault-dir> <summaries.json> <out-dir> [--max-df N]
//
// Writes <out-dir>/wiki/<rel> for every document, with its plain-language summary lines
// appended under a heading. The vault itself is never written to; this is the copy the
// bench indexes, so the before/after comparison differs in one thing only.
//
// --max-df drops a summary line that says nothing specific. The model sometimes emits
// filler ("음, 이거 어떻게 하면 좋을까?"), and filler indexed against a document is worse
// than no summary: it gives every vague query a weak match on a document it has nothing
// to do with. A filler line is made of syllable bigrams that occur across the whole
// corpus, so a line is dropped when it has fewer than MIN_RARE bigrams under the
// document-frequency cutoff.
//
// The default of 20 was read off the data: over 784 generated lines the cutoff drops 27,
// and all 27 are contentless ("이 도구는 뭘 하는 건데?"). At 10 it drops 72 and starts
// taking specific lines with them.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'

const [vault, summaryPath, outDir] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'))
const maxDfArg = process.argv.indexOf('--max-df')
const MAX_DF = maxDfArg === -1 ? 20 : Number(process.argv[maxDfArg + 1])
const MIN_RARE = 3

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name)
  if (e.isDirectory()) return e.name.startsWith('.') ? [] : walk(p)
  return e.isFile() && e.name.endsWith('.md') ? [p] : []
})

const bigrams = (s) => {
  const out = []
  for (const run of s.match(/[가-힣]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  return out
}

const { summaries } = JSON.parse(readFileSync(summaryPath, 'utf8'))

// Document frequency over the summaries themselves: a bigram in most summaries is a
// connective, not a topic.
const df = new Map()
for (const text of Object.values(summaries)) {
  for (const g of new Set(bigrams(text))) df.set(g, (df.get(g) ?? 0) + 1)
}

const keepLine = (line) => bigrams(line).filter((g) => (df.get(g) ?? 0) <= MAX_DF).length >= MIN_RARE

let docs = 0
let linesKept = 0
let linesDropped = 0
for (const file of walk(vault)) {
  const rel = relative(vault, file)
  const body = readFileSync(file, 'utf8')
  const lines = (summaries[rel] ?? '').split('\n').filter(Boolean)
  const kept = lines.filter(keepLine)
  linesKept += kept.length
  linesDropped += lines.length - kept.length
  const dest = join(outDir, 'wiki', rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, kept.length === 0 ? body : `${body.trimEnd()}\n\n## 이 문서가 답하는 질문\n\n${kept.map((l) => `- ${l}`).join('\n')}\n`)
  docs++
}

console.log(`docs=${docs} lines_kept=${linesKept} lines_dropped=${linesDropped} max_df=${MAX_DF} distinct_bigrams=${df.size}`)
