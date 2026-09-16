/**
 * bench-vault-paraphrase — build a paraphrase goldset from a real Korean vault with a local model.
 *
 * Usage: bun scripts/bench-vault-paraphrase.ts <vault-dir> <out.json> [options]
 *   --collection <name>   collection name written into the goldset (default: wiki)
 *   --per-doc <n>         questions to ask the model for per document (default: 2)
 *   --docs <n>            stop after this many documents (default: all)
 *   --model <name>        ollama model (default: qwen3:4b)
 *   --keep-rejects <path> write every rejected candidate with its reason, for tuning the gates
 *   --minutes <n>         stop after this many minutes and write what is done (default: no limit)
 *   --seed <n>            shuffle seed, so a truncated run samples the vault (default: 1)
 *   --max-df <n>          a heading word in more than this many documents is common, not jargon,
 *                         and is not banned from questions (default: 12)
 *
 * The sibling generator, bench-vault-goldset.mjs, harvests headings and body clauses: its queries
 * are the document's own words, so they measure lexical matching. This one measures the opposite
 * case — the question someone types when they do not know the vocabulary the document is written
 * in. BASELINE.md's `sem-004` is the instance that motivated it: a note about `CLAUDE.md` and
 * context budget, unreachable from "설정 파일에 다 적어놓으면 산만해진다".
 *
 * Runs against ollama rather than the package's own node-llama-cpp models, because the bundled
 * models cannot do this. Measured on a real vault: the default generate model
 * (qmd-query-expansion-1.7B, a fine-tune that only ever sees `Expand this search query: …`)
 * returns an empty string for a free-form instruction, and LFM2.5-1.2B-Instruct produced 0 usable
 * questions over 12 documents — every output was a summary of the document it had just been shown.
 * If a bundled model catches up, `ask` is the one function to switch back.
 *
 * Generation is unreliable in a way that matters more than yield: the model will write a fluent,
 * well-formed question about something the document does not discuss, and that question would
 * enter the goldset paired with this document as its answer — a benchmark item with a wrong
 * answer key, which is worse than no item at all. So nothing is kept on the generator's word.
 * Every candidate passes four mechanical gates and then a separate verification call that is
 * shown the question and the document and asked whether the answer is in there.
 *
 * Model choice, measured on the same 6 documents with the same prompt and gates: `gemma3` kept 2
 * questions in 31s, `qwen3:4b` kept 11 in 11m51s. The yield is not the whole difference — both of
 * gemma3's name a product or quote the document's own term back, and qwen3's do not. qwen3 is the
 * default and costs about 120s per document, because it is a reasoning model and the thinking
 * cannot be turned off here; see `stripThinking`. A goldset is built once and used for a long
 * time, so the slower model is the cheaper one.
 *
 * Known leak: the banned-term gate compares literal strings, so a Korean transliteration of an
 * English title term gets through — a note titled `ContextPack` still admits a question that says
 * 컨텍스트 팩. Those items are easier than the bucket intends rather than wrong, so they are worth
 * knowing about when reading a score, and closing it means matching transliterations, not another
 * prompt rule.
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import { spawn } from 'node:child_process'

type Args = {
  vault: string; out: string; collection: string
  perDoc: number; docs: number; model: string; keepRejects: string | null
  minutes: number; seed: number; maxDf: number
}

const parseArgs = (argv: string[]): Args => {
  const [vault, out] = argv
  if (!vault || !out) throw new Error('usage: bun scripts/bench-vault-paraphrase.ts <vault-dir> <out.json> [options]')
  const flag = (name: string, fallback: string | null) => {
    const i = argv.indexOf(`--${name}`)
    return i === -1 ? fallback : (argv[i + 1] ?? fallback)
  }
  return {
    vault, out,
    collection: flag('collection', 'wiki')!,
    perDoc: Number(flag('per-doc', '2')),
    docs: Number(flag('docs', String(Number.MAX_SAFE_INTEGER))),
    model: flag('model', 'qwen3:4b')!,
    keepRejects: flag('keep-rejects', null),
    minutes: Number(flag('minutes', '0')),
    seed: Number(flag('seed', '1')),
    maxDf: Number(flag('max-df', '12')),
  }
}

/** `ollama run` draws a spinner even with stdin piped, which leaves erase-line escapes in stdout. */
const stripAnsi = (s: string) => s.replace(/\[[0-9;]*[A-Za-z]/g, '')

/**
 * Reasoning models emit their working before the answer, and it is full of sentences that read
 * like candidate questions — including rejected drafts, quoted in full. Parsing the whole stream
 * takes those drafts as output. ollama renders the block as plain prose terminated by
 * "...done thinking.", other runners use <think> tags, so both are cut.
 *
 * Cutting it after the fact is the only option here. Measured against ollama 0.x with qwen3:4b,
 * neither `--think=false`, `--hidethinking`, nor a `/no_think` line in the prompt suppresses the
 * block, and the prompt version is worse than nothing: the model spends its reasoning wondering
 * what the directive means. So the time thinking costs is paid whatever this function does.
 */
const stripThinking = (s: string): string => {
  const withoutTags = s.replace(/<think>[\s\S]*?<\/think>/g, '')
  const marker = withoutTags.lastIndexOf('...done thinking.')
  return marker === -1 ? withoutTags : withoutTags.slice(marker + '...done thinking.'.length)
}

/** A model that stalls or errors costs its document, not the run: every failure comes back null. */
const ask = (model: string, prompt: string, timeoutMs = 180_000): Promise<string | null> =>
  new Promise((resolve) => {
    // COLUMNS: ollama hard-wraps its output to the terminal width even when stdout is a pipe, which
    // splits a single question across two lines and loses both halves to the gates below.
    const child = spawn('ollama', ['run', model], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, COLUMNS: '10000' },
    })
    let out = ''
    let settled = false
    const done = (v: string | null) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v) } }
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(null) }, timeoutMs)

    child.stdout.on('data', (c) => { out += c })
    child.on('error', () => done(null))
    child.on('close', (code) => done(code === 0 ? stripThinking(stripAnsi(out)).trim() : null))
    child.stdin.on('error', () => done(null))
    child.stdin.end(prompt)
  })

const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  const p = join(d, e.name)
  if (e.isDirectory()) return e.name.startsWith('.') ? [] : walk(p)
  return e.isFile() && e.name.endsWith('.md') ? [p] : []
})

const korean = (s: string) => (s.match(/[가-힣]/g) ?? []).length

/** Frontmatter is metadata, not prose a question should be written from. */
const stripFrontmatter = (text: string) => text.replace(/^---\n[\s\S]*?\n---\n/, '')

/**
 * What the model is shown: the title and the opening prose, which is where a note says what it is
 * about. Feeding the whole document buries that lead and the questions drift to whatever the last
 * section happened to discuss.
 */
const brief = (text: string, limit = 1200) => {
  const body = stripFrontmatter(text)
  const title = (body.match(/^# +(.+)$/m) ?? [])[1]?.trim() ?? ''
  const prose = body.replace(/^#.*$/gm, '').replace(/```[\s\S]*?```/g, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\s+/g, ' ').trim()
  return { title, text: prose.slice(0, limit) }
}

const tokenize = (s: string): string[] => s.split(/[\s/·,()]+/)
  .map((w) => w.replace(/[`*_\[\]()|#>.:]/g, '').trim())
  .filter((w) => w.length >= 2 && (korean(w) >= 2 || /^[A-Za-z][A-Za-z0-9.+-]{2,}$/.test(w)))
  .map((w) => w.toLowerCase())

/** How many documents each token appears in, so the gate below can tell jargon from common words. */
const documentFrequency = (docs: Array<{ text: string }>): Map<string, number> => {
  const df = new Map<string, number>()
  for (const d of docs) {
    for (const t of new Set(tokenize(stripFrontmatter(d.text)))) df.set(t, (df.get(t) ?? 0) + 1)
  }
  return df
}

/**
 * The words a question may not reuse: the title, the headings and the filename. A question built
 * out of those is the `head` bucket with extra steps.
 *
 * Only the rare ones, though. Taking every heading word banned 환경, 요청 and 처리 along with the
 * jargon, and those are how a person describes a situation without naming anything — which is what
 * the questions are supposed to be made of. Measured on 6 documents, every rejection on both models
 * was this gate, and three of the ones it threw away were exactly the shape being asked for. A term
 * in more than `maxDf` documents of the vault is common vocabulary, not this document's name for
 * something, so it is not banned.
 */
const bannedTerms = (rel: string, text: string, df: Map<string, number>, maxDf: number): string[] => {
  const body = stripFrontmatter(text)
  const headings = (body.match(/^#{1,3} +(.+)$/gm) ?? []).map((h) => h.replace(/^#+ +/, ''))
  const stem = basename(rel, '.md').replace(/[-_]/g, ' ')
  return [...headings, stem].flatMap(tokenize).filter((w) => (df.get(w) ?? 0) <= maxDf)
}

/**
 * Few-shot, because the instruction alone does not get this shape out of a small model. The
 * examples are the hand-written `sem` queries this generator scales up, and what they have in
 * common is stated rather than left to be inferred: none of them names the thing being looked for.
 */
const SHOTS = [
  '여러 개 열어둔 AI 에이전트 터미널 중에 어느 게 끝났는지 하나하나 확인 안 해도 되는 도구 있나요',
  '다 팔릴까 봐 불안하게 만들어서 빨리 사게 만드는 마케팅 심리는 뭐라고 부르나요',
  '앱이랑 웹 버전이 안 맞을 때 기기에 저장된 옛날 데이터를 서로 다르게 해석해서 꼬이는 걸 어떻게 관리하나요',
].join('\n')

const writePrompt = (title: string, text: string, n: number) => `어떤 위키 문서를 찾으려는 사람이 검색창에 칠 법한 한국어 질문을 쓰는 일이다.

좋은 질문의 예:
${SHOTS}

위 예시들의 공통점: 찾으려는 대상의 이름을 한 번도 말하지 않는다. 대신 그 사람이 겪고 있는
상황과 원하는 결과만 쉬운 말로 적는다. 이름을 알면 검색할 필요도 없기 때문이다.

규칙:
- 질문이어야 한다. 요약하는 서술문을 쓰지 마라.
- 제품명·도구명·기술용어·영어 단어를 쓰지 마라. 아래 문서 제목에 나온 단어는 특히 금지다.
- "이 문서" 같은 말을 쓰지 마라. 질문하는 사람은 그 문서를 아직 못 찾았다.
- 문서에 실제로 적힌 내용만 물어라. 문서에 없는 상황을 지어내지 마라.
- 한 줄에 질문 하나씩. 번호나 기호를 붙이지 마라. 설명을 덧붙이지 마라.

문서 제목: ${title}
문서 내용: ${text}

질문 ${n}개:`

/**
 * The verification call is deliberately not the writing call: asked in the same breath, the model
 * approves what it just wrote. Shown the document and a question with no memory of having authored
 * it, it rejects the invented ones.
 */
const verifyPrompt = (text: string, questions: string[]) => `아래 문서를 읽고, 각 질문에 대해 그 답이 이 문서 안에 실제로 있는지 판정하라.

문서:
${text}

질문:
${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

각 질문마다 한 줄씩, "번호: 예" 또는 "번호: 아니오" 형식으로만 답하라. 설명을 쓰지 마라.
문서가 그 질문에 답하지 못하면 "아니오"다. 주제가 비슷하기만 해도 "아니오"다.

판정:`

const parseVerdicts = (raw: string, count: number): boolean[] => {
  const verdicts = new Array<boolean>(count).fill(false)
  for (const line of raw.split('\n')) {
    const m = line.match(/(\d+)\s*[:.)]\s*(예|아니오|yes|no)/i)
    if (!m) continue
    const idx = Number(m[1]) - 1
    if (idx >= 0 && idx < count) verdicts[idx] = /^(예|yes)$/i.test(m[2])
  }
  return verdicts
}

/**
 * One question per line is what the prompt asks for and not what arrives: ollama hard-wraps its
 * output at the terminal width regardless of stdout being a pipe or of COLUMNS, so a long question
 * comes back as two lines, each of which fails the gates on its own. Lines are therefore rejoined
 * until the accumulated text reads as a finished question, which is the same signal the statement
 * gate uses. A run of lines that never finishes one is dropped rather than guessed at.
 */
const parseQuestions = (raw: string): string[] => {
  const out: string[] = []
  let buf = ''
  for (const line of raw.split('\n')) {
    const l = line.replace(/^\s*[-–—•*]\s*/, '').replace(/^\s*\d+[.)]\s*/, '').trim()
    if (l.length === 0 || l.endsWith(':')) { buf = ''; continue }
    buf = buf ? `${buf}${/[가-힣A-Za-z0-9]$/.test(buf) && /^[가-힣]/.test(l) ? '' : ' '}${l}` : l
    if (QUESTION_END.test(buf)) { out.push(buf); buf = '' }
  }
  return out
}

/**
 * Korean questions end in a recognizable way and the statements a small model falls back to do
 * not. The ending is what separates "…어떻게 관리하나요" from "…라고 설명합니다".
 *
 * Interrogatives are deliberately absent from it. 무엇 and 어떻게 open a question rather than close
 * one, and with them here the rejoin below cut "…이유는 무엇인가요" in half at a wrap: the first
 * part was kept as a truncated question and "인가요" was discarded as too short. Three of eleven
 * questions in a 6-document run came out that way.
 */
const QUESTION_END = /(\?|나요|가요|까요|은가요|인가요|뭔가요|뭐예요|뭐죠|있나|하나요|되나요|하죠|건가요|는지)\s*$/
/** The asker has not found the document yet, so they cannot refer to it. */
const SELF_REFERENTIAL = /(이 문서|본문|여기서|위 문서|해당 문서|문서에서)/

/**
 * A deterministic shuffle, so a run that stops on its time budget is a sample of the whole vault
 * rather than of whatever sorts first — and so two runs with the same seed cover the same
 * documents and are comparable.
 */
const shuffled = <T,>(items: T[], seed: number): T[] => {
  const out = [...items]
  let state = seed || 1
  const next = () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const root = join(args.vault, 'wiki')
  const all = walk(root).filter((f) => statSync(f).size < 400_000)
    .map((f) => ({ file: f, rel: `wiki/${relative(root, f)}`, text: readFileSync(f, 'utf8') }))
  // Document frequency comes from the whole vault, not from the slice this run gets through: what
  // counts as a common word does not depend on where the time budget happened to stop.
  const df = documentFrequency(all)
  const files = shuffled(all, args.seed).slice(0, args.docs)
  const deadline = args.minutes > 0 ? Date.now() + args.minutes * 60_000 : Infinity
  let stoppedEarly = false

  const queries: Array<Record<string, unknown>> = []
  const rejects: Array<{ file: string; query: string; reason: string }> = []
  const seen = new Set<string>()
  const counts: Record<string, number> = {
    generate_failed: 0, length: 0, selfref: 0, banned: 0, dupe: 0,
    unverified: 0, verify_failed: 0,
  }
  const reject = (file: string, query: string, reason: string) => {
    counts[reason]++
    if (args.keepRejects) rejects.push({ file, query, reason })
  }

  for (const [i, { rel, text }] of files.entries()) {
    if (Date.now() >= deadline) {
      stoppedEarly = true
      process.stderr.write(`  time budget reached at ${i}/${files.length} docs\n`)
      break
    }
    const { title, text: body } = brief(text)
    if (!title || korean(body) < 40) continue  // not a Korean prose note

    const written = await ask(args.model, writePrompt(title, body, args.perDoc))
    if (!written) { reject(rel, '', 'generate_failed'); continue }

    const banned = bannedTerms(rel, text, df, args.maxDf)
    const candidates: string[] = []
    for (const q of parseQuestions(written)) {
      if (korean(q) < 12 || q.length > 70) { reject(rel, q, 'length'); continue }
      if (SELF_REFERENTIAL.test(q)) { reject(rel, q, 'selfref'); continue }
      if (banned.some((w) => q.toLowerCase().includes(w))) { reject(rel, q, 'banned'); continue }
      if (seen.has(q)) { reject(rel, q, 'dupe'); continue }
      candidates.push(q)
    }
    if (candidates.length === 0) continue

    const verdictRaw = await ask(args.model, verifyPrompt(body, candidates))
    if (!verdictRaw) { for (const q of candidates) reject(rel, q, 'verify_failed'); continue }
    const verdicts = parseVerdicts(verdictRaw, candidates.length)

    for (const [j, q] of candidates.entries()) {
      if (!verdicts[j]) { reject(rel, q, 'unverified'); continue }
      seen.add(q)
      queries.push({
        id: `gen-${String(queries.length + 1).padStart(3, '0')}`,
        query: q, type: 'exact', description: `generated paraphrase of ${rel}`,
        expected_files: [rel], expected_in_top_k: 1,
      })
    }
    if ((i + 1) % 10 === 0) process.stderr.write(`  ${i + 1}/${files.length} docs, ${queries.length} queries\n`)
  }

  writeFileSync(args.out, JSON.stringify({
    description: `generated paraphrase goldset from ${args.vault}`,
    version: '1', generator: 'bench-vault-paraphrase', model: args.model,
    collection: args.collection, queries,
  }, null, 1))
  if (args.keepRejects) writeFileSync(args.keepRejects, JSON.stringify(rejects, null, 1))
  const processed = stoppedEarly ? `stopped early, budget ${args.minutes}m` : 'all'
  console.log(`docs=${files.length} (${processed}) queries=${queries.length} rejected=${JSON.stringify(counts)}`)
}

await main()
