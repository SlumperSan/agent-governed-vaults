// @ts-check
/**
 * Runnable indexer daemon: resume from a snapshot, poll new logs, fold them, snapshot
 * periodically. The chain client and clock are injected so the whole loop is testable with a
 * fake client and no RPC (see test/daemon.test.mjs). Wire a real viem client via chain.mjs in
 * production.
 */

import { apply } from './projections.mjs';
import { loadSnapshot, saveSnapshot, resumeCursor } from './store.mjs';

/**
 * @param {Object} cfg
 * @param {string} cfg.statePath                     snapshot file path
 * @param {(fromBlock:number, toBlock:number) => Promise<import('./projections.mjs').Event[]>} cfg.fetchEvents
 *        return NORMALIZED events for a block range (chain.mjs produces these from logs)
 * @param {() => Promise<number>} cfg.headBlock      current chain head
 * @param {number} [cfg.confirmations]               lag behind head before indexing (reorg safety)
 * @param {number} [cfg.batchBlocks]                 max blocks per poll
 * @param {(msg:string)=>void} [cfg.log]
 */
export function createIndexerDaemon({ statePath, fetchEvents, headBlock, confirmations = 5, batchBlocks = 2000, log = () => {} }) {
  let state = null;
  let running = false;

  async function init() {
    state = await loadSnapshot(statePath);
    log(`resumed at block ${state.lastBlock} (${state.vaults.size} vaults)`);
    return state;
  }

  /**
   * Index one batch: fetch events from the resume cursor up to (head - confirmations), capped at
   * batchBlocks, fold them, snapshot. Returns the number of events applied. Safe to call in a
   * loop or on a schedule; a no-op when already caught up.
   */
  async function tick() {
    if (!state) await init();
    const head = await headBlock();
    const safeHead = head - confirmations;
    const from = resumeCursor(state).fromBlock;
    if (safeHead < from) return 0; // caught up (or not enough confirmations yet)
    const to = Math.min(safeHead, from + batchBlocks - 1);

    const events = await fetchEvents(from, to);
    for (const e of events) apply(state, e);
    // Advance the cursor to `to` even if no events landed, so we don't re-scan empty ranges.
    if (state.lastBlock < to) {
      state.lastBlock = to;
      state.lastLogIndex = -1;
    }
    await saveSnapshot(statePath, state);
    log(`indexed [${from}..${to}] — ${events.length} events, now at ${state.lastBlock}`);
    return events.length;
  }

  /** Run until caught up with the chain head (drains all batches). Returns total events applied. */
  async function catchUp() {
    let total = 0;
    for (;;) {
      const n = await tick();
      const head = await headBlock();
      if (resumeCursor(state).fromBlock > head - confirmations) return total + n;
      total += n;
    }
  }

  return {
    init,
    tick,
    catchUp,
    getState: () => state,
    stop: () => { running = false; },
    get isRunning() { return running; },
  };
}
