#!/usr/bin/env bash
# autoresearch/eval.sh — the fixed evaluation the rerank-input loop optimizes (program.md). The loop
# runs it and never edits it.
#
# Usage: bash scripts/autoresearch/eval.sh [--baseline | --dir]
#   --baseline  record this run's bm25/vector/hybrid top_files as the invariant reference for the
#               goldset and index (baseline-<goldset>-<index key>.json). Run once, before the first
#               experiment, and again after prepare.sh rebuilds the data.
#   --dir       print the resolved data dir and exit (for the loop's own files: run.log, results.tsv)
#
# stdout, in order (nothing else):
#   METRIC train_full_mrr=<f>                      summary.full.avg_mrr — the number the loop raises
#   INVARIANT bm25=<same|changed> vector=<…> hybrid=<…>   top_files per query vs the baseline
#   SECONDS <n>
# The line name says train_full_mrr for any AR_GOLDSET; slice 06 runs heldout.json through it too.
# Exit non-zero with no METRIC line when the data, the baseline or the bench is missing, so a loop
# can never score against nothing; METRIC is printed only after the invariants are computed.
#
# Env: AUTORESEARCH_DIR  data dir from prepare.sh (default: <main checkout>/tmp/autoresearch)
#      AR_GOLDSET        goldset file name inside it (default train.json; a plain *.json name)
#
# The index is built once per corpus content + models.yml hash (index-<key>/) and reused: the loop
# edits only search-time rerank input, never indexing. Rerank scores persist in rerank-cache.sqlite
# (QMD_RERANK_CACHE), so an experiment pays only for the pairs it changed.
set -euo pipefail
unset CDPATH
start=$(date +%s)

baseline_mode=0
[ "${1:-}" = "--baseline" ] && baseline_mode=1
dir_mode=0
[ "${1:-}" = "--dir" ] && dir_mode=1

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
main_root="$(cd "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)/.." && pwd -P)"
dir="${AUTORESEARCH_DIR:-$main_root/tmp/autoresearch}"
[ -d "$dir/corpus" ] || { echo "no corpus in $dir — run prepare.sh first" >&2; exit 1; }
# Absolute from here on: the script changes directory before writing into it.
dir="$(cd "$dir" && pwd -P)"
for tree in "$main_root" "$(cd "$ROOT" && pwd -P)"; do
  case "$dir/" in
    "$tree"/*) git -C "$tree" check-ignore -q "$dir" \
      || { echo "AUTORESEARCH_DIR is inside a checkout but not gitignored: $dir" >&2; exit 1; } ;;
  esac
done
[ "$dir_mode" = 0 ] || { echo "$dir"; exit 0; }
goldset_name="${AR_GOLDSET:-train.json}"
[[ "$goldset_name" =~ ^[A-Za-z0-9_-][A-Za-z0-9._-]*\.json$ ]] || { echo "AR_GOLDSET must be a plain *.json name: $goldset_name" >&2; exit 1; }
goldset="$dir/$goldset_name"
models="$ROOT/test/fixtures/ko-vault/models.yml"

[ -f "$goldset" ] || { echo "no goldset $goldset — run prepare.sh first" >&2; exit 1; }
[ -d "$ROOT/node_modules" ] || { echo "no node_modules in $ROOT — symlink the main checkout's" >&2; exit 1; }

key="$( { (cd "$dir/corpus" && find . -type f -name '*.md' -print0 | sort -z | xargs -0 shasum); shasum < "$models"; } | shasum | cut -c1-12)"
index_dir="$dir/index-$key"
baseline="$dir/baseline-${goldset_name%.json}-$key.json"
[ "$baseline_mode" = 1 ] || [ -f "$baseline" ] || { echo "no baseline $baseline — run eval.sh --baseline once" >&2; exit 1; }
export INDEX_PATH="$index_dir/index.sqlite"
export QMD_CONFIG_DIR="$index_dir/config"
export QMD_RERANK_CACHE="$dir/rerank-cache.sqlite"
cd "$ROOT"
qmd() { npm run --silent qmd -- --index index "$@"; }

if [ ! -f "$index_dir/ready" ]; then
  rm -rf "$index_dir"
  mkdir -p "$QMD_CONFIG_DIR"
  {
    echo "collections:"
    echo "  vault:"
    echo "    path: $(node -e 'console.log(JSON.stringify(process.argv[1]))' "$dir/corpus")"
    echo "    pattern: \"**/*.md\""
    echo "models:"
    grep -E '^[a-z]+:' "$models" | sed 's/^/  /'
  } > "$QMD_CONFIG_DIR/index.yml"
  qmd update >&2
  qmd embed >&2
  touch "$index_dir/ready"
fi

# Seam form, as bench-ko: each one-line query reaches the bench as `lex: <q>` + `vec: <q>`.
seam="$dir/.seam-${goldset_name}"
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
j.queries = j.queries.map(q => ({ ...q, query: `lex: ${q.query.trim()}\nvec: ${q.query.trim()}` }));
fs.writeFileSync(process.argv[2], JSON.stringify(j, null, 1));' "$goldset" "$seam"

out="$dir/last-bench-${goldset_name}"
qmd bench "$seam" --json > "$out"

[ "$baseline_mode" = 1 ] && cp "$out" "$baseline"

node -e '
const fs = require("fs");
const run = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const base = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const mrr = run.summary?.full?.avg_mrr;
if (!Number.isFinite(mrr)) { console.error("bench has no full backend summary"); process.exit(1); }
const byId = new Map(base.results.map(r => [r.id, r]));
const same = b => run.results.every(r =>
  JSON.stringify(r.backends?.[b]?.top_files) === JSON.stringify(byId.get(r.id)?.backends?.[b]?.top_files));
const invariant = ["bm25", "vector", "hybrid"].map(b => `${b}=${same(b) ? "same" : "changed"}`).join(" ");
console.log(`METRIC train_full_mrr=${mrr.toFixed(4)}`);
console.log(`INVARIANT ${invariant}`);
' "$out" "$baseline"
echo "SECONDS $(( $(date +%s) - start ))"
