#!/usr/bin/env bash
# judge-ko — LLM-as-judge relevance grading over the ko-vault judge query set (eval stage 2).
#
# Usage: bash scripts/judge-ko.sh            # bench → judge → report
#        JUDGE_SKIP_BENCH=1 bash scripts/judge-ko.sh   # reuse tmp/bench-ko/bench.json
#
# 1. scripts/bench-ko.sh with KO_BENCH=test/fixtures/ko-vault/judge/queries.json (seam form, isolated
#    index, embeds the fixture and loads the reranker — local models, not for CI).
# 2. scripts/judge/run.ts grades every query's pool (union of bm25/hybrid/full top 10) with the
#    Ollama judge model, once per seed in JUDGE_SEEDS → test/fixtures/ko-vault/judge/judgments.json.
# 3. scripts/judge/report.ts prints JUDGE / POSITION / GOLD / OFFCORPUS / NDCG / NDCG-DIFF / KAPPA
#    and writes judge/report.json. KAPPA stays "pending" until judge/labels.json holds hand labels
#    (npx tsx scripts/judge/label.ts).
#
# Env passes through to run.ts: JUDGE_MODEL (qwen3:8b), OLLAMA_HOST, JUDGE_SEEDS (1,2), JUDGE_BACKENDS.
# Exit: 0 · 2 a step failed (bench, an Ollama call that failed validation twice, bad input).
set -euo pipefail
unset CDPATH

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
judge="test/fixtures/ko-vault/judge"
bench="tmp/bench-ko/bench.json"

if [ -z "${JUDGE_SKIP_BENCH:-}" ]; then
  KO_BENCH="$judge/queries.json" bash scripts/bench-ko.sh >&2 || { echo "bench-ko.sh failed" >&2; exit 2; }
fi
[ -f "$bench" ] || { echo "no $bench — run without JUDGE_SKIP_BENCH first" >&2; exit 2; }

commit="$(git rev-parse --short HEAD)"
JUDGE_COMMIT="$commit" npx --no-install tsx scripts/judge/run.ts "$bench" "$judge/queries.json" "$judge/judgments.json" || exit 2
npx --no-install tsx scripts/judge/report.ts "$judge/judgments.json" "$judge/queries.json" "$judge/labels.json" "$judge/report.json" || exit 2
