// @ts-check
/**
 * Graceful shutdown: run a list of named hooks on SIGTERM/SIGINT, then exit.
 *
 * `docker compose down`, a rolling restart and a Ctrl-C all deliver a signal and then wait a
 * bounded time before SIGKILL. Without a handler the default action is immediate termination —
 * the indexer loses the batch it was folding, the API cuts live responses mid-body, and the canary
 * drops the transitions it had just detected. Each hook here closes exactly one of those gaps.
 *
 * Guarantees:
 *  - hooks run ONCE, in registration order, sequentially;
 *  - a hook that throws is logged and does not stop the ones after it (a failed snapshot must
 *    still let the API drain);
 *  - a SECOND signal exits immediately — the "I meant it" escape hatch, so an operator is never
 *    stuck waiting on a hook that is itself wedged;
 *  - a `timeoutMs` watchdog force-exits if the hooks never finish, so the process cannot outlive
 *    its own shutdown and sit there until SIGKILL.
 *
 * `proc` and `exit` are injected, which is how this is tested with no real signals (see
 * test/shutdown.test.mjs) — a fake EventEmitter stands in for `process`.
 */

/**
 * @param {Object} [p]
 * @param {{info?:Function, warn?:Function, error?:Function}} [p.log]
 * @param {{on:Function}} [p.proc]
 * @param {string[]} [p.signals]
 * @param {number} [p.timeoutMs]
 * @param {(code:number)=>void} [p.exit]
 */
export function createShutdown({
  log = {}, proc = process, signals = ['SIGTERM', 'SIGINT'], timeoutMs = 15_000,
  exit = (code) => process.exit(code),
} = {}) {
  /** @type {{name:string, fn:(reason:string)=>any}[]} */
  const hooks = [];
  let state = 'idle';
  /** @type {Promise<void>|null} */
  let running = null;

  async function drain(reason) {
    for (const h of hooks) {
      try {
        await h.fn(reason);
        log.info?.('shutdown.step', { step: h.name, ok: true });
      } catch (err) {
        log.error?.('shutdown.step', { step: h.name, ok: false, error: String(err?.message ?? err) });
      }
    }
  }

  /** Begin (or, on a repeat signal, abandon) shutdown. Resolves when the hooks are done. */
  function trigger(reason = 'manual') {
    if (state !== 'idle') {
      log.warn?.('shutdown.forced', { reason, state });
      exit(1);
      return running ?? Promise.resolve();
    }
    state = 'running';
    log.info?.('shutdown.begin', { reason, hooks: hooks.length, timeoutMs });
    const watchdog = setTimeout(() => {
      log.error?.('shutdown.timeout', { reason, timeoutMs });
      exit(1);
    }, timeoutMs);
    if (typeof watchdog.unref === 'function') watchdog.unref();

    running = drain(reason).then(() => {
      clearTimeout(watchdog);
      state = 'done';
      log.info?.('shutdown.complete', { reason });
      exit(0);
    });
    return running;
  }

  const api = {
    /** Register a hook. Order matters: they run in the order registered. */
    onShutdown(name, fn) { hooks.push({ name, fn }); return api; },
    install() { for (const s of signals) proc.on(s, () => { trigger(s); }); return api; },
    trigger,
    get state() { return state; },
    get hooks() { return hooks.map((h) => h.name); },
  };
  return api;
}
