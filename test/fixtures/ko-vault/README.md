# ko-vault fixture

Synthetic Korean wiki vault + `qmd bench` goldset for Hangul search work (`docs/vault-search/`).

- Source: 2nd-brain `projects/second-brain/config/skills/vault-search/fixtures/` at commit `e856721` (A4, aliases included).
  `wiki/` is a verbatim copy of `ko-vault/wiki/`, `ko-bench.json` of `ko-search-bench.json`.
- Do not edit `wiki/` or `ko-bench.json` here — fix upstream in 2nd-brain and re-copy.
- `models.yml`: models used by `scripts/bench-ko.sh` (top-level `embed`/`rerank`/`generate` keys). Pinned to embeddinggemma as the baseline.
- `BASELINE.md`: recorded `RESULT` lines.

Run: `bash scripts/bench-ko.sh` (isolated index under `tmp/bench-ko/`).
