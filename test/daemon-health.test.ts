import { describe, expect, test } from "vitest";
import { formatDaemonHealthLine, resolveHealthLogIntervalMs } from "../src/mcp/daemon-health.js";

describe("daemon health line", () => {
  test("reports heap, rss, open listen streams and in-flight /mcp requests in MB and hours", () => {
    const line = formatDaemonHealthLine(
      { heapUsed: 3787 * 2 ** 20, heapTotal: 4142 * 2 ** 20, rss: 5000 * 2 ** 20 },
      { listens: 16, inflight: 17 },
      10.2 * 3_600_000,
    );
    expect(line).toBe("health heap_used=3787MB heap_total=4142MB rss=5000MB listens=16 mcp_inflight=17 uptime=10.2h");
  });
});

describe("health log interval", () => {
  test("defaults to one hour", () => {
    expect(resolveHealthLogIntervalMs(undefined)).toBe(3_600_000);
  });

  test("0 turns it off and a positive integer overrides it", () => {
    expect(resolveHealthLogIntervalMs("0")).toBe(0);
    expect(resolveHealthLogIntervalMs("60000")).toBe(60_000);
  });

  test.each(["", "abc", "-5", "1.5", "2147483648", "99999999999999999999"])("%j falls back to the default", (value) => {
    expect(resolveHealthLogIntervalMs(value)).toBe(3_600_000);
  });
});
