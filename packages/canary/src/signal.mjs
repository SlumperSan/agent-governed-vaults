// @ts-check
/**
 * The vocabulary every signal check returns. Kept tiny and pure so a signal module can be read,
 * tested, and reasoned about without knowing anything about the runner, the sinks, or the RPC.
 *
 * Three statuses, and the third one matters:
 *   ok      — measured, within threshold.
 *   alert   — measured, out of threshold. Pages.
 *   skipped — could NOT be measured (no eligible member to probe with, oracle breaker tripped,
 *             archive state unavailable…). A check that cannot run is not a check that passed,
 *             so it never collapses into `ok`. The runner reports OK→SKIPPED as its own
 *             transition line, which is how a dead sentinel becomes visible instead of silent.
 *
 * @typedef {'ok'|'alert'|'skipped'} SignalStatus
 * @typedef {Object} SignalResult
 * @property {string} id            stable identity for transition tracking: signal|vault|key
 * @property {string} signal        signal name (e.g. 'oracle-freshness')
 * @property {string} vault         the vault this observation is about
 * @property {string} [key]         sub-key when a signal fans out (e.g. per basket asset)
 * @property {SignalStatus} status
 * @property {string} message       one actionable line: what is wrong, measured vs threshold
 * @property {string} [measured]    the measured value, formatted
 * @property {string} [threshold]   the threshold it was compared against, formatted
 * @property {Record<string, any>} [detail]  structured extras for the webhook payload
 */

/** Stable transition key. Per-asset fan-out gets its own key so one stale asset cannot flap a vault. */
export function signalId(signal, vault, key) {
  return key ? `${signal}|${vault}|${key}` : `${signal}|${vault}`;
}

const build = (status) => (
  /**
   * @param {{signal:string, vault:string, key?:string, message:string,
   *          measured?:string, threshold?:string, detail?:Record<string,any>}} fields
   * @returns {SignalResult}
   */
  (fields) => ({ ...fields, status, id: signalId(fields.signal, fields.vault, fields.key) })
);

export const ok = build('ok');
export const alert = build('alert');
export const skipped = build('skipped');

/**
 * A `skipped` whose cause is the DETECTOR, not the system under observation.
 *
 * The distinction is the whole point. "No member holds shares to probe with" and "navWad reverts
 * StaleOracle" are KNOWN-STATE skips: the monitor understands the situation, the situation is
 * covered by another signal, and repeating it every poll would be noise. "This oracle answers
 * neither ABI I know" and "the check threw" are different in kind — the monitor is BLIND and does
 * not know what it is missing. Those are marked here, and the transition tracker re-asserts them on
 * an escalating backoff instead of falling silent after one line.
 *
 * That failure mode is not hypothetical: the pre-C-6 oracle signal called `assetConfig` on a
 * `ChainlinkOracle` that has no such function, emitted ONE degraded line at startup, and then said
 * nothing for the rest of the deployment's life while the flagship freeze detector was dead.
 *
 * @param {{signal:string, vault:string, key?:string, message:string,
 *          measured?:string, threshold?:string, detail?:Record<string,any>}} fields
 * @returns {SignalResult}
 */
export function detectorBroken(fields) {
  return skipped({ ...fields, detail: { ...(fields.detail ?? {}), detectorBroken: true } });
}

/** Short vault label for alert lines: 0x1234…cdef. Full address always rides in `detail`. */
export function shortAddr(a) {
  return typeof a === 'string' && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : String(a);
}

/**
 * |a - b| as a fraction of max(a, b), in basis points. Integer math end to end — divergence
 * thresholds must never round through a float. Returns 0 when both sides are zero.
 * @param {bigint} a @param {bigint} b @returns {bigint}
 */
export function divergenceBps(a, b) {
  const hi = a > b ? a : b;
  if (hi === 0n) return 0n;
  const diff = a > b ? a - b : b - a;
  return (diff * 10000n) / hi;
}

/**
 * Render integer basis points as a percentage string, e.g. 137n -> "1.37%".
 *
 * The sign is taken from the WHOLE value, not from the integer-divided whole part. BigInt division
 * truncates toward zero, so `-50n / 100n` is `0n` and the naive form renders -50 bps as "0.50%" —
 * a lost minus sign on exactly the numbers where it matters most. Nothing rendered a negative bps
 * value until `signals/operator-power.mjs` began reporting `marginBps` (which is negative for every
 * operator already below their gate), so this only ever produced correct output before; it is
 * corrected here rather than left as a trap for the next caller.
 */
export function bpsToPct(bps) {
  const n = typeof bps === 'bigint' ? bps : BigInt(bps);
  const abs = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}%`;
}
