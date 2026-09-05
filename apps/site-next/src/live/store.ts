/**
 * One read, shared by every component that wants it.
 *
 * WHY A MODULE SINGLETON RATHER THAN A CONTEXT. Two components want this data
 * and they sit on opposite sides of the tree: the price chip is in the masthead
 * and the live panel is in the page body. A context could span both, since
 * `PageShell` is above both, but it would put a provider in the shell whose only
 * job is to hold state the shell itself never reads, and it would still not stop
 * a third caller mounted outside it from firing its own request. A module-level
 * store has no such position in the tree, so the invariant it enforces is the
 * one that matters: THE PAGE MAKES ONE ROUND OF RPC REQUESTS, however many
 * components ask.
 *
 * IT IS INERT ON THE SERVER. `start()` is only ever called from an effect, so a
 * prerender does no network work and the server markup contains no live value.
 * That is not only a build concern. Every figure this store carries is stamped
 * with when it was read; a figure baked into HTML at build time would carry a
 * stamp from whenever the build ran, which is the exact misstatement the live
 * section exists to prevent. The server renders the labels and the empty slots,
 * and the numbers arrive in the reader's own browser or not at all.
 *
 * THE BLOCK NUMBER RE-READS AND NOTHING ELSE DOES. `eth_blockNumber` is one
 * cheap call and the answer genuinely changes every couple of seconds, so a
 * ticking figure is true. `vaultCount` changes when somebody creates a vault,
 * which has not happened, and a Chainlink feed does not print again because the
 * page asked twice. Polling those would be four requests a tick to re-learn the
 * same answer, and it would make the page's network traffic look like a trading
 * terminal's when it is a ledger's.
 *
 * FAILURE IS A STATE, NOT A BLANK. `error` is rendered as an error with the
 * endpoint named. The honest version of a failed read is a reader who can see it
 * failed, because the alternative is a panel that looks the same whether the
 * chain said zero or said nothing.
 */
import { readBlockNumber, readChain, type ChainState } from './chain';

export type LiveState =
  | { readonly status: 'idle' }
  | { readonly status: 'reading' }
  | { readonly status: 'ok'; readonly data: ChainState }
  | { readonly status: 'failed'; readonly message: string };

let state: LiveState = { status: 'idle' };
const listeners = new Set<() => void>();
let started = false;
let ticker: ReturnType<typeof setInterval> | undefined;

/** How often the head is re-read. Robinhood Chain blocks are fast; this is not. */
const TICK_MS = 6000;

function publish(next: LiveState): void {
  state = next;
  for (const l of listeners) l();
}

/**
 * Begin reading, once per page load.
 *
 * Idempotent by design: every subscriber calls it on mount, and the `started`
 * latch is what turns N calls into one round of requests. It is never reset, so
 * a component unmounting and remounting does not re-fetch a chain state that
 * has not changed.
 */
export function start(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  publish({ status: 'reading' });

  readChain()
    .then((data) => {
      publish({ status: 'ok', data });
      ticker = setInterval(() => {
        readBlockNumber()
          .then((blockNumber) => {
            // Only the head moves. Everything else is carried forward from the
            // one full read, so no figure is ever refreshed into a shape the
            // rest of the panel has not caught up with.
            if (state.status !== 'ok') return;
            publish({ status: 'ok', data: { ...state.data, blockNumber } });
          })
          .catch(() => {
            // A failed TICK is not a failed READ. The panel is still showing
            // values that were true when they were fetched, and replacing them
            // with an error because the head did not answer once would be a
            // worse statement than leaving the last known height in place.
          });
      }, TICK_MS);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error && err.message ? err.message : 'unknown error';
      publish({ status: 'failed', message });
    });
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && ticker) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };
}

export function snapshot(): LiveState {
  return state;
}

/**
 * The server's snapshot, and it is a DIFFERENT function returning a CONSTANT.
 *
 * `useSyncExternalStore` calls this during hydration, and React compares what it
 * produces against the server markup. Returning `state` here would return
 * whatever the client store had reached by then, which is a hydration mismatch
 * on a fast connection and a silent one on a slow one. A frozen `idle` is what
 * the server actually rendered, every time.
 */
export function serverSnapshot(): LiveState {
  return SERVER;
}

const SERVER: LiveState = { status: 'idle' };
