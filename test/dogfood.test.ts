/**
 * scripts/dogfood.sh gate: `--check` judges a bench-ko RESULT line against the
 * newest one in test/fixtures/ko-vault/BASELINE.md without installing anything,
 * and a deploy whose bench regresses stops before `npm pack`.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/dogfood.sh", import.meta.url));
const baselineFile = fileURLToPath(new URL("fixtures/ko-vault/BASELINE.md", import.meta.url));
const result = (bm25: string) =>
  `RESULT bm25_r5=${bm25} vector_r5=1.0000 hybrid_r5=1.0000 full_r5=1.0000 full_mrr=0.9000`;
const run = (args: string[], env: Record<string, string> = {}) =>
  spawnSync("bash", [script, ...args], { encoding: "utf-8", env: { ...process.env, ...env } });

// The gate's reference value, read the way the script reads it (newest bench-ko RESULT line).
const baseline = (): string => {
  const lines = readFileSync(baselineFile, "utf-8").split("\n")
    .filter((l) => /^RESULT bm25_r5=[0-9.]+ vector_r5=/.test(l));
  return /bm25_r5=([0-9.]+)/.exec(lines.at(-1) ?? "")?.[1] ?? "";
};

describe.skipIf(process.platform === "win32")("dogfood.sh --check", () => {
  test("a bm25_r5 below the baseline is a regression (exit 3)", () => {
    const check = run(["--check", result("0.0000")]);
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("REGRESSION bm25_r5=0.0000");
  });

  test("a bm25_r5 equal to the baseline passes", () => {
    const value = baseline();
    expect(value).not.toBe("");
    const check = run(["--check", result(value)]);
    expect(check.status).toBe(0);
    expect(check.stderr).toContain(`gate: ok bm25_r5=${value}`);
  });

  test("a bm25_r5 above the baseline passes", () => {
    expect(run(["--check", result("1.0000")]).status).toBe(0);
  });

  test("output without a RESULT line fails closed (exit 3)", () => {
    const check = run(["--check", "bench crashed: model not found"]);
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("no bench-ko RESULT line");
  });

  test("bad arguments are a usage error (exit 64)", () => {
    expect(run(["--check"]).status).toBe(64);
    expect(run(["--bogus"]).status).toBe(64);
  });
});

describe.skipIf(process.platform === "win32")("dogfood.sh deploy gate", () => {
  let stubDir: string;
  let npmLog: string;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "qmd-dogfood-stub-"));
    npmLog = join(stubDir, "npm.log");
    // npm stub: records every call, installs and packs nothing.
    writeFileSync(join(stubDir, "npm"), `#!/usr/bin/env bash\necho "$*" >> "${npmLog}"\n`);
    chmodSync(join(stubDir, "npm"), 0o755);
  });

  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  const deploy = (bench: string) =>
    run([], {
      PATH: `${stubDir}:${process.env.PATH}`,
      DOGFOOD_BENCH: bench,
      XDG_CACHE_HOME: stubDir,
      // If the gate ever lets a deploy through, it must not reach the machine's real daemon.
      DOGFOOD_LABEL: "invalid.qmd-dogfood-test",
      DOGFOOD_URL: "http://127.0.0.1:9",
    });
  const npmCalls = () => {
    try { return readFileSync(npmLog, "utf-8"); } catch { return ""; }
  };

  test("a regressing bench never packs or installs", () => {
    const out = deploy(`echo "${result("0.0000")}"`);
    expect(out.status).toBe(3);
    expect(out.stderr).toContain("REGRESSION bm25_r5=0.0000");
    expect(npmCalls()).toContain("run --silent build");
    expect(npmCalls()).not.toMatch(/\bpack\b|\binstall\b/);
  });

  test("a failing bench never packs or installs", () => {
    const out = deploy("false");
    expect(out.status).toBe(3);
    expect(out.stderr).toContain("bench failed");
    expect(npmCalls()).not.toMatch(/\bpack\b|\binstall\b/);
  });
});
