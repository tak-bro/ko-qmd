#!/usr/bin/env bash
# autoresearch/prepare.sh — one-time data setup for the rerank-input loop (program.md). The loop
# never runs or edits this script; it only reads what it leaves in $AUTORESEARCH_DIR.
#
# Usage: bash scripts/autoresearch/prepare.sh <collection> [corpus|generate|split]...
#   <collection>  a qmd collection name; its path comes from `qmd collection show`, so no vault
#                 path or name is written into git
#   steps         default all three, in order:
#     corpus      copy the collection's *.md files into $AUTORESEARCH_DIR/corpus/wiki/ (read-only
#                 source; the generator reads <vault>/wiki and names answers wiki/<path>), and
#                 remove indexes built from an older copy
#     generate    paraphrase goldset from the copy with ollama (scripts/bench-vault-paraphrase.ts);
#                 about 2 min per document with qwen3:4b, checkpointed after each document
#     split       seeded 80/20 split by answer document into train.json and heldout.json, so two
#                 paraphrases of one note never land on both sides. Fails when train < 100 or
#                 held-out < 25 (the files are still written) — generate from more documents
#
# Env: AUTORESEARCH_DIR  data dir (default: <main checkout>/tmp/autoresearch — the main checkout,
#                        not this worktree, so a loop worktree reads the same data). Inside the
#                        repo it must be gitignored; the run stops otherwise
#      AR_DOCS           documents to generate from (default 80)
#      AR_SEED           shuffle seed for generation and split (default 1)
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

for step in $steps; do
  case "$step" in
    corpus)
      # From $HOME with the default index name, so no .qmd/index.yml above cwd can redirect it.
      src="$(cd "$HOME" && qmd --index index collection show "$collection" | sed -n 's/^  Path: *//p')"
      [ -d "$src" ] || { echo "collection $collection has no readable path: '$src'" >&2; exit 1; }
      rm -rf "$dir/corpus" "$dir"/index-*
      mkdir -p "$dir/corpus/wiki"
      (cd "$src" && find . -name '*.md' -type f -print0 | while IFS= read -r -d '' f; do
        mkdir -p "$dir/corpus/wiki/$(dirname "$f")"
        cp "$f" "$dir/corpus/wiki/$f"
      done)
      echo "corpus: $(find "$dir/corpus" -name '*.md' | wc -l | tr -d ' ') files" >&2
      ;;
    generate)
      ollama list | grep -q '^qwen3:4b' || { echo "missing ollama model: run 'ollama pull qwen3:4b'" >&2; exit 1; }
      (cd "$ROOT" && npx tsx scripts/bench-vault-paraphrase.ts "$dir/corpus" "$dir/generated.json" \
        --collection vault --docs "$docs" --seed "$seed" --keep-rejects "$dir/rejects.json")
      ;;
    split)
      node -e '
const fs = require("fs");
const [gen, dir, seed] = process.argv.slice(1);
const g = JSON.parse(fs.readFileSync(gen, "utf8"));
// mulberry32: a fixed seed gives the same split on every machine.
let a = Number(seed) >>> 0;
const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const groups = [...new Set(g.queries.map(q => q.expected_files[0]))].sort();
for (let i = groups.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [groups[i], groups[j]] = [groups[j], groups[i]]; }
const heldDocs = new Set(groups.slice(Math.round(groups.length * 0.8)));
const held = g.queries.filter(q => heldDocs.has(q.expected_files[0]));
const train = g.queries.filter(q => !heldDocs.has(q.expected_files[0]));
const out = (name, queries) => fs.writeFileSync(`${dir}/${name}`, JSON.stringify({ ...g, queries }, null, 1));
out("train.json", train);
out("heldout.json", held);
console.error(`split: ${train.length} train, ${held.length} held-out of ${g.queries.length} (${groups.length} documents)`);
if (train.length < 100 || held.length < 25) { console.error("short: need train >= 100 and held-out >= 25"); process.exit(1); }
' "$dir/generated.json" "$dir" "$seed"
      ;;
    *) echo "unknown step: $step" >&2; exit 1 ;;
  esac
done
