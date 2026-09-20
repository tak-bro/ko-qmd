# qmd-jev

Search a qmd index with [Jev](https://docs.typesafe.ai) (TypeSafe System One) making the two
judgements qmd otherwise spends a local GPU model on: which retrieval route a query needs, and
whether each hit is actually about the query. It consumes qmd through the published SDK
(`createStore`), so the `qmd` tool itself is untouched.

`qmd-jev query` retrieves locally through the SDK, then — when a key is present and the
collection is listed in `QMD_JEV_COLLECTIONS` — asks Jev one question per hit: is this chunk
about the query? Hits scoring below the threshold are dropped; everything else is returned in
qmd's own fused order. Jev down, no key, nothing listed: the same answer without the gate, one
line on stderr. `qmd-jev doctor` reports the configuration and whether the pinned model still
answers.

`qmd-jev mcp` serves the same query as one MCP tool over stdio, on the same SDK transport as
`qmd mcp` — a client configured for `qmd mcp` can point at this binary unchanged. The tool
returns the presented text as content and the hit array as `structuredContent.hits`, carrying
`gate` stats and, when Jev failed, a `jevFailure` status or category. It never returns a tool
error because Jev is down. `QMD_JEV_LOG`, when set, appends one JSON line per query from either
front door: model, route (`jev`/`qmd`), gate counts, and every judged hit's `noul` and `kept` —
the record a threshold re-calibration reads. The key cannot enter a log line: entries are built
from results, not from configuration.

**Pre-release workspace package.** Not published to npm; `query`, `doctor`, `mcp` are its
commands.

## What the gate does today — read this first

**Measured on the corpus this package is developed against, the gate drops nothing.** On the
`kb` collection (460 markdown files, 2026-09-20, jev-1.13.0, the exact question sentence this
package sends), **every one of 226 candidates across 10 queries scored >= 0.56** — far above
the 0.3 threshold. The gate is a **safety net for a corpus or query where Jev does separate**
(the 0.3 calibration comes from a code-grep corpus where irrelevant scored <= 0.21 and on-path
>= 0.38), **not a filter you should expect to see fire** on prose.

**The gate judges membership, not order.** Kept hits stay in qmd's fused order. An earlier
draft sorted kept hits by their relevance score; measured over the same 10 queries, that sort
**demoted the known-right document in 7 of 10 queries and improved it in none** (within-query
score spread was 0.02–0.05 — the sort order was noise). That number is why there is no sort.
Do not re-add one without a measurement showing a wider spread.

Three question shapes were tried (free 0–1 `noul`, anchored 0/0.3/0.6/1.0, discrete 4-level
`score`): all compressed to ~0.1 total spread on prose. **Next thing to try, not built:**
`candidateLimit` 8 instead of 40 — small batches kept the right document at #1 in 3 of 4
probes, suggesting attention dilution, but they also trade recall for a signal that was itself
near-noise. Measure before building.

Re-calibrate with `qmd-jev query --explain`: it prints every judged hit with its noul and its
kept/dropped mark, under a header with the gate's counts. That display is the only way to see
whether the threshold would fire on your corpus.

## What leaves the machine, and when

**The vendor offers zero data retention to enterprise customers only — whatever this package
puts in a Jev request may be kept.** Every path below states what it sends; no other path exists.

| Path | Sends | Gated by |
|---|---|---|
| `doctor`, no key | nothing — zero requests | a key |
| `doctor`, with key | one request: an **empty** state and one liveness question. No collection content. | |
| `query`, nothing consented | nothing — no key, no listed collection, or no listed hits ⇒ the request is never built | `QMD_JEV_COLLECTIONS` |
| `query`, Jev on | hit excerpts of **listed collections only**, capped at 1500 characters per hit | `QMD_JEV_COLLECTIONS` |

Consent is per collection, because the collection is qmd's unit of content. A collection not
listed in `QMD_JEV_COLLECTIONS` is never described to Jev — its hits are still searched and
returned, they just never leave the machine. An allowlist is chosen over a denylist because an
allowlist fails closed on the next collection nobody listed.

Indexing, `embed` and `update` never call Jev. A query is one Jev request regardless of hit
count.

## Env

| Variable | Default | |
|---|---|---|
| `QMD_JEV_COLLECTIONS` | unset = off | comma-separated collection names Jev may be told about |
| `TYPESAFE_API_KEY` | — | else the file `~/.config/typesafe/key` (`chmod 600`) |
| `QMD_JEV_TIMEOUT_MS` | `2000` | per-call deadline; a non-positive or non-numeric value falls back |
| `QMD_JEV_LOG` | unset | append one JSON line per query (model, route, per-hit `noul`, `kept`); best-effort — a write failure never fails a query |

## The key

`TYPESAFE_API_KEY`, else `~/.config/typesafe/key`. Read once per process. It goes into the
`Authorization` header and nowhere else: not into doctor output, the query log, stderr, or any
error text.

## The pin

`MODEL = "jev-1.13.0"`, not `jev-latest`. Every threshold in this package is calibrated against
a version and a question sentence, and an alias would move the calibration silently. Measured
2026-09-20: the pinned id answers 200 and echoes itself; `jev-1.13` and an unknown version
answer 400 `{"detail":{"error_type":"api_usage_error","message":"Unknown model: …"}}`.

When `qmd-jev doctor` says `model jev-1.13.0: no answer (last: 400)`, the pin has been retired:
re-measure on the new version, then raise the pin here and in `src/jev.ts`.

## Measured (kb collection, jev-1.13.0, 2026-09-20)

| Measurement | Result | Decision it set |
|---|---|---|
| Gate, 10 queries × 40 candidates | all 226 candidates scored >= 0.56 | threshold stays 0.3; gate ships as a safety net, expected silent on prose |
| Sort kept hits by noul | right document demoted in 7/10, improved in 0/10; spread 0.02–0.05 | no sort — order is qmd's fused order, membership only |
| Question shape | free `noul`, anchored 4-point, and discrete 4-level all spread <= ~0.1 on prose | the free `noul` sentence ships; the other two were not better |
| Batch size 8 vs 40 candidates | spread unchanged (~0.03) but demotion mostly disappears (3/4 probes keep #1) | not built — README "Next thing to try" |
| `--expand` (qmd's LLM expansion) vs in-package sub-queries, same 10 queries, Jev on | **387 ms/query vs 494 ms/query** (first expand query pays the local model load: 1307 ms) | default stays in-package; `--expand` is opt-in |
| State size at 40 × 1500-char chunks | ~76K chars of the ~128K-char (32K token) budget | `candidateLimit` 40 is safe |

## Failure behaviour

Jev unreachable — no key, timeout, 5xx, breaker open — is never an error. The command still
answers in qmd's fused order, exit 0, with at most one line on stderr per process naming the
failure as an HTTP status or category. Three consecutive failures switch the client off for the
process; one success resets it. A missing answer for a hit keeps that hit.

## Development

```sh
bun install                              # at repo root — links ko-qmd into the workspace
bun run --cwd packages/qmd-jev build     # tsc → dist/; bin/qmd-jev then runs it with node
bun test --cwd packages/qmd-jev          # offline: fetch/env/readFile are injected
bun run --cwd packages/qmd-jev lint      # tsc --noEmit over src/
```
