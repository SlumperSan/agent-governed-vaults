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
 *  - `notApplicable` (carried on a result's `detail`) is the mirror image of that rule. It rides on an `ok`
 *    result whose check has no subject in this deployment, and it is the ONE case where a
 *    first-sighting `ok` emits: exactly one NOTICE line, so the fact is stated once instead of
 *    never. Every later sweep matches the tracked status and emits nothing.
 *  - `minConsecutive` (carried on a result's `detail`) requires N consecutive same-status
 *    observations before a transition is emitted. Used by share-conservation when it cannot pin
 *    its chain read to the indexer's height, where a one-poll mismatch is ordinary lag.
 *  - `detectorBroken` (also on `detail`) is the ONE exception to "report a standing problem once".
 *    A broken DETECTOR is re-asserted on a doubling backoff -- sweeps 1, 2, 4, 8, ... then every 64
 *    -- with the consecutive-sweep count in the line, so it escalates instead of scrolling away.
 *    See `detectorBroken()` in signal.mjs for why this one case earns the noise: report-once is
 *    correct for a problem in the SYSTEM, because someone is already looking at it; it is exactly
 *    wrong for a problem in the MONITOR, because a monitor nobody knows is dead manufactures
 *    confidence. The pre-C-6 oracle signal degraded once at startup and then said nothing for the
 *    rest of the deployment's life. This rule is what makes that impossible.
 */

/**
 * @typedef {{status:'ok'|'alert'|'skipped', since:number, pendingStatus:string|null, pendingCount:number,
 *            brokenPolls?:number, brokenNext?:number}} TrackedState
 * @typedef {Object} Transition
 * @property {string} id
 * @property {string} signal
 * @property {string} vault
 * @property {string} [key]
 * @property {'ok'|'alert'|'skipped'} from
 * @property {'ok'|'alert'|'skipped'} to
 * @property {string} line       the operator-facing one-liner
 * @property {number} [repeat]   consecutive sweeps a broken detector has been blind (re-assertions only)
 * @property {import('./signal.mjs').SignalResult} result
 */

/** Rendered prefix per destination status. */
const MARK = { alert: 'ALERT', ok: 'RECOVERED', skipped: 'DEGRADED' };

/**
 * Re-assert a broken detector on a doubling backoff, then at a fixed cadence: sweeps 1, 2, 4, 8,
 * 16, 32, 64, 128, 192, 256... Doubling keeps a transient RPC blip from producing a burst, and the
 * cap stops the interval from growing until the reminder is useless -- at the default 30s cadence
 * the steady state is one line every ~32 minutes, which is a reminder rather than a pager storm.
 */
const BROKEN_REPEAT_CAP = 64;
const nextBrokenReport = (n) => (n >= BROKEN_REPEAT_CAP ? n + BROKEN_REPEAT_CAP : n * 2);

/**
 * A broken DETECTOR is marked differently from a DEGRADED check on purpose. "DEGRADED" reads as
 * "this vault is in a state the check cannot measure"; "DETECTOR BROKEN" reads as "you are not
 * being monitored", which is the thing an operator must never mistake for silence-means-healthy.
 */
function markFor(to, r, repeat) {
  if (r?.detail?.detectorBroken) {
    return repeat > 0 ? `DETECTOR BROKEN (still blind after ${repeat} consecutive sweeps)` : 'DETECTOR BROKEN';
  }
  // A not-applicable check is `ok`, but `MARK.ok` is "RECOVERED" and nothing recovered: there was
  // never a fault to come back from. NOTICE says what the line actually is — a statement of fact
  // about how this deployment is wired, made once.
  if (to === 'ok' && r?.detail?.notApplicable) return 'NOTICE';
  return MARK[to] ?? to.toUpperCase();
}

/**
 * Format one transition line. Every alert line carries vault, signal, and measured-vs-threshold,
 * so it is actionable without opening a dashboard.
 * @param {'ok'|'alert'|'skipped'} to
 * @param {import('./signal.mjs').SignalResult} r
 * @param {string} [timestamp] ISO time; the runner supplies it so this stays clock-free
 * @param {number} [repeat] consecutive sweeps a broken detector has been blind; 0 on a transition
 */
export function formatLine(to, r, timestamp, repeat = 0) {
  const bits = [timestamp, markFor(to, r, repeat), `[${r.signal}]`, r.message];
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

    /** Build one transition record. `repeat` > 0 marks a broken-detector re-assertion. */
    const emit = (r, from, repeat = 0) => ({
      id: r.id, signal: r.signal, vault: r.vault, key: r.key,
      from, to: r.status, line: formatLine(r.status, r, timestamp, repeat), result: r,
      ...(repeat > 0 ? { repeat } : {}),
    });

    for (const r of results) {
      const need = Math.max(1, Number(r.detail?.minConsecutive ?? 1));
      // A detector only counts as blind while it is also not-OK; a signal that recovers stops
      // escalating even if the flag is somehow still set on the result.
      const blind = r.detail?.detectorBroken === true && r.status !== 'ok';
      const prev = states.get(r.id);

      if (!prev) {
        // First sighting. Record it; announce only if it is already wrong.
        states.set(r.id, {
          status: r.status, since: poll, pendingStatus: null, pendingCount: 0,
          brokenPolls: blind ? 1 : 0, brokenNext: blind ? 2 : 0,
        });
        // A healthy first sighting stays silent; a not-applicable one does not. Left silent it
        // would never be said at all, and "this check has no subject here" is precisely the fact an
        // operator cannot infer from silence — silence is what a passing check looks like.
        if (r.status !== 'ok' || r.detail?.notApplicable === true) out.push(emit(r, 'ok'));
        continue;
      }

      if (r.status === prev.status) {
        prev.pendingStatus = null;
        prev.pendingCount = 0;
        if (!blind) {
          prev.brokenPolls = 0;
          prev.brokenNext = 0;
          continue;
        }
        // Still blind. Count the sweep and re-assert when the backoff falls due. A state file
        // written before these fields existed restores them as 0, so a restart re-asserts within
        // two sweeps rather than inheriting silence.
        prev.brokenPolls = (prev.brokenPolls ?? 0) + 1;
        if (prev.brokenPolls >= (prev.brokenNext || 2)) {
          prev.brokenNext = nextBrokenReport(prev.brokenPolls);
          out.push(emit(r, prev.status, prev.brokenPolls));
        }
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
      prev.brokenPolls = blind ? 1 : 0;
      prev.brokenNext = blind ? 2 : 0;
      out.push(emit(r, from));
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
