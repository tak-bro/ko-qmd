#!/usr/bin/env bash
# bench-ko — isolated `qmd bench` over test/fixtures/ko-vault using the current branch's source.
#
# Usage: bash scripts/bench-ko.sh
#        KO_CORPUS=<dir> KO_BENCH=<goldset.json> KO_FORM=<seam|plain> bash scripts/bench-ko.sh
#
# KO_FORM picks how the goldset reaches `qmd bench`. `seam` (the default) rewrites every one-line
# query as `lex: <q>` + `vec: <q>` into tmp/bench-ko/ko-bench.seam.json — the shape REST/MCP
# callers send, which routes hybrid/full through structuredSearch with no LLM query expansion. A
# query already written as `lex:`/`vec:`/`hyde:`/`intent:` lines passes through as written.
# `plain` benches the goldset as written, so a plain query goes through hybridQuery and its query
# expansion. The dogfood gate runs the default and refuses a baseline line of another form.
#
# KO_CORPUS swaps the indexed corpus: a directory holding `wiki/` and `distractors/` like the
# fixture does (e.g. a summary-augmented copy). KO_BENCH swaps the goldset. Either may be
# relative to the caller's cwd. models.yml always comes from the committed fixture, and the
# resolved paths are echoed to stderr as `corpus=` / `bench=` so a run shows what it measured.
# A set-but-empty override, an unknown KO_FORM, a corpus without `wiki/`, a KO_BENCH inside
# tmp/bench-ko/, a goldset whose `queries` is not a list of one-line or typed string queries, or a
# goldset `collection` outside [A-Za-z0-9._-] stops the run before the previous output is removed.
#
# Isolation: INDEX_PATH and QMD_CONFIG_DIR live under tmp/bench-ko/ and are rebuilt every run.
# `--index index` is passed explicitly so qmd does not walk up from cwd to a .qmd/index.yml.
# Model cache (~/.cache/qmd/models) is shared, read-only here. Models come from the committed
# test/fixtures/ko-vault/models.yml.
#
# stdout: first line `RESULT bm25_r5=<f> vector_r5=<f> hybrid_r5=<f> full_r5=<f> full_mrr=<f>`
# (format fixed — scripts/dogfood.sh's bm25_of regex parses it), then `RESULT-HARD
# hybrid_r1=<f> hybrid_mrr=<f> full_r1=<f> full_mrr=<f> n=<n> form=<seam|plain>` pooling the hard
# query types (sem-hard/multi/neg) weighted by query count; `n=0` and `nan` while the fixture
# has no hard queries. Full bench JSON is kept at tmp/bench-ko/bench.json.
set -euo pipefail
# An exported CDPATH makes `cd` resolve elsewhere and print the path into $(...).
unset CDPATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Checked at ROOT, not the caller's cwd: a run from another directory must not npm-install there.
[ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm install --no-audit --no-fund >&2)

# Overrides are made absolute before `cd "$ROOT"` so a relative path means the caller's cwd, and a
# bad one stops here — before the rm below clears the previous run's output. `:-` alone would
# read an empty override as unset and quietly measure the fixture instead.
fixture="$ROOT/test/fixtures/ko-vault"
work="$ROOT/tmp/bench-ko"
[ -n "${KO_CORPUS-unset}" ] || { echo "KO_CORPUS is set but empty" >&2; exit 1; }
[ -n "${KO_BENCH-unset}" ] || { echo "KO_BENCH is set but empty" >&2; exit 1; }
[ -n "${KO_FORM-unset}" ] || { echo "KO_FORM is set but empty" >&2; exit 1; }
form="${KO_FORM:-seam}"
case "$form" in
  seam | plain) ;;
  *) echo "KO_FORM must be seam or plain, got: $form" >&2; exit 1 ;;
esac
corpus="${KO_CORPUS:-$fixture}"
bench_json="${KO_BENCH:-$fixture/ko-bench.json}"
[ -d "$corpus" ] || { echo "KO_CORPUS is not a directory: $corpus" >&2; exit 1; }
[ -d "$corpus/wiki" ] || { echo "KO_CORPUS has no wiki/ (point it at the dir holding wiki/ and distractors/): $corpus" >&2; exit 1; }
[ -f "$bench_json" ] || { echo "KO_BENCH is not a file: $bench_json" >&2; exit 1; }
corpus="$(cd "$corpus" && pwd)"
bench_json="$(cd "$(dirname "$bench_json")" && pwd)/$(basename "$bench_json")"
# Compared as physical paths: a symlink into tmp/bench-ko/ would slip past a logical comparison.
case "$(cd "$(dirname "$bench_json")" && pwd -P)/" in
  "$(cd "$ROOT" && pwd -P)/tmp/bench-ko/"*)
    echo "KO_BENCH must not be inside tmp/bench-ko/ — the run clears its outputs there: $bench_json" >&2; exit 1 ;;
esac
echo "corpus=$corpus" >&2
echo "bench=$bench_json" >&2
echo "form=$form" >&2
cd "$ROOT"

# The name lands unquoted in index.yml, so it is held to a plain identifier: a newline would let a
# goldset inject keys — an `update:` hook is a shell command `qmd update` runs.
# The queries are checked here too, since the seam rewrite below runs after the rm. A query must be
# one line (plain) or lines that each carry a lex:/vec:/hyde:/intent: prefix (typed). Several lines
# without prefixes make src/bench/bench.ts parseStructuredQuery throw, and the backend would score
# that query 0 without a word. The parser's finer rules for typed lines (text after the prefix, one
# intent: at most) are left to it.
collection="$(node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const c = j.collection;
if (typeof c !== "string" || !/^[A-Za-z0-9._-]+$/.test(c)) {
  console.error(`goldset collection must match [A-Za-z0-9._-]+, got ${JSON.stringify(c)}: ${process.argv[1]}`);
  process.exit(1);
}
if (!Array.isArray(j.queries) || !j.queries.every(q => q && typeof q.query === "string")) {
  console.error(`goldset queries must be a list of {query: string}: ${process.argv[1]}`);
  process.exit(1);
}
const typed = /^(lex|vec|hyde|intent):/i;
for (const q of j.queries) {
  const lines = q.query.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0 || (lines.length > 1 && !lines.every(l => typed.test(l)))) {
    console.error(`goldset query ${q.id} must be one line or typed lex:/vec:/hyde:/intent: lines: ${process.argv[1]}`);
    process.exit(1);
  }
}
console.log(c);' "$bench_json")"

# Remove only this script's outputs — the autoloop runner keeps loop-B-*.log in the same dir.
rm -rf "$work/config" "$work"/index.sqlite* "$work/bench.json" "$work/ko-bench.seam.json"
mkdir -p "$work/config"
export INDEX_PATH="$work/index.sqlite"
export QMD_CONFIG_DIR="$work/config"

goldset="$bench_json"
if [ "$form" = seam ]; then
  goldset="$work/ko-bench.seam.json"
  node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const typed = /^(lex|vec|hyde|intent):/i;
j.queries = j.queries.map(q => {
  const lines = q.query.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.some(l => typed.test(l))) return q;
  return { ...q, query: `lex: ${lines[0]}\nvec: ${lines[0]}` };
});
fs.writeFileSync(process.argv[2], JSON.stringify(j, null, 2) + "\n");' "$bench_json" "$goldset"
fi

# Collection root is the corpus dir (ko-vault/, not wiki/) so result paths keep the `wiki/` prefix —
# bench matches by path suffix. Brace pattern indexes wiki/** and distractors/** (near-topic decoys);
# README.md and BASELINE.md at the fixture root stay out.
{
  echo "collections:"
  echo "  $collection:"
  # JSON string = valid YAML double-quoted scalar, so any directory name stays one value.
  echo "    path: $(node -e 'console.log(JSON.stringify(process.argv[1]))' "$corpus")"
  echo "    pattern: \"{wiki,distractors}/**/*.md\""
  echo "models:"
  grep -E '^[a-z]+:' "$fixture/models.yml" | sed 's/^/  /'
} > "$QMD_CONFIG_DIR/index.yml"

qmd() { npm run --silent qmd -- --index index "$@"; }

qmd update >&2
qmd embed >&2
qmd bench "$goldset" --json > "$work/bench.json"

node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const s = j.summary;
const h = j.summary_hard || {};
const f = v => Number.isFinite(v) ? v.toFixed(4) : "nan";
const g = (b, k) => f(s[b] ? s[b][k] : NaN);
console.log(`RESULT bm25_r5=${g("bm25","avg_recall_at_5")} vector_r5=${g("vector","avg_recall_at_5")} ` +
  `hybrid_r5=${g("hybrid","avg_recall_at_5")} full_r5=${g("full","avg_recall_at_5")} full_mrr=${g("full","avg_mrr")}`);
console.log(`RESULT-HARD hybrid_r1=${f(h.hybrid_r1)} hybrid_mrr=${f(h.hybrid_mrr)} ` +
  `full_r1=${f(h.full_r1)} full_mrr=${f(h.full_mrr)} n=${h.n ?? 0} form=${process.argv[2]}`);
' "$work/bench.json" "$form"
