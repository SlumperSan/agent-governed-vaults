// @ts-check
/**
 * The canary's chain adapter — the ONLY file in this package that talks to an RPC.
 *
 * Every signal check is a pure function over a `reader` shaped like the object this builds, so
 * the tests inject a plain literal and no signal ever needs a live chain. viem is a lazy,
 * OPTIONAL import (built only when no `client` is injected), mirroring packages/indexer/src/rpc.mjs
 * so this package stays loadable in a bare checkout.
 *
 * READ-ONLY BY CONSTRUCTION. This module builds a viem *public* client — there is no
 * `createWalletClient`, no account, no signer, and no key anywhere in packages/canary. The five
 * methods below map to `eth_blockNumber`, `eth_getBlockByNumber`, `eth_call`, and `eth_getLogs`;
 * nothing else is reachable through this object.
 *
 * The reader interface (what a mock must implement):
 *   headBlock()                                        -> Promise<number>
 *   chainNow()                                         -> Promise<number>   (latest block ts, seconds)
 *   read(address, abi, fn, args, opts)                 -> Promise<any>      (throws on revert)
 *   tryRead(address, abi, fn, args, opts)              -> Promise<ReadResult>   (never throws)
 *   getLogs({address, event, args, fromBlock, toBlock})-> Promise<Log[]>
 *   staticCall({to, from, data})                       -> Promise<CallResult>   (never throws)
 *
 * ── `kind` on a failure: is this evidence about the contract? ──
 * `ok:false` alone says only that a read did not produce a value. A 429, a timeout and a genuine
 * revert all reach a caller that way, so a signal branching on `!ok` turns a busy network into a
 * finding about the protocol. Every failure therefore carries `kind`: `'revert'` when the chain
 * refused the call, `'transport'` when it is not a confirmed revert (see call-error.mjs — that
 * word does NOT mean the node was unreachable). Signals route `'transport'` to a blind-detector
 * result and keep their verdicts for `'revert'`.
 *
 * A transport failure also carries NO returndata. `extractRevertData` falls back to scraping hex
 * out of the error text, and viem's transport errors quote the request — so on an HTTP 429 it
 * returns the canary's OWN `requestExit` calldata, whose first four bytes then read as an
 * unrecognized revert selector. That is measured, not hypothetical (test/reader.test.mjs), and it
 * is why `revertData`/`data` is forced to null when `kind === 'transport'`: a call that never
 * reached the chain produced no returndata, so reporting scraped hex would be a lie at the source.
 *
 * @typedef {{ok:boolean, value?:any, revertData?:string|null, error?:string, kind?:'revert'|'transport'}} ReadResult
 * @typedef {{ok:boolean, data:string|null, error?:string, kind?:'revert'|'transport'}} CallResult
 */
import { classifyCallError } from './call-error.mjs';

const HEX_RE = /0x[0-9a-fA-F]{8,}/;

/**
 * Dig the raw revert returndata out of whatever the provider or viem threw.
 *
 * Pure and unit-tested, because the whole exit-liveness sentinel hinges on it: a bug here that
 * silently returned null would downgrade a real H-1 fault into "unclassifiable". Callers treat
 * `null` as "reverted with no data", which ALERTS — so the failure mode here is loud, not silent.
 *
 * Walks the `cause` chain (viem nests RpcRequestError inside CallExecutionError inside
 * ContractFunctionExecutionError) and falls back to scraping a hex blob out of the message.
 * @param {any} err
 * @returns {string|null} lowercased 0x-prefixed returndata, or null if there was none
 */
export function extractRevertData(err) {
  return structuredRevertData(err) ?? scrapedRevertData(err);
}

/**
 * The STRUCTURED half of the walk: returndata viem actually handed us in a field, as opposed to
 * hex found in prose. Split out (behaviour of `extractRevertData` unchanged — it is these two in
 * the original order) because the two halves carry very different weight as evidence.
 *
 * Returndata in a field can only exist if the EVM executed and reverted, so a non-null answer here
 * is positive proof of a revert and outranks the message text when `tryRead`/`staticCall` decide
 * `kind`. That matters for a provider whose wording no pattern recognises: without this, a real
 * revert carrying real returndata would be filed as unreadable.
 * @param {any} err
 * @returns {string|null}
 */
export function structuredRevertData(err) {
  const seen = new Set();
  let node = err;
  for (let depth = 0; node && typeof node === 'object' && depth < 12; depth += 1) {
    if (seen.has(node)) break;
    seen.add(node);
    for (const key of ['data', 'raw', 'returnData']) {
      const v = node[key];
      if (typeof v === 'string' && v.startsWith('0x') && v.length >= 10) return v.toLowerCase();
      // viem sometimes nests the decoded shape as { data: { data: '0x…' } }
      if (v && typeof v === 'object' && typeof v.data === 'string' && v.data.startsWith('0x')) {
        return v.data.toLowerCase();
      }
    }
    node = node.cause;
  }
  return null;
}

/**
 * The SCRAPED half: the first long hex run anywhere in the error prose. Weak evidence, and the
 * reason `kind` exists — viem quotes the failing request in a transport error's message, so on an
 * HTTP 429 this returns the CALLER'S OWN calldata. Never used to decide `kind`.
 * @param {any} err
 * @returns {string|null}
 */
function scrapedRevertData(err) {
  const text = [err?.details, err?.shortMessage, err?.message]
    .filter((s) => typeof s === 'string')
    .join(' ');
  const m = HEX_RE.exec(text);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Was a failed call EVIDENCE ABOUT THE CONTRACT, or did it never get there?
 *
 * Two sources, in order of how much they prove. Returndata viem handed us in a FIELD can only
 * exist if the EVM executed and reverted, so it settles the question outright — that path also
 * keeps a revert classifiable when a provider's wording matches no known pattern. Failing that,
 * the message text decides, via the classifier `scripts/soak/lib.mjs` shares.
 *
 * The scraped hex is deliberately not consulted: it is the thing that made a 429 look like a
 * revert in the first place.
 * @param {any} err @param {string} errorText @returns {'revert'|'transport'}
 */
function classifyFailure(err, errorText) {
  return structuredRevertData(err) != null ? 'revert' : classifyCallError(errorText);
}

/**
 * @param {Object} cfg
 * @param {any} [cfg.client]    an injected viem-style public client (tests); built from rpcUrl if omitted
 * @param {string} [cfg.rpcUrl] HTTP RPC endpoint (required when no client is injected)
 * @param {number} [cfg.chainId]
 * @param {string} [cfg.chainName]
 */
export function createChainReader({ client, rpcUrl, chainId = 8453, chainName = 'base' } = {}) {
  let _client = client ?? null;

  async function getClient() {
    if (_client) return _client;
    if (!rpcUrl) throw new Error('canary: no client injected and no rpcUrl provided');
    const { createPublicClient, http } = await import('viem').catch(() => {
      throw new Error('canary: viem is not installed — run `npm install viem` (optional runtime dependency)');
    });
    const chain = {
      id: chainId,
      name: chainName,
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    };
    _client = createPublicClient({ chain, transport: http(rpcUrl) });
    return _client;
  }

  async function headBlock() {
    const c = await getClient();
    return Number(await c.getBlockNumber());
  }

  /**
   * Latest block timestamp, seconds. Oracle freshness is measured against CHAIN time, never the
   * canary host's clock — a skewed monitoring box must not invent (or hide) staleness.
   */
  async function chainNow() {
    const c = await getClient();
    const block = await c.getBlock();
    return Number(block.timestamp);
  }

  /** @param {{blockNumber?:number}} [opts] pin the read to a height (share conservation does) */
  async function read(address, abi, functionName, args = [], opts = {}) {
    const c = await getClient();
    const at = opts.blockNumber != null ? { blockNumber: BigInt(opts.blockNumber) } : {};
    return c.readContract({ address, abi, functionName, args, ...at });
  }

  /** read() that reports a revert as data instead of throwing — signals branch on the reason. */
  async function tryRead(address, abi, functionName, args = [], opts = {}) {
    try {
      return { ok: true, value: await read(address, abi, functionName, args, opts) };
    } catch (err) {
      const error = err?.shortMessage ?? err?.message ?? String(err);
      const kind = classifyFailure(err, error);
      return {
        ok: false,
        revertData: kind === 'revert' ? extractRevertData(err) : null,
        error,
        kind,
      };
    }
  }

  async function getLogs({ address, event, args, fromBlock, toBlock }) {
    const c = await getClient();
    if (Array.isArray(address) ? address.length === 0 : !address) return [];
    return c.getLogs({
      address,
      event,
      ...(args ? { args } : {}),
      fromBlock: BigInt(fromBlock),
      toBlock: BigInt(toBlock),
    });
  }

  /**
   * Raw `eth_call`. No `gas` is passed on purpose: VaultCore gas-caps its own module calls at
   * 300k (MODULE_CALL_GAS), and supplying a low call gas here would manufacture failures the
   * chain would not produce. Let the node use the block gas limit, exactly like a real caller.
   *
   * `from` is an address the canary IMPERSONATES for the duration of one eth_call. It is not an
   * account, it is not unlocked, and nothing is signed — `eth_call` never touches a key.
   */
  async function staticCall({ to, from, data }) {
    const c = await getClient();
    try {
      const res = await c.call({ to, account: from, data });
      return { ok: true, data: res?.data ?? '0x' };
    } catch (err) {
      const error = err?.shortMessage ?? err?.message ?? String(err);
      const kind = classifyFailure(err, error);
      return {
        ok: false,
        data: kind === 'revert' ? extractRevertData(err) : null,
        error,
        kind,
      };
    }
  }

  return { headBlock, chainNow, read, tryRead, getLogs, staticCall };
}
