#!/usr/bin/env bash
# autoresearch/prepare.sh — one-time data setup for the rerank-input loop (program.md). The loop
# never runs or edits this script; it only reads what it leaves in $AUTORESEARCH_DIR.
#
# Usage: bash scripts/autoresearch/prepare.sh <collection> [corpus|generate|split]...
#   <collection>  a qmd collection name; its path comes from `qmd collection show`, so no vault
#                 path or name is written into git
#   steps         default all three, in order:
#     corpus      copy the collection's *.md files into $AUTORESEARCH_DIR/corpus/wiki/ and each
#                 AR_EXTRA_DIRS sibling of the collection directory into corpus/<name>/ (read-only
#                 sources; answers are named <dir>/<path>), and remove indexes built from an older copy
#     generate    paraphrase goldset from the copy with ollama (scripts/bench-vault-paraphrase.ts);
#                 about 2 min per document with qwen3:4b, checkpointed after each document. Run 1
#                 writes generated.json; run N (AR_RUN) writes generated-N.json from documents no
#                 earlier run has an answer in. Rejected queries go to generated[-N]-rejects.json
#     split       merge every generated*.json, drop the ids listed in dropped.txt (review), and make a
#                 seeded 80/20 split by answer document into train.json and heldout.json, so two
#                 paraphrases of one note never land on both sides. Each run splits only the
#                 documents it adds, so an earlier split never changes. Run N's ids are prefixed rN-,
#                 and dropped.txt must list them with that prefix. A run that adds 1 or 2 documents
#                 holds none of them out (round(n*0.8) == n). The merged files list their source
#                 runs in "runs". Fails when train < 100 or held-out < 25 (the files are still written)
#
# Env: AUTORESEARCH_DIR  data dir (default: <main checkout>/tmp/autoresearch — the main checkout,
#                        not this worktree, so a loop worktree reads the same data). Inside the
#                        repo it must be gitignored; the run stops otherwise
#      AR_DOCS           documents to generate from (default 80)
#      AR_SEED           shuffle seed for generation and split (default 1)
#      AR_EXTRA_DIRS     sibling directories of the collection to add, space-separated names (e.g.
#                        "outputs docs"); names only, so no vault path is written into git
#      AR_RUN            generation run number (default 1)
set -euo pipefail
unset CDPATH

[ $# -ge 1 ] || { echo "usage: prepare.sh <collection> [corpus|generate|split]..." >&2; exit 1; }
collection="$1"; shift
case "$collection" in -*|"") echo "collection name must not start with '-': $collection" >&2; exit 1 ;; esac
steps="${*:-corpus generate split}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
main_root="$(cd "$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)/.." && pwd -P)"
dir="${AUTORESEARCH_DIR:-$main_root/tmp/autoresearch}"
mkdir -p "$dir"
# Absolute from here on: every step below changes directory, and rm/cp must agree on one tree.
dir="$(cd "$dir" && pwd -P)"
for tree in "$main_root" "$(cd "$ROOT" && pwd -P)"; do
  case "$dir/" in
    "$tree"/*) git -C "$tree" check-ignore -q "$dir" \
      || { echo "AUTORESEARCH_DIR is inside a checkout but not gitignored: $dir" >&2; exit 1; } ;;
  esac
done
docs="${AR_DOCS:-80}"
seed="${AR_SEED:-1}"
extra_dirs="${AR_EXTRA_DIRS:-}"
run="${AR_RUN:-1}"
[[ "$run" =~ ^[1-9][0-9]*$ ]] || { echo "AR_RUN must be a positive integer: $run" >&2; exit 1; }
# Split on spaces without glob expansion, so AR_EXTRA_DIRS='*' is rejected instead of expanded.
set -f; extra=($extra_dirs); set +f
for d in ${extra[@]+"${extra[@]}"}; do
  [[ "$d" =~ ^[A-Za-z0-9_][A-Za-z0-9._-]*$ && "$d" != wiki ]] || { echo "AR_EXTRA_DIRS entries must be plain names other than wiki: $d" >&2; exit 1; }
done

for step in $steps; do
  case "$step" in
    corpus)
      # From $HOME with the default index name, so no .qmd/index.yml above cwd can redirect it.
      src="$(cd "$HOME" && qmd --index index collection show "$collection" | sed -n 's/^  Path: *//p')"
      [ -d "$src" ] || { echo "collection $collection has no readable path: '$src'" >&2; exit 1; }
      rm -rf "$dir/corpus" "$dir"/index-*
      mkdir -p "$dir/corpus/wiki"
      copy_md() { # copy_md <source dir> <corpus subdir>
        (cd "$1" && find . -name '*.md' -type f -print0 | while IFS= read -r -d '' f; do
          mkdir -p "$dir/corpus/$2/$(dirname "$f")"
          cp "$f" "$dir/corpus/$2/$f"
        done)
      }
      copy_md "$src" wiki
      for d in ${extra[@]+"${extra[@]}"}; do
        [ -d "$src/../$d" ] || { echo "no directory $d beside the collection" >&2; exit 1; }
        copy_md "$src/../$d" "$d"
      done
      echo "corpus: $(find "$dir/corpus" -name '*.md' | wc -l | tr -d ' ') files" >&2
      ;;
    generate)
      ollama list | grep -q '^qwen3:4b' || { echo "missing ollama model: run 'ollama pull qwen3:4b'" >&2; exit 1; }
      dirs="$(IFS=,; echo "wiki${extra[*]+,${extra[*]}}")"
      if [ "$run" = 1 ]; then
        out="$dir/generated.json"; skip=()
      else
        out="$dir/generated-$run.json"
        # Every earlier run's answers, merged into one goldset for --skip.
        node -e '
const fs = require("fs");
const [dir, run, out] = process.argv.slice(1);
const files = ["generated.json", ...Array.from({ length: run - 2 }, (_, i) => `generated-${i + 2}.json`)];
const queries = files.filter(f => fs.existsSync(`${dir}/${f}`))
  .flatMap(f => JSON.parse(fs.readFileSync(`${dir}/${f}`, "utf8")).queries);
fs.writeFileSync(out, JSON.stringify({ queries }));' "$dir" "$run" "$dir/.skip-$run.json"
        skip=(--skip "$dir/.skip-$run.json")
      fi
      (cd "$ROOT" && npx tsx scripts/bench-vault-paraphrase.ts "$dir/corpus" "$out" \
        --collection vault --dirs "$dirs" --docs "$docs" --seed "$seed" ${skip[@]+"${skip[@]}"} \
        --keep-rejects "${out%.json}-rejects.json")
      ;;
    split)
      node -e '
const fs = require("fs");
const [gen, dir, seed] = process.argv.slice(1);
const runs = fs.readdirSync(dir).map(f => f.match(/^generated(?:-([0-9]+))?\.json$/)).filter(Boolean)
  .map(m => ({ file: m[0], run: Number(m[1] ?? 1) })).sort((a, b) => a.run - b.run);
const dropFile = `${dir}/dropped.txt`;
const dropped = new Set(fs.existsSync(dropFile) ? fs.readFileSync(dropFile, "utf8").split(/\s+/).filter(Boolean) : []);
const g = JSON.parse(fs.readFileSync(gen, "utf8"));
g.queries = [];
// Each run splits only the documents it adds, with a fresh seeded shuffle, so a later run never
// moves a document of an earlier run between train and held-out.
const heldDocs = new Set();
let groupCount = 0;
for (const { file, run } of runs) {
  const qs = JSON.parse(fs.readFileSync(`${dir}/${file}`, "utf8")).queries
    .map(q => run === 1 ? q : { ...q, id: `r${run}-${q.id}` });
  const known = new Set(g.queries.map(q => q.expected_files[0]));
  g.queries.push(...qs);
  // mulberry32: a fixed seed gives the same split on every machine.
  let a = (Number(seed) + run - 1) >>> 0;
  const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const groups = [...new Set(qs.map(q => q.expected_files[0]))].filter(d => !known.has(d)).sort();
  for (let i = groups.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [groups[i], groups[j]] = [groups[j], groups[i]]; }
  for (const d of groups.slice(Math.round(groups.length * 0.8))) heldDocs.add(d);
  groupCount += groups.length;
}
// Dropped after grouping, so a reviewed drop never reshuffles which documents are held out.
const kept = g.queries.filter(q => !dropped.has(q.id));
const held = kept.filter(q => heldDocs.has(q.expected_files[0]));
const train = kept.filter(q => !heldDocs.has(q.expected_files[0]));
const out = (name, queries) => fs.writeFileSync(`${dir}/${name}`, JSON.stringify({ ...g, docs_done: undefined, docs_total: undefined, runs: runs.map(r => r.file), queries }, null, 1));
out("train.json", train);
out("heldout.json", held);
console.error(`split: ${train.length} train, ${held.length} held-out of ${kept.length} (${groupCount} documents, ${g.queries.length - kept.length} dropped)`);
if (train.length < 100 || held.length < 25) { console.error("short: need train >= 100 and held-out >= 25"); process.exit(1); }
' "$dir/generated.json" "$dir" "$seed"
      ;;
    *) echo "unknown step: $step" >&2; exit 1 ;;
  esac
done
