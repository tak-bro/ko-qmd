# qmd-jev

Search a qmd index with [Jev](https://docs.typesafe.ai) (TypeSafe System One) making the two
judgements qmd otherwise spends a local GPU model on: which retrieval route a query needs, and
whether each hit is actually about the query. It consumes qmd through the published SDK
(`createStore`), so the `qmd` tool itself is untouched.

**Pre-release workspace package.** Not published to npm; `qmd-jev doctor` and
`qmd-jev query` run — query currently answers in qmd's own fused order, with no
Jev call. Jev ranking and `mcp` land with their slices.

## What leaves the machine, and when

**The vendor offers zero data retention to enterprise customers only — whatever this package
puts in a Jev request may be kept.** Every path below states what it sends; no other path exists.

| Path | Sends | Gated by |
|---|---|---|
| `doctor`, no key | nothing — zero requests | a key |
| `doctor`, with key | one request: an **empty** state and one liveness question. No collection content. | |
| `query`, today | nothing — retrieval runs locally; `QMD_JEV_COLLECTIONS` gates only what Jev is told | — |
| `query`, Jev ranking (next slice) | hit excerpts of **listed collections only**, capped at 1500 characters per hit with the cut marked | `QMD_JEV_COLLECTIONS` |

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
| `QMD_JEV_LOG` | unset | query log path (not yet built) |

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

## Failure behaviour

Jev unreachable — no key, timeout, 5xx, breaker open — is never an error. The command still
answers, ranked by qmd's own fused score, exit 0, with at most one line on stderr per process.
Three consecutive failures switch the client off for the process; one success resets it. A
missing answer for a hit keeps that hit.

## Development

```sh
bun install                              # at repo root — links ko-qmd into the workspace
bun run --cwd packages/qmd-jev build     # tsc → dist/; bin/qmd-jev then runs it with node
bun test --cwd packages/qmd-jev          # offline: fetch/env/readFile are injected
bun run --cwd packages/qmd-jev lint      # tsc --noEmit over src/
```
