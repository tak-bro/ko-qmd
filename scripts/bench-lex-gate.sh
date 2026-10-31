#!/usr/bin/env bash
# bench-lex-gate — the lex (BM25) evaluation gate. Benches bm25 alone over test/fixtures/ko-vault and
# compares each query's recall@5 and reciprocal rank with the committed baseline.
#
# Usage: bash scripts/bench-lex-gate.sh                    # check against the baseline
#        bash scripts/bench-lex-gate.sh --update-baseline  # rewrite the baseline from this run
#        LEX_REPS=<n> bash scripts/bench-lex-gate.sh       # repeat count (default 5)
#
# No model is needed: the index is built with `qmd update` only (no `qmd embed`), the generated
# index.yml has no `models:` block, and `qmd bench --backend bm25` never touches the vector or
# rerank paths. CI runs this as the `lex-gate` job (.github/workflows/ci.yml; its push/PR branches).
#
# Each of the LEX_REPS runs rebuilds the index from scratch, so the `NOISE` line measures
# run-to-run variation of the whole index + search path. The verdict uses the per-query mean.
# Verdict rules (paired bootstrap over queries, seeded) live in src/bench/gate.ts.
#
# stdout (fixed lines, parsed by nothing but humans and the CI log):
#   NOISE reps=<n> differing=<k> max_abs=<f>
#   LEX r5=<f> mrr=<f> baseline_r5=<f> baseline_mrr=<f> n=<queries>
#   DELTA r5=<f> [<lo>, <hi>] mrr=<f> [<lo>, <hi>]
#   DROP <id> r5=<b>-><c> rr=<b>-><c>        (one per query that scores lower)
#   GATE <PASS|WARN|FAIL> <reason>
# Exit: 0 on PASS or WARN, 1 on FAIL, 2 on a usage or input error.
set -euo pipefail
unset CDPATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode=check
case "${1:-}" in
  "") ;;
  --update-baseline) mode=update ;;
  *) echo "usage: bash scripts/bench-lex-gate.sh [--update-baseline]" >&2; exit 2 ;;
esac
# `:-` alone would read a set-but-empty LEX_REPS as unset and run the default count without a word.
[ -n "${LEX_REPS-unset}" ] || { echo "LEX_REPS must be a positive integer, got an empty value" >&2; exit 2; }
reps="${LEX_REPS:-5}"
case "$reps" in
  '' | *[!0-9]* | 0) echo "LEX_REPS must be a positive integer, got: $reps" >&2; exit 2 ;;
esac

[ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm install --no-audit --no-fund >&2)
cd "$ROOT"

fixture="$ROOT/test/fixtures/ko-vault"
goldset="$fixture/ko-bench.json"
baseline="$fixture/lex-baseline.json"
work="$ROOT/tmp/bench-lex-gate"
rm -rf "$work"
mkdir -p "$work"
export INDEX_PATH="$work/index.sqlite"
export QMD_CONFIG_DIR="$work/config"

# The goldset's collection name goes into index.yml unquoted, so it is held to a plain identifier
# (same rule as scripts/bench-ko.sh).
collection="$(node -e '
const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).collection;
if (typeof c !== "string" || !/^[A-Za-z0-9._-]+$/.test(c)) {
  console.error(`goldset collection must match [A-Za-z0-9._-]+, got ${JSON.stringify(c)}`);
  process.exit(2);
}
console.log(c);' "$goldset")"

qmd() { npm run --silent qmd -- --index index "$@"; }

runs=()
for i in $(seq 1 "$reps"); do
  rm -rf "$QMD_CONFIG_DIR" "$work"/index.sqlite*
  mkdir -p "$QMD_CONFIG_DIR"
  {
    echo "collections:"
    echo "  $collection:"
    echo "    path: $(node -e 'console.log(JSON.stringify(process.argv[1]))' "$fixture")"
    echo "    pattern: \"{wiki,distractors}/**/*.md\""
  } > "$QMD_CONFIG_DIR/index.yml"
  qmd update > "$work/update-$i.log" 2>&1 || { cat "$work/update-$i.log" >&2; exit 2; }
  qmd bench "$goldset" --backend bm25 --json > "$work/run-$i.json" || { echo "qmd bench failed (run $i)" >&2; exit 2; }
  runs+=("$work/run-$i.json")
done

commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
LEX_COMMIT="$commit" npx --no-install tsx scripts/bench-lex-gate.ts "$mode" "$baseline" "${runs[@]}"
