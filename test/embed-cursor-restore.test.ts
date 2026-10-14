/**
 * Regression: a throwing generateEmbeddings (e.g. dim mismatch, dims fetch
 * failure) must restore the hidden terminal cursor before propagating.
 *
 * Uses an injected throwing embed fn — no models are loaded or downloaded.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectorIndex } from "../src/cli/qmd.ts";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";

describe("vectorIndex cursor restore", () => {
  let dir: string;
  let prevIndexPath: string | undefined;
  let writes: string[];
  let origWrite: typeof process.stderr.write;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qmd-cursor-"));
    prevIndexPath = process.env.INDEX_PATH;
    process.env.INDEX_PATH = join(dir, "index.sqlite");
    writes = [];
    origWrite = process.stderr.write;
    process.stderr.write = function (chunk: unknown, ..._args: unknown[]): boolean {
      writes.push(String(chunk));
      return true;
    } as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = origWrite;
    if (prevIndexPath === undefined) delete process.env.INDEX_PATH;
    else process.env.INDEX_PATH = prevIndexPath;
    await rm(dir, { recursive: true, force: true });
  });

  test("restores cursor on the success path", async () => {
    await vectorIndex("test-model", true, undefined, {
      runEmbeddings: (async () => ({
        docsProcessed: 0,
        chunksEmbedded: 0,
        errors: 0,
        durationMs: 0,
      })) as never,
    });
    const out = writes.join("");
    expect(out).toContain(HIDE);
    expect(out).toContain(SHOW);
  });

  test("restores cursor when embeddings throw (dim mismatch path)", async () => {
    const err = await vectorIndex("test-model", true, undefined, {
      runEmbeddings: (async () => {
        throw new Error(
          "Embedding dimension mismatch: existing vectors are 768d but the current model produces 1024d."
        );
      }) as never,
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(err).toBeInstanceOf(Error);
    const out = writes.join("");
    expect(out).toContain(HIDE);
    expect(out).toContain(SHOW);
  });
});
