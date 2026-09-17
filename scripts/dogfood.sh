#!/usr/bin/env bash
# dogfood — run this checkout's build as the machine's qmd daemon, or put the published package back.
#
# Usage:
#   bash scripts/dogfood.sh                     # build → bench-ko gate → npm pack → npm i -g → restart daemon → smoke
#   bash scripts/dogfood.sh --restore           # reinstall the published ko-qmd, restart daemon
#   bash scripts/dogfood.sh --check "<RESULT>"  # gate verdict for one bench-ko RESULT line, installs nothing
#
# Gate: `bm25_r5` from bench-ko must not fall below the newest bench-ko RESULT line in
# test/fixtures/ko-vault/BASELINE.md. A regression stops before anything is installed.
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
#
# On success writes `<ISO time> <commit>` to $XDG_CACHE_HOME/qmd/dogfood-deployed (default ~/.cache).
# DOGFOOD_BENCH overrides the bench command (tests use it to feed a RESULT line).
# exit: 0 ok · 1 deploy/smoke failed · 3 gate regression, bench failure or unreadable bench · 64 usage
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASELINE="$ROOT/test/fixtures/ko-vault/BASELINE.md"
LABEL="${DOGFOOD_LABEL:-com.lemoncloud.qmd-daemon}"
URL="${DOGFOOD_URL:-http://127.0.0.1:8181}"
MARKER="${XDG_CACHE_HOME:-$HOME/.cache}/qmd/dogfood-deployed"
BENCH="${DOGFOOD_BENCH:-bash scripts/bench-ko.sh}"

TARBALL=""   # global: the EXIT trap runs after deploy() has returned

say() { echo "dogfood: $*" >&2; }
remove_tarball() { if [ -n "$TARBALL" ]; then rm -f "$ROOT/$TARBALL"; fi; }

bm25_of() { # bm25_of <text> — bm25_r5 of the last bench-ko RESULT line in <text>, or nothing
  grep -E '^RESULT bm25_r5=[0-9.]+ vector_r5=' <<<"$1" | tail -1 | sed -E 's/^RESULT bm25_r5=([0-9.]+).*/\1/' || true
}

check_gate() { # check_gate <RESULT line> — 0 pass, 3 regression or unparsable
  local now base
  now="$(bm25_of "$1")"
  base="$(bm25_of "$(cat "$BASELINE")")"
  if [ -z "$now" ] || [ -z "$base" ]; then
    say "gate: no bench-ko RESULT line (current='${now}', baseline='${base}')"
    return 3
  fi
  if awk -v n="$now" -v b="$base" 'BEGIN { exit !(n + 0 < b + 0) }'; then
    say "gate: REGRESSION bm25_r5=$now < baseline $base — not installing"
    return 3
  fi
  say "gate: ok bm25_r5=$now (baseline $base)"
}

restart_daemon() { # restart_daemon — kickstart the launchd job, wait up to 30s for /health
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null \
    || { say "launchctl kickstart $LABEL failed — is the job loaded?"; return 1; }
  local _
  for _ in $(seq 1 30); do
    curl -fsS -m 2 "$URL/health" >/dev/null 2>&1 && return 0
    sleep 1
  done
  say "daemon did not answer $URL/health within 30s"
  return 1
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
  result="$(bash -c "$BENCH" | tail -1)" || { say "bench failed — not installing"; exit 3; }
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
  --check) [ $# -eq 2 ] || { say "usage: --check \"<RESULT line>\""; exit 64; }; check_gate "$2" ;;
  *) say "usage: dogfood.sh [--restore | --check \"<RESULT line>\"]"; exit 64 ;;
esac
