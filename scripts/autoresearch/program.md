# autoresearch: rerank input

You are running an autonomous research loop on ko-qmd's search. Your job is to raise one number,
`train_full_mrr`, by changing what the cross-encoder reranker is shown. You work alone, you do not
ask questions, and you do not stop until the time budget is spent.

## Setup (once, before the first experiment)

1. You are in a git worktree on a branch made for this run (`exp/rerank-loop` or similar). Confirm
   with `git branch --show-current` that it is not `main` or `develop`.
2. Read these files in full: this one, `src/rerank-input.ts`, and the rerank call sites in
   `src/store.ts` (`chunkCandidatesForRerank`, `rerankDocuments`, `rerank`). Read
   `scripts/autoresearch/eval.sh` so you know what it measures.
3. Run `bash scripts/autoresearch/eval.sh` once. It must print a `METRIC` line and
   `INVARIANT bm25=same vector=same hybrid=same`. If it exits non-zero, stop and report: the data
   or baseline is missing and there is nothing to optimize against.
4. Your own files (`run.log`, `results.tsv`) live in the data dir, outside the repo, because they
   name vault files. Shell state may not survive between your commands, so start every command
   that touches them with `AR="$(bash scripts/autoresearch/eval.sh --dir)" &&`. Create the table once,
   without overwriting it on a restart:
   `AR="$(bash scripts/autoresearch/eval.sh --dir)" && [ -f "$AR/results.tsv" ] || printf 'commit\ttrain_full_mrr\tstatus\tseconds\tdescription\n' > "$AR/results.tsv"`.
   Log this run as `baseline`.

## What you may change

- **Only `src/rerank-input.ts`.** It decides three things:
  - `formatRerankQuery` — the query string the reranker scores against (intent + query today)
  - `selectRerankChunk` — which chunk of each candidate is sent (most query-word hits today)
  - `formatRerankDoc` — the document text built from that chunk (the chunk alone today; it may
    use the candidate's `title`, `file` and `displayPath`)
- You may add pure helpers inside that file. You may not add dependencies.
- **Keep the intent branches working.** No goldset here carries an `intent:` line, so the metric
  cannot see what intent does — but MCP and REST callers send it. Do not delete or weaken the
  intent handling in `formatRerankQuery` or `selectRerankChunk`, even when a change that does
  would score the same; the simplicity tie-break below does not apply to intent code.

## What you must not change

- Any other file: not `store.ts`, `llm.ts`, `eval.sh`, `prepare.sh`, the goldsets, tests or config.
- The goldset or its answers. You never read `heldout.json`; it is kept for the final check.
- Fusion weights, blend, chunk sizes, the reranker model or its context size.

## The experiment loop

LOOP until 2 hours have passed since setup:

1. Pick one hypothesis. Write it as one line (it becomes the commit message and the tsv
   description). Examples of directions, not a list to work through: put the note title before the
   chunk; send a heading path; pick the chunk by Hangul syllable-bigram overlap instead of whole
   words; trim boilerplate lines from the chunk.
2. Edit `src/rerank-input.ts`. Run `npm run --silent test:types`. If it fails, fix it or abandon
   the idea.
3. `git commit -am "exp: <hypothesis>"`.
4. `AR="$(bash scripts/autoresearch/eval.sh --dir)" && bash scripts/autoresearch/eval.sh > "$AR/run.log" 2>&1; echo "exit=$?"`,
   then read the three stdout lines with `AR="$(bash scripts/autoresearch/eval.sh --dir)" && grep -E '^(METRIC|INVARIANT|SECONDS)' "$AR/run.log"`.
   The log stays outside the repo because it names vault files. A non-zero exit or no METRIC line
   is a crash: `tail -n 40` the log, fix a simple mistake and rerun once; otherwise log `crash` and
   reset.
5. Keep or discard:
   - **keep** if `train_full_mrr` is higher than the best kept value so far **and** every
     invariant is `same`. The bench is deterministic, so any rise is real on train; the held-out
     check after the loop guards against overfitting.
   - **keep** also if the metric is equal and the change deletes code (simplicity wins ties).
   - otherwise **discard**: `git reset --hard HEAD~1`.
6. Append a row to `"$AR/results.tsv"`: short commit hash, metric (0 for a crash), `keep` / `discard` /
   `crash`, seconds, the hypothesis line. Do not commit `results.tsv`; it lives outside the repo.

## Budget and judgement

- One eval should take under 10 minutes; most take far less because unchanged (query, chunk) pairs
  come from the rerank cache. If an eval takes over 15 minutes, discard the change as too costly.
- Prefer simple changes. A 0.002 gain that adds 30 lines is worth less than a 0.002 gain from
  deleting a line. Weigh that when choosing what to keep among close results.
- Do not repeat a discarded hypothesis with cosmetic changes. Read `results.tsv` before choosing.
- If you run out of ideas, combine two kept ideas, revisit a near-miss, or try the opposite of what
  worked.

**NEVER STOP** before the budget is spent: do not pause to ask whether to continue. The person who
started you may be away and expects to find `results.tsv` full when they return. When the budget
is spent, stop and print the best kept commit, its metric, and the number of experiments run.
