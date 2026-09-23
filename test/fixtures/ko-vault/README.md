# ko-vault fixture

Synthetic Korean wiki vault + `qmd bench` goldset for Hangul search work (`docs/vault-search/`).

- Source: 2nd-brain `projects/second-brain/config/skills/vault-search/fixtures/` at commit `e856721` (A4, aliases included).
  `wiki/` is a verbatim copy of `ko-vault/wiki/`, `ko-bench.json` of `ko-search-bench.json`.
- Do not edit `wiki/` here — fix upstream in 2nd-brain and re-copy. `ko-bench.json` has diverged: queries
  `ko-01`…`ko-16` and `ali-12`…`ali-22` were added in this repo (see `BASELINE.md`); keep them on a re-copy.
- `models.yml`: models used by `scripts/bench-ko.sh` (top-level `embed`/`rerank`/`generate` keys). Pinned to Qwen3-Embedding-0.6B-Q8_0, the package default (switched from embeddinggemma on 2026-09-16, see `BASELINE.md`).
- `BASELINE.md`: recorded `RESULT` lines.

Run: `bash scripts/bench-ko.sh` (isolated index under `tmp/bench-ko/`).
