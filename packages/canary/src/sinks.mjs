// @ts-check
/**
 * Where transition lines go. Optional-failure-tolerant throughout: a sink that throws must never
 * take the canary down, because a paging outage is not a reason to stop watching the chain.
 *
 * console  — always on. stdout for recoveries, stderr for alerts and degradations, so a `2>` split
 *            gives you a pure problem feed.
 * webhook  — plain, single-URL POST of one JSON body per transition. Kept for callers that only
 *            want one endpoint.
 * tiered webhook — PAGE vs LOG by signal, and by a per-alert predicate where one signal name
 *            covers alerts of two severities (Monitoring Gap Analysis §2 G6 / §3 item 4): `sinks.mjs`
 *            used to be console + one generic webhook, every transition, same channel, no
 *            severity — this is that gap closed. `PAGE_WEBHOOK_URL` / `LOG_WEBHOOK_URL` route to
 *            two endpoints; `ALERT_WEBHOOK_URL` remains the backwards-compatible fallback for
 *            whichever of the two is unset, so an existing single-webhook deployment is unchanged.
 * deadman ping — an off-host dead-man's switch: a successful sweep pings an external URL
 *            (Healthchecks.io-style). `ops-check` (packages/oplog) already notices a dead canary,
 *            but it runs ON THE SAME HOST as the canary — host death silences both the watcher and
 *            the watcher's watcher. This ping is the "something not on that host" G6 asks for. Off
 *            by default when `DEADMAN_PING_URL` is unset; a failed ping is logged, never fatal.
 */

/** @param {{log?:Function, error?:Function}} [io] */
export function createConsoleSink({ log = console.log, error = console.error } = {}) {
  return {
    name: 'console',
    /** @param {import('./transitions.mjs').Transition} t */
    async emit(t) {
      (t.to === 'ok' ? log : error)(t.line);
    },
  };
}

/**
 * Signals that PAGE on EVERY ALERT — the four "member capital wrong-priced or invariant broken" /
 * "flagship freeze detector" signals the Monitoring Gap Analysis §3 item 4 names explicitly:
 * "PAGE: nav-backing, share-conservation, fee-routing, exit-liveness ALERT, oracle-v2 ALERT".
 * `oracle-freshness` is the SIGNAL name `signals/oracle-health.mjs` still emits post-pivot (the
 * file was renamed, the wire name was not, so standing transition state and this map both survive
 * the rename) — it is the "oracle-v2" the note refers to.
 *
 * `feed-identity` is not here because only SOME of its alerts page — see `CONDITIONAL_PAGE`.
 */
export const PAGE_SIGNALS = new Set([
  'nav-backing', 'share-conservation', 'fee-routing', 'exit-liveness', 'oracle-freshness',
]);

/**
 * Signals whose ALERTs page on a PREDICATE rather than on the signal name alone, because one signal
 * name covers alerts of two genuinely different severities.
 *
 * `feed-identity` (G2's on-chain half, `signals/feed-identity.mjs`) is why this category exists. It
 * emits three kinds of ALERT and they are not the same thing:
 *
 *   - `detail.harm === 'decimals'`     — the feed's `decimals()` no longer matches the scale
 *     `ChainlinkOracle` cached at construction. That config is IMMUTABLE, so this LATCHES: it does
 *     not self-clear and cannot be repaired, only evacuated. Every price served since the change is
 *     mis-scaled — the vault is not frozen, it is silently WRONG. Severity Ladder SEV-1.
 *   - `detail.harm === 'denomination'` — the feed no longer describes itself as USD-quoted. Same
 *     immutability, same latch, same "NAV, deposits and exits are all wrong rather than frozen".
 *   - `detail.harm === null` (aggregator swap) — legitimate routine Chainlink operation. It
 *     self-clears next sweep once the pin is re-taken, and there is nothing to fix on-chain. LOG.
 *
 * The §3 item 4 severity map ("LOG: everything else") was written 2026-08-30, BEFORE `feed-identity`
 * existed (2026-09-01, PR #103), so it never ruled on these. Routing all three to LOG would leave
 * the two LATCHING ones — the ones that mean member capital is wrong-priced right now — waiting for
 * the weekly ops review. They are not redundantly covered elsewhere either: `ChainlinkOracle`'s
 * sane-price band catches a ±2-decimal drift only while the live price sits inside it, and per
 * `Owner Decisions 2026-09-01.md` §1 that window CLOSES for cbBTC at BTC $100,000 (+29.5% from
 * 2026-09-01). Above that price `feed-identity` is the only detector there is, and nav-backing
 * cannot substitute because it recomputes through the same mis-scaled `priceWad`.
 *
 * Each predicate takes the transition and returns true to PAGE. It is consulted only on an ALERT.
 * @type {Map<string, (t: import('./transitions.mjs').Transition) => boolean>}
 */
export const CONDITIONAL_PAGE = new Map([
  ['feed-identity', (t) => t?.result?.detail?.harm != null],
]);

/**
 * Every OTHER signal name the runner can currently emit, spelled out on purpose rather than left as
 * "whatever isn't in PAGE_SIGNALS". A signal that lands in NONE of the three categories fails
 * `sinks.test.mjs`'s coverage test instead of silently defaulting to LOG (or PAGE) — and that test
 * enumerates `src/signals/` from disk, so a brand-new signal FILE fails it too, not just a rename.
 */
export const LOG_SIGNALS = new Set(['module-events', 'vault-config']);

/**
 * PAGE or LOG for one transition. A synthetic self-test transition (see `canary-runner.mjs`
 * `testAlert()`) forces its tier via `result.detail.tier` rather than impersonating a real signal
 * name — that keeps the routing path under test genuine without ever being able to page on a fake
 * `nav-backing` ALERT. That override is honoured ONLY alongside `detail.selfTest === true`: a real
 * signal's `detail` is a bag of decoded on-chain values, and a future signal that spreads a struct
 * field named `tier` into it must not be able to DEMOTE its own page. Real transitions fall through
 * to the signal/status derivation.
 * @param {import('./transitions.mjs').Transition} t
 * @returns {'page'|'log'}
 */
export function tierOf(t) {
  const detail = t?.result?.detail;
  if (detail?.selfTest === true && (detail.tier === 'page' || detail.tier === 'log')) return detail.tier;
  if (t?.to !== 'alert') return 'log';
  if (PAGE_SIGNALS.has(t?.signal)) return 'page';
  const pagesWhen = CONDITIONAL_PAGE.get(t?.signal);
  return pagesWhen?.(t) === true ? 'page' : 'log';
}

/**
 * @param {Object} cfg
 * @param {string} cfg.url
 * @param {typeof fetch} [cfg.fetchImpl]  injected in tests
 * @param {number} [cfg.timeoutMs]
 * @param {Function} [cfg.onError]        how to report a delivery failure (default: console.error)
 */
export function createWebhookSink({ url, fetchImpl = globalThis.fetch, timeoutMs = 5000, onError = console.error }) {
  return {
    name: 'webhook',
    /** @param {import('./transitions.mjs').Transition} t */
    async emit(t) {
      const body = {
        text: t.line,
        status: t.to,
        previousStatus: t.from,
        // >0 on a broken-detector re-assertion: how many consecutive sweeps the check has been
        // blind. A receiver can escalate on it without parsing the human line.
        repeat: t.repeat ?? 0,
        // 'page' | 'log' — lets a receiver on a SINGLE endpoint (e.g. the ALERT_WEBHOOK_URL
        // fallback, or a tiered deployment that points both URLs at the same place) still route
        // without re-deriving the severity map itself.
        tier: tierOf(t),
        signal: t.signal,
        vault: t.vault,
        key: t.key ?? null,
        measured: t.result.measured ?? null,
        threshold: t.result.threshold ?? null,
        detail: t.result.detail ?? {},
      };
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)),
          signal: ac.signal,
        });
        if (!res?.ok) onError(`canary: webhook returned ${res?.status ?? '?'} for ${t.id}`);
      } catch (err) {
        onError(`canary: webhook delivery failed for ${t.id}: ${err?.message ?? err}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Two webhook URLs, routed by `tierOf`. Either URL may be omitted (that tier is simply not
 * delivered); when `pageUrl === logUrl` — the `ALERT_WEBHOOK_URL`-only back-compat case — routing
 * still resolves to exactly one physical POST per transition, identical to today's single-webhook
 * behaviour, because each `emit` call handles one transition and picks one URL for it.
 * @param {Object} cfg
 * @param {string|null} [cfg.pageUrl]
 * @param {string|null} [cfg.logUrl]
 * @param {typeof fetch} [cfg.fetchImpl]
 * @param {number} [cfg.timeoutMs]
 * @param {Function} [cfg.onError]
 */
export function createTieredWebhookSink({ pageUrl, logUrl, fetchImpl = globalThis.fetch, timeoutMs = 5000, onError = console.error }) {
  const sinkFor = (url) => createWebhookSink({ url, fetchImpl, timeoutMs, onError });
  const pageSink = pageUrl ? sinkFor(pageUrl) : null;
  const logSink = logUrl ? (logUrl === pageUrl ? pageSink : sinkFor(logUrl)) : null;
  return {
    name: 'webhook-tiered',
    /** @param {import('./transitions.mjs').Transition} t */
    async emit(t) {
      const sink = tierOf(t) === 'page' ? pageSink : logSink;
      if (sink) await sink.emit(t);
    },
  };
}

/**
 * Off-host dead-man's switch. `ping()` is called once per SUCCESSFUL sweep (see
 * `canary-runner.mjs`'s `loop()`) against an external heartbeat-monitoring URL — e.g.
 * https://hc-ping.com/<uuid> from a Healthchecks.io-style free check. That account is a human's to
 * create (see the README); this is only the code path that pings it. A plain GET matches the
 * simplest form every such service accepts (curl/wget compatible, no body needed).
 *
 * Off by default when `url` is unset: most deployments start before the external monitor account
 * exists, and pinging nothing must never look like a failure. A failed ping is logged, never
 * fatal — the whole point of this switch is to be noticed from OUTSIDE this host, so a delivery
 * failure here is itself something an operator reading logs should see, not a reason to crash the
 * loop that is the last line of defence.
 * @param {Object} cfg
 * @param {string|null} [cfg.url]
 * @param {typeof fetch} [cfg.fetchImpl]
 * @param {number} [cfg.timeoutMs]
 * @param {Function} [cfg.onError]
 */
export function createDeadmanPing({ url = null, fetchImpl = globalThis.fetch, timeoutMs = 5000, onError = console.error } = {}) {
  return {
    name: 'deadman',
    enabled: Boolean(url),
    async ping() {
      if (!url) return;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      try {
        const res = await fetchImpl(url, { method: 'GET', signal: ac.signal });
        if (!res?.ok) onError(`canary: dead-man ping returned ${res?.status ?? '?'}`);
      } catch (err) {
        onError(`canary: dead-man ping failed: ${err?.message ?? err}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Fan one transition out to every sink. A throwing sink is reported and skipped, never fatal.
 * @param {Array<{name:string, emit:Function}>} sinks
 * @param {import('./transitions.mjs').Transition[]} transitions
 */
export async function emitAll(sinks, transitions, { onError = console.error } = {}) {
  for (const t of transitions) {
    for (const sink of sinks) {
      try {
        await sink.emit(t);
      } catch (err) {
        onError(`canary: sink ${sink.name} threw on ${t.id}: ${err?.message ?? err}`);
      }
    }
  }
}
