#!/usr/bin/env bash
# bench-vault — run a Korean bench over a real vault instead of the synthetic fixture.
#
# Usage: bash scripts/bench-vault.sh <vault-dir> <goldset.json> [--embed]
#   node scripts/bench-vault-goldset.mjs <vault-dir> <goldset.json> [collection] [per-bucket]
#     builds the goldset from the vault's own Korean headings and body clauses.
#
# The vault stays where it is; nothing is copied into the repo. Index and results land under
# tmp/real-bench/<vault name>/. Lex-only by default — pass --embed to also measure the vector
# and hybrid backends (slow: it embeds every document).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
vault="$(cd "$1" && pwd)"; bench="$2"; shift 2
name="$(basename "$vault")"
work="$ROOT/tmp/real-bench/$name"  # gitignored scratch, never the vault itself
# The work directory is derived from the vault's name, so a vault that already lives in
# tmp/real-bench resolves to itself and the rm below would delete the corpus being measured.
case "$vault" in
  "$work"|"$work"/*) echo "vault $vault is inside the work directory $work — move it out" >&2; exit 1 ;;
esac
rm -rf "$work"; mkdir -p "$work/config"
export INDEX_PATH="$work/index.sqlite"
export QMD_CONFIG_DIR="$work/config"
collection="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).collection)' "$bench")"
cat > "$QMD_CONFIG_DIR/index.yml" <<YML
collections:
  $collection:
    path: "$vault"
    pattern: "wiki/**/*.md"
models:
  embed: "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
YML
qmd() { npm run --silent qmd -- --index index "$@"; }
qmd update >&2
if [ "${1:-}" = "--embed" ]; then qmd embed >&2; fi
qmd bench "$bench" --json > "$work/bench.json"
node scripts/bench-vault-report.mjs "$work/bench.json"
echo "json: $work/bench.json"
