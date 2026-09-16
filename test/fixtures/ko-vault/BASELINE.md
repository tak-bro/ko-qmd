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
