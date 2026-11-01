#!/usr/bin/env bash
# rag-ko — RAG answer evaluation over the ko-vault question set (eval stage 3).
#
# Usage: bash scripts/rag-ko.sh                    # bench → retrieve → answer + grade per prompt → report
#        RAG_SKIP_RETRIEVE=1 bash scripts/rag-ko.sh  # reuse rag/contexts.json (same chunks, new answers)
#
# 1. scripts/bench-ko.sh with KO_BENCH=test/fixtures/ko-vault/rag/questions.json builds the isolated
#    tmp/bench-ko index (embeds the fixture, loads the reranker — local models, not for CI) and
#    records retrieval metrics in tmp/bench-ko/bench.json.
# 2. scripts/rag/retrieve.ts fetches the top RAG_K chunks per question from that index once →
#    rag/contexts.json. Every prompt variant answers from these same chunks.
# 3. For each variant in RAG_PROMPTS: scripts/rag/answer.ts (RAG_MODEL) → rag/answers-<v>.json, then
#    scripts/rag/grade.ts (RAG_JUDGE_MODEL) → rag/grades-<v>.json.
# 4. scripts/rag/report.ts prints RUN / FAITH / CITE / GOLDCITE / CONTEXT / ABSTAIN per variant and
#    DIFF (second − first) and writes rag/report.json.
#
# Env: RAG_PROMPTS (baseline,grounded) · RAG_MODEL (gemma3:4b) · RAG_JUDGE_MODEL (qwen3:8b) · RAG_K (5)
#      OLLAMA_HOST
# Exit: 0 · 2 a step failed (bench, retrieval, a reply that failed validation twice, bad input).
set -euo pipefail
unset CDPATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
rag="test/fixtures/ko-vault/rag"
contexts="$rag/contexts.json"
IFS=, read -r -a prompts <<< "${RAG_PROMPTS:-baseline,grounded}"
case "${#prompts[@]}" in
  1 | 2) ;;
  *) echo "RAG_PROMPTS must name one or two prompt variants, got: ${RAG_PROMPTS:-}" >&2; exit 2 ;;
esac

if [ -z "${RAG_SKIP_RETRIEVE:-}" ]; then
  KO_BENCH="$rag/questions.json" bash scripts/bench-ko.sh >&2 || { echo "bench-ko.sh failed" >&2; exit 2; }
  rm -f "$contexts"
  npx --no-install tsx scripts/rag/retrieve.ts tmp/bench-ko/index.sqlite tmp/bench-ko/config/index.yml "$rag/questions.json" "$contexts" ||
    { echo "retrieve.ts failed" >&2; exit 2; }
fi
[ -f "$contexts" ] || { echo "no $contexts — run without RAG_SKIP_RETRIEVE first" >&2; exit 2; }

commit="$(git rev-parse --short HEAD)"
# A step with failed questions still writes its file, so the report runs anyway — stale outputs
# from an earlier run must not sit next to new ones — and the exit stays 2.
rc=0
args=()
for p in "${prompts[@]}"; do
  answers="$rag/answers-$p.json"
  grades="$rag/grades-$p.json"
  rm -f "$answers" "$grades"
  RAG_PROMPT="$p" RAG_COMMIT="$commit" npx --no-install tsx scripts/rag/answer.ts "$contexts" "$answers" || rc=2
  [ -f "$answers" ] || exit 2
  RAG_COMMIT="$commit" npx --no-install tsx scripts/rag/grade.ts "$contexts" "$answers" "$grades" || rc=2
  [ -f "$grades" ] || exit 2
  args+=("$answers" "$grades")
done
rm -f "$rag/report.json"
npx --no-install tsx scripts/rag/report.ts "$contexts" "${args[@]}" --out "$rag/report.json" || rc=2
exit "$rc"
