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
against a real 2nd-brain vault instead: 232 Korean wiki documents in `lemoncloud/lemon/knowledge`,
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
| muzly-wiki | 107 | 87 | 0.9770 |
| ssocio-wiki | 28 | 65 | 1.0000 |

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
and the standing miss `레몬 웹 코어` is this shape against a real vault).

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
