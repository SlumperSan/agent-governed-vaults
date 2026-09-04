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
 * A transport failure also carries NO returndata: `revertData`/`data` is forced to null when
 * `kind === 'transport'`. A call that never reached the chain produced no returndata, and the
 * fallback scrape below can still find hex in a node's own words for such a failure — a pruned
 * node's `missing trie node <hash>` classifies 'transport' and carries a 64-hex-character hash
 * (measured; test/reader.test.mjs).
 *
 * ── Returndata comes from the node, never from the request ──
 * viem builds a `BaseError`'s `message` out of its `shortMessage`, `metaMessages` and `details`,
 * and for a failed call the `metaMessages` quote the request: `call` prints `from`, `to` and
 * `data` under "Raw Call Arguments", `readContract` prints the address and args under "Contract
 * Call". Scraping hex out of `message` therefore returns something the canary itself sent
 * whenever the node returned nothing — on a genuine empty-returndata revert, the H-1 signature,
 * it returned the probe's `from` address as the "revert data". The scrape reads only `details`,
 * which viem carries up the cause chain unchanged from the innermost error — for a revert, the
 * node's JSON-RPC `error.message` (viem/errors/base.js, request.js) — and never `message` or
 * `shortMessage`. Measured both ways in test/reader.test.mjs.
 *
 * @typedef {{ok:boolean, value?:any, revertData?:string|null, error?:string, kind?:'revert'|'transport'}} ReadResult
 * @typedef {{ok:boolean, data:string|null, error?:string, kind?:'revert'|'transport'}} CallResult
 */
import { classifyCallError } from './call-error.mjs';

const HEX_RE = /0x[0-9a-fA-F]{8,}/;

/**
 * Dig the raw revert returndata out of whatever the provider or viem threw.
 *
 * Pure and unit-tested, because the exit-liveness sentinel classifies on it. `null` is a real
 * answer, not a failure: it is what a revert with EMPTY returndata produces — the H-1 signature
 * signals/exit-liveness.mjs names — and callers ALERT on it, so a miss here is loud, not silent.
 * The hazard runs the other way, hex the node never sent: this function once scraped the probe's
 * own `from` address out of viem's message on exactly that revert, so the pager line named an
 * "unrecognized revert 0x22222222" instead of empty returndata (measured; test/reader.test.mjs).
 *
 * Walks the `cause` chain for a structured field first (viem nests RpcRequestError inside
 * CallExecutionError inside ContractFunctionExecutionError), then scrapes the node's own words.
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
 * The SCRAPED half: the first long hex run in the NODE'S OWN WORDS — `details`, and only
 * `details`. Weak evidence, never used to decide `kind`.
 *
 * Not `message` and not `shortMessage`. viem composes `message` from `metaMessages`, and for a
 * failed call those quote the request: `call` prints from/to/data under "Raw Call Arguments",
 * `readContract` prints address/args under "Contract Call". On a revert whose returndata is
 * empty there is no hex in the node's words, so a scrape over `message` finds the request's
 * instead — the probe's `from` address in `call`'s message, the contract address in
 * `readContract`'s. `details` is the innermost error's text carried up the chain unchanged
 * (viem/errors/base.js); for a revert that is the node's JSON-RPC `error.message`, and viem does
 * not quote the request there.
 * @param {any} err
 * @returns {string|null}
 */
function scrapedRevertData(err) {
  const details = err?.details;
  if (typeof details !== 'string') return null;
  const m = HEX_RE.exec(details);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Was a failed call EVIDENCE ABOUT THE CONTRACT, or did it never get there?
 *
 * Two sources, in order of how much they prove. Returndata viem handed us in a FIELD can only
 * exist if the EVM executed and reverted, so it settles the question outright — that path also
 * keeps a revert classifiable when a provider's wording matches no known pattern. Failing that,
 * the text decides, via the classifier `scripts/soak/lib.mjs` shares — given BOTH the node's own
 * words (`details`) and viem's (`shortMessage`, or `message` when there is none).
 *
 * `details` is consulted because viem's wording differs by action. `call` says "Execution
 * reverted for an unknown reason.", which the classifier recognises; `readContract` says 'The
 * contract function "f" reverted.', which it does not. So a revert with empty returndata reached
 * `tryRead` as 'transport' — a real revert filed as missing evidence — while `details` said
 * "execution reverted" the whole time (measured; test/reader.test.mjs). The soak harness feeds
 * the same classifier `cast`'s stderr, which is likewise the node's text.
 *
 * The scraped hex is deliberately not consulted: it is the thing that made a 429 look like a
 * revert in the first place.
 * @param {any} err @param {string} errorText @returns {'revert'|'transport'}
 */
function classifyFailure(err, errorText) {
  if (structuredRevertData(err) != null) return 'revert';
  const details = typeof err?.details === 'string' ? err.details : '';
  return classifyCallError(`${details} ${errorText}`);
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
