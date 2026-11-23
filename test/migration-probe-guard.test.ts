/**
 * scripts/migration-probe.sh converts a copy of an index in place, so it must
 * never write to an index it was not asked to copy into: an inherited
 * INDEX_PATH can name a real index, and a source inside the work dir would be
 * deleted before it is copied.
 */
import { describe, test, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const probe = join(root, "scripts", "migration-probe.sh");
const hasTools = process.platform !== "win32" && spawnSync("sqlite3", ["-version"]).status === 0;

function runProbe(env: Record<string, string>) {
  return spawnSync("bash", [probe], {
    env: { ...process.env, QMD_PUBLISHED: "false", ...env },
    encoding: "utf8",
  });
}

describe.skipIf(!hasTools)("migration-probe guards", () => {
  test("an inherited INDEX_PATH is never written", () => {
    const dir = mkdtempSync(join(tmpdir(), "qmd-probe-guard-"));
    try {
      const source = join(dir, "source.sqlite");
      spawnSync("sqlite3", [source, "CREATE TABLE t(x); INSERT INTO t VALUES (1);"]);
      const sentinel = join(dir, "real.sqlite");
      spawnSync("sqlite3", [sentinel, "CREATE TABLE real(y); INSERT INTO real VALUES ('kept');"]);

      // QMD_PUBLISHED=false stops the probe right after the copy step.
      const result = runProbe({ PROBE_SOURCE_INDEX: source, PROBE_SOURCE_CONFIG: join(dir, "none"), INDEX_PATH: sentinel });

      expect(result.status).not.toBe(0);
      const kept = spawnSync("sqlite3", [sentinel, "SELECT y FROM real;"], { encoding: "utf8" });
      expect(kept.stdout.trim()).toBe("kept");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a source inside the work dir exits 2 before anything is deleted", () => {
    const result = runProbe({ PROBE_SOURCE_INDEX: join(root, "tmp", "migration-probe", "index.sqlite") });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("must not lie inside the work dir");
  });
});
