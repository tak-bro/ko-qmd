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
 *   alias    the display text of a `[[target|alias]]` wikilink, from the linking document
 *   fmalias  an entry of the target's own `aliases:` frontmatter list
 * The two alias buckets are human-written "other names" for a document and cost no model call.
 * An `alias` lives in the *linking* document, so a lexical backend may rank the linker above the
 * target — that is the measurement, not a defect of the goldset. Aliases that already occur
 * verbatim in the target are kept; the description says which ones do not.
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

// Wikilink aliases: `[[target|alias]]` in any document names `target` in the linker's words.
const byStem = new Map()
for (const d of docs) byStem.set(d.rel.replace(/^wiki\//, '').replace(/\.md$/, ''), d)
const resolve = (target) => {
  const t = target.replace(/\.md$/, '')
  if (byStem.has(t)) return byStem.get(t)
  const tail = t.split('/').pop()
  const hits = [...byStem.keys()].filter((k) => k.split('/').pop() === tail)
  return hits.length === 1 ? byStem.get(hits[0]) : null
}
const flat = (s) => s.toLowerCase().replace(/\s+/g, '')
const aliasesOf = new Map()  // rel -> Set(alias)
for (const d of docs) {
  for (const m of d.text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?\|([^\]]+)\]\]/g)) {
    const target = resolve(m[1].trim())
    // A wikilink can wrap across source lines; a query with a newline in it parses as a structured
    // query and returns nothing on every backend. Collapse whitespace, then drop a trailing parenthetical.
    const alias = m[2].replace(/\s+/g, ' ').replace(/\s*\(.*\)\s*$/, '').trim()
    if (!target || target.rel === d.rel || korean(alias) < 2 || alias.length > 40) continue
    ;(aliasesOf.get(target.rel) ?? aliasesOf.set(target.rel, new Set()).get(target.rel)).add(alias)
  }
}
// Frontmatter aliases: the document's own list.
const fmAliases = (text) => {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)
  if (!fm) return []
  const block = fm[1].split(/^aliases:\s*$/m)[1]
  if (!block) return []
  const out = []
  for (const line of block.split('\n').slice(1)) {  // [0] is the rest of the `aliases:` line
    const m = line.match(/^\s*-\s*"?([^"\n]+?)"?\s*$/)
    if (!m) break
    if (korean(m[1]) >= 2 && m[1].length <= 40) out.push(m[1])
  }
  return out
}

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
  for (const a of aliasesOf.get(d.rel) ?? []) {
    if (count('alias') >= perBucket) break
    const inTarget = flat(d.text).includes(flat(a))
    add('alias', a, [d.rel], `wikilink alias, ${inTarget ? 'present in' : 'absent from'} target`)
  }
  for (const a of fmAliases(d.text)) {
    if (count('fmalias') >= perBucket) break
    add('fmalias', a, [d.rel], `frontmatter alias`)
  }
}
writeFileSync(out, JSON.stringify({ description: `auto goldset v4 from ${vault}`, version: '4', collection, queries }, null, 1))
const by = {}
for (const q of queries) by[q.id.split('-')[0]] = (by[q.id.split('-')[0]] ?? 0) + 1
console.log(`docs=${docs.length} queries=${queries.length}`, by)
