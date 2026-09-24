#!/usr/bin/env bash
# dogfood — run this checkout's build as the machine's qmd daemon, or put the published package back.
#
# Usage:
#   bash scripts/dogfood.sh                     # build → bench-ko gate → npm pack → npm i -g → restart daemon → smoke
#   bash scripts/dogfood.sh --restore           # reinstall the published ko-qmd, restart daemon, warm models
#   bash scripts/dogfood.sh --check "<output>"  # gate verdict for bench-ko output (RESULT + RESULT-HARD lines), installs nothing
#
# Gate: `bm25_r5` from bench-ko must not fall below the newest bench-ko RESULT line in
# test/fixtures/ko-vault/BASELINE.md, and when the baseline has a RESULT-HARD line the hard
# `full_r1` must not fall below that line's value minus its own `tol=`. full_r1 is the gated
# number because it held one value over eight same-commit runs while hybrid_r1 wobbled by ~3.5
# queries of 30 (BASELINE.md 2026-09-25). The tolerance rides on the line it qualifies, so a
# newer RESULT-HARD cannot silently inherit an older one. A regression stops before anything
# is installed.
# bench-ko runs the *source* through tsx; the installed tarball (dist/) is checked by the smoke step.
#
# Install is `npm pack` + `npm i -g <tarball>`, not `npm link`: a linked daemon would serve this
# working tree's dist/, and rebuilding while it runs can break it mid-request.
#
# Machine wiring (env overrides):
#   DOGFOOD_LABEL     launchd label of the daemon      (com.lemoncloud.qmd-daemon)
#   DOGFOOD_URL       daemon base URL                  (http://127.0.0.1:8181)
#   DOGFOOD_SMOKE     optional extra smoke command; must print JSON with "status":"hit"
#   DOGFOOD_PIN_FILE  file holding the `ko-qmd@<version>` pin used by --restore
#                     (unset or no pin → ko-qmd@latest)
#   DOGFOOD_BASELINE  baseline file to gate against (tests use it to feed synthetic baselines)
#
# On success writes `<ISO time> <commit>` to $XDG_CACHE_HOME/qmd/dogfood-deployed (default ~/.cache).
# DOGFOOD_BENCH overrides the bench command (tests use it to feed RESULT/RESULT-HARD lines).
# exit: 0 ok · 1 deploy/smoke failed · 3 gate regression, bench failure or unreadable bench · 64 usage
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="${DOGFOOD_BASELINE:-$ROOT/test/fixtures/ko-vault/BASELINE.md}"
LABEL="${DOGFOOD_LABEL:-com.lemoncloud.qmd-daemon}"
URL="${DOGFOOD_URL:-http://127.0.0.1:8181}"
MARKER="${XDG_CACHE_HOME:-$HOME/.cache}/qmd/dogfood-deployed"
BENCH="${DOGFOOD_BENCH:-bash scripts/bench-ko.sh}"

TARBALL=""   # global: the EXIT trap runs after deploy() has returned

say() { echo "dogfood: $*" >&2; }
remove_tarball() { if [ -n "$TARBALL" ]; then rm -f "$ROOT/$TARBALL"; fi; }

field_of() { # field_of <line-prefix> <text> — the number right after <line-prefix> on the last matching line, or nothing
  # `-e t -e d`: a line that did not match (non-numeric value) is dropped, not echoed back whole;
  # separate expressions because BSD sed rejects `t; d` in one
  grep -E "^$1" <<<"$2" | tail -1 | sed -E -e "s/^$1([0-9.]+).*/\1/" -e t -e d || true
}

bm25_of() { field_of 'RESULT bm25_r5=' "$1"; }
hard_field() { # hard_field <name> <text> — numeric <name>= on the last RESULT-HARD line, or nothing
  grep -E '^RESULT-HARD ' <<<"$2" | tail -1 | sed -E -e "s/.* $1=([0-9.]+)( .*)?\$/\1/" -e t -e d || true
}
hard_of() { hard_field full_r1 "$1"; }
tolerance_of() { hard_field tol "$1"; }

check_gate() { # check_gate <bench output> — 0 pass, 3 regression or unparsable
  local now base now_hard base_hard tol baseline_text
  now="$(bm25_of "$1")"
  baseline_text="$(cat "$BASELINE")"
  base="$(bm25_of "$baseline_text")"
  if [ -z "$now" ] || [ -z "$base" ]; then
    say "gate: no bench-ko RESULT line (current='${now}', baseline='${base}')"
    return 3
  fi
  if awk -v n="$now" -v b="$base" 'BEGIN { exit !(n + 0 < b + 0) }'; then
    say "gate: REGRESSION bm25_r5=$now < baseline $base — not installing"
    return 3
  fi
  say "gate: ok bm25_r5=$now (baseline $base)"
  now_hard="$(hard_of "$1")"
  base_hard="$(hard_of "$baseline_text")"
  if [ -n "$base_hard" ]; then
    if [ -z "$now_hard" ]; then
      say "gate: no RESULT-HARD line but the baseline has one (baseline full_r1=$base_hard)"
      return 3
    fi
    tol="$(tolerance_of "$baseline_text")"
    if [ -z "$tol" ]; then
      say "gate: the baseline RESULT-HARD line has no tol= — cannot gate hard numbers"
      return 3
    fi
    if awk -v n="$now_hard" -v b="$base_hard" -v t="$tol" 'BEGIN { exit !(n + 0 < b + 0 - t - 0) }'; then
      say "gate: REGRESSION hard full_r1=$now_hard < baseline $base_hard − tolerance $tol — not installing"
      return 3
    fi
    say "gate: ok hard full_r1=$now_hard (baseline $base_hard − tolerance $tol)"
  else
    if grep -q '^RESULT-HARD ' "$BASELINE"; then
      say "gate: REGRESSION hard — the baseline's RESULT-HARD value is unparsable"
      return 3
    fi
    say "gate: skip hard — no RESULT-HARD line in the baseline"
  fi
}

# restart_daemon — kickstart the launchd job, wait up to 30s for the *new* process's /health.
# `kickstart -k` returns while the old process is still shutting down, and it keeps answering
# /health until it exits (2026-09-24: answered 1ms, then the port was closed ~9s before the new
# one listened). A /health whose uptime predates the kickstart is the old process.
restart_daemon() {
  local kicked=$SECONDS _ uptime
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null \
    || { say "launchctl kickstart $LABEL failed — is the job loaded?"; return 1; }
  for _ in $(seq 1 30); do
    # `|| true`: a refused connection is the normal gap between the two processes, not an error
    uptime="$(curl -fsS -m 2 "$URL/health" 2>/dev/null | sed -nE 's/.*"uptime":([0-9]+).*/\1/p' || true)"
    if [ -n "$uptime" ] && [ "$uptime" -le $((SECONDS - kicked + 1)) ]; then
      warm_models
      return 0
    fi
    sleep 1
  done
  say "a restarted daemon did not answer $URL/health within 30s"
  return 1
}

# warm_models — one vec query loads the embedding model. A fresh daemon's first vec query took
# 15.5s (2026-09-24), and the KB seam's 20s curl limit then failed the first search after a
# restart. A failed warm-up is not a failed restart: the daemon is up, the next search pays the load.
warm_models() {
  local started=$SECONDS
  if curl -fsS -m 90 -X POST "$URL/query" -H 'Content-Type: application/json' -H 'X-QMD-No-Log: 1' \
    -d '{"searches":[{"type":"vec","query":"qmd"}],"limit":1,"rerank":false}' >/dev/null 2>&1; then
    say "warmed embedding model in $((SECONDS - started))s"
  else
    say "warning: warm-up vec query failed — the first search after this restart pays the model load"
  fi
}

restore() {
  local spec="ko-qmd@latest" pin
  if [ -n "${DOGFOOD_PIN_FILE:-}" ] && [ -f "$DOGFOOD_PIN_FILE" ]; then
    pin="$(grep -oE '^ko-qmd@[^[:space:]]+' "$DOGFOOD_PIN_FILE" | tail -1 || true)"
    [ -n "$pin" ] && spec="$pin"
  fi
  say "restoring $spec"
  # The marker must never outlive the build it describes — drop it before touching the install.
  rm -f "$MARKER"
  npm install -g "$spec" >&2
  restart_daemon
  say "restored: $(qmd --version)"
}

# check_json <label> <json> <node predicate on r> — tell "not JSON" apart from "wrong value"
check_json() {
  # shellcheck disable=SC2016  # the single-quoted body is JavaScript; ${…} are JS template slots
  node -e '
    let r;
    try { r = JSON.parse(process.argv[2]); } catch { console.error(`dogfood: ${process.argv[1]} is not JSON: ${process.argv[2].slice(0, 200)}`); process.exit(1); }
    if (!new Function("r", `return (${process.argv[3]})`)(r)) { console.error(`dogfood: ${process.argv[1]} failed check ${process.argv[3]}: ${process.argv[2].slice(0, 200)}`); process.exit(1); }
  ' "$1" "$2" "$3"
}

# smoke <commit> — the global `qmd` is this build (the launchd job runs that same binary through
# its libexec symlink) and the daemon answers a search
smoke() {
  local version out
  version="$(qmd --version)"
  case "$version" in
    *"($1)"*) ;;
    *) say "installed qmd reports '$version', expected commit $1"; return 1 ;;
  esac
  out="$(curl -fsS -m 20 -X POST "$URL/query" -H 'Content-Type: application/json' -H 'X-QMD-No-Log: 1' \
    -d '{"searches":[{"type":"lex","query":"qmd"}],"limit":1,"rerank":false}')" \
    || { say "POST $URL/query failed"; return 1; }
  check_json "POST /query" "$out" 'Array.isArray(r.results)' || return 1
  if [ -n "${DOGFOOD_SMOKE:-}" ]; then
    out="$(bash -c "$DOGFOOD_SMOKE")" || { say "DOGFOOD_SMOKE failed"; return 1; }
    check_json "DOGFOOD_SMOKE" "$out" 'r.status === "hit"' || return 1
  fi
}

deploy() {
  cd "$ROOT"
  local started result commit
  started="$(date +%s)"
  if [ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]; then
    say "warning: uncommitted changes — the build is stamped <commit>-dirty"
  fi
  npm run --silent build >&2
  # whole stdout: the gate needs both the RESULT and the RESULT-HARD line
  result="$(bash -c "$BENCH")" || { say "bench failed — not installing"; exit 3; }
  check_gate "$result" || exit 3

  commit="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("dist/cli/build-info.json","utf8")).commit)')"
  # --ignore-scripts: `prepare` would rebuild what was just built and benched.
  TARBALL="$(npm pack --ignore-scripts --silent | tail -1)"
  trap remove_tarball EXIT
  say "installing $TARBALL ($commit)"
  rm -f "$MARKER"   # a failed install/restart below must not leave an older deploy's marker behind
  npm install -g "./$TARBALL" >&2

  if ! restart_daemon || ! smoke "$commit"; then
    say "deploy failed — the daemon may be down; seams fall back to rg. Undo: bash scripts/dogfood.sh --restore"
    exit 1
  fi
  mkdir -p "$(dirname "$MARKER")"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$commit" > "$MARKER"
  say "deployed $commit in $(( $(date +%s) - started ))s — undo: bash scripts/dogfood.sh --restore"
}

case "${1:-}" in
  "") deploy ;;
  --restore) restore ;;
  --check) [ $# -eq 2 ] || { say "usage: --check \"<bench-ko output>\""; exit 64; }; check_gate "$2" ;;
  *) say "usage: dogfood.sh [--restore | --check \"<bench-ko output>\"]"; exit 64 ;;
esac
