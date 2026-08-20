// @ts-check
/**
 * Transition detection: turn a stream of per-poll signal observations into the handful of lines an
 * operator should actually read. Pure — no I/O, no clock, no formatting of its own beyond the
 * alert line. Persistence is the runner's job (see canary-runner.mjs).
 *
 * RULES
 *  - One line per TRANSITION only. A signal that stays OK poll after poll emits nothing, which is
 *    the entire point: silence means healthy, so any output is worth looking at.
 *  - State is keyed by the signal's full id — `signal|vault|key` — so per-asset oracle freshness
 *    tracks each asset separately and one stale asset cannot flap a whole vault's signal.
 *  - The FIRST observation of an ALERT emits. The first observation of an OK does not: a canary
 *    starting up against a healthy chain must not announce every signal it is watching.
 *  - `skipped` is its own state, not a silent `ok`. OK→SKIPPED emits, because a sentinel that has
 *    stopped being able to run is exactly the thing you would otherwise never notice.
 *  - `minConsecutive` (carried on a result's `detail`) requires N consecutive same-status
 *    observations before a transition is emitted. Used by share-conservation when it cannot pin
 *    its chain read to the indexer's height, where a one-poll mismatch is ordinary lag.
 */

/**
 * @typedef {{status:'ok'|'alert'|'skipped', since:number, pendingStatus:string|null, pendingCount:number}} TrackedState
 * @typedef {Object} Transition
 * @property {string} id
 * @property {string} signal
 * @property {string} vault
 * @property {string} [key]
 * @property {'ok'|'alert'|'skipped'} from
 * @property {'ok'|'alert'|'skipped'} to
 * @property {string} line       the operator-facing one-liner
 * @property {import('./signal.mjs').SignalResult} result
 */

/** Rendered prefix per destination status. */
const MARK = { alert: 'ALERT', ok: 'RECOVERED', skipped: 'DEGRADED' };

/**
 * Format one transition line. Every alert line carries vault, signal, and measured-vs-threshold,
 * so it is actionable without opening a dashboard.
 * @param {'ok'|'alert'|'skipped'} to
 * @param {import('./signal.mjs').SignalResult} r
 * @param {string} [timestamp] ISO time; the runner supplies it so this stays clock-free
 */
export function formatLine(to, r, timestamp) {
  const bits = [timestamp, MARK[to] ?? to.toUpperCase(), `[${r.signal}]`, r.message];
  const mt = r.measured != null && r.threshold != null ? `(measured ${r.measured}, threshold ${r.threshold})` : null;
  return [...bits.filter(Boolean), mt].filter(Boolean).join(' ');
}

/**
 * @param {Object} [opts]
 * @param {Record<string, TrackedState>} [opts.initial] restored state from disk
 */
export function createTransitionTracker({ initial = {} } = {}) {
  /** @type {Map<string, TrackedState>} */
  const states = new Map(Object.entries(initial ?? {}));

  /**
   * Feed one poll's worth of results; get back only what changed.
   * @param {import('./signal.mjs').SignalResult[]} results
   * @param {{poll?:number, timestamp?:string}} [ctx]
   * @returns {Transition[]}
   */
  function observe(results, { poll = 0, timestamp } = {}) {
    /** @type {Transition[]} */
    const out = [];

    for (const r of results) {
      const need = Math.max(1, Number(r.detail?.minConsecutive ?? 1));
      const prev = states.get(r.id);

      if (!prev) {
        // First sighting. Record it; announce only if it is already wrong.
        states.set(r.id, { status: r.status, since: poll, pendingStatus: null, pendingCount: 0 });
        if (r.status !== 'ok') {
          out.push({
            id: r.id, signal: r.signal, vault: r.vault, key: r.key,
            from: 'ok', to: r.status, line: formatLine(r.status, r, timestamp), result: r,
          });
        }
        continue;
      }

      if (r.status === prev.status) {
        prev.pendingStatus = null;
        prev.pendingCount = 0;
        continue;
      }

      // Status differs. Require `need` consecutive observations of the new status before flipping.
      prev.pendingCount = prev.pendingStatus === r.status ? prev.pendingCount + 1 : 1;
      prev.pendingStatus = r.status;
      if (prev.pendingCount < need) continue;

      const from = prev.status;
      prev.status = r.status;
      prev.since = poll;
      prev.pendingStatus = null;
      prev.pendingCount = 0;
      out.push({
        id: r.id, signal: r.signal, vault: r.vault, key: r.key,
        from, to: r.status, line: formatLine(r.status, r, timestamp), result: r,
      });
    }

    return out;
  }

  /** Serializable snapshot — the runner persists this so a restart does not re-page. */
  function snapshot() {
    return Object.fromEntries(states.entries());
  }

  /** Currently-not-OK signals, for the periodic heartbeat summary. */
  function unhealthy() {
    return [...states.entries()].filter(([, s]) => s.status !== 'ok').map(([id, s]) => ({ id, ...s }));
  }

  return { observe, snapshot, unhealthy, get size() { return states.size; } };
}
