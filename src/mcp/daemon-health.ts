/**
 * ko-qmd: periodic health line for the HTTP daemon's log.
 *
 * One daemon ran ten days and died with "Reached heap limit" after its heap
 * crept to 3.8 GB under nothing but idle discover/cancelled traffic. A line an
 * hour of heap, rss and open `subscriptions/listen` streams gives the slope of
 * that growth and whether it tracks the listen count.
 */

const MB = 2 ** 20;
const DEFAULT_INTERVAL_MS = 3_600_000;

export type DaemonRequestCounts = {
  /** `subscriptions/listen` requests whose handler is still awaiting the response body — not open sockets */
  listens: number;
  /** the same for every /mcp request, listens included */
  inflight: number;
};

export function formatDaemonHealthLine(
  memory: Pick<NodeJS.MemoryUsage, "heapUsed" | "heapTotal" | "rss">,
  counts: DaemonRequestCounts,
  uptimeMs: number,
): string {
  const mb = (bytes: number) => `${Math.round(bytes / MB)}MB`;
  return `health heap_used=${mb(memory.heapUsed)} heap_total=${mb(memory.heapTotal)} rss=${mb(memory.rss)}`
    + ` listens=${counts.listens} mcp_inflight=${counts.inflight} uptime=${(uptimeMs / 3_600_000).toFixed(1)}h`;
}

/** Node clamps a longer setInterval delay to 1 ms, which would flood the log. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** QMD_HEALTH_LOG_INTERVAL_MS: 0 = off, a positive integer up to 2^31-1 = that many ms, anything else = one hour. */
export function resolveHealthLogIntervalMs(envValue = process.env.QMD_HEALTH_LOG_INTERVAL_MS): number {
  if (envValue === undefined || !/^\d+$/.test(envValue)) return DEFAULT_INTERVAL_MS;
  const ms = Number(envValue);
  return ms <= MAX_TIMER_MS ? ms : DEFAULT_INTERVAL_MS;
}
