# ko-vault bench baseline (ko-qmd)

- Command: `bash scripts/bench-ko.sh` (raw queries, no expansion)
- Code: branch `feat/hangul-fts` at B1 (no Hangul changes yet — same search code as upstream `2.8.3`)
- Models: `models.yml` → embeddinggemma-300M-Q8_0; rerank/generate defaults (qwen3-reranker-0.6b, qmd-query-expansion-1.7B)
- Fixture: 2nd-brain `e856721` (A4, aliases included), 28 documents indexed (`wiki/**/*.md`), 36 queries

## B1 — baseline (2026-09-16)

```
RESULT bm25_r5=0.6250 vector_r5=0.9861 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9444
RESULT bm25_r5=0.6250 vector_r5=0.9861 hybrid_r5=0.9583 full_r5=1.0000 full_mrr=0.9583
```

Two consecutive runs, same code and models. Per-type recall@5 from the second run (last column is full MRR):

| type | n | bm25 | vector | hybrid | full | full MRR |
|---|---|---|---|---|---|---|
| exact | 7 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| alias | 11 | 0.909 | 1.000 | 1.000 | 1.000 | 1.000 |
| semantic | 11 | 0.273 | 1.000 | 1.000 | 1.000 | 0.909 |
| topical | 4 | 0.625 | 1.000 | 0.875 | 1.000 | 0.875 |
| cross-domain | 3 | 0.000 | 0.833 | 0.667 | 1.000 | 1.000 |

Notes:

- `bm25_r5` matches 2nd-brain A4 (stock global qmd, 0.6250) — the fork reproduces the baseline. BM25 misses 14 of 36; 12 of those return zero results (Korean terms become exact character-sequence phrases).
- `hybrid_r5` and `full_mrr` vary between runs (hybrid 1.0000 vs 0.9583; misses in run 2: top-01, cro-01, cro-02). Compare B2/B3 on `bm25_r5`, which was identical across runs.

## B2 — Q1 Hangul query suffix stripping (2026-09-16)

Plain Hangul terms become `(stem phrase OR original phrase)` (`src/hangul.ts`). Index unchanged.

```
RESULT bm25_r5=0.6528 vector_r5=0.9861 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9583
RESULT bm25_r5=0.6528 vector_r5=0.9861 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9444
```

Per-type recall@5 from the second run (last column is full MRR):

| type | n | bm25 | vector | hybrid | full | full MRR |
|---|---|---|---|---|---|---|
| exact | 7 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| alias | 11 | 0.909 | 1.000 | 1.000 | 1.000 | 0.955 |
| semantic | 11 | 0.364 | 1.000 | 1.000 | 1.000 | 0.909 |
| topical | 4 | 0.625 | 1.000 | 1.000 | 1.000 | 0.875 |
| cross-domain | 3 | 0.000 | 0.833 | 1.000 | 1.000 | 1.000 |

Notes:

- The design §4 particle list alone scored `bm25_r5=0.6250` (no change). Adding the nominalizing ending `기` recovers sem-07 (`나누기` → `나누`): +1 of 36.
- Remaining 13 BM25 misses: every term is ANDed, and one inflected verb (`만드는 방법`, `찾기`, `정리해`, `들었는지`) or a word absent from the expected doc zeroes the query. Suffix stripping cannot fix those.

## B3 — I1 Hangul syllable bigram index (2026-09-16)

Indexed fields append the syllable bigrams of their Hangul runs after the character tokens (`FTS_CJK_NORMALIZED_VERSION` `"2"`). Plain Hangul terms query `(stem bigram OR stem chars OR word bigram OR word chars)`.

```
RESULT bm25_r5=0.6528 vector_r5=0.9861 hybrid_r5=0.9861 full_r5=1.0000 full_mrr=0.9306
RESULT bm25_r5=0.6528 vector_r5=0.9861 hybrid_r5=0.9583 full_r5=1.0000 full_mrr=0.9444
```

Per-type recall@5 from the second run (last column is full MRR):

| type | n | bm25 | vector | hybrid | full | full MRR |
|---|---|---|---|---|---|---|
| exact | 7 | 1.000 | 1.000 | 1.000 | 1.000 | 1.000 |
| alias | 11 | 0.909 | 1.000 | 1.000 | 1.000 | 0.955 |
| semantic | 11 | 0.364 | 1.000 | 1.000 | 1.000 | 0.909 |
| topical | 4 | 0.625 | 1.000 | 0.875 | 1.000 | 0.875 |
| cross-domain | 3 | 0.000 | 0.833 | 0.667 | 1.000 | 1.000 |

Notes:

- Per-query BM25 recall@5 and MRR are identical to B2 on all 36 queries (compared against a same-day B2 run: `bm25_r5=0.6528 hybrid_r5=1.0000 full_mrr=0.9306`). FTS5 `bm25()` scores whole phrases, so a bigram phrase carries about the same IDF as the character phrase it duplicates; bigrams do not change which documents match.
- First attempt queried bigram phrases only: `bm25_r5=0.5972`. sem-05 `하이브리드검색` and sem-06 `간격반복` went to zero results — the documents space the words, and a bigram (`드검`) cannot span two runs the way the character phrase does. Keeping the character phrase in the OR restores them.
- Hybrid misses in run 2 (top-01, cro-01, cro-02) are the same set B1 saw; hybrid still varies run to run.

## Default embedding model (2026-09-16)

`models.yml` now pins the same model the package defaults to (Qwen3-Embedding-0.6B-Q8_0, 1024 dims).
Both rows are one `bash scripts/bench-ko.sh` run on the same tree, same day, macOS arm64:

```
RESULT bm25_r5=0.6528 vector_r5=0.9861 hybrid_r5=0.9722 full_r5=1.0000 full_mrr=0.9444   # embeddinggemma-300M-Q8_0
RESULT bm25_r5=0.6528 vector_r5=1.0000 hybrid_r5=0.9861 full_r5=1.0000 full_mrr=0.9398   # Qwen3-Embedding-0.6B-Q8_0
```

Qwen3 takes vector recall@5 to 1.0000 on this fixture (embeddinggemma misses one query) and hybrid
follows it up by the same query. `full_mrr` moves down 0.0046 — inside the run-to-run spread this
fixture shows for hybrid, so it is not evidence either way. BM25 is untouched, as expected: the
model has no part in the lex path.

## Goldset 36 → 52, endings and particle chains (2026-09-16)

16 harder Korean queries (`ko-01`…`ko-16`): particle chains (`청킹에서의`), verb endings
(`토큰화하는`, `검색하기`), joined compounds (`출처추적`, `하이브리드검색`), compound + particle
(`간격반복으로`). Same run, Qwen3 embeddings, 52 queries:

```
RESULT bm25_r5=0.6635 vector_r5=1.0000 hybrid_r5=0.9904 full_r5=0.9808 full_mrr=0.9551   # before
RESULT bm25_r5=0.7212 vector_r5=1.0000 hybrid_r5=0.9904 full_r5=0.9808 full_mrr=0.9359   # after
```

The change: `hangulStems` strips a verbal/nominalizing ending (하는·하기·된다 …) before particles,
then repeats once, so `청킹에서의` reaches `청킹` and `검색하기` reaches `검색` instead of `검색하`.
`ko-05`, `ko-10`, `ko-11` flip from 0 to 1. Split by subset: the original 36 stay at
`bm25_r5=0.6528` (no regression, same per-query values), the 16 new ones reach `0.8750`.

Still lex-missing by design: every `sem-*`/`cro-*` query (paraphrases with no shared term — vector's
job) plus `ko-13`·`ko-14`, where the shared words are inflected verbs (`더하는` vs `더해`) that stem
stripping does not bridge.

Bench bug found while writing the fixture: a query entry without `expected_in_top_k` made
`limit` NaN in `src/bench/bench.ts`, and every backend returned zero results with no error — the
fixture looked like a total retrieval failure. The field is optional now and falls back to
`expected_files.length`.

### Round 2 — bare 한/된 and the 하/해 contraction

```
RESULT bm25_r5=0.7212 vector_r5=1.0000 hybrid_r5=0.9904 full_r5=0.9808 full_mrr=0.9359   # before
RESULT bm25_r5=0.7404 vector_r5=1.0000 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9173   # after
```

Two lex gaps found by reading the failing AND, not by guessing: `필요한` never met `필요하다` in the
document (bare `한` was not an ending), and `더하는` stemmed to `더하` while the document writes the
contraction `더해`. Stems now include the 하↔해 sibling. `ko-13` flips; hybrid and full reach 1.0000.
The original 36 stay at `bm25_r5=0.6528`; the 16 new ones reach 0.9375.

`ko-14` still misses on lex and always will: the query says `언어`, and the document says `교착어`
without the word `언어` anywhere. That is a vocabulary gap, which is vector's job, not stemming's.
`full_mrr` moved 0.9359 → 0.9173 — rank order inside the top 5, within this fixture's run-to-run
spread.

## Real vaults — script-mixed query terms (2026-09-16)

The synthetic fixture had run out of headroom (hybrid and full both 1.0000), so this round measured
against a real 2nd-brain vault instead: 232 Korean wiki documents in a team vault,
with a 240-query goldset built by `scripts/bench-vault-goldset.mjs` from the vault's own unique
headings and body clauses. The vault is not committed here; regenerate the goldset to reproduce.

```
bash scripts/bench-vault.sh <vault> <goldset.json>
RESULT bm25_r5=0.9042 bm25_r1=0.8375 bm25_mrr=0.8666   # before
RESULT bm25_r5=0.9333 bm25_r1=0.8625 bm25_mrr=0.8937   # after
```

Per bucket, before → after: `head` 0.950 → 0.967, `headp` 0.900 → 0.933, `headjoin` 0.817 → 0.883,
`clause` 0.950 unchanged. Misses 23 → 16.

The failure the misses pointed at was script-mixed terms — `SKILL.md계약의핵심`,
`hook이유일한hardboundary다`, `auto-dream의발화조건`. `hangulTermQuery` returned null for anything
that was not pure Hangul, so the whole glued token was searched as one phrase that appears nowhere,
and the hyphen and dot branches of `buildFTS5Query` kept the Hangul run glued as well. The index
side had always split scripts (`hangulBigramTail` only sees Hangul runs; the porter tokenizer splits
the rest), so only the query side was missing the split. `hangulMixedQuery` now splits a term into
script runs and ANDs them.

Two earlier drafts of this goldset were discarded rather than reported: sampling terms that occur in
exactly one document scored `bm25_r5=1.0000` (any index finds them), and harvesting bare words
produced particle-glued fragments like `진실원이다` that no one would type.

What still misses is not stemming's to fix. Latin compounds written solid in the query but spaced in
the document (`headlesssubagent`, `hardboundary`) need a dictionary to split, and generic two-word
headings (`서비스 구성`, `두 가지 모드`) are ranking, not matching. Three `clause` misses are goldset
artifacts, where a URL split mid-token.

Synthetic fixture after the same change, unchanged within run spread:
`bm25_r5=0.7404 vector_r5=1.0000 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9494`.

### Cross-vault check and what the vector backend actually does here

Same change, same goldset generator, two more real vaults (lex only, after the fix):

| vault | documents | queries | `bm25_r5` |
| --- | --- | --- | --- |
| 2nd-brain knowledge | 232 | 240 | 0.9333 |
| vault-b | 107 | 87 | 0.9770 |
| vault-c | 28 | 65 | 1.0000 |

Only the 232-document vault still separates good from bad. The two small ones sit at the ceiling,
the same way the synthetic fixture did, so they confirm nothing broke but cannot rank anything.

With embeddings on the 232-document vault (`--embed`, Qwen3-Embedding-0.6B, 1512 chunks):

```
RESULT bm25_r5=0.9333 bm25_r1=0.8625 bm25_mrr=0.8937
       vector_r5=0.5875 hybrid_r5=0.9208 full_r5=0.9750 full_mrr=0.8877
```

Hybrid lands *below* bm25 alone — RRF mixes 0.5875-quality vector hits into a lex result that was
already right. Only `full` (hybrid plus rerank) beats lex. This does not say the vector path is
weak in general: every query in this goldset is a verbatim phrase from its document, which is lex's
best case and vector's least useful one. The goldset has no paraphrase queries at all, so the case
vector exists for is unmeasured here. Read this as "on exact-phrase Korean queries, hybrid costs
about a point of recall against lex", not as a verdict on hybrid.

## Long questions and what the vector list is worth (2026-09-16)

Two goldsets on the same 232-document vault, both embedded with Qwen3-Embedding-0.6B:

- **exact**, 240 queries — the vault's own headings and clauses, verbatim (`scripts/bench-vault-goldset.mjs`).
- **paraphrase**, 30 hand-written queries — a person's wording for a document's topic, with the
  document's own distinctive terms kept out. Split by whether any rare word of the query does
  appear in the target: `sem` (16, no lexical anchor) and `mix` (14, one or more).

Neither goldset is committed: the first is regenerable, the second quotes private vault topics.

Measured before this round:

```
exact        bm25 0.9333  vector 0.5875  hybrid 0.9167
paraphrase   bm25 0.0000  vector 0.8000  hybrid 0.8333
```

`bm25 0.0000` on paraphrase is not a vocabulary gap. `buildFTS5Query` joins every term with AND,
so a natural Korean question — a sentence, particles and all — asks for a document containing all
ten of its words and matches nothing at all. Korean makes this worse than English does, because
each particle rides on the word it follows and becomes another required term.

Three changes, each measured:

1. **Relaxed retry.** `searchFTS` re-runs the same terms ORed when the strict AND returns no rows
   at all (three terms minimum — with fewer, OR drops the query rather than loosening it). It can
   only fire where there was nothing to dilute.
2. **Vector lists count half in RRF.** At k=60 a rank-1 vector hit is worth nearly what a rank-1
   lex hit is worth, so on a query whose words are literally in the document the vector list pulled
   weaker candidates past the right answer. Swept 1.0 / 0.5 / 0.25 / 0: exact hybrid 0.9167 →
   0.9542 at 0.5 and below, paraphrase hybrid flat at 0.8333 down to 0.25 and losing at 0 (0.7667).
   0.5 is the point that buys the exact case without spending the semantic one.
3. **Relaxed lists count half again, and never count as a strong signal.** A relaxed list only says
   some of the words appear. Without this, the fallback took over paraphrase queries and hybrid
   `sem` fell 0.750 → 0.625.

Expansion-derived lists moved 1.0 → 0.75 at the same time. Halving the vector lists would otherwise
leave the original query's vector list tied with a lex expansion, and upstream's rule — original
evidence outranks anything the expander invented — would be decided by insertion order instead of
by weight. Measured identical on both goldsets, so it costs nothing.

After:

```
exact        bm25 0.9500  vector 0.5875  hybrid 0.9583
paraphrase   bm25 0.5667  vector 0.8000  hybrid 0.8667
```

Per bucket, paraphrase hybrid: `mix` 0.929 → 1.000, `sem` 0.750 → 0.750. The synthetic fixture
moves with it: `bm25_r5` 0.7404 → 0.9519, because its `sem-*`/`cro-*` paraphrase queries were
failing on the same AND. `full_r5` stays 1.0000; `hybrid_r5` 1.0000 → 0.9904, one query inside a
52-query fixture.

Re-run on 2026-09-17 at `52d95f4` (the `scripts/dogfood.sh` gate reads the newest line of this form;
`full_*` moved within the run-to-run spread noted under B1):

```
RESULT bm25_r5=0.9519 vector_r5=1.0000 hybrid_r5=0.9904 full_r5=0.9808 full_mrr=0.9423
```

`sem` at 0.750 is a hybrid-only number, and re-measuring it per query says most of that gap is
already closed downstream. Per backend on the same 16 queries:

```
sem r@5      bm25 0.250  vector 0.688  hybrid 0.750  full 0.938
```

Four queries miss the hybrid top 5, but three of them — `sem-009`, `sem-010`, `sem-014` — come
back inside the top 5 under `full`, at ranks 3, 2 and 4. For those, hybrid has the right document
in the candidate pool and orders it badly; expansion and reranking fix the order. `qmd query` is
the product path, so they are not failures a retrieval weight should be tuned against.

One query fails everywhere. `sem-004` ("설정 파일에 다 적어놓으면 에이전트가 오히려 산만해진다는 게
무슨 원리인가요") should land on `claude-md-minimalism.md`, and neither `설정 파일` nor `산만`
appears in that document — it says `CLAUDE.md` and talks in context-budget terms from the title
down. The gap is vocabulary, between how a question is asked and how the note is written, and no
RRF weight reaches it. Closing it means giving documents plain-language surface to match against
(a summary field, aliases), which is indexing work, not ranking work.

lex is at 0.250 on this bucket by construction.

## 2026-09-21 — search-path best-chunk sizing follows the script-aware char/token ratio

`chunkDocumentByTokens` and both search-path best-chunk call sites now size chunks with
`estimateCharsPerToken` (harmonic char/token blend, measured ko 1.64 / en 6.08 on
Qwen3-Embedding-0.6B-Q8_0) instead of the fixed 3.0. Attribution pair for the search-path
change, run at `990bbc7` (before) and `9a3c060` (after):

```
RESULT bm25_r5=0.9519 vector_r5=1.0000 hybrid_r5=0.9904 full_r5=1.0000 full_mrr=0.9760   # before
RESULT bm25_r5=0.9519 vector_r5=1.0000 hybrid_r5=0.9904 full_r5=1.0000 full_mrr=0.9760   # after
```

Identical on every metric: Korean rerank chunks get smaller (~1440 vs ~3600 chars target) but
the winning chunk per query is unchanged, so bm25/vector/hybrid/full all hold.

## 2026-09-23 — loanword alias queries (`ali-12`…`ali-22`)

Eleven `alias` queries spell a Latin identifier in Hangul loanword form (`하이브리드 서치` for
`hybrid-search.md`, `디시전 레코드` for `decision-record.md`, …); none of the loanwords appears
in the fixture text, so lex can only reach the target through the Latin form. The fixture grows
from 52 to 63 queries, so the overall `bm25_r5` below is not comparable with earlier rows — the
split is. Before the loanword bridge, run at `c68f63c` + fixture change:

```
RESULT bm25_r5=0.7857 vector_r5=1.0000 hybrid_r5=0.9921 full_r5=1.0000 full_mrr=0.9802   # before
```

| subset | bm25_r5 | vector_r5 | hybrid_r5 | full_r5 |
|---|---|---|---|---|
| original 52 | 0.9519 | 1.0000 | 0.9904 | 1.0000 |
| loanword 11 | 0.0000 | 1.0000 | 1.0000 | 1.0000 |

Every loanword query returns zero lex results: FTS5 ANDs the terms and the Hangul loanword
matches nothing. The vector path already finds all eleven, so the gap is lex-only — it matters
where lex runs alone or carries the fusion (the knowledge-base seam sends raw query as lex + vec,
and the standing miss `리액트 웹 코어` is this shape against a real vault).

After the loanword bridge (`hangulLoanwordForms` in `hangulTermQuery`):

```
RESULT bm25_r5=0.9603 vector_r5=1.0000 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9802   # after
```

| subset | bm25_r5 | vector_r5 | hybrid_r5 | full_r5 |
|---|---|---|---|---|
| original 52 | 0.9519 | 1.0000 | 1.0000 | 1.0000 |
| loanword 11 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |

Per query, bm25 recall@5 and MRR on the original 52 are identical before and after. Four
original queries moved on hybrid MRR or recall (`ali-01`, `ali-06`, `top-01`, `ko-11`), in both
directions; `ali-01` (`inverted index`) has no Hangul and never reaches the bridge, so these are
run-to-run variance from re-embedding, not the change. The loanword table covers every
loanword in these eleven queries by construction — the bench shows the bridge works and does
not disturb the rest, not how much of a real vault's vocabulary the table covers.

A rerun at ship time gave `hybrid_r5=0.9841` with everything else equal: `ko-11` (`검색하기`)
sat at hybrid rank 4 in the run above and at rank 6 here, while its bm25 result did not move.
Hybrid numbers on this fixture wobble by one query between runs; bm25 per query is the stable
regression signal.

```
RESULT bm25_r5=0.9603 vector_r5=1.0000 hybrid_r5=0.9841 full_r5=1.0000 full_mrr=0.9802   # after, rerun
```

## 2026-09-23 — upstream sync (v2.8.3 → main 04e4dbd), pre-sync reference

Run on `develop` `be1d65f` before the first upstream merge; the per-query rows are the reference
the sync slices diff against (bm25 recall@5 + MRR, all 63 queries).

```
RESULT bm25_r5=0.9603 vector_r5=1.0000 hybrid_r5=0.9921 full_r5=1.0000 full_mrr=0.9802   # pre-sync
```

After the last sync merge (`04e4dbd`); the same run held after the metadata (`a6764bc`) and
separator (`bfb0bcc`) merges. bm25 recall@5 and MRR are identical to the pre-sync run on all 63
queries.

```
RESULT bm25_r5=0.9603 vector_r5=1.0000 hybrid_r5=0.9921 full_r5=1.0000 full_mrr=0.9802   # post-sync
```

## 2026-09-24 — near-topic distractors (`distractors/`, 69 docs)

69 decoy documents (23 wiki topics × 3): same domain vocabulary, different concept —
`README.md` here maps every decoy to its shadowed topic. bench-ko now indexes
`{wiki,distractors}/**/*.md` (97 files, `qmd ls` counted). The original 63 queries and the
bench code are unchanged (slice-01 HEAD `2385ca7`), so this is the attribution pair for the
ko-bench-hard work: everything that moves below is distractor pressure, not a code change.

```
RESULT bm25_r5=0.9603 vector_r5=1.0000 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9802   # before
RESULT bm25_r5=0.9603 vector_r5=0.9762 hybrid_r5=0.9683 full_r5=1.0000 full_mrr=0.9794   # after
```

Lex is untouched: bm25_r5 is byte-identical. Vector r@1 falls on three queries, each swapped
for a decoy sharing an ambiguous word in Korean — `sem-08` (후보 문서의 순서 재배치) →
`forward-index.md`, `ko-01` (조사를) → `search-log-analysis.md` (조사: particle vs
investigation), `ali-19` (디시전 레코드) → `id3-tag.md` (레코드: document record vs music
record). Cross-domain queries give up hybrid r@5 ground (`cro-01`, `cro-02` lose half their
tail; `ko-11` drops its vector top-5 entirely) as IR-adjacent decoys crowd in. Reading every
swapped top-1: each is a legitimate near-topic decoy, not corpus noise — the pressure the
hard gate will guard against is real.

The reranker absorbs all of it: full_r5 stays 1.0000, full_mrr dips 0.0008. The dogfood hard
gate rides the hybrid line, which is exactly where the pressure lands. `RESULT-HARD` prints
`n=0` until slice 03 adds hard queries.

## 2026-09-24 — hard queries (`sem-hard` 12 · `multi` 8 · `neg` 10)

Thirty hard queries join the goldset (63 → 93; ids `hsh-*`, `hmu-*`, `hneg-*`). `sem-hard`
rewords the target in everyday Korean with zero title-term overlap (fixture test enforces it,
loanword forms included); `multi` spans 2–3 notes; `neg` names a concept to exclude that is a
`distractors/` decoy. Fixture invariants live in `test/ko-bench-fixture.test.ts`. Bench code
still at slice-01 HEAD — the movement below is fixture-driven, like the 02 pair.

```
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8943 full_r5=0.9480 full_mrr=0.8991
RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5525 full_r1=0.4778 full_mrr=0.7306 n=30
```

| type | n | hybrid_r1 | full_r1 |
|---|---|---|---|
| sem-hard | 12 | 0.5000 | 0.7500 |
| multi | 8 | 0.2917 | 0.4167 |
| neg | 10 | 0.1000 | 0.2000 |

Hard `full_r1` = 0.4778 ≤ 0.90, so no easiest-query replacement (plan checklist). `neg` is the
hardest: at rank 1 the excluded decoy usually wins — exactly the bag-of-words temptation the
type was designed to expose, and the reason the distractor corpus earns its keep. Three hard
queries have full_r5=0 (`hsh-05` ingest, `hneg-04` 검색어 덧붙이기, `hneg-08` 기록 관리): the
everyday wording reaches no gold file even after rerank — headroom for whatever the
knowledge-base side does with these signals. This run is the reference the slice-04 gate
(`check_gate` on `RESULT-HARD`, tolerance from 3 runs) will encode. One same-commit rerun
(the verify pass) gave `hybrid_r1=0.3444 full_r1=0.5111` — ±2 queries of rank-1 movement on
30, consistent with the 2026-09-23 wobble note; the tolerance cannot be a constant.

## 2026-09-24 — hard gate: three-run spread and the tolerance

Three same-commit bench-ko runs (fixture at 93 queries, code unchanged) to size the hard
gate's tolerance:

```
# run 1
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8943 full_r5=0.9480 full_mrr=0.9045
RESULT-HARD hybrid_r1=0.3278 hybrid_mrr=0.5704 full_r1=0.5111 full_mrr=0.7472 n=30
# run 2
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8996 full_r5=0.9588 full_mrr=0.9066
RESULT-HARD hybrid_r1=0.3444 hybrid_mrr=0.5861 full_r1=0.5111 full_mrr=0.7539 n=30
# run 3
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9104 full_r5=0.9480 full_mrr=0.9063
RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5909 full_r1=0.5111 full_mrr=0.7528 n=30
```

Tolerance from these three runs: 0.05.

bm25_r5 and full_r1 are identical across runs — the wobble is all in the vector-fed hybrid
rank 1: 0.3111–0.3444, spread 0.0333 ≈ one query of 30. The tolerance is that spread rounded
up to 0.05: a real regression has to cost ~1.5 queries of rank-1 to trip, re-embedding noise
does not. The gate reads the newest lines (run 3): floor = 0.3111 − 0.05 = 0.2611. The bm25
gate carries no tolerance — three identical values say it needs none.

## 2026-09-24 — hard-gate tolerance revised: the fuller sample (n=8)

Five further same-commit runs surfaced after the three-run spread above (slice-03 verify,
simplify verify, two review verifies, and the third review verify that landed at 0.2278 —
below the 0.05-tolerance floor and would have failed the gate). All eight hard `hybrid_r1`
observations, in order: 0.3111, 0.3444, 0.3278, 0.3444, 0.3111, 0.2944, 0.2944, 0.2278.
True spread is 0.1167 (≈ 3.5 queries of 30), not 0.0333 — the three-run sample undershot the
variance. `full_r1` stayed 0.5111 in every run; all wobble remains vector-fed hybrid rank 1.

Tolerance: 0.12. The gate reads the tolerance from the `tol=` field of the newest `RESULT-HARD`
line, so the reference line (run 3's numbers) carries it:

```
RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5909 full_r1=0.5111 full_mrr=0.7528 n=30 tol=0.12
```

Floor = 0.3111 − 0.12 = 0.1911: a real regression must cost ~3.6 queries of rank-1 to trip,
observed re-embedding noise does not. The three-run derivation stands as recorded above; the
review loop caught the under-sample, this block supersedes it.

## 2026-09-25 — the hard gate moves to `full_r1`

The eight same-commit runs above settle which number to gate on: `hybrid_r1` wobbled over
0.2278–0.3444 (spread 0.1167, ≈ 3.5 queries of 30), and `full_r1` read 0.5111 in all eight. A
hybrid gate has to tolerate that wobble, so its floor (0.3111 − 0.12 = 0.1911) only trips after
about four hard queries lose rank 1. `full_r1` has shown no run-to-run movement, so its
tolerance only needs to absorb what eight runs cannot rule out. 0.034 lets one query's worth of
rank-1 movement pass (1/30 = 0.0333) and trips on the second. Floor = 0.5111 − 0.034 = 0.4771.

The reference line is run 3's numbers; the gate reads `full_r1` and `tol=` from it:

```
RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5909 full_r1=0.5111 full_mrr=0.7528 n=30 tol=0.034
```

Eight runs is still a small sample. If a same-commit run ever lands below the floor, widen `tol=`
on a new reference line; do not edit this one.

## 2026-09-25 — plain-language summary surface A/B

Question: if every document carries three everyday-language question lines, does the hard bucket
improve? The 16-query experiment behind `bench-vault-summarize.ts` (CHANGELOG, bench tooling)
moved BM25 r@5 .250 → .562 and unreranked hybrid .625 → .812, but it had no near-topic decoys and
no negation queries. This A/B reruns the idea on this fixture, decoys included.

Setup (HEAD `02a8e7e`, Apple M3 Max 36 GB):

- Summaries: `bench-vault-summarize.ts` with `gemma3:latest` (4.3B Q4_K_M, ollama) over the
  fixture root. On the first pass, 2 of the 97 indexed documents came back with no usable line
  (`wiki/inverted-index.md`, `wiki/chunking-strategy.md`). Those two got one retry, so all 97 are
  covered, the 69 decoys included — gold documents alone getting a surface would inflate the
  effect. `bench-vault-summary-apply.mjs` at the default max-df 20 kept 291 lines and dropped 0.
- Goldset: the primary A/B uses a "seam" copy of `ko-bench.json` in which every query becomes
  `lex: <q>` + `vec: <q>`. That is the shape REST/MCP callers send (the KB seam puts the same
  sentence in both), and it routes hybrid/full through `structuredSearch` with no LLM query
  expansion. The plain goldset (expansion via `hybridQuery`) ran 1+1 for continuity with the
  lines above.
- Runs: seam before/after interleaved ×3, then plain before/after ×1. The after side ran with
  `KO_CORPUS=tmp/summary-ab/aug/wiki`, and every after run's stderr shows that `corpus=`.

Result lines, prefixed so the dogfood gate never reads them as a baseline. The three seam runs on
each side were byte-identical, so each side is shown once:

```
ab-seam-before-{1,2,3}: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8996 full_r5=0.9480 full_mrr=0.9036
ab-seam-before-{1,2,3}: RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5615 full_r1=0.5111 full_mrr=0.7444 n=30
ab-seam-after-{1,2,3}: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9695 full_mrr=0.9081
ab-seam-after-{1,2,3}: RESULT-HARD hybrid_r1=0.2778 hybrid_mrr=0.5614 full_r1=0.5111 full_mrr=0.7750 n=30
ab-plain-before-1: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9104 full_r5=0.9480 full_mrr=0.9063
ab-plain-before-1: RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5528 full_r1=0.5111 full_mrr=0.7528 n=30
ab-plain-after-1: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9265 full_r5=0.9749 full_mrr=0.9081
ab-plain-after-1: RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5889 full_r1=0.5111 full_mrr=0.7750 n=30
```

Verdict under the rule fixed before the runs (seam goldset, hard 30): **not reproduced**.

| criterion | before → after | bar | met |
|---|---|---|---|
| lex: bm25 hit@5 | 0.667 → 0.700 (+1 query) | +0.10 | no |
| hybrid_r1, mean of 3 | 0.3111 → 0.2778 (−1 query) | +0.12, ranges apart | no |
| full_r1, mean of 3 | 0.5111 → 0.5111 | +0.067 | no |
| easy 63: regression | no backend moved | −2 queries | no regression |

Hard hit@5 per type (seam, identical across runs):

| type | n | bm25 | vector | hybrid | full |
|---|---|---|---|---|---|
| sem-hard | 12 | 0.750 → 0.833 | 0.917 → 0.833 | 0.917 → 0.917 | 0.917 → 1.000 |
| multi | 8 | 0.875 → 0.875 | 0.875 → 0.875 | 0.875 → 1.000 | 1.000 → 1.000 |
| neg | 10 | 0.400 → 0.400 | 0.600 → 0.700 | 0.500 → 0.600 | 0.800 → 0.900 |
| hard | 30 | 0.667 → 0.700 | 0.800 → 0.800 | 0.767 → 0.833 | 0.900 → 0.967 |

The three queries no path reached before: `hsh-05` full rank 6 → 2, `hneg-04` full — → 2 (bm25
— → 4), `hneg-08` still unreached.

Reading: the summaries pull gold documents into the candidate pool — two more hard queries in the
hybrid and full top 5, full_mrr 0.7444 → 0.7750 — but they do not win rank 1. Every decoy got the
same kind of surface, so the rank-1 contest is where it was, and hybrid rank 1 lost a query. An
agent reads rank 1 first. A top-5 gain of 2 of 30 does not pay for the cost below.

Cost: fixture median 1317 ms per document (p90 1671); a 20-document sample of the live KB
(`~/workspace/knowledge-base/docs`) median 1984 ms (p90 2508). At that rate the 1057-document
live corpus takes about 35 minutes per full pass, and generation adds an instruct model to the
dependency set.

Where to generate, if ever: not in `qmd embed`, for the two reasons above. If a vault wants this
surface anyway, it belongs on the authoring side as frontmatter, which is already indexed as body
text and needs no ko-qmd change. Some vaults already have such a field: KB `summary:` in 62 of
652 documents, vault A `aliases:` in 59 of 236, vault B `aliases:` in 2 of 119.

Limits, both in the after side's favour: fixture documents are short (median 666 chars with the
6000-char prompt cap applied, against 1837 on the live corpus, where 85 of 1057 hit the cap), so
three lines weigh more here than they would live. And the summary model and the hard queries both
write everyday Korean. The effect still did not reproduce.

Side finding: each seam run built a fresh index and re-embedded all 97 documents, and the three
runs per side still matched to the last digit. Re-embedding is deterministic here. The
hybrid_r1 wobble recorded above (0.2278–0.3444 over eight plain runs) therefore points at the
plain path's LLM query expansion, not at re-embedding; this was not isolated by a direct test.
The plain 1+1 runs point the same way. Hard rank 1 does not move (hybrid_r1 0.3111 and full_r1
0.5111 on both sides). Hard hit@5 gains one query on hybrid (0.833 → 0.867) and two on full
(0.900 → 0.967), and `hsh-05` and `hneg-04` both reach full rank 2. The plain before-run's
hybrid_mrr, 0.5528, is a fourth distinct value next to the 0.5704 / 0.5861 / 0.5909 recorded above
at earlier commits. The seam form gave 0.5615 three times. That contrast is the same pattern as the
side finding.

Reproduce: `bun scripts/bench-vault-summarize.ts test/fixtures/ko-vault <out.json>`, then
`node scripts/bench-vault-summary-apply.mjs test/fixtures/ko-vault <out.json> <dir>`, then
`KO_CORPUS=<dir>/wiki KO_BENCH=<seam goldset> bash scripts/bench-ko.sh`. ollama output is not
deterministic, so a rerun gets different lines.

## 2026-09-26 — the hybrid wobble is LLM query expansion

Question: does LLM query expansion cause the plain path's hard `hybrid_r1` wobble (0.2278–0.3444
over the eight same-commit runs above)? The 2026-09-25 side finding pointed there without
isolating it. The verdict rule was fixed before the runs:

- (a) With the expansion held fixed, a rerun reproduces every query's hybrid and full top 10.
- (b) Across fresh runs, some query's hybrid or full top 10 moves.
- (c) Every query that moves saw a different expansion.

(a)–(c) together mean confirmed. A failure of (a) means something besides expansion also varies.

Setup (HEAD `3e024d8`, Apple M3 Max 36 GB): the expansion model is `qmd-query-expansion-1.7B`
(q4_k_m), sampled at temperature 0.7 with no seed (`LlamaCpp.expandQuery`). bench-ko rebuilds its
index on every run, so each run starts with an empty `llm_cache` and draws new expansions.

- F1–F3: plain bench-ko runs. P1 and P2 are two earlier plain runs at the same HEAD, from a first
  attempt whose expansion dump failed. They are kept as observations only.
- H1–H3: a probe that calls `hybridQuery` for every goldset query with the options bench's hybrid
  and full backends use, on a fresh index each run. It records the expansion each call used through
  `SearchHooks.onExpand`.
- R1–R2: the same probe on H3's index, with `store.expandQuery` swapped for H3's recorded
  expansions. The expansion is held fixed and nothing else changes.
- S: the seam goldset (`lex: <q>` + `vec: <q>`) through bench-ko.

Method change: the plan was to hold expansions fixed by rerunning `qmd bench` on the same index, so
that the cache would serve them. That does not work. `setCachedResult` trims `llm_cache` to its
newest 1000 rows on 1% of writes, and a bench run writes more than a thousand rerank rows, so a
run's early expansions are gone by the time it ends. F3's cache held 1121 rows, and only 27 of them were
expansions, all written in its last three minutes. The first same-index rerun ended with 25
expansions in its cache, none of them F3's. The probe replaced the rerun; the rule above did not change.

Result lines, prefixed so the dogfood gate never reads them as a baseline:

```
ab-exp-P1: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8996 full_r5=0.9480 full_mrr=0.9081
ab-exp-P1: RESULT-HARD hybrid_r1=0.3278 hybrid_mrr=0.5856 full_r1=0.5111 full_mrr=0.7583 n=30
ab-exp-P2: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8943 full_r5=0.9480 full_mrr=0.9060
ab-exp-P2: RESULT-HARD hybrid_r1=0.3611 hybrid_mrr=0.5742 full_r1=0.5111 full_mrr=0.7520 n=30
ab-exp-F1: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8943 full_r5=0.9588 full_mrr=0.9010
ab-exp-F1: RESULT-HARD hybrid_r1=0.2611 hybrid_mrr=0.5108 full_r1=0.4778 full_mrr=0.7364 n=30
ab-exp-F2: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9158 full_r5=0.9588 full_mrr=0.9072
ab-exp-F2: RESULT-HARD hybrid_r1=0.2778 hybrid_mrr=0.5789 full_r1=0.5111 full_mrr=0.7556 n=30
ab-exp-F3: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9050 full_r5=0.9480 full_mrr=0.9045
ab-exp-F3: RESULT-HARD hybrid_r1=0.3611 hybrid_mrr=0.5939 full_r1=0.5111 full_mrr=0.7472 n=30
ab-exp-S: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8996 full_r5=0.9480 full_mrr=0.9036
ab-exp-S: RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5615 full_r1=0.5111 full_mrr=0.7444 n=30
```

Probe, hard 30:

| run | hybrid_r1 | full_r1 | hybrid latency p50 / p90 |
|---|---|---|---|
| H1 | 0.4111 | 0.5111 | 1083 / 5638 ms |
| H2 | 0.3278 | 0.5111 | 1029 / 6336 ms |
| H3 | 0.2444 | 0.5111 | 1094 / 6212 ms |
| R1 (H3's expansions) | 0.2444 | 0.5111 | 96 / 175 ms |
| R2 (H3's expansions) | 0.2444 | 0.5111 | 98 / 175 ms |

Verdict: **confirmed**.

- (a) R1 and R2 match H3 on every query's hybrid and full top 10, with 0 differences.
- (b) 81 of 93 queries changed their hybrid or full top 10 across H1–H3.
- (c) All 81 saw a different expansion across the three runs; none moved with the same one. The
  10 queries that were never expanded all moved zero times: `ali-04 ali-05 sem-03 sem-06 sem-07
  top-01 top-03 top-04 ko-13 ali-15`, the hook saw an empty expansion every time,
  which is the shape of the strong-signal bypass.
- Rule S: S matches `ab-seam-before-{1,2,3}` byte for byte. The seam form gave the same two lines
  in three runs at `02a8e7e` and again at `3e024d8`.

Per type, hybrid_r1 swings in every hard bucket (H1 / H2 / H3): sem-hard 0.5833 / 0.5000 /
0.3333, multi 0.4167 / 0.3542 / 0.2917, neg 0.2000 / 0.1000 / 0.1000. full_r1 held sem-hard
0.8333, multi 0.4167 and neg 0.2000 in all three runs.

What the expansion writes for Korean: over H1–H3, the 85 Hangul queries got 889 expansion lines.
283 of them carry an English word the question does not have, 12 carry Han or kana, and 259 of the
275 `hyde` lines are English sentence templates with the Korean question pasted in. Samples:

- `hneg-04` 오타 교정 말고 검색어에 알맹이 덧붙이기, H1: `hyde: Understanding 오타 교정 말고
  검색어에 알맹이 덧붙이기 is essential for modern development. …`
- `hsh-05` 새 글이 들어와서 검색이 가능해질 때까지 거치는 일련의 단계, H2: the `hyde` line
  repeats `任何问题都可以通过这个设置来解决, 确保遵循最佳实践.` until the token limit.
- `hmu-01` 하이브리드 검색에서 두 점수를 합치는 법과 그걸 평가하는 법, H3: `lex: 빅데이터 기반 하이브리드
  검색의`. The question never mentions 빅데이터.

Cost: expansion is most of the plain hybrid latency. The p50 is about 1.0–1.1 s with expansion and
96 ms with the expansion supplied (R1/R2). The p90 of 5.6–6.3 s comes from `hyde` lines that run
to the token limit.

This corrects two readings above; the sections themselves are left as written. The hybrid wobble
the 2026-09-24 sections call re-embedding noise is query expansion, and the seam form, which has
no expansion, repeats exactly. `full_r1` is not immune either. F1 read 0.4778, which is 0.0007
above the plain gate's floor (0.5111 − 0.034 = 0.4771); P1, P2, F2 and F3 read 0.5111. The next
section moves the gate to the seam form.

Reproduce: plain runs are `bash scripts/bench-ko.sh` at this commit. The seam run is
`KO_BENCH=<seam copy of ko-bench.json> bash scripts/bench-ko.sh`. The probe is not committed. It
is about 70 lines over `createStore` + `hybridQuery` with `hooks.onExpand`, and a replay mode that
assigns `store.internal.expandQuery = async () => <recorded>` before each call.

## 2026-09-26 — the gate moves to the seam form

The section above shows that the plain form's hard numbers are partly a draw from the expansion
sampler: hybrid_r1 by up to five queries, and full_r1 once by one. A gate on the plain form either
tolerates that draw or fails on it. The seam form, where every query is `lex: <q>` + `vec: <q>`,
has no expansion. It is the shape REST/MCP callers send, and it gave the same two lines in all five
runs recorded here: three at `02a8e7e`, one at `3e024d8`, and the reference below, run with this
branch's `bench-ko.sh`.

So `bench-ko.sh` now benches the seam form by default and ends its RESULT-HARD line with
`form=<seam|plain>`, while `KO_FORM=plain` keeps the old path. The dogfood gate refuses a bench
whose form differs from the baseline line's form, where a line without `form=` counts as plain. On
the seam form it gates hard `hybrid_r1` next to `full_r1`. `hybrid_r1` is the `rerank:false` path,
the one the gate could not watch before.

Reference, from the default bench-ko run on this branch. It is `ab-exp-S` above plus
`tol=0 form=seam`:

```
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8996 full_r5=0.9480 full_mrr=0.9036
RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5615 full_r1=0.5111 full_mrr=0.7444 n=30 tol=0 form=seam
```

The tolerance is 0, so losing a single hard query at rank 1, on hybrid or full, stops the deploy. A
same-commit run that differs from this line would itself be a finding, because the seam form has
repeated exactly so far. A dependency or model bump that moves the numbers gets a new reference line
with the reason next to it; this one is not edited. The plain path, which is CLI `qmd query` with a
plain question, is no longer gated. Changes to it are measured by hand with `KO_FORM=plain`.

## 2026-09-26 — a Hangul query skips LLM expansion

`hybridQuery` now leaves a query with any Hangul unexpanded, and treats it the same way as a
strong-signal bypass. The keep rule was fixed before the runs. F1–F3 above are the with-expansion
side, and X1 is the plain bench with the skip. Keep only if all three hold:

- X1's hard `hybrid_r1` ≥ mean(F) − 0.034.
- X1's hard `full_r1` ≥ min(F) − 0.034.
- X1's easy hit@5, hybrid and full each, ≥ min(F) − 1 query.

Anything else meant dropping the change. X2 repeats X1. V is the seam bench, run to show that the
real-use path is untouched.

```
ab-exp-X1: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9480 full_mrr=0.9045
ab-exp-X1: RESULT-HARD hybrid_r1=0.3778 hybrid_mrr=0.6001 full_r1=0.5111 full_mrr=0.7472 n=30 form=plain
ab-exp-X2: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9480 full_mrr=0.9045
ab-exp-X2: RESULT-HARD hybrid_r1=0.3778 hybrid_mrr=0.6001 full_r1=0.5111 full_mrr=0.7472 n=30 form=plain
ab-exp-V: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.8996 full_r5=0.9480 full_mrr=0.9036
ab-exp-V: RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5615 full_r1=0.5111 full_mrr=0.7444 n=30 form=seam
```

| | F1 / F2 / F3 (expansion) | X1 (Hangul skip) |
|---|---|---|
| hard hybrid_r1 | 0.2611 / 0.2778 / 0.3611 (mean 0.3000) | 0.3778 |
| hard full_r1 | 0.4778 / 0.5111 / 0.5111 | 0.5111 |
| easy hit@5 hybrid | 62 / 62 / 62 of 63 | 63 |
| easy hit@5 full | 63 / 63 / 63 of 63 | 63 |
| hybrid latency p50 | 1205 / 1067 / 1000 ms | 20 ms |

Verdict: **keep**. All three conditions hold: 0.3778 ≥ 0.2660, 0.5111 ≥ 0.4438, and hit@5 of 63
and 63 against floors of 61 and 62.

By type, X1's hard hybrid_r1 is sem-hard 0.5833, multi 0.2917 and neg 0.2000, against F's ranges
of 0.3333–0.5833, 0.3542–0.4167 and 0.0000–0.1000. `multi` is the one bucket below F's range. Its
answers span 2–3 notes; why it lost ground was not isolated.
full_r1 per type is sem-hard 0.8333, multi 0.4167 and neg 0.2000, the same values as F2 and F3.

X2 gave X1's lines exactly. Per query, the top 10 of all 85 Hangul queries matched between the two
runs. The 9 cells that differed all belong to English-only queries, which still expand: `ali-01`,
`ali-02`, `ali-03`, `ali-08`, `ali-09` and `ali-11`. V is byte-identical to the run behind the seam
reference line two sections up, so that line stands.

With neither side expanding, the plain path now leads the seam form on hard hybrid_r1, 0.3778
against 0.3111. The two differ in how they weight a relaxed (any-word) FTS list:
`getHybridRrfWeights` halves it and `structuredSearch` does not. Whether that difference causes
the gap is not tested here.

## 2026-09-27 — structuredSearch halves a relaxed lex list

The section above left one question open: does the relaxed-list weight cause the plain path's
hard `hybrid_r1` lead (0.3778 against the seam form's 0.3111)? A probe on a copy of the seam
reference run's index answered it before any code changed. For each of the 85 Hangul queries it
ran `hybridQuery` and `structuredSearch` (`lex: q` + `vec: q`), both with `skipRerank` as bench's
hybrid backend does. It then rebuilt the fused lists from the explain trace and re-fused them with
each path's weights. The re-fused top 10 matched each path's own top 10 for 85 of 85 queries, so
the weights are the whole difference. All 30 hard queries and 41 of the 85 fell back to the relaxed
retry. Rank 1 differed on 3 queries, all of them relaxed:

| query | plain (relaxed list 1.0) | seam (first list 2.0) | expected |
|---|---|---|---|
| `hsh-03` | `wiki/bm25-ranking.md` | `distractors/tf-idf.md` | `wiki/bm25-ranking.md` |
| `hsh-11` | `wiki/spaced-repetition.md` | `distractors/fine-tuning.md` | `wiki/spaced-repetition.md` |
| `hneg-09` | `distractors/book-notes.md` | `distractors/cornell-notes.md` | `wiki/zettelkasten.md` |

In both `hsh` rows the seam form put a decoy on the question's topic at rank 1, and halving the
relaxed list gave rank 1 to the expected note. The probe did not record each list's own ranking.
No query ranked better on the seam form.

`structuredSearch` now weights its lists through `getStructuredRrfWeights`: the first list 2.0 and
the rest 1.0, times `RELAXED_LIST_WEIGHT` (0.5) for a relaxed FTS list. The vector weight is
unchanged; `VEC_LIST_WEIGHT` stays specific to `hybridQuery`.

Rule W was fixed before the run, against the seam reference line above. The seam form is
deterministic, so one run decides:

- W0 (precondition): `bm25_r5` = 0.8459 and `vector_r5` = 0.9050. Neither goes through RRF.
- W1: hard `hybrid_r1` > 0.3111.
- W2: hard `full_r1` ≥ 0.5111.
- W3: `hybrid_r5` ≥ 0.8996, `full_r5` ≥ 0.9480, `full_mrr` ≥ 0.9036, hard `hybrid_mrr` ≥ 0.5615,
  hard `full_mrr` ≥ 0.7444.

Keep if all hold. The prediction was hard `hybrid_r1` = 0.3778, with every Hangul query's rank 1
equal to the plain path's. It was not part of the rule.

```
ab-exp-W: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9480 full_mrr=0.9045
ab-exp-W: RESULT-HARD hybrid_r1=0.3778 hybrid_mrr=0.6001 full_r1=0.5111 full_mrr=0.7472 n=30 form=seam
```

Verdict: **keep**. W0 holds. W1 is 0.3778, W2 is 0.5111, and every W3 value rose or held:
`hybrid_r5` 0.8996 → 0.9211, `full_mrr` 0.9036 → 0.9045, hard `hybrid_mrr` 0.5615 → 0.6001 and
hard `full_mrr` 0.7444 → 0.7472. The prediction held: rank 1 of all 85 Hangul queries equals the
plain path's from the probe.

The seam reference moves to this run. The gate reads the last two lines below:

RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9480 full_mrr=0.9045
RESULT-HARD hybrid_r1=0.3778 hybrid_mrr=0.6001 full_r1=0.5111 full_mrr=0.7472 n=30 tol=0 form=seam

Reproduce: `bash scripts/bench-ko.sh` at this commit. The probe is not committed. It calls
`hybridQuery` with `explain: true` and `structuredSearch` for each Hangul query, and passes the
per-list ranks from the explain contributions to `reciprocalRankFusion` under both weight rules.

## 2026-09-27 — a Korean negation clause is stripped before search

All ten `neg` queries read "X 말고 Y", and X is usually a decoy from `distractors/`. Until now every
list and the reranker searched for X as well, and in most of those queries the excluded decoy took
rank 1. `stripHangulNegation` (`src/hangul.ts`) now keeps only the text after the last whitespace-
delimited 말고, 빼고, 제외하고 or 제외한 marker. `hybridQuery` rewrites its query once. `structuredSearch`
rewrites `lex` and `vec` lines, which also changes the rerank query taken from them. `hyde` lines
and `intent` stay as written. `아닌` and bare `제외` are not markers, because they also state
conditions ("캐시가 아닌 경우") or act as nouns ("검색 제외 설정").

The seam reference is the 2026-09-27 run above. On it, the `neg` bucket (10 queries) has full MRR
0.4500 and hybrid MRR 0.3344.

Rule N was fixed before the run. The seam form is deterministic, so one run decides:

- N0 (precondition): `bm25_r5` = 0.8459 and `vector_r5` = 0.9050. The bench bm25 and vector
  backends call the searches directly and are not rewritten.
- N1: `neg` full MRR > 0.4500.
- N2: every query outside `neg` has the same `top_files` on all four backends as the reference
  run. This shows that the parser never fires outside `neg`.
- N3: hard `full_mrr` ≥ 0.7472.

Keep if all hold.

```
ab-neg-N: RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9588 full_mrr=0.9308
ab-neg-N: RESULT-HARD hybrid_r1=0.4111 hybrid_mrr=0.6356 full_r1=0.6111 full_mrr=0.8287 n=30 form=seam
```

Verdict: **keep**. N0 holds. N1: `neg` full MRR goes 0.4500 → 0.6944, and hybrid MRR goes
0.3344 → 0.4408. N2: none of the 83 queries outside `neg` changed `top_files` on any backend.
N3: hard `full_mrr` goes 0.7472 → 0.8287, and hard `full_r1` goes 0.5111 → 0.6111.

Per `neg` query, MRR before → after:

| query | hybrid | full |
|---|---|---|
| `hneg-01` | 0.333 → 0.125 | 0.5 → 0.5 |
| `hneg-02` | 0.2 → 0.5 | 0.5 → 1 |
| `hneg-03` | 0.111 → 1 | 0.333 → 1 |
| `hneg-04` | 0 → 0.2 | 0 → 0.333 |
| `hneg-05` | 0.25 → 0.25 | 0.333 → 0.5 |
| `hneg-06` | 1 → 1 | 1 → 1 |
| `hneg-07` | 0.25 → 0 | 0.333 → 0.5 |
| `hneg-08` | 0 → 0 | 0 → 0.111 |
| `hneg-09` | 0.2 → 0.333 | 1 → 1 |
| `hneg-10` | 1 → 1 | 0.5 → 1 |

No query ranked worse after rerank. Two queries, `hneg-01` and `hneg-07`, ranked worse before
rerank. This run does not show why. `hneg-04` and `hneg-08`, which had no hit in either backend
before, now have one after rerank.

The plain form (`KO_FORM=plain`, `hybridQuery`) gave the same two lines as the seam form in one run.
The Hangul query skips expansion, so both forms search the same text.

The seam reference moves to this run. The gate reads the last two lines below:

RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9588 full_mrr=0.9308
RESULT-HARD hybrid_r1=0.4111 hybrid_mrr=0.6356 full_r1=0.6111 full_mrr=0.8287 n=30 tol=0 form=seam

Reproduce: `bash scripts/bench-ko.sh` at this commit. The per-query diff against the reference
run's `tmp/bench-ko/bench.json` is not committed.

## 2026-09-28 — rerank-input autoresearch: the keep rule, written before the loop

An autonomous loop (`scripts/autoresearch/program.md`) edits only `src/rerank-input.ts` and keeps a
commit when `train_full_mrr` rises on a generated train goldset. The goldset is paraphrased from a
private team vault by `scripts/autoresearch/prepare.sh` and stays outside git. It holds 190 kept
queries from 140 documents. A seeded split by answer document gives 151 train and 39 held-out
queries. Review dropped 11 answer keys (4 train, 7 held-out) as wrong or too generic, leaving 147
train and 32 held-out.

Reference, taken at `fa5ae77` with `bash scripts/autoresearch/eval.sh --baseline`:

| set | queries | `full_mrr` | eval seconds |
|---|---|---|---|
| train | 147 | 0.7132 | 33 (rerank cache warm) |
| held-out | 32 | 0.6589 | 500 (cold) |

The loop's best commit is adopted only if it passes every check below. If it misses one, nothing
is adopted:

1. held-out `full_mrr` ≥ 0.6589
2. ko-vault seam `full_mrr` ≥ 0.9308 and hard `full_mrr` ≥ 0.8287 (`bash scripts/bench-ko.sh`)
3. bm25, vector and hybrid `top_files` identical to the reference on held-out (eval.sh
   `INVARIANT`) and on ko-vault

Train gains alone never count: the loop saw train, so only held-out and ko-vault can show that a
gain generalizes.

### Result (2026-09-28): adopted

The loop ran 28 experiments in two hours. It kept 5, discarded 23 and had no crashes. Its best
commit raised train `full_mrr` from 0.7132 to 0.7295. The gates were measured on that commit,
with only `src/rerank-input.ts` changed:

| check | reference | loop best | pass |
|---|---|---|---|
| held-out `full_mrr` (32) | 0.6589 | 0.7260 | yes |
| ko-vault seam `full_mrr` | 0.9308 | 0.9308 | yes |
| ko-vault hard `full_mrr` | 0.8287 | 0.8287 | yes |
| held-out bm25/vector/hybrid `top_files` | — | same | yes |
| ko-vault bm25/vector/hybrid r@5 | 0.8459 / 0.9050 / 0.9211 | same | yes (by construction) |

bm25, vector and rerank-less hybrid never read `src/rerank-input.ts`, so their ko-vault `top_files`
cannot change; this run compared the r@5 averages, not the per-query lists. The ko-vault lines
match the reference exactly:

RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9588 full_mrr=0.9308
RESULT-HARD hybrid_r1=0.4111 hybrid_mrr=0.6356 full_r1=0.6111 full_mrr=0.8287 n=30 tol=0 form=seam

The gain on held-out (+0.067) is larger than on train (+0.016). Held-out has 32 queries, so a few
queries moving one rank account for most of it. The loop also found that nearly identical variants
scored 0.001–0.01 lower on train, so the finer weights (ASCII ×2, three-syllable minimum) are tuned
to this goldset. The adopted rules:

- chunk selection counts query Hangul syllable bigrams, taken only from Hangul runs of three or
  more syllables, plus two points per query word with no Hangul longer than two characters. Intent words
  add one point, raised from 0.5 after review so intent keeps half a query word's weight (no
  goldset carries intent, so this moves no number).
- the document text is the chunk, led by `# <title>` when the chunk lacks the title.

The loop also found two limits:

- Any change that rewrites every (query, chunk) pair runs cold and takes 20–40 minutes per eval.
  Stripping frontmatter from the text sent to the reranker and adding the display path both ran
  out of the eval budget and were never measured.
- Removing the title lead from the final version drops train to 0.7227, so the title lead is worth
  about 0.007 on its own.

## 2026-09-29 — rerank-input autoresearch, second loop: the first chunk's head start

The goldset grew to 399 corpus documents (wiki plus three sibling folders of the same private
vault) and 545 generated queries. Review dropped 154 more: questions whose answer was a run log, a
weekly report or a lint report (several documents answer them equally), two whose answer held pay
data, and seven too generic to have one answer. That leaves 320 train and 71 held-out queries. The
first loop's split is unchanged; the new documents were split on their own.

The keep rule was the first loop's, restated against the new reference after the loop ran rather
than before it: held-out `full_mrr` at or above the reference, ko-vault lines unchanged, and
bm25/vector/hybrid `top_files` identical.

| check | reference (`d418abc`) | loop best | pass |
|---|---|---|---|
| train `full_mrr` (320) | 0.6589 | 0.7004 | — |
| held-out `full_mrr` (71) | 0.7291 | 0.7459 | yes |
| ko-vault seam / hard `full_mrr` | 0.9308 / 0.8287 | same | yes |
| held-out bm25/vector/hybrid `top_files` | — | same | yes |

RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9588 full_mrr=0.9308
RESULT-HARD hybrid_r1=0.4111 hybrid_mrr=0.6356 full_r1=0.6111 full_mrr=0.8287 n=30 tol=0 form=seam

The loop ran 32 experiments (16 kept, 16 discarded). A head start for the first chunk rose
steadily: +1 0.6751, +2 0.6829, +4 0.6954, +8 0.6996, +16 0.7004, and +32 tied +16. Under it,
four earlier gains (a question-wording stoplist, a densest-window score, and two trigram bonuses)
no longer moved train and were removed. Held-out rose by 0.017 against train's 0.042.

The loop turned the head start off whenever intent was given, so intent words could still pick a
later chunk. Review changed that to half the head start (8): a single intent word would otherwise
switch the rule off entirely. No goldset carries intent, so this moves no number.

## 2026-10-09 — a relaxed first lex list forfeits the positional boost

`getStructuredRrfWeights` gave the first list 2.0 and halved a relaxed list to 1.0 — the same
weight as the vector list. A probe over the seam reference run's per-list ranks showed that is
still a tie a decoy wins: `hmu-05` has the decoy at lex r1 + vec r2 against the expected note at
lex r4 + vec r1, which fuses to 0.0743 vs 0.0742 once the top-rank bonus lands on both. A relaxed
first list now counts 0.25; non-first relaxed lists still count half, `getHybridRrfWeights` is
untouched, and the `hybridQuery` (plain) path measures byte-identical to its old lines below.

Rule R was fixed before the run (seam form, one run decides — deterministic):

- R0: `bm25_r5` = 0.8459 and `vector_r5` = 0.9050 (neither goes through RRF).
- R1: hard `hybrid_r1` > 0.4111.
- R2: hard `full_r1` ≥ 0.6111 and every easy recall@5 line holds.
- R3: `bm25` per-query recall@5·MRR identical (the lex path is untouched).

Keep if all hold. Against a stashed-base rerun for the per-query diff:

```
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9588 full_mrr=0.9309
RESULT-HARD hybrid_r1=0.4444 hybrid_mrr=0.6773 full_r1=0.6111 full_mrr=0.8292 n=30 tol=0 form=seam
```

Verdict: **keep**. R0 holds. R1 is 0.4444 (`hmu-03`, `hmu-05` take hybrid rank 1). R2 holds and hard
`full_mrr` rises 0.8287 → 0.8292. R3 holds: no `bm25` or `vector` top_files moved on any of the 93
queries — the 41 moved queries move on `hybrid`/`full` only, and all movement is at rank 2 or
below except three rank-1 flips: `hmu-03` and `hmu-05` from decoy to expected, and `sem-08` from
expected to decoy (its relaxed lex rank 1 is the correct note, the one case the blunter weight
punishes; its `full` rank 1 and every recall@5 line hold). Per-bucket `neg` numbers against the
stashed-base rerun: `neg` full MRR 0.6944 → 0.6958, `neg` hybrid MRR 0.4408 → 0.4560; `hneg-01`
hybrid MRR 0.125 → 0.143 (rank 8 → 7), `hneg-07` hybrid unchanged at 0.000 (both lists agree on
the decoy — see the 2026-10-09 probe note). The loanword additions in the same branch
(`지연` → `latency` et al.) move nothing: no bench query uses the new words.

The plain form (`KO_FORM=plain`, reference only since the gate moved to seam) at the same commit:

```
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9588 full_mrr=0.9308
RESULT-HARD hybrid_r1=0.4111 hybrid_mrr=0.6356 full_r1=0.6111 full_mrr=0.8287 n=30 form=plain
```

## 2026-10-09 — adaptivity probe: no pre-rerank signal separates the tied pairs (no change)

Two open items from the C+A branch asked whether anything before rerank can do better. Both
answered no, with numbers. Nothing below changes a weight, a stem or the table.

**sem-08 vs hmu-05 (adaptive routing?).** `hmu-05` wants the vector rank 1 to win ties, `sem-08`
wants the lex rank 1 to win them, and both are relaxed-first fusions. Candidate signal: the lex
top1-vs-runnerup BM25 margin. Measured over all 30 hard queries' stripped lex lists
(`tmp/probe-ca/probe3.ts`, read-only over the bench index): every relaxed list scores its top at
0.89–0.98 with a runner-up gap of 0.000–0.030. The two cases sit inside the same noise —
`sem-08` (lex right) 0.965 vs 0.951, gap 0.014; `hmu-05` (lex wrong) 0.954 vs 0.948, gap 0.006 —
so no threshold separates "lex is right" from "lex is wrong". List agreement does not separate
them either: both pairs split the two lists the same way, mirrored. The only asymmetry is
document content, which is what the reranker already reads: `full` rank 1 holds on both queries.
Static — or margin-adaptive — pre-rerank fusion cannot split a mirrored tie; stop tuning there.

**hneg-07 (vocabulary gap).** Its kept clause shares zero content words with the expected note
(every word lands only in the decoy), both lists agree on the decoy at rank 1, and the expected
note sits at vec rank 3. No query rewrite reaches a document with no shared surface; the in-scope
fixes are exhausted (expansion stays off for Hangul, index-time summaries were rejected
2026-09-25, a bigger embedding model is a separate A/B). The reranker already carries it to
`full` rank 2. Left open.

Follow-up with a real signal, not taken here: weight a relaxed list by per-document term
coverage (how many of the query's words each document actually matched) instead of one global
constant. That needs match counts out of FTS per candidate — new retrieval machinery, designed
and benched on its own, not a constant tweak inside this branch.

The seam reference moves to the R run above. The gate reads the last two lines below:

RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9588 full_mrr=0.9309
RESULT-HARD hybrid_r1=0.4444 hybrid_mrr=0.6773 full_r1=0.6111 full_mrr=0.8292 n=30 tol=0 form=seam

## 2026-10-10 — per-document coverage on relaxed lists + rerank cascade

Two changes in one branch (`feat/coverage-cascade`), benched together on the seam
form (one run — deterministic):

1. A relaxed lex list scales each document by `0.5 + 0.5 × coverage`
   (`relaxedDocCoverage` in `src/store.ts`, units mirror the rerank chunk scorer).
   No new FTS machinery: coverage is a substring check of query units against the
   candidate body, computed only for relaxed lists.
2. Rerank cascades: the RRF head (15) is scored first; the tail is skipped
   (score 0) when the head's top-2 margin reaches 0.08, else everything is
   scored as before. Deadlines and cache semantics unchanged.

Attribution: the `hybrid` backend skips rerank, so its movement is coverage
alone; `full` carries both.

```
RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9695 full_mrr=0.9314
RESULT-HARD hybrid_r1=0.4778 hybrid_mrr=0.6948 full_r1=0.6111 full_mrr=0.8306 n=30 tol=0 form=seam
```

Verdict: **keep**. `bm25`/`vector` untouched (neither goes through RRF).
Hard `hybrid_r1` 0.4444 → 0.4778 (+1 query): `hmu-05` hybrid rank 1 is now the
expected `zettelkasten.md`, and `sem-08` keeps hybrid rank 1 on the expected
`cross-encoder-reranking.md` — the mirrored tie the 2026-10-09 probe left open
splits the right way on both sides. Hard `full_r1` holds at 0.6111 and easy
`full_r5` gains one (0.9588 → 0.9695), so the cascade's skipped tails cost
nothing on this fixture. Cascade latency itself is not in this number
(`candidateLimit` 40 interactive path only); measure it against the query-log
`stages.rerank` p90 before tuning the 15 / 0.08 constants.

The seam reference moves to this run. The gate reads the last two lines below:

RESULT bm25_r5=0.8459 vector_r5=0.9050 hybrid_r5=0.9211 full_r5=0.9695 full_mrr=0.9314
RESULT-HARD hybrid_r1=0.4778 hybrid_mrr=0.6948 full_r1=0.6111 full_mrr=0.8306 n=30 tol=0 form=seam

## 2026-10-10 — cascade latency probe (no gate change)

`tmp/probe-cascade.ts` (uncommitted): two fresh ko-vault indexes, the 30 hard
seam queries through `structuredSearch` with `candidateLimit: 40`, first query
dropped (model load), rerank stage ms per query, cascade on vs
`QMD_RERANK_CASCADE=0`:

| | p50 | p90 | mean | docs scored (mean) | skipped |
|---|---|---|---|---|---|
| cascade on | 1436 ms | 3057 ms | 2053 ms | 22 | 16/29 |
| cascade off | 2985 ms | 3330 ms | 2938 ms | 31 | — |

Top-1 agreement 29/29: the skipped tails change no answer on this set. The
p50 halves while the p90 barely moves — contested heads still score all 40,
so the 15 / 0.08 constants buy the median, not the tail. A p90-motivated
tuning would need a tighter gate or a smaller first batch, measured the same
way. Quality lines are untouched by this probe (same commit, switch only).

## 2026-10-10 — goldset 93 → 123 (easy 15 + hard 15, no new measurement yet)

Fixture-only change: `ko-bench.json` grows from 93 to 123 queries without touching
`wiki/` or `distractors/` (97 documents indexed, unchanged).

- easy 15: exact 5 (`exa-08`…`exa-12`: wikilink · reranking · ingest · append-only ·
  topic-map, low-coverage topics), alias 4 (`ali-23`…`ali-26`: lint · meeting notes ·
  append-only · cross encoder), semantic 3 (`sem-12`…`sem-14`: lint · ingest · wikilink
  paraphrases), topical 2 (`top-05`·`top-06`: first coverage of
  `wiki/topics/knowledge-operations.md` and `wiki/topics/information-retrieval.md`),
  cross-domain 1 (`cro-04`: append-only + provenance).
- hard 15: sem-hard 5 (`hsh-13`…`hsh-17`: decision-record · frontmatter-metadata ·
  golden-dataset · cross-encoder-reranking · lint-automation; fixture test enforces zero
  title-term overlap), multi 5 (`hmu-09`…`hmu-13`: all novel pairs), neg 5
  (`hneg-11`…`hneg-15`: checksum · unit-test · autocomplete · citation-network ·
  fine-tuning exclusions, all previously unused distractors).
- New distribution: exact 24 / alias 28 / semantic 14 / topical 8 / cross-domain 4 /
  sem-hard 17 / multi 13 / neg 15; hard n=45.

No RESULT lines below on purpose: the dogfood gate reads the newest RESULT-HARD line,
which stays the n=30 seam reference above until a full `bash scripts/bench-ko.sh` run
on this fixture records replacement lines. Fast checks done here: `ko-bench-fixture`
invariants, `bench-ko.sh` KO_CORPUS/KO_BENCH/KO_FORM validation, goldset JSON shape.

## 2026-10-10 — goldset 123 first measurement (hard n=45), new seam reference

First full `bash scripts/bench-ko.sh` run on the 123-query fixture, defaults
(fixture corpus, fixture goldset, seam form; stderr `corpus=…/ko-vault`,
`bench=…/ko-bench.json`, `form=seam`). Fresh index, 97 documents, Qwen3-Embedding-0.6B
embeddings, rerank. Distribution: exact 24 / alias 28 / semantic 14 / topical 8 /
cross-domain 4 / sem-hard 17 / multi 13 / neg 15.

Against the n=30 seam reference above: `bm25_r5` 0.8459 → 0.8428 (−1 query of 123),
`vector_r5` 0.9050 → 0.8794. The vector drift is the new hard queries, not a
regression: every old-query vector miss is a standing one (`ko-11`, `hsh-02`,
`hneg-02`, `hneg-04`, `hneg-08`, `hmu-07`), while the new misses are new hard ids
(`hsh-16`, `hmu-09`, `hmu-12`, `hneg-13`, `hneg-15` vector r5=0). Per type, easy
stays at ceiling (alias/semantic/topical hybrid r5 = 1.0, exact 1.0); hard
`full_r1` 0.6111 → 0.5963 (−0.0148, under one query of 45) and hard `hybrid_r1`
0.4778 → 0.4519 (−1.2 queries of 45). The seam form is deterministic, so one run
decides; tolerance stays 0.

The seam reference moves to this run. The gate reads the last two lines below:

RESULT bm25_r5=0.8428 vector_r5=0.8794 hybrid_r5=0.8957 full_r5=0.9485 full_mrr=0.9165
RESULT-HARD hybrid_r1=0.4519 hybrid_mrr=0.6429 full_r1=0.5963 full_mrr=0.8007 n=45 tol=0 form=seam
