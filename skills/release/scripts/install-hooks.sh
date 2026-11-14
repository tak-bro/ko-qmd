#!/usr/bin/env bash
set -euo pipefail

# Install git hooks for release validation.
# Idempotent — safe to run multiple times.

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [[ -z "$REPO_ROOT" ]]; then
  echo "Error: not in a git repository" >&2
  exit 1
fi

GIT_COMMON_DIR=$(git -C "$REPO_ROOT" rev-parse --git-common-dir)
case "$GIT_COMMON_DIR" in
  /*) : ;;
  *) GIT_COMMON_DIR="$REPO_ROOT/$GIT_COMMON_DIR" ;;
esac
HOOKS_DIR="$GIT_COMMON_DIR/hooks"
SOURCE="$REPO_ROOT/scripts/pre-push"

if [[ ! -f "$SOURCE" ]]; then
  echo "Error: scripts/pre-push not found at $SOURCE" >&2
  exit 1
fi

# Install pre-push hook as a copy, not a symlink: the hooks dir is shared by
# every worktree, and a link into one dangles once that worktree is removed.
HOOK="$HOOKS_DIR/pre-push"
if [[ -f "$HOOK" && ! -L "$HOOK" ]] && ! cmp -s "$SOURCE" "$HOOK"; then
  # Existing hook that isn't ours — back it up
  BACKUP="$HOOK.backup.$(date +%s)"
  echo "pre-push hook: backing up existing hook to $(basename "$BACKUP")"
  mv "$HOOK" "$BACKUP"
fi
rm -f "$HOOK"
cp "$SOURCE" "$HOOK"
echo "pre-push hook: installed (copy of scripts/pre-push)"

chmod +x "$HOOK"
echo "Done."
