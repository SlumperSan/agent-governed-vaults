/**
 * Identity of the DATA chain the metered read serves from — Robinhood Chain mainnet, 4663 —
 * as distinct from the PAYMENT chain resolved in `_price.js` (Base mainnet, 8453). The two are
 * unrelated on purpose (see `docs/REVENUE.md` §1) and this file only ever names the first one.
 *
 * WHY THESE ARE CONSTANTS AND NOT ENV, UNLIKE `_price.js`'s six settings.
 * `_price.js`'s docstring draws the line correctly: an OPERATOR DECISION — who gets paid, what
 * facilitator settles, what the price is — is refused rather than defaulted, because a default
 * would silently pick one on the operator's behalf. Nothing here is that kind of value. The RPC
 * URL, the chain id and the two vault addresses are public facts about a live deployment, the
 * same class of fact `BASE_MAINNET_USDC` already hardcodes in `_price.js` for the payment side.
 * Getting one wrong does not misdirect anyone's money; it makes the route read the wrong chain,
 * which is a bug this file's own drift test (`apps/site-next/test/x402-edge.test.mjs`) catches by
 * comparing `VAULTS` against `contracts/config/deployments/robinhood-mainnet.json` rather than by
 * trusting either copy.
 *
 * The two addresses are NOT read from that deployment-record JSON at request time on purpose: it
 * is a multi-hundred-KB prose file, and importing it into the Worker bundle to extract two
 * addresses would ship kilobytes of narrative the route never uses. This file is the small,
 * bundle-facing copy; the test file is what proves it has not drifted from the record.
 */

/** Robinhood Chain mainnet. */
export const DATA_CHAIN_ID = 4663;
export const DATA_CHAIN_NAME = 'robinhood-mainnet';

// Public RPC. Deliberately no head-block figure in this comment: this chain's own measured block
// time is ~0.1s, so any block number written here is stale before the commit lands, and a prior
// draft of this file learned that the hard way — the figure it carried was wrong by tens of
// thousands of blocks from the moment it was typed, having been hand-converted from a hex
// `eth_blockNumber` reading rather than read straight, and it read as a measured fact because it
// was phrased like one. Reachability is proven by every response `vaults.js` serves carrying the
// `blockNumber` it read AT REQUEST TIME (see `_vaultread.js`); that is the only honest freshness
// claim this route can make about itself, and it is a live one, not a comment.
export const DATA_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * The two vaults this route reads, in the order they are served. Addresses match
 * `contracts/config/deployments/robinhood-mainnet.json`'s `smokeVault.address` /
 * `secondVault.address` — asserted equal by a test rather than assumed.
 */
export const VAULTS = Object.freeze([
  Object.freeze({ label: 'smoke', address: '0x9b0229FF0613EaD59e41Eec556e03b5ED228e2b4' }),
  Object.freeze({ label: 'second', address: '0x03E121e18c68B48B84a60D8F93BcD7D5be31ee38' }),
]);
