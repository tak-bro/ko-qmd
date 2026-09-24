# Handoff: KB rerank latency experiment

Temporary. Delete this directory in its own commit before the branch is merged.

## Where it stands (2026-09-24)
- Branch `feat/rerank-max-doc-tokens` adds `QMD_RERANK_MAX_DOC_TOKENS`, an opt-in per-doc token cap on rerank
  input. The cap is part of the rerank cache key, so capped and uncapped scores never mix.
- Plans: `PLAN-12-27-43.md` (candidate-count sweep, verdict none) and `PLAN-16-46-00.md` (input cap, verdict
  none, both slices done).
- Results: `NOTE-12-58-00.md` and `NOTE-17-30-00.md`. Cap 128 at N=15 reaches Hit@5 0.97 / Recall@5 0.77, which
  beats the uncapped rerank. Its p90 is 2192ms against the 2s seam budget.
- A per-chunk floor of ~110ms remains. N=15 runs on only 2 ranking contexts, because
  `LlamaCpp.RERANK_TARGET_DOCS_PER_CONTEXT` is 10.

## Next move
Option B: spread N=15 over more ranking contexts at cap 128, then measure whether p90 drops under 2000ms. The
levers are `RERANK_TARGET_DOCS_PER_CONTEXT` and the `min(computeParallelism(1000), 4)` cap in
`LlamaCpp.ensureRerankContexts`. Start with `/01-plan` in a fresh session, from `NOTE-17-30-00.md § Open`.

## Machine setup
1. `git switch feat/rerank-max-doc-tokens && bun install`
2. Check out knowledge-base (it has the goldset `scripts/eval/golden.jsonl`). Set `KB_DIR` if it is not at
   `~/workspace/knowledge-base`.
3. Register the `kb` collection in `~/.config/qmd/index.yml`, then run `qmd update` and `qmd embed` by hand.
   The reranker model downloads on the first rerank.
4. Latency depends on the machine. The table in the NOTE is from an Apple Silicon Mac on Metal, with the qmd
   daemon running. Re-measure a baseline before comparing: `bash .handoff/rerank-cap/cap.sh full 128`.

## Scripts
Run all of them from anywhere; they resolve the repo from their own path.

| Script | What it does |
|---|---|
| `cap.sh <cap\|full>...` | For each cap, takes a `.backup` of the index, empties `llm_cache` on the copy, runs `dump.ts`, and prints Hit@5, Recall@5, MISS, median and p90. Env: `CL` (candidate limit, default 15), `OUT` (work dir, default `$TMPDIR/rerank-cap`), `INDEX` (default `~/.cache/qmd/index.sqlite`). The real index is only read. |
| `dump.ts <db> <candidateLimit\|0> <out.json>` | Runs the 40 golden queries through the SDK with the KB seam payload (vec+lex, collection kb), recording per-query ms and candidates. |
| `sweep.ts <dump.json>` | Offline candidate-count sweep over a candidateLimit-40 dump. |
| `tokens.ts <db>` | Token lengths of the N=15 best chunks under the rerank tokenizer. bun can hang at exit after printing, so wrap it in `timeout`. |

Verify the real index was untouched: `sqlite3 ~/.cache/qmd/index.sqlite "SELECT count(*) FROM llm_cache"`
should read the same before and after.
