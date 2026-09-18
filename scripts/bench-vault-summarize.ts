/**
 * bench-vault-summarize — write a plain-language summary per vault document.
 *
 * Usage: bun scripts/bench-vault-summarize.ts <vault-dir> <out.json> [options]
 *   --model <name>   ollama model (default: gemma3:latest)
 *   --docs <n>       stop after this many documents (default: all)
 *   --minutes <n>    stop after this many minutes and write what is done
 *
 * The paraphrase goldset measures the query nobody in the vault writes: a question in
 * everyday words about a document written in jargon. Query expansion cannot close that
 * gap — measured 2026-09-18 over those 30 queries, expansion contributed a median of 2
 * bigrams of the target document's vocabulary and every one of them was a grammatical
 * ending. The gap is between the question's words and the document's, so it closes at
 * index time or not at all: a summary written in the words a reader would use gives the
 * document a surface the question can match.
 *
 * This writes summaries to a sidecar file rather than touching the vault. The bench
 * harness appends them to its own copy; the vault stays as it is.
 *
 * Model choice: the sibling paraphrase generator uses qwen3:4b because a goldset item
 * with a wrong answer key is worse than no item, and that judgement needs the better
 * model at ~120s per document. A summary carries no answer key — a bad one fails to help
 * rather than corrupting a measurement — so this takes the fast model instead, which is
 * the difference between minutes and hours over 208 documents.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'))
const [vault, out] = positional
const model = flag('model', 'gemma3:latest')!
const maxDocs = Number(flag('docs', '0'))
const minutes = Number(flag('minutes', '0'))

const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/g, '')

/**
 * A model that stalls or errors costs its document, not the run: every failure comes back null.
 *
 * This goes to ollama's HTTP API rather than `ollama run`, which the sibling paraphrase
 * generator uses. The CLI hard-wraps its output at 80 columns even when stdout is a pipe
 * and even with COLUMNS set, and it breaks mid-word, so a summary line arrives as two
 * fragments that are each wrong. The API returns the string the model produced.
 */
const ask = async (prompt: string, timeoutMs = 120_000): Promise<string | null> => {
  try {
    const res = await fetch('http://localhost:11434/api/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return null
    const body = await res.json() as { response?: string }
    return stripThinking(body.response ?? '').trim()
  } catch {
    return null
  }
}

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name)
  if (e.isDirectory()) return e.name.startsWith('.') ? [] : walk(p)
  return e.isFile() && e.name.endsWith('.md') ? [p] : []
})

const korean = (s: string) => (s.match(/[가-힣]/g) ?? []).length

const prompt = (title: string, body: string) => `다음 문서를 읽고, 이 문서가 답해 주는 질문을 평범한 일상어로 3개 쓴다.

규칙:
- 문서에 나오는 전문용어·제품명·영어 약어를 쓰지 않는다. 그 말을 모르는 사람이 쓸 법한 표현으로 바꾼다.
- 한 줄에 하나씩, 번호나 기호 없이 질문만 쓴다.
- 설명·머리말·맺음말을 쓰지 않는다.

제목: ${title}

${body.slice(0, 6000)}`

const main = async () => {
  const files = walk(vault)
  const picked = maxDocs > 0 ? files.slice(0, maxDocs) : files
  const deadline = minutes > 0 ? Date.now() + minutes * 60_000 : Infinity
  const summaries: Record<string, string> = {}
  let skipped = 0

  const flush = (done: number) => writeFileSync(out, JSON.stringify({
    description: 'Plain-language summary lines per document, for index-time vocabulary bridging.',
    version: '1', generator: 'bench-vault-summarize', model,
    docs_done: done, docs_total: picked.length, skipped, summaries,
  }, null, 1))

  for (const [i, file] of picked.entries()) {
    if (Date.now() > deadline) { console.error(`time budget reached at ${i}/${picked.length}`); break }
    const rel = relative(vault, file)
    const text = readFileSync(file, 'utf8')
    const title = rel.replace(/\.md$/, '').split('/').pop() ?? rel
    const t0 = Date.now()
    const answer = await ask(prompt(title, text))
    // Keep only lines that read as Korean questions; a model that drifts into English, or
    // into prose about the document, adds noise to the index instead of a matchable surface.
    // A line that talks *about* the document ("다음은 문서에서 나온 질문 3가지입니다") is the
    // model narrating the task, and would index as a sentence every vague query half-matches.
    const META = /문서|다음은|위 내용|아래 내용|질문\s*\d*\s*(가지|개)/
    const lines = (answer ?? '').split('\n')
      .map((l) => l.replace(/^[-*\d.)\s]+/, '').trim())
      .filter((l) => l.length >= 10 && l.length <= 120 && korean(l) >= 5 && !META.test(l))
    if (lines.length === 0) { skipped++ } else { summaries[rel] = lines.join('\n') }
    flush(i + 1)
    console.error(`[${i + 1}/${picked.length}] ${rel} ${Date.now() - t0}ms ${lines.length} lines`)
  }
  flush(picked.length)
}

main()
