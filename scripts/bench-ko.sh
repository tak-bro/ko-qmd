#!/usr/bin/env bash
# bench-ko — isolated `qmd bench` over test/fixtures/ko-vault using the current branch's source.
#
# Usage: bash scripts/bench-ko.sh
#
# Isolation: INDEX_PATH and QMD_CONFIG_DIR live under tmp/bench-ko/ and are rebuilt every run.
# `--index index` is passed explicitly so qmd does not walk up from cwd to a .qmd/index.yml.
# Model cache (~/.cache/qmd/models) is shared, read-only here. Models come from the committed
# test/fixtures/ko-vault/models.yml.
#
# stdout: first line `RESULT bm25_r5=<f> vector_r5=<f> hybrid_r5=<f> full_r5=<f> full_mrr=<f>`
# (format fixed — scripts/dogfood.sh's bm25_of regex parses it), then `RESULT-HARD
# hybrid_r1=<f> hybrid_mrr=<f> full_r1=<f> full_mrr=<f> n=<n>` pooling the hard query
# types (sem-hard/multi/neg) weighted by query count; `n=0` and `nan` while the fixture
# has no hard queries. Full bench JSON is kept at tmp/bench-ko/bench.json.
[ -d node_modules ] || npm install --no-audit --no-fund >&2
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

fixture="$ROOT/test/fixtures/ko-vault"
bench_json="$fixture/ko-bench.json"
collection="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).collection)' "$bench_json")"

work="$ROOT/tmp/bench-ko"
# Remove only this script's outputs — the autoloop runner keeps loop-B-*.log in the same dir.
rm -rf "$work/config" "$work"/index.sqlite* "$work/bench.json"
mkdir -p "$work/config"
export INDEX_PATH="$work/index.sqlite"
export QMD_CONFIG_DIR="$work/config"

# Collection root is ko-vault/ (not wiki/) so result paths keep the `wiki/` prefix — bench matches
# by path suffix. Brace pattern indexes wiki/** and distractors/** (near-topic decoys); README.md
# and BASELINE.md at the fixture root stay out.
{
  echo "collections:"
  echo "  $collection:"
  echo "    path: \"$fixture\""
  echo "    pattern: \"{wiki,distractors}/**/*.md\""
  echo "models:"
  grep -E '^[a-z]+:' "$fixture/models.yml" | sed 's/^/  /'
} > "$QMD_CONFIG_DIR/index.yml"

qmd() { npm run --silent qmd -- --index index "$@"; }

qmd update >&2
qmd embed >&2
qmd bench "$bench_json" --json > "$work/bench.json"

node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const s = j.summary;
const h = j.summary_hard || {};
const f = v => Number.isFinite(v) ? v.toFixed(4) : "nan";
const g = (b, k) => f(s[b] ? s[b][k] : NaN);
console.log(`RESULT bm25_r5=${g("bm25","avg_recall_at_5")} vector_r5=${g("vector","avg_recall_at_5")} ` +
  `hybrid_r5=${g("hybrid","avg_recall_at_5")} full_r5=${g("full","avg_recall_at_5")} full_mrr=${g("full","avg_mrr")}`);
console.log(`RESULT-HARD hybrid_r1=${f(h.hybrid_r1)} hybrid_mrr=${f(h.hybrid_mrr)} ` +
  `full_r1=${f(h.full_r1)} full_mrr=${f(h.full_mrr)} n=${h.n ?? 0}`);
' "$work/bench.json"
