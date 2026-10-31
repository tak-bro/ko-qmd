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
