// @ts-check
/**
 * Plain-text counters for `/metrics`.
 *
 * Prometheus text exposition format, hand-written in ~20 lines, because that format is a
 * `name value` line per metric and adding a client library to a repo whose only runtime dependency
 * is viem would be an absurd trade. It is equally readable with `curl` when there is no Prometheus
 * — which, during an incident, is the case that matters.
 *
 * Counters are monotonic and pushed at you (`inc`). Gauges are pulled: registered as functions and
 * evaluated at scrape time, so a value like snapshot age is computed when asked rather than by a
 * timer that could itself be the thing that died.
 *
 * ON "INDEXER LAG": the API deliberately has no RPC client — it serves the snapshot and nothing
 * else — so it cannot know the chain head and MUST NOT claim a blocks-behind figure. What it can
 * measure exactly is how long ago the indexer last wrote the snapshot, which is the number that
 * actually tells you the indexer stopped. The metric is named for what it measures:
 * `vault_indexer_snapshot_age_seconds`.
 */

/** Metric metadata. A metric absent from here still renders; it just has no HELP line. */
const HELP = {
  vault_api_requests_total: ['counter', 'HTTP requests received'],
  vault_api_payment_required_total: ['counter', '402 responses issued (unpaid or invalid payment)'],
  vault_api_settlements_total: ['counter', 'payments verified and settled by the facilitator'],
  vault_api_rate_limited_total: ['counter', '429 responses issued to free routes'],
  vault_api_rejected_total: ['counter', 'requests refused on size/URL/method limits'],
  vault_api_errors_total: ['counter', 'unhandled errors turned into a 500'],
  vault_api_snapshot_reload_failures_total: ['counter', 'snapshot reloads that failed and left stale state serving'],
  vault_api_uptime_seconds: ['gauge', 'seconds since this process started serving'],
  vault_indexer_last_block: ['gauge', 'last block in the snapshot the API is serving'],
  vault_indexer_snapshot_age_seconds: ['gauge', 'seconds since the indexer last wrote the snapshot — the lag signal'],
  vault_api_rate_limit_buckets: ['gauge', 'per-IP token buckets currently tracked'],
  vault_api_seen_nonces: ['gauge', 'payment nonces held for local replay defence'],
};

export function createMetrics() {
  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {Map<string, () => number>} */
  const gauges = new Map();

  const api = {
    /** Bump a counter. Unknown names are allowed — a metric should never be the thing that throws. */
    inc(name, by = 1) {
      counters.set(name, (counters.get(name) ?? 0) + by);
      return api;
    },
    /** Register a pull-at-scrape-time gauge. */
    gauge(name, fn) {
      gauges.set(name, fn);
      return api;
    },
    get(name) {
      if (counters.has(name)) return counters.get(name);
      const g = gauges.get(name);
      return g ? safe(g) : undefined;
    },
    /** Every metric as a plain object — used by tests and by the shutdown summary line. */
    snapshot() {
      const out = {};
      for (const [k, v] of counters) out[k] = v;
      for (const [k, fn] of gauges) out[k] = safe(fn);
      return out;
    },
    /** Prometheus text exposition format. */
    render() {
      const all = api.snapshot();
      const lines = [];
      for (const name of Object.keys(all).sort()) {
        const meta = HELP[name];
        if (meta) {
          lines.push(`# HELP ${name} ${meta[1]}`);
          lines.push(`# TYPE ${name} ${meta[0]}`);
        }
        lines.push(`${name} ${all[name]}`);
      }
      return `${lines.join('\n')}\n`;
    },
  };

  // Counters that must read 0 rather than be absent before their first event: a missing series and
  // a zero series look identical in a graph, and only one of them is good news.
  for (const n of ['vault_api_requests_total', 'vault_api_payment_required_total', 'vault_api_settlements_total',
    'vault_api_rate_limited_total', 'vault_api_rejected_total', 'vault_api_errors_total',
    'vault_api_snapshot_reload_failures_total']) counters.set(n, 0);

  return api;
}

/** A gauge that throws must not take the whole scrape down with it. */
function safe(fn) {
  try {
    const v = Number(fn());
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
