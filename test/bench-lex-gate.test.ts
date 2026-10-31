/**
 * scripts/bench-lex-gate.sh / bench-lex-gate.ts input handling.
 *
 * The full gate (index + bench) runs in CI's `lex-gate` job. These tests cover the paths that
 * stop before indexing — bad arguments, a bad repeat count, a missing baseline — and the
 * verdict CLI on hand-made run files, so none of them builds an index.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const shScript = join(repoRoot, "scripts", "bench-lex-gate.sh");
const tsScript = join(repoRoot, "scripts", "bench-lex-gate.ts");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function runSh(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [shScript, ...args], { encoding: "utf-8", env: { ...process.env, ...env }, timeout: 30_000 });
}

function runTs(args: string[]) {
  return spawnSync(process.execPath, [tsxCli, tsScript, ...args], { encoding: "utf-8", timeout: 60_000 });
}

describe("bench-lex-gate.sh arguments", () => {
  test("an unknown argument exits 2 with usage", () => {
    const res = runSh(["--nope"]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("usage:");
  });

  test.each(["0", "abc", "-1", ""])("LEX_REPS=%j exits 2", reps => {
    const res = runSh([], { LEX_REPS: reps });
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("LEX_REPS must be a positive integer");
  });
});

describe("bench-lex-gate.ts verdict CLI", () => {
  let dir: string;
  const run = (id: string, r5: number, mrr: number) => ({ id, query: id, type: "exact", backends: { bm25: { recall_at_5: r5, mrr } } });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-lex-gate-"));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeRun(name: string, results: ReturnType<typeof run>[]): string {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify({ results }));
    return p;
  }

  test("a missing baseline exits 2 and points at --update-baseline", () => {
    const r = writeRun("r.json", [run("a", 1, 1)]);
    const res = runTs(["check", join(dir, "absent.json"), r]);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain("--update-baseline");
  });

  test("update then check on the same runs passes; a broad drop fails with exit 1", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `q${i}`);
    const good = writeRun("good.json", ids.map(id => run(id, 1, 1)));
    const bad = writeRun("bad.json", ids.map((id, i) => run(id, i < 20 ? 0 : 1, i < 20 ? 0 : 1)));
    const baseline = join(dir, "baseline.json");

    const up = runTs(["update", baseline, good, good]);
    expect(up.status).toBe(0);
    const written = JSON.parse(readFileSync(baseline, "utf8"));
    expect(written.conditions.reps).toBe(2);
    expect(written.summary).toEqual({ r5: 1, mrr: 1, n: 40 });

    const ok = runTs(["check", baseline, good]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^GATE PASS/m);

    const fail = runTs(["check", baseline, bad]);
    expect(fail.status).toBe(1);
    expect(fail.stdout).toMatch(/^GATE FAIL 95% interval below zero for r5, mrr/m);
    expect(fail.stdout.match(/^DROP /gm)).toHaveLength(20);
  });

  test("runs that disagree are named on the NOISE line", () => {
    const a = writeRun("a.json", [run("x", 1, 1), run("y", 1, 1)]);
    const b = writeRun("b.json", [run("x", 1, 1), run("y", 0, 0.5)]);
    const res = runTs(["update", join(dir, "noisy.json"), a, b]);
    expect(res.stdout).toMatch(/^NOISE reps=2 differing=1 max_abs=1\.0000 ids=y$/m);
  });
});
