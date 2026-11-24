#!/usr/bin/env bash
# migration-probe.sh — convert a copy of the real index to the partitioned vector
# layout (upstream #983) and check that nothing was lost (plan AC-2).
#
# The real index and config are only read: `sqlite3 .backup` copies the index and
# `cp` copies the config into the work dir, and every qmd command below runs with
# INDEX_PATH and QMD_CONFIG_DIR pointing at the copies. Both are always set to
# the work dir: an inherited INDEX_PATH may name a real index, and copying the
# source over it would convert that index in place.
#
# 1. The published `qmd` (QMD_PUBLISHED, default `qmd`) reads the copy's status
#    before the conversion: embedded vectors, pending documents, orphaned chunks.
# 2. The branch source (`bun src/cli/qmd.ts`) runs one `vsearch -c <collection>`
#    per collection that has vectors, querying that collection's first embedded
#    document title. The first command converts the index; its time is reported.
# 3. The branch source reads `status` and runs `doctor`.
#
# Pass: Pending is unchanged, Vectors is unchanged or smaller by exactly the
# orphaned chunks (the conversion drops content_vectors rows no active document
# holds), every collection returns at least one result, and doctor's embedding
# vector sample check passes. Prints `MIGRATION-OK embedded=<n> pending=<n>`.
#
# Exit 2 when PROBE_SOURCE_INDEX or PROBE_SOURCE_CONFIG lies inside the work dir,
# which the probe deletes before copying.
#
# Env: PROBE_SOURCE_INDEX (default ~/.cache/qmd/index.sqlite),
#      PROBE_SOURCE_CONFIG (default ~/.config/qmd), QMD_PUBLISHED (default qmd).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

source_index="${PROBE_SOURCE_INDEX:-$HOME/.cache/qmd/index.sqlite}"
source_config="${PROBE_SOURCE_CONFIG:-$HOME/.config/qmd}"
published="${QMD_PUBLISHED:-qmd}"
work="$root/tmp/migration-probe"
export INDEX_PATH="$work/index.sqlite"
export QMD_CONFIG_DIR="$work/config"
export NO_COLOR=1

# Resolve a path whose last component may not exist yet.
resolve() {
  local dir base
  dir="$(dirname "$1")"
  base="$(basename "$1")"
  if [ -d "$dir" ]; then
    printf '%s/%s\n' "$(cd "$dir" && pwd -P)" "$base"
  else
    printf '%s\n' "$1"
  fi
}

work_real="$(resolve "$work")"
for source in "$(resolve "$source_index")" "$(resolve "$source_config")"; do
  case "$source/" in
    "$work_real"/*)
      echo "migration-probe: the source must not lie inside the work dir ($source)" >&2
      exit 2
      ;;
  esac
done

if [ ! -f "$source_index" ]; then
  echo "migration-probe: no source index at $source_index" >&2
  exit 1
fi

rm -rf "$work"
mkdir -p "$work" "$(dirname "$INDEX_PATH")" "$QMD_CONFIG_DIR"
sqlite3 "$source_index" ".backup '$INDEX_PATH'"
if [ -d "$source_config" ]; then
  cp -R "$source_config"/. "$QMD_CONFIG_DIR"/
fi

# `Vectors: N embedded` / `Pending: N need embedding` / `Orphaned: N embedding chunks`.
# status prints Vectors always and Pending/Orphaned only when nonzero, so a missing
# Pending or Orphaned line reads as 0 and a missing Vectors line is an error.
status_field() {
  local text="$1" pattern="$2"
  printf '%s\n' "$text" | sed -n "s/^ *$pattern: *\([0-9][0-9]*\).*/\1/p" | head -n 1
}

branch() {
  bun "$root/src/cli/qmd.ts" "$@"
}

# Run a status command and require its Vectors line.
status_of() {
  local label="$1" text
  shift
  if ! text="$("$@" status 2>&1)"; then
    printf '%s\n' "$text" | tail -n 20 >&2
    echo "migration-probe: $label status failed" >&2
    exit 1
  fi
  if [ -z "$(status_field "$text" Vectors)" ]; then
    printf '%s\n' "$text" | tail -n 20 >&2
    echo "migration-probe: $label status printed no Vectors line" >&2
    exit 1
  fi
  printf '%s\n' "$text"
}

before="$(status_of published "$published")"
published_version="$("$published" --version 2>&1)" || { echo "migration-probe: $published --version failed: $published_version" >&2; exit 1; }
embedded_before="$(status_field "$before" Vectors)"
pending_before="$(status_field "$before" Pending)"
orphaned_before="$(status_field "$before" Orphaned)"
pending_before="${pending_before:-0}"
orphaned_before="${orphaned_before:-0}"
echo "before: embedded=$embedded_before pending=$pending_before orphaned=$orphaned_before ($published_version)"
if [ "$embedded_before" -lt 1 ]; then
  echo "migration-probe: the copy has no embedded vectors to convert" >&2
  exit 1
fi

# Collections with at least one embedded active document, and the title of the first one.
targets="$(sqlite3 -separator $'\t' "$INDEX_PATH" "
  SELECT d.collection, d.title FROM documents d
  WHERE d.id IN (
    SELECT MIN(d2.id) FROM documents d2
    WHERE d2.active = 1 AND EXISTS (SELECT 1 FROM content_vectors cv WHERE cv.hash = d2.hash)
    GROUP BY d2.collection
  )
  ORDER BY d.collection;")"
if [ -z "$targets" ]; then
  echo "migration-probe: the copy has no embedded collections" >&2
  exit 1
fi
# A collection without vectors cannot answer a vsearch; name it rather than skip it silently.
skipped="$(sqlite3 "$INDEX_PATH" "
  SELECT name FROM store_collections
  WHERE name NOT IN (
    SELECT d.collection FROM documents d
    WHERE d.active = 1 AND EXISTS (SELECT 1 FROM content_vectors cv WHERE cv.hash = d.hash)
  )
  ORDER BY name;" | tr '\n' ' ')"
[ -z "$skipped" ] || echo "skipped (no vectors): $skipped"

failed=0
first=1
while IFS=$'\t' read -r collection title; do
  [ -n "$collection" ] || continue
  started=$(date +%s)
  log="$work/vsearch-$collection.log"
  rc=0
  json="$(branch vsearch -c "$collection" "$title" -n 3 --json 2>"$log")" || rc=$?
  elapsed=$(( $(date +%s) - started ))
  if [ "$rc" != 0 ]; then
    tail -n 20 "$log" >&2
    echo "migration-probe: vsearch -c $collection exited $rc" >&2
    failed=1
    continue
  fi
  hits="$(printf '%s' "$json" | python3 -c 'import json,sys
try: print(len(json.load(sys.stdin)))
except ValueError: print(-1)')"
  if [ "$hits" = -1 ]; then
    tail -n 20 "$log" >&2
    echo "migration-probe: vsearch -c $collection printed no JSON" >&2
    failed=1
    continue
  fi
  if [ "$first" = 1 ]; then
    echo "conversion: first vsearch took ${elapsed}s (includes the vector migration and VACUUM)"
    first=0
  fi
  echo "vsearch -c $collection: $hits result(s)"
  if [ "${hits:-0}" -lt 1 ]; then failed=1; fi
done <<< "$targets"

after="$(status_of branch branch)"
embedded_after="$(status_field "$after" Vectors)"
pending_after="$(status_field "$after" Pending)"
pending_after="${pending_after:-0}"
echo "after:  embedded=$embedded_after pending=$pending_after"

layout="$(sqlite3 "$INDEX_PATH" "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('vectors_vec', 'vectors_by_collection') ORDER BY name;" | tr '\n' ' ')"
echo "vector tables: $layout"
case "$layout" in
  *vectors_vec*) echo "migration-probe: the legacy vectors_vec table is still there" >&2; failed=1 ;;
esac

if [ "$pending_after" != "$pending_before" ]; then
  echo "migration-probe: pending changed ($pending_before -> $pending_after)" >&2
  failed=1
fi
if [ "$embedded_after" != "$embedded_before" ] && [ "$embedded_after" != "$((embedded_before - orphaned_before))" ]; then
  echo "migration-probe: embedded changed ($embedded_before -> $embedded_after, orphaned before: $orphaned_before)" >&2
  failed=1
fi

# doctor reports a warned check in its output and exits nonzero only when it crashes.
doctor_rc=0
doctor="$(branch doctor 2>&1)" || doctor_rc=$?
sample="$(printf '%s\n' "$doctor" | grep 'embedding vector sample:' || true)"
echo "doctor: ${sample:-no embedding vector sample line} (exit $doctor_rc)"
case "$doctor_rc:$sample" in
  "0:✓ embedding vector sample:"*) ;;
  *)
    printf '%s\n' "$doctor" | tail -n 20 >&2
    failed=1
    ;;
esac

if [ "$failed" = 0 ]; then
  echo "MIGRATION-OK embedded=$embedded_after pending=$pending_after"
else
  echo "MIGRATION-FAIL" >&2
  exit 1
fi
