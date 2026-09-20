# Changelog — qmd-jev

The package's own history. The root `CHANGELOG.md` is qmd's release notes;
this package ships nothing in qmd, so its changes live here.

## [Unreleased]

### Changes

- `qmd-jev mcp` serves one `query` tool over stdio, on the same SDK
  transport as `qmd mcp`. The tool shares `runQuery` with the CLI — gate,
  consent and fail-open behaviour cannot fork between the two front doors —
  and returns the presented text plus `structuredContent.hits` with `gate`
  stats and, when Jev failed, a `jevFailure` status or category. Jev being
  down never returns a tool error. Several calls may be in flight: when the
  breaker trips mid-flight, every call still resolves and the trip notice
  is emitted exactly once.
- `QMD_JEV_LOG` appends one JSON line per query from either front door:
  model, route (`jev`/`qmd`), gate counts, and every judged hit's `noul`
  and `kept` — including dropped hits, whose scores are the calibration
  data. The key cannot enter a line by construction; a write failure never
  fails a query.
- `qmd-jev query` runs SDK retrieval (in-package lex+vec sub-queries,
  reranker off) and asks Jev one relevance question per hit, dropping what
  scores below 0.3 — a safety net, not a filter: on the measured markdown
  corpus every candidate scored >= 0.56, so nothing drops today, and kept
  hits stay in qmd's fused order because sorting by the measured 0.02–0.05
  spread demoted the right document in 7/10 queries and improved it in none
  (measured, not guessed — see the README). `--explain` prints every judged
  hit with its noul and kept/dropped mark for re-calibration; `--expand`
  opts back into qmd's own LLM expansion (measured slower: 494 vs 387
  ms/query, so the in-package sub-queries stay the default). Jev down, no
  key, nothing listed: the same answer in qmd's own fused order, one line
  on stderr. `--format json` is the hit array.
- `qmd-jev doctor`: the configuration and whether the pinned model
  (`jev-1.13.0`) still answers — zero requests without a key, one empty
  request with one. The key is never printed, echoed, or logged; a failure
  is named by status or category only.
