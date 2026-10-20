/**
 * Regression: chunks that fail after retries leave the index incomplete, so
 * `qmd embed` must be able to report that to automation. `vectorIndex` returns
 * the number of chunks still failed after its retries; `case "embed"` exits 1
 * when that count is positive (mirroring the lock-busy skip, which already
 * exits nonzero so `qmd embed && deploy` cannot mistake it for success).
 *
 * Uses an injected embed fn — no models are loaded or downloaded.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectorIndex } from "../src/cli/qmd.ts";

describe("vectorIndex failure count", () => {
  let dir: string;
  let prevIndexPath: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-embed-fail-"));
    prevIndexPath = process.env.INDEX_PATH;
    process.env.INDEX_PATH = join(dir, "index.sqlite");
  });

  afterEach(async () => {
    if (prevIndexPath === undefined) delete process.env.INDEX_PATH;
    else process.env.INDEX_PATH = prevIndexPath;
    await rm(dir, { recursive: true, force: true });
  });

  test("returns the chunks that failed after retries", async () => {
    const failed = await vectorIndex("test-model", true, undefined, {
      runEmbeddings: (async () => ({
        docsProcessed: 2,
        chunksEmbedded: 5,
        errors: 3,
        failures: [{ path: "docs/a.md", seq: 1, attempts: 3, reason: "boom" }],
        durationMs: 5,
      })) as never,
    });
    expect(failed).toBe(3);
  });

  test("returns 0 when every chunk embedded", async () => {
    const failed = await vectorIndex("test-model", true, undefined, {
      runEmbeddings: (async () => ({
        docsProcessed: 1,
        chunksEmbedded: 4,
        errors: 0,
        durationMs: 1,
      })) as never,
    });
    expect(failed).toBe(0);
  });

  test("does not claim there was nothing to embed when every chunk failed", async () => {
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      const failed = await vectorIndex("test-model", true, undefined, {
        runEmbeddings: (async () => ({
          docsProcessed: 0,
          chunksEmbedded: 0,
          errors: 2,
          failures: [{ path: "docs/a.md", seq: 0, attempts: 3, reason: "boom" }],
          durationMs: 1,
        })) as never,
      });
      expect(failed).toBe(2);
    } finally {
      console.log = origLog;
    }
    const out = logs.join("\n");
    expect(out).toContain("✗ No chunks embedded");
    expect(out).not.toContain("No non-empty documents");
  });
});
