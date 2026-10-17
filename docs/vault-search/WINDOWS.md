# Windows CI — accepted failures

Windows is a release target, but the `windows-latest` test job in `.github/workflows/ci.yml`
runs with `continue-on-error: true`: its failures are recorded here rather than fixed in the
patch stack. A red Windows column is expected — this page is how you tell a known failure
from a new one.

## Snapshot

develop `f092e86` — [CI run 38684652771](https://github.com/tak-bro/ko-qmd/actions/runs/38684652771), `Node 22 (windows-latest)`:

- test files: **22 failed** | 71 passed | 1 skipped (94)
- tests: **88 failed** | 1808 passed | 197 skipped (2093)

Failing test files:

- test/bench-ko-env.test.ts
- test/bin-wrapper.test.ts
- test/build-script.test.ts
- test/cli.test.ts
- test/daemon-log-perms.test.ts
- test/embed-cursor-restore.test.ts
- test/embed-lock-exitcode.test.ts
- test/embed-lock.test.ts
- test/full-path-fallback.test.ts
- test/llm.test.ts
- test/mcp-pid.test.ts
- test/mcp-stdio-lifecycle.test.ts
- test/mcp.test.ts
- test/metadata-search.test.ts
- test/package.test.ts
- test/path-fidelity.test.ts
- test/query-log.test.ts
- test/store-cjk-fts.test.ts
- test/store.helpers.unit.test.ts
- test/store.test.ts
- test/update-hook-trust.test.ts
- test/version.test.ts

## Refreshing this list

```sh
RUN=$(gh run list --branch develop --workflow CI --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN" --log \
  | grep 'Node 22 (windows-latest)' \
  | perl -pe 's/\e\[[0-9;]*m//g' \
  | grep 'FAIL' | grep -oE 'test/[a-z0-9._-]+\.test\.ts' | sort -u
```

Update the snapshot (sha, run link, list) whenever the output changes.
