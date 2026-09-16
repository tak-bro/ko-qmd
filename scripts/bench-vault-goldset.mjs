/**
 * bench-vault-goldset — build a `qmd bench` goldset from a real Korean vault.
 *
 * Usage: node scripts/bench-vault-goldset.mjs <vault-dir> <out.json> [collection] [per-bucket]
 *
 * Queries come from the vault's own Korean headings and body clauses, which are real noun
 * phrases. Harvesting bare words instead produces particle-glued fragments (`진실원이다`) that
 * no one would type. A heading is used only when it is unique across the corpus, so exactly
 * one document is the right answer. Four buckets separate the failure modes:
 *   head     heading verbatim
 *   headp    heading with a particle on the last word
 *   headjoin heading with the spaces removed
 *   clause   a body clause, the long-query case
 * The goldset is written outside the repo tree by convention — vault text is not ours to commit.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const vault = process.argv[2], out = process.argv[3]
const collection = process.argv[4] ?? 'wiki', perBucket = Number(process.argv[5] ?? 40)

const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name)
  if (e.isDirectory()) return e.name.startsWith('.') ? [] : walk(p)
  return e.isFile() && e.name.endsWith('.md') ? [p] : []
})
const root = join(vault, 'wiki')
const docs = walk(root).filter((f) => statSync(f).size < 400_000)
  .map((f) => ({ rel: `wiki/${relative(root, f)}`, text: readFileSync(f, 'utf8') }))

const clean = (s) => s.replace(/[`*_\[\]()|#>]/g, ' ').replace(/^\s*[-–—•]\s*/, '')
  .replace(/^\s*\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim()
const korean = (s) => (s.match(/[가-힣]/g) ?? []).length
const headings = new Map()  // heading text -> Set(rel)
const perDoc = new Map()
for (const d of docs) {
  const hs = (d.text.match(/^#{2,3} +(.+)$/gm) ?? []).map((l) => clean(l.replace(/^#+ +/, '')))
    .filter((t) => korean(t) >= 4 && t.split(/\s+/).length >= 2 && t.length <= 26)
  perDoc.set(d.rel, hs)
  for (const h of hs) (headings.get(h) ?? headings.set(h, new Set()).get(h)).add(d.rel)
}
const uniqueHeadings = (rel) => (perDoc.get(rel) ?? []).filter((h) => headings.get(h).size === 1)

// Body clauses: a Korean sentence fragment long enough to be a real question.
const clauses = (text) => (clean(text.replace(/^---[\s\S]*?^---/m, '')).split(/[.。\n]/))
  .map((s) => s.trim()).filter((s) => korean(s) >= 12 && s.length <= 40)

const queries = []
const add = (bucket, query, expected, description) => {
  if (!query || queries.some((q) => q.query === query)) return
  queries.push({
    id: `${bucket}-${String(queries.length + 1).padStart(3, '0')}`,
    query, type: 'exact', description, expected_files: expected, expected_in_top_k: expected.length,
  })
}
const count = (b) => queries.filter((q) => q.id.startsWith(`${b}-`)).length

for (const d of docs) {
  const hs = uniqueHeadings(d.rel)
  const h = hs[0]
  if (h) {
    if (count('head') < perBucket) add('head', h, [d.rel], `heading verbatim`)
    // last word carries a particle, the way a question would write it
    if (count('headp') < perBucket) {
      const w = h.split(/\s+/)
      const last = w[w.length - 1]
      if (/[가-힣]$/.test(last)) add('headp', `${w.slice(0, -1).join(' ')} ${last}은`, [d.rel], `heading + 조사`)
    }
    // spacing variant: the same phrase typed without spaces
    if (count('headjoin') < perBucket) add('headjoin', h.replace(/\s+/g, ''), [d.rel], `heading, spaces removed`)
  }
  if (count('clause') < perBucket) {
    const c = clauses(d.text).find((s) => s.split(/\s+/).length >= 3)
    if (c) add('clause', c, [d.rel], `body clause verbatim`)
  }
}
writeFileSync(out, JSON.stringify({ description: `auto goldset v3 from ${vault}`, version: '3', collection, queries }, null, 1))
const by = {}
for (const q of queries) by[q.id.split('-')[0]] = (by[q.id.split('-')[0]] ?? 0) + 1
console.log(`docs=${docs.length} queries=${queries.length}`, by)
