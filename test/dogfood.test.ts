/**
 * scripts/dogfood.sh gate: `--check` judges bench-ko output (RESULT + RESULT-HARD lines)
 * against the newest ones in test/fixtures/ko-vault/BASELINE.md without installing anything,
 * and a deploy whose bench regresses stops before `npm pack`.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

const RESULT_HARD_LINE = /^RESULT-HARD /;
const lastValue = (pattern: RegExp, field: string): string => {
  const lines = readFileSync(baselineFile, "utf-8").split("\n").filter((l) => pattern.test(l));
  return new RegExp(`${field}=([0-9.]+)`).exec(lines.at(-1) ?? "")?.[1] ?? "";
};
const hardBaseline = (): string => lastValue(RESULT_HARD_LINE, "full_r1");
const tolerance = (): string => lastValue(RESULT_HARD_LINE, "tol");
// A synthetic baseline for tests that need a specific shape; returns its path.
const tempBaseline = (body: string): string => {
  const path = join(mkdtempSync(join(tmpdir(), "dogfood-hard-")), "baseline.md");
  writeFileSync(path, `## t\n\nRESULT bm25_r5=0.9000 vector_r5=1.0000\n${body}`);
  return path;
};
const hardLine = (r1: string) =>
  `RESULT-HARD hybrid_r1=0.3000 hybrid_mrr=0.5000 full_r1=${r1} full_mrr=0.6000 n=30`;
// The real baseline's form; a line without form= predates the field and is plain.
const hardForm = (): string => {
  const lines = readFileSync(baselineFile, "utf-8").split("\n").filter((l) => RESULT_HARD_LINE.test(l));
  return / form=([a-z]+)/.exec(lines.at(-1) ?? "")?.[1] ?? "plain";
};
// A RESULT-HARD line as bench-ko prints it against the real baseline: same form, and the baseline's
// hybrid_r1, which the seam form gates too.
const realHardLine = (r1: string) =>
  `RESULT-HARD hybrid_r1=${lastValue(RESULT_HARD_LINE, "hybrid_r1")} hybrid_mrr=0.5000 full_r1=${r1} ` +
  `full_mrr=0.6000 n=30 form=${hardForm()}`;
const seamBaseline = "RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5615 full_r1=0.5111 full_mrr=0.7444 n=30 tol=0 form=seam\n";
const seamLine = (hybrid: string, full: string) =>
  `RESULT-HARD hybrid_r1=${hybrid} hybrid_mrr=0.5615 full_r1=${full} full_mrr=0.7444 n=30 form=seam`;

describe.skipIf(process.platform === "win32")("dogfood.sh --check", () => {
  test("a bm25_r5 below the baseline is a regression (exit 3)", () => {
    const check = run(["--check", result("0.0000")]);
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("REGRESSION bm25_r5=0.0000");
  });

  test("a bm25_r5 equal to the baseline passes", () => {
    const value = baseline();
    expect(value).not.toBe("");
    const check = run(["--check", `${result(value)}\n${realHardLine(hardBaseline())}`]);
    expect(check.status).toBe(0);
    expect(check.stderr).toContain(`gate: ok bm25_r5=${value}`);
  });

  test("a bm25_r5 above the baseline passes", () => {
    const check = run(["--check", `${result("1.0000")}\n${realHardLine(hardBaseline())}`]);
    expect(check.status).toBe(0);
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

describe.skipIf(process.platform === "win32")("dogfood.sh --check hard gate", () => {
  test("a hard full_r1 below baseline − tolerance is a regression (exit 3)", () => {
    const base = hardBaseline();
    const tol = tolerance();
    expect(base).not.toBe("");
    expect(tol).not.toBe("");
    const below = (Number(base) - Number(tol) - 0.01).toFixed(4);
    const check = run(["--check", `${result(baseline())}\n${realHardLine(below)}`]);
    expect(check.status).toBe(3);
    expect(check.stderr).toContain(`REGRESSION hard full_r1=${below}`);
  });

  test("a hard full_r1 below the baseline but within tolerance passes", () => {
    // The real baseline's seam line carries tol=0, so the band is exercised on a plain line.
    const base = tempBaseline("RESULT-HARD hybrid_r1=0.3000 hybrid_mrr=0.5 full_r1=0.5111 full_mrr=0.7 n=30 tol=0.034\n");
    try {
      const within = (0.5111 - 0.034 + 0.005).toFixed(4);
      const check = run(["--check", `${result("0.9000")}\n${hardLine(within)}`], { DOGFOOD_BASELINE: base });
      expect(check.status).toBe(0);
      expect(check.stderr).toContain(`ok hard full_r1=${within} (baseline 0.5111 − tolerance 0.034)`);
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });

  test("RESULT-HARD in the baseline but missing from the output fails closed (exit 3)", () => {
    const base = tempBaseline("RESULT-HARD hybrid_r1=0.4000 hybrid_mrr=0.5 full_r1=0.4 full_mrr=0.6 n=10 tol=0.05\n");
    try {
      const check = run(["--check", result("0.9000")], { DOGFOOD_BASELINE: base });
      expect(check.status).toBe(3);
      expect(check.stderr).toContain("no RESULT-HARD");
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });

  test("a baseline RESULT-HARD without tol= fails closed (exit 3)", () => {
    const base = tempBaseline("RESULT-HARD hybrid_r1=0.4000 hybrid_mrr=0.5 full_r1=0.4 full_mrr=0.6 n=10\n");
    try {
      const check = run(["--check", `${result("0.9000")}\n${hardLine("0.4000")}`], { DOGFOOD_BASELINE: base });
      expect(check.status).toBe(3);
      expect(check.stderr).toContain("has no tol=");
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });

  test("an unparsable baseline RESULT-HARD value is a regression, not a skip (exit 3)", () => {
    const base = tempBaseline("RESULT-HARD hybrid_r1=0.4 hybrid_mrr=0.5 full_r1=nan full_mrr=0.6 n=10 tol=0.05\n");
    try {
      const check = run(["--check", result("0.9000")], { DOGFOOD_BASELINE: base });
      expect(check.status).toBe(3);
      expect(check.stderr).toContain("unparsable");
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });

  test("a newer baseline RESULT-HARD does not inherit an older line's tol= (exit 3)", () => {
    const base = tempBaseline(
      "RESULT-HARD hybrid_r1=0.4000 hybrid_mrr=0.5 full_r1=0.4 full_mrr=0.6 n=10 tol=0.05\n" +
      "RESULT-HARD hybrid_r1=0.4000 hybrid_mrr=0.5 full_r1=0.4 full_mrr=0.6 n=10\n",
    );
    try {
      const check = run(["--check", `${result("0.9000")}\n${hardLine("0.4000")}`], { DOGFOOD_BASELINE: base });
      expect(check.status).toBe(3);
      expect(check.stderr).toContain("has no tol=");
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });

  test("a baseline without RESULT-HARD skips the hard gate and says so", () => {
    const base = tempBaseline("");
    try {
      const check = run(["--check", result("0.9000")], { DOGFOOD_BASELINE: base });
      expect(check.status).toBe(0);
      expect(check.stderr).toContain("skip hard — no RESULT-HARD line in the baseline");
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  });

  test("the RESULT line format is unchanged — RESULT-HARD does not shadow the bm25 gate", () => {
    const both = run(["--check", `${result(baseline())}\n${realHardLine(hardBaseline())}`]);
    expect(both.status).toBe(0);
    const bm25StillGates = run(["--check", `${result("0.0000")}\n${hardLine("1.0000")}`]);
    expect(bm25StillGates.status).toBe(3);
    expect(bm25StillGates.stderr).toContain("REGRESSION bm25_r5=0.0000");
  });
});

describe.skipIf(process.platform === "win32")("dogfood.sh --check form", () => {
  const withBaseline = (body: string, output: string) => {
    const base = tempBaseline(body);
    try {
      return run(["--check", `${result("0.9000")}\n${output}`], { DOGFOOD_BASELINE: base });
    } finally {
      rmSync(dirname(base), { recursive: true, force: true });
    }
  };

  test("a plain run against a seam baseline is a form mismatch (exit 3)", () => {
    const check = withBaseline(seamBaseline, `${hardLine("0.5111")} form=plain`);
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("form mismatch — bench ran form=plain, baseline is form=seam");
  });

  test("a seam run against a baseline line without form= is a form mismatch (exit 3)", () => {
    const check = withBaseline(
      "RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5 full_r1=0.5111 full_mrr=0.7 n=30 tol=0.034\n",
      seamLine("0.3111", "0.5111"),
    );
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("form mismatch — bench ran form=seam, baseline is form=plain");
  });

  test("a baseline line without form= reads as plain and does not gate hybrid_r1", () => {
    const check = withBaseline(
      "RESULT-HARD hybrid_r1=0.3111 hybrid_mrr=0.5 full_r1=0.5111 full_mrr=0.7 n=30 tol=0.034\n",
      "RESULT-HARD hybrid_r1=0.1000 hybrid_mrr=0.5 full_r1=0.5111 full_mrr=0.7 n=30",
    );
    expect(check.status).toBe(0);
    expect(check.stderr).not.toContain("hybrid_r1");
  });

  test("on the seam form, a hybrid_r1 below baseline − tol is a regression (exit 3)", () => {
    const check = withBaseline(seamBaseline, seamLine("0.2778", "0.5111"));
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("REGRESSION hard hybrid_r1=0.2778 < baseline 0.3111");
  });

  test("on the seam form, tol=0 passes a run equal to the baseline", () => {
    const check = withBaseline(seamBaseline, seamLine("0.3111", "0.5111"));
    expect(check.status).toBe(0);
    expect(check.stderr).toContain("ok hard full_r1=0.5111");
    expect(check.stderr).toContain("ok hard hybrid_r1=0.3111");
  });

  test("on the seam form, tol=0 still gates full_r1 (exit 3)", () => {
    const check = withBaseline(seamBaseline, seamLine("0.3111", "0.4778"));
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("REGRESSION hard full_r1=0.4778");
  });

  test("on the seam form, an unparsable hybrid_r1 fails closed (exit 3)", () => {
    const check = withBaseline(seamBaseline, seamLine("nan", "0.5111"));
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("hybrid_r1 is unparsable");
  });

  test("a baseline value that is only a dot is unparsable, not zero (exit 3)", () => {
    const check = withBaseline(seamBaseline.replace("hybrid_r1=0.3111", "hybrid_r1=."), seamLine("0.3111", "0.5111"));
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("hybrid_r1 is unparsable");
  });

  test.each([
    ["a baseline form= that is not seam or plain", seamBaseline.replace("form=seam", "form=Seam"), seamLine("0.3111", "0.5111")],
    ["a bench form= with a trailing carriage return", seamBaseline, `${seamLine("0.3111", "0.5111")}\r`],
  ])("%s is unreadable and fails closed (exit 3)", (_name, baselineBody, output) => {
    const check = withBaseline(baselineBody, output);
    expect(check.status).toBe(3);
    expect(check.stderr).toContain("unreadable form=");
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

  const deploy = (bench: string, env: Record<string, string> = {}) =>
    run([], {
      ...env,
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

  test("a passing two-line bench gets past the gate to pack", () => {
    // bench-ko prints RESULT then RESULT-HARD; the deploy path must hand the gate both lines.
    const out = deploy(`printf '%s\\n%s\\n' "${result(baseline())}" "${realHardLine(hardBaseline())}"`);
    expect(out.stderr).toContain(`gate: ok hard full_r1=${hardBaseline()}`);
    expect(npmCalls()).toMatch(/\bpack\b/);
  });

  test("the bench runs without the caller's KO_BENCH / KO_CORPUS / KO_FORM", () => {
    // An exported override would let the gate measure an easier goldset or corpus than the baseline's.
    const out = deploy(
      "env | grep -E '^KO_(BENCH|CORPUS|FORM)=' | sed 's/^/leaked /' >&2; " +
      `printf '%s\\n%s\\n' "${result(baseline())}" "${realHardLine(hardBaseline())}"`,
      { KO_BENCH: "/tmp/easy.json", KO_CORPUS: "/tmp/easy", KO_FORM: "plain" },
    );
    expect(out.stderr).not.toContain("leaked");
    expect(out.stderr).toContain(`gate: ok hard full_r1=${hardBaseline()}`);
  });

  test("a failing bench never packs or installs", () => {
    const out = deploy("false");
    expect(out.status).toBe(3);
    expect(out.stderr).toContain("bench failed");
    expect(npmCalls()).not.toMatch(/\bpack\b|\binstall\b/);
  });
});

describe.skipIf(process.platform === "win32")("dogfood.sh --restore warm-up", () => {
  let stubDir: string;
  let curlLog: string;

  beforeEach(() => {
    stubDir = mkdtempSync(join(tmpdir(), "qmd-dogfood-restore-"));
    curlLog = join(stubDir, "curl.log");
    const stub = (name: string, body: string) => {
      writeFileSync(join(stubDir, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(stubDir, name), 0o755);
    };
    stub("npm", "exit 0");
    stub("launchctl", "exit 0");
    stub("qmd", 'echo "qmd 0.0.0-test (abc1234)"');
    // curl stub: records every call; /query fails when CURL_QUERY_FAILS is set. /health answers
    // uptime 0 (a fresh daemon), except for the first STALE_HEALTH calls, which answer the way the
    // old process does while it shuts down — up for a day — and the next DOWN_HEALTH calls, which
    // fail to connect the way the port does between the two processes.
    stub("curl", [
      `echo "$*" >> "${curlLog}"`,
      'case "$*" in',
      '  *"/query"*) [ -z "$CURL_QUERY_FAILS" ] || exit 7 ;;',
      `  *"/health"*) n=$(grep -c /health "${curlLog}")`,
      '    if [ "$n" -le "${STALE_HEALTH:-0}" ]; then echo \'{"status":"ok","uptime":86400}\';',
      '    elif [ "$n" -le $(( ${STALE_HEALTH:-0} + ${DOWN_HEALTH:-0} )) ]; then exit 7;',
      '    else echo \'{"status":"ok","uptime":0}\'; fi ;;',
      "esac",
      "exit 0",
    ].join("\n"));
  });

  afterEach(() => {
    rmSync(stubDir, { recursive: true, force: true });
  });

  const restore = (env: Record<string, string> = {}) =>
    run(["--restore"], {
      PATH: `${stubDir}:${process.env.PATH}`,
      // Not stubDir itself: the \`qmd\` stub lives there, and the marker path is $XDG_CACHE_HOME/qmd/.
      XDG_CACHE_HOME: join(stubDir, "cache"),
      DOGFOOD_LABEL: "invalid.qmd-dogfood-test",
      DOGFOOD_URL: "http://127.0.0.1:9",
      ...env,
    });
  const curlCalls = () => readFileSync(curlLog, "utf-8").trim().split("\n");

  test("a vec query follows the health check, so the first seam call finds the model loaded", () => {
    const out = restore();
    expect(out.status).toBe(0);
    const calls = curlCalls();
    const health = calls.findIndex((c) => c.includes("/health"));
    const warm = calls.findIndex((c) => c.includes("/query") && c.includes('"type":"vec"'));
    expect(health).toBeGreaterThanOrEqual(0);
    expect(warm).toBeGreaterThan(health);
    expect(out.stderr).toContain("warmed embedding model");
  });

  test("the old daemon answering /health mid-shutdown does not count as restarted", () => {
    const out = restore({ STALE_HEALTH: "1", DOWN_HEALTH: "1" });
    expect(out.status).toBe(0);
    const calls = curlCalls();
    const warm = calls.findIndex((c) => c.includes("/query"));
    // A stale answer and a refused connection are both waited out; the warm-up follows the third, fresh one.
    expect(calls.slice(0, warm).filter((c) => c.includes("/health"))).toHaveLength(3);
    expect(out.stderr).toContain("warmed embedding model");
  });

  test("a failed warm-up is a warning, not a failed restore", () => {
    const out = restore({ CURL_QUERY_FAILS: "1" });
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("warning: warm-up vec query failed");
  });
});
