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
have no answer key. The judge is only trusted as far as it agrees with reference labels on the
same rubric. The reference labels here come from a stronger model, not from people (see Kappa).

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
   - kappa against the labels in `judge/labels.json`.

The label sample comes from `scripts/judge/label.ts`. For each goldset query it takes 5 documents:
the top 2 of `full` and 3 drawn at random from the rest of the pool. The order is shuffled, and the
judge's grade is never shown. The labeler sees the same 900 characters the judge saw. Only goldset
queries are labeled, so kappa does not cover the judge's grades on the 27 open queries.

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
of 39), which is too small to call better. Kappa below does not separate them either, so pointwise
stays the reported mode because document order cannot move its grades.

nDCG@10 with 95% bootstrap intervals over queries, from the pointwise grades. The judge is lenient
(see Kappa), so read these as relative between backends rather than as absolute quality.

| Query set | bm25 | hybrid | full | full − bm25 |
|---|---|---|---|---|
| goldset (50) | 0.726 [0.657, 0.792] | 0.868 [0.819, 0.910] | 0.891 [0.858, 0.918] | +0.164 [0.098, 0.234] |
| no answer key (27) | 0.716 [0.655, 0.776] | 0.794 [0.728, 0.855] | 0.823 [0.758, 0.878] | +0.107 [0.050, 0.163] |

The listwise grades (pass 1, one of the two orders) rank the backends in the same order. Their full − bm25 differences are
+0.126 [0.063, 0.194] on the goldset and +0.168 [0.093, 0.248] on the open queries. On both
query sets and with both judges, the interval for full − bm25 lies above zero.

**Kappa.** The labels are **not human**. The plan called for hand labels; the maintainer asked
for model labels instead. The 250 pairs were graded by Claude Opus 5.5 (`claude-opus-5-5`), five
instances of 50 pairs each, reading only `rubric.md` and the pair text. They never saw the judge's
grades, `queries.json` or the answer key. Kappa therefore measures how far the 8B judge agrees
with a much larger model on the same rubric, not agreement with people. Intervals are 95% bootstrap
over the 50 queries.

| Judge | weighted kappa | Cohen kappa | exact agreement |
|---|---|---|---|
| pointwise | 0.708 [0.646, 0.764] | 0.376 [0.290, 0.464] | 0.556 |
| listwise (pass 1) | 0.667 [0.576, 0.746] | 0.396 [0.312, 0.480] | 0.576 |

The intervals overlap, so neither mode agrees measurably better. Weighted kappa is in the range
usually called substantial; Cohen kappa is low because most disagreements are one grade apart.
The pointwise confusion matrix (rows reference 0–3, columns judge 0–3) shows where:

| ref \ judge | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| 0 | 40 | 22 | 1 | 1 |
| 1 | 35 | 46 | 15 | 23 |
| 2 | 0 | 3 | 3 | 8 |
| 3 | 0 | 1 | 2 | 50 |

- The judge rarely misses a relevant document: of 67 pairs the reference graded ≥ 2, it graded 63
  at ≥ 2, and 50 of the 53 reference 3s got a 3.
- It is lenient on near misses: of 119 pairs the reference graded 1 (same field, other concept), it
  graded 38 at ≥ 2, 23 of them 3. These inflate the nDCG ideal and the gains alike.
- The 0/1 line is loose in both directions (22 and 35 pairs). Index and topic pages that only
  list links account for many of them, and the reference labelers flagged that line as ambiguous.
  The gain gap between 0 and 1 is small, so this matters least for nDCG.

The rubric and model were not changed after this measurement. A stricter rubric line for 1 versus
3, or a larger judge, is the next lever if absolute nDCG values are needed. Rerun the report for
both modes with:

```sh
npx tsx scripts/judge/report.ts test/fixtures/ko-vault/judge/judgments.json test/fixtures/ko-vault/judge/queries.json test/fixtures/ko-vault/judge/labels.json test/fixtures/ko-vault/judge/report.json
npx tsx scripts/judge/report.ts test/fixtures/ko-vault/judge/judgments-pointwise.json test/fixtures/ko-vault/judge/queries.json test/fixtures/ko-vault/judge/labels.json test/fixtures/ko-vault/judge/report-pointwise.json
```

## Stage 3 — RAG answers with citations

**What.** `scripts/rag/ask.ts` answers a question from a qmd index. It retrieves the top 5 chunks
and has a local model answer in sentences, each citing the chunks it rests on. If the chunks do not
answer the question, the model says it does not know ("모른다"). `scripts/rag-ko.sh` measures three
things on a fixed question set:

- faithfulness: per answer, the share of its sentences that their cited chunks fully support,
  averaged over answered questions. It does not ask whether the answer is right: an answer to a
  near-miss question built from true but beside-the-point sentences still scores high;
- citation precision: per answer, the share of its citations whose chunk alone supports the
  sentence, averaged the same way;
- abstention: how often the model says it does not know, split into questions it should refuse
  and questions it should answer.

It compares one change, a stricter prompt, on the same questions and the same chunks. Generation
stays out of the `qmd` binary; whether it belongs there is a later decision.

**How.**

1. The question set is `test/fixtures/ko-vault/rag/questions.json`, 44 questions over the fixture.
   - 24 are answered by one note and 8 need two notes.
   - 8 are near misses: the corpus covers the topic but not the fact asked, such as who first
     proposed BM25. A grep over the whole corpus confirmed each fact is absent.
   - 4 are off-corpus, such as cooking a stew.

   Claude Opus 5.5 wrote the set after reading every note.
2. `bench-ko.sh` builds the isolated index. `scripts/rag/retrieve.ts` then fetches the top 5 chunks
   per question once, into `rag/contexts.json`. Retrieval is the `full` backend in seam form.
   Fixture notes fit in one chunk each, so a chunk is a whole note. Chunk size was therefore not a
   useful change to compare.
3. `scripts/rag/answer.ts` answers each question with `gemma3:4b` on Ollama (temperature 0, seed 42).
   The reply is JSON: a list of sentences with chunk numbers, or `unknown: true`. It runs once per
   prompt, so both prompts see the same chunks:
   - `baseline` asks for a concise answer with citations, and `unknown` when the documents cannot
     answer.
   - `grounded` adds four rules: use the documents only, write one claim per sentence, cite only
     chunks that state the sentence, and abstain when the exact fact is missing even if the topic
     is there.
4. `scripts/rag/grade.ts` has `qwen3:8b` grade every cited sentence on
   `rag/faithfulness.md`. The judge sees the question, the sentence and only the chunks it cites.
   It returns support (full, partial or none) and, for each cited chunk, whether that chunk alone
   supports the sentence. A sentence without a citation counts as unsupported.
5. `scripts/rag/report.ts` gives each metric with a 95% bootstrap interval over questions, and the
   grounded − baseline difference with a paired bootstrap over the questions both runs define.
   Each answers file records the hash of the contexts it came from, and each grades file the hash
   of the answers it graded. The report and `agreement.ts` refuse files whose hashes do not match.
   These fields, and the Ollama version, were added to the committed files after the run, at the
   review. The run's own code did not yet write them.

The judge was checked before its numbers were used. Claude Opus 5.5 graded the same 77 sentences
blind. Two instances took the sentences of both runs shuffled together; they read only the rubric
and each sentence's cited chunks. They saw neither the judge's grades nor which prompt wrote the
sentence. `scripts/rag/agreement.ts` compares the two sets of grades. These reference grades come
from a model, not from people.

**Result.** Conditions: Apple M3 Max, darwin-arm64, Ollama 0.40.1, one run each (temperature 0,
seed 42). Answers came from `gemma3:4b` at commit `ded6b84`, about 140 s per prompt. Judge grades
came from `qwen3:8b` at `320397e`, 90 s and 49 s. Retrieval used Qwen3-Embedding-0.6B and
Qwen3-Reranker-0.6B (`models.yml`) and put an expected note in the top 5 for all 32 answerable
questions.

The judge agrees poorly with the reference grades:

| Agreement over 77 sentences | value |
|---|---|
| Cohen kappa, full vs not full (what faithfulness counts) | 0.347 [0.154, 0.539] |
| Cohen kappa, full / partial / none | 0.231 [0.088, 0.382] |
| Per-citation verdicts that match | 80 of 89 |

The confusion matrix shows two failures:

- The judge marks paraphrases down to partial. Of 58 sentences the reference graded full, it
  graded 20 partial.
- It misses fabrications. Of 11 sentences the reference graded none, it graded 2 none, 7 partial
  and 2 full. One of them: asked for BM25's usual saturation value, which no note gives, the
  baseline answered "60", and the judge called that partial.

Two changes to the judge were tried:

- Turning on qwen3:8b's thinking. The run failed on 3 of its first 9 questions and was stopped.
  Two failures came from a numbering bug: a sentence citing chunk 4 alone showed the judge a lone
  "[4]". The third was Node's 5-minute fetch timeout. The bug was fixed in `320397e`, but thinking
  was not retried, so it remains untested.
- Showing the cited chunks numbered from 1, which is that fix, moved kappa from 0.329 to 0.347.

The first judge run is kept in commit `9688b5b`. Faithfulness below is therefore reported on the
reference grades (`rag/report-reference.json`), with the judge's numbers alongside
(`rag/report.json`).

| Metric | baseline | grounded | grounded − baseline |
|---|---|---|---|
| Faithfulness, reference grades | 0.667 [0.517, 0.806] (n=40) | 0.792 [0.615, 0.950] (n=24) | +0.097 [−0.125, 0.333] (n=24) |
| Faithfulness, qwen3:8b judge | 0.444 [0.295, 0.593] | 0.617 [0.421, 0.808] | +0.117 [−0.042, 0.283] |
| Citation precision, reference grades | 0.663 [0.522, 0.800] | 0.875 [0.727, 1.000] | +0.207 [0.000, 0.412] |
| Citation precision, qwen3:8b judge | 0.722 [0.587, 0.848] | 0.896 [0.761, 1.000] | +0.172 [0.042, 0.325] |
| Cites an expected note (no judge) | 0.906 (29 / 32) | 1.000 (20 / 20) | — |
| "모른다" on near-miss + off-corpus (higher is better) | 0.333 (4 / 12) | 0.667 (8 / 12) | +0.333 [0.083, 0.583] |
| "모른다" on answerable questions (lower is better) | 0.000 (0 / 32) | 0.375 (12 / 32) | +0.375 [0.219, 0.563] |

The baseline and grounded columns cover different questions: each run is averaged over the
questions it chose to answer. So 0.792 against 0.667 is not the effect. On the 24 questions both
prompts answered, reference faithfulness goes from 0.694 to 0.792, which is the +0.097 in the last
column. The judge's figures on the same 24 go from 0.500 to 0.617. Grounded also dropped harder
questions: on the 16 it refused, baseline's reference faithfulness was 0.625.

The faithfulness intervals for the change contain zero under both graders. This set therefore
cannot show that the stricter prompt makes answers more faithful.

What the change does show is a trade:

- It refuses twice as many unanswerable questions. Baseline answered all 8 near misses; grounded
  answered 4.
- It refuses 12 of 32 questions the chunks do answer, against none for baseline.
- Citation precision rises, but under the reference grades the interval only reaches zero.

For a user, the grounded prompt as written trades wrong answers for missing ones. The next lever is
the abstention rule, which is too broad as worded, measured on this set again.

Rerun everything, or new answers from the committed chunks, with the first two commands below.
The reference grades belong to the committed answers. `rag-ko.sh` removes them when it writes new
answers; git keeps the old ones. The last two commands rebuild the reference report and the
agreement from the committed files.

```sh
bash scripts/rag-ko.sh
RAG_SKIP_RETRIEVE=1 bash scripts/rag-ko.sh
R=test/fixtures/ko-vault/rag
npx tsx scripts/rag/report.ts $R/contexts.json $R/answers-baseline.json $R/grades-baseline-reference.json $R/answers-grounded.json $R/grades-grounded-reference.json --out $R/report-reference.json
npx tsx scripts/rag/agreement.ts $R/grades-baseline.json $R/grades-baseline-reference.json $R/grades-grounded.json $R/grades-grounded-reference.json
```
