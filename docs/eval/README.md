# Evaluation

How ko-qmd's search quality is measured and guarded. Each stage records what is measured, how,
and the measured result with its conditions (machine, model, commit, repeat count).

## Stage 1 — lex (BM25) CI gate

**What.** CI benches the bm25 path, the only one that needs no model, on every push to `main`,
`develop` or `feat/**` and every pull request into `main` or `develop`. It runs the ko-vault goldset:
123 queries in `test/fixtures/ko-vault/ko-bench.json` against the 97 notes that `qmd update` indexes
from `wiki/` and `distractors/`. The gate fails a change that lowers recall@5 or
MRR by more than the query sample can explain.

**How.** `scripts/bench-lex-gate.sh` builds a fresh index with `qmd update` (no `qmd embed`) and runs
`qmd bench --backend bm25`. It does this five times and rebuilds the index each time. The `NOISE`
line counts queries whose metrics differ between the runs. The per-query mean is compared with the
committed baseline `test/fixtures/ko-vault/lex-baseline.json` by a paired bootstrap over queries:
10,000 resamples, seed 20261031, 95% interval of the mean change (`src/bench/gate.ts`).

- `FAIL`: the interval for recall@5 or MRR lies wholly below zero, or the query set differs from
  the baseline's.
- `WARN`: some queries score lower, but no interval lies below zero. The gate lists the lowered queries.
- `PASS`: no query scores lower.

bm25 has no sampling step. So the interval measures how much the result depends on which queries
were drawn. It does not measure run-to-run noise, which the `NOISE` line measures on every run. The
CI job is `lex-gate` in `.github/workflows/ci.yml`. To refresh the baseline after an intended
change, run `bash scripts/bench-lex-gate.sh --update-baseline`.

**Result.**

| Run | Conditions | Outcome |
|---|---|---|
| Baseline | Apple M3 Max, darwin-arm64, Node v24.20.0, commit `0c09d58`, 5 reps | r5 0.8875, MRR 0.8169, n=123; `NOISE differing=0 max_abs=0` |
| Same tree vs baseline | same machine, 5 reps | `GATE PASS`; Δr5 0.0000 [0.0000, 0.0000] |
| Hangul bigram tail dropped from the index | same machine, 1 rep, local only | `GATE WARN`; 5 queries lower; Δr5 −0.0041 [−0.0366, 0.0285], ΔMRR −0.0008 [−0.0045, 0.0030] |
| CJK runs indexed unspaced (deliberate break) | same machine, 1 rep, local only | `GATE FAIL`, exit 1; 45 queries lower; Δr5 −0.2222 [−0.2995, −0.1463], ΔMRR −0.2107 [−0.2824, −0.1424] |
| CI, unchanged tree | GitHub `ubuntu-latest`, Node 22, commit `3d6c962`, 5 reps | `GATE PASS`; r5 0.8875, MRR 0.8169 (identical to the local baseline); `NOISE differing=0` |
| CI, deliberate break pushed | same runner, commit `154b298`, 5 reps | job red, exit 1; `GATE FAIL`, same numbers as the local break; `NOISE differing=0` |
| CI, break reverted | same runner, commit `df6c639`, 5 reps | `GATE PASS`; no model cache found after the gate |

The CI runner (ubuntu, Node 22) reproduced the macOS baseline to the fourth decimal, so one
committed baseline serves both. A lex gate job takes about 40 s.

The bigram row shows the WARN tier at work. Dropping the bigram tail lowers 5 queries and raises
others, and the interval cannot tell the net change from zero. So the gate warns and names the 5
queries instead of failing.

## Stage 2 — LLM-as-judge relevance grading

**What.** A local model grades how relevant each retrieved document is to a query, on a 0–3 scale
(`test/fixtures/ko-vault/judge/rubric.md`: 3 answers the query, 2 explains it in part, 1 same field
but another concept, 0 unrelated). With those grades, nDCG@10 can be measured for queries that
have no answer key. The judge is only trusted after it has been checked against hand labels on the
same rubric.

**How.** `scripts/judge-ko.sh` runs three steps.

1. `bench-ko.sh` retrieves the top 10 for 80 queries from bm25, hybrid and full (seam form, no
   query expansion). The query set is `judge/queries.json`. It holds 50 goldset queries sampled by
   type and 30 queries with no answer key; 3 of those 30 are off-corpus, such as "파스타 면 삶는 시간".
2. `scripts/judge/run.ts` grades each query's pool: the union of the three top-10 lists, plus any
   answer file all three missed. The judge is `qwen3:8b` on Ollama, with thinking off, temperature
   0 and a fixed sampling seed. Each document is cut to 900 characters.
   - **listwise** (default) puts the whole pool in one prompt. It runs twice, with the pool
     shuffled into a different order each time and the sampling seed unchanged. Any grade that
     moves between the two runs comes from document order alone.
   - **pointwise** (`JUDGE_MODE=pointwise`) sends each document alone through the same prompt.
3. `scripts/judge/report.ts` reports these checks:
   - how many grades changed with the order (POSITION);
   - how many answer files the judge graded at least 2 (GOLD);
   - whether off-corpus pools got 0 (OFFCORPUS);
   - per-backend nDCG@10 against the pooled ideal, with 95% bootstrap intervals over queries;
   - kappa against hand labels.

Hand labels come from `scripts/judge/label.ts`. For each goldset query it shows 5 documents: the
top 2 of `full` and 3 drawn at random from the rest of the pool. The order is shuffled, and the
judge's grade is never shown. The labeler sees the same 900 characters the judge saw. Only goldset
queries are labeled, so kappa will not cover the judge's grades on the 27 open queries.

**Result.** Conditions: Apple M3 Max, darwin-arm64, qwen3:8b on Ollama (`ollama --version` on the
day: 0.40.1; the version is not recorded in the judgments), 80 queries, 1076 (query, document)
pairs, no failed queries. Listwise ran at commit `131e590` and took 3906 s for two passes. That
commit's run.ts did not yet write `conditions.mode`; `"mode": "listwise"` was added to
`judgments.json` after the run, and `report.json` was regenerated from it. Pointwise ran at commit
`c9c7e7c` and took 2796 s for one pass.

| Check | listwise (pass 1) | pointwise |
|---|---|---|
| Grades changed by reordering the pool | 0.409 of 1076 (weighted kappa 0.622 between the two orders) | — (no list) |
| Answer files graded ≥ 2 | 56 / 59 | 58 / 59 |
| Off-corpus documents graded 0 | 38 / 39 | 39 / 39 |
| Agreement with the other mode (weighted kappa) | 0.635 (pass 2: 0.665) | — |

The listwise judge is not stable. Reordering the same documents changed 41% of the grades, and
120 of them moved by 2 or more. The second order also graded lower overall: 601 zeros against 486.
Pointwise grading removes document order as a variable. Its stability across reruns was not
measured. On the label-free checks it differs from listwise by 1–2 items (58 vs 56 of 59, 39 vs 38
of 39), which is too small to call better. Pointwise is the mode used below only until kappa
decides between the two.

nDCG@10 with 95% bootstrap intervals over queries, from the pointwise grades. These are
provisional: the judge has not yet been checked against hand labels.

| Query set | bm25 | hybrid | full | full − bm25 |
|---|---|---|---|---|
| goldset (50) | 0.726 [0.657, 0.792] | 0.868 [0.819, 0.910] | 0.891 [0.858, 0.918] | +0.164 [0.098, 0.234] |
| no answer key (27) | 0.716 [0.655, 0.776] | 0.794 [0.728, 0.855] | 0.823 [0.758, 0.878] | +0.107 [0.050, 0.163] |

The listwise grades (pass 1, one of the two orders) rank the backends in the same order. Their full − bm25 differences are
+0.126 [0.063, 0.194] on the goldset and +0.168 [0.093, 0.248] on the open queries. On both
query sets and with both judges, the interval for full − bm25 lies above zero.

**Kappa: pending.** There are no hand labels yet (`judge/labels.json`). Until there are, these
numbers depend on the judge's own label-free checks. Once labeling is done, rerun the report for
both modes. The report needs no model.

```sh
npx tsx scripts/judge/label.ts
npx tsx scripts/judge/report.ts test/fixtures/ko-vault/judge/judgments.json test/fixtures/ko-vault/judge/queries.json test/fixtures/ko-vault/judge/labels.json test/fixtures/ko-vault/judge/report.json
npx tsx scripts/judge/report.ts test/fixtures/ko-vault/judge/judgments-pointwise.json test/fixtures/ko-vault/judge/queries.json test/fixtures/ko-vault/judge/labels.json test/fixtures/ko-vault/judge/report-pointwise.json
```
