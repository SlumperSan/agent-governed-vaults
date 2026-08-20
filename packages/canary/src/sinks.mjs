// @ts-check
/**
 * Where transition lines go. Two sinks, both optional-failure-tolerant: a sink that throws must
 * never take the canary down, because a paging outage is not a reason to stop watching the chain.
 *
 * console  — always on. stdout for recoveries, stderr for alerts and degradations, so a `2>` split
 *            gives you a pure problem feed.
 * webhook  — on iff ALERT_WEBHOOK_URL is set. POSTs one JSON body per transition, carrying the
 *            structured `detail` from the signal so a receiver can route on vault or signal
 *            without parsing the human line.
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
