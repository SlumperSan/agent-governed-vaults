// @ts-check
/**
 * The read-only surface the canary touches: view functions, watched events, and the 4-byte
 * selectors the exit-liveness sentinel classifies revert data with.
 *
 * DELIBERATELY SEPARATE from packages/indexer/src/abis.mjs. The indexer's table is asserted
 * against `HANDLED_EVENTS` by its event-coverage test — adding ModuleCallFailed / SliceEscrowed
 * there would fail that test, because the projection does not fold them. The canary watches
 * events the projection ignores, so it carries its own table.
 *
 * Nothing here is state-changing. There is no ABI fragment in this file for any non-`view`
 * function except `requestExit`, and that one exists ONLY to build calldata for `eth_call`
 * (see signals/exit-liveness.mjs) — the canary never sends a transaction and holds no key.
 *
 * Selectors are EMBEDDED rather than computed so this module needs no keccak implementation and
 * no viem at import time. test/abis.test.mjs recomputes every one of them with viem and fails on
 * drift — the same guard the indexer's ABI table uses.
 */

/** @typedef {{type:'event', name:string, anonymous:boolean, inputs:Array<{name:string,type:string,indexed:boolean}>}} AbiEvent */

const ev = (name, inputs) => ({ type: 'event', name, anonymous: false, inputs });
const addr = (name, indexed = false) => ({ name, type: 'address', indexed });
const u256 = (name, indexed = false) => ({ name, type: 'uint256', indexed });
const view = (name, inputs, outputs) => ({
  type: 'function',
  name,
  stateMutability: 'view',
  inputs: inputs.map((t, i) => (typeof t === 'string' ? { name: `a${i}`, type: t } : t)),
  outputs: outputs.map((t, i) => (typeof t === 'string' ? { name: `o${i}`, type: t } : t)),
});

/** VaultCore views the NAV / share / basket signals read. All `view`, all free. */
export const VAULT_VIEWS = Object.freeze([
  view('navWad', [], ['uint256']),
  view('totalShares', [], ['uint256']),
  view('idleUsdc', [], ['uint256']),
  view('usdcScalar', [], ['uint256']),
  view('usdc', [], ['address']),
  view('oracle', [], ['address']),
  view('feeEngine', [], ['address']),
  view('creator', [], ['address']),
  view('operatorRegistry', [], ['address']),
  view('basketLength', [], ['uint256']),
  view('basketAssets', ['uint256'], ['address']),
  // assetUnit and assetBalance are PUBLIC mappings on VaultCore, so the canary reads the very
  // same numbers navWad() multiplies — it re-derives nothing and assumes no token's decimals.
  view('assetUnit', ['address'], ['uint256']),
  view('assetBalance', ['address'], ['uint256']),
  view('childVaultCount', [], ['uint256']),
  view('childVaults', ['uint256'], ['address']),
  view('sharesOf', ['address'], ['uint256']),
  view('totalPendingUsdc', [], ['uint256']),
  // The vault's immutable governance module — how `governance-watch` finds the Governance
  // contract without a second env var, exactly the way `oracle` locates the oracle.
  view('governance', [], ['address']),
]);

/**
 * OracleAggregator — RETIRED by the C-6 pivot (the contract now lives in contracts/test/retired/).
 * Kept because a pre-pivot deployment is still readable with it, and because `priceWad(address)` is
 * the one fragment BOTH oracle flavors share — nav-backing prices every asset through it.
 * `assetConfig`/`assets` exist on the retired aggregator ONLY; ChainlinkOracle has neither.
 */
export const ORACLE_VIEWS = Object.freeze([
  view('priceWad', ['address'], ['uint256']),
  view('assetConfig', ['address'], [
    { name: 'sources', type: 'address[]' },
    { name: 'maxStaleness', type: 'uint32' },
    { name: 'quorum', type: 'uint8' },
  ]),
  view('assets', ['uint256'], ['address']),
]);

/**
 * ChainlinkOracle — the LIVE oracle since the C-6 pivot. Single Chainlink feed per asset, no
 * quorum, no source set. `feedOf` is a public mapping-to-struct getter, so viem flattens it to the
 * five struct fields in declaration order.
 *
 * `priceWad` is deliberately listed FIRST and read on every sweep: it is the contract's own verdict
 * on whether the asset is priceable, and a revert IS the freeze. The other fields exist to
 * ATTRIBUTE that revert to a cause (heartbeat, band, sequencer, dead feed), not to second-guess it.
 */
export const CHAINLINK_ORACLE_VIEWS = Object.freeze([
  view('priceWad', ['address'], ['uint256']),
  view('feedOf', ['address'], [
    { name: 'feed', type: 'address' },
    { name: 'heartbeat', type: 'uint32' },
    { name: 'scale', type: 'uint64' },
    { name: 'minPriceWad', type: 'uint128' },
    { name: 'maxPriceWad', type: 'uint128' },
  ]),
  view('usdc', [], ['address']),
  view('sequencerUptimeFeed', [], ['address']),
  view('GRACE_PERIOD', [], ['uint256']),
]);

/**
 * Chainlink AggregatorV3 — the per-asset price feeds AND the L2 sequencer uptime feed.
 *
 * The two consume DIFFERENT fields of the same tuple and mixing them is the bug this comment
 * exists to prevent: an asset feed's staleness is `updatedAt` (4th), while the sequencer gate is
 * `answer` + `startedAt` (2nd + 3rd) and ignores `updatedAt` entirely, because the uptime feed is
 * event-driven and only writes on an up<->down transition. See ChainlinkOracle._requireSequencerUp.
 */
export const AGGREGATOR_V3_VIEWS = Object.freeze([
  view('latestRoundData', [], [
    { name: 'roundId', type: 'uint80' },
    { name: 'answer', type: 'int256' },
    { name: 'startedAt', type: 'uint256' },
    { name: 'updatedAt', type: 'uint256' },
    { name: 'answeredInRound', type: 'uint80' },
  ]),
]);

/**
 * The feed's OWN self-description — the surface `signals/feed-identity.mjs` re-checks every sweep.
 *
 * `ChainlinkOracle` reads `description()` and `decimals()` exactly ONCE, in its constructor, and
 * caches `scale = 10**(18 - decimals)` in an immutable `feedOf` entry. Chainlink swaps the
 * aggregator behind an `EACAggregatorProxy` as routine operation, and the proxy forwards all four
 * of these to whichever aggregator is current — so every one of them can move after construction
 * while the oracle keeps using what it cached. That gap is G2.
 *
 * `decimals()` and `description()` are the HARM legs: a change to either silently mis-scales or
 * re-denominates every price the vault computes. `aggregator()` and `phaseId()` are the IDENTITY
 * legs, which only say that a swap happened. `phaseId` increments on every swap, so it convicts on
 * its own; `aggregator` names the new implementation for the alert line.
 *
 * Only `decimals()` and `description()` are cross-checkable against a contract in this tree — the
 * other two belong to Chainlink's `EACAggregatorProxy`, which we do not compile. test/abis.test.mjs
 * pins what can be pinned and says so about the rest.
 */
export const CHAINLINK_FEED_IDENTITY_VIEWS = Object.freeze([
  view('decimals', [], ['uint8']),
  view('description', [], ['string']),
  view('aggregator', [], ['address']),
  view('phaseId', [], ['uint16']),
]);

/** IPriceSource — polled per source to count how many are fresh right now. */
export const PRICE_SOURCE_VIEWS = Object.freeze([
  view('latestPrice', [], [
    { name: 'priceWad', type: 'uint256' },
    { name: 'updatedAt', type: 'uint256' },
  ]),
]);

/** OperatorRegistry: maps a vault to the operator address fees must NEVER be paid to directly. */
export const OPERATOR_REGISTRY_VIEWS = Object.freeze([
  view('operatorOf', ['address'], ['uint256']),
  view('operatorAddressOf', ['uint256'], ['address']),
  view('operatorIdOf', ['address'], ['uint256']),
]);

/** ERC20 balance reads — the independent custody leg of the NAV-backing signal. */
export const ERC20_VIEWS = Object.freeze([
  view('balanceOf', ['address'], ['uint256']),
]);

/** ERC20 Transfer — the fee-routing signal's only log input. */
export const ERC20_TRANSFER_EVENT = Object.freeze(
  ev('Transfer', [addr('from', true), addr('to', true), u256('value')]),
);

/**
 * VaultCore events the canary watches but the indexer's projection does not fold.
 *
 * `ModuleCallFailed.module` is a raw bytes32 holding a right-zero-padded ASCII label
 * ("feeEngine.onRealize", "feeEngine.onFeeCollected", "feeEngine.onFeeCollectedAsset") — a
 * literal, not a hash. decodeModuleLabel() below turns it back into text for the alert line.
 */
export const VAULT_WATCH_EVENTS = Object.freeze([
  ev('ModuleCallFailed', [{ name: 'module', type: 'bytes32', indexed: true }, addr('member', true)]),
  ev('SliceEscrowed', [addr('member', true), addr('asset', true), u256('amount')]),
]);

/**
 * Governance — the three public getters `signals/governance-watch.mjs` reads. `proposals` and
 * `configOf` are public mapping-to-struct getters, so viem flattens each to its struct fields in
 * declaration order; the field ORDER below is copied from Governance.sol and pinned against the
 * compiled ABI by test/abis.test.mjs. `Status` and `ProposalType` come back as uint8 enum indices.
 */
export const GOVERNANCE_VIEWS = Object.freeze([
  view('activeProposalOf', ['address'], ['uint256']),
  view('proposals', ['uint256'], [
    { name: 'vault', type: 'address' },
    { name: 'ptype', type: 'uint8' },
    { name: 'proposer', type: 'address' },
    { name: 'createdAt', type: 'uint64' },
    { name: 'commitDeadline', type: 'uint64' },
    { name: 'revealDeadline', type: 'uint64' },
    { name: 'executableAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'status', type: 'uint8' },
    { name: 'actionHash', type: 'bytes32' },
    { name: 'snapshotTotal', type: 'uint256' },
    { name: 'memberCount', type: 'uint256' },
    { name: 'forWeight', type: 'uint256' },
    { name: 'againstWeight', type: 'uint256' },
    { name: 'revealedWeight', type: 'uint256' },
    { name: 'revealedVoterCount', type: 'uint256' },
  ]),
  view('configOf', ['address'], [
    { name: 'commitDuration', type: 'uint32' },
    { name: 'revealDuration', type: 'uint32' },
    { name: 'timelockDuration', type: 'uint32' },
    { name: 'executionWindow', type: 'uint32' },
    { name: 'quorumBps', type: 'uint16' },
    { name: 'proposalThresholdBps', type: 'uint16' },
    { name: 'concentrationCapBps', type: 'uint16' },
    { name: 'proposalCooldown', type: 'uint32' },
  ]),
]);

/**
 * Governance lifecycle events `governance-watch` scans over the poll window — for block/tx
 * attribution only. The PHASE a proposal is in is read from `proposals(pid)` against chain time,
 * because commit→reveal and timelock→executable are clock crossings that emit no event at all.
 * The indexer folds these four too, but the canary must not depend on the projection being
 * caught up to notice a proposal.
 */
export const GOVERNANCE_WATCH_EVENTS = Object.freeze([
  ev('Proposed', [
    u256('pid', true), addr('vault', true), { name: 'ptype', type: 'uint8', indexed: false },
    addr('proposer', true), { name: 'actionHash', type: 'bytes32', indexed: false },
  ]),
  ev('Finalized', [u256('pid', true), { name: 'status', type: 'uint8', indexed: false }]),
  ev('Executed', [u256('pid', true)]),
  ev('ProposalExpired', [u256('pid', true)]),
]);

/** ExitSettled — not folded here, but needed to tell an operator's honest exit payout from a fee leak. */
export const EXIT_SETTLED_EVENT = Object.freeze(
  ev('ExitSettled', [
    addr('member', true), u256('sharesBurned'), u256('usdcPaid'),
    u256('exitFeeBps'), u256('perfFeeUsdc'),
  ]),
);

/** `requestExit(uint256)` — eth_call ONLY. Never signed, never broadcast. */
export const REQUEST_EXIT_SELECTOR = '0x721c6513';

/**
 * Revert selectors, classified for the H-1 exit-liveness sentinel.
 *
 * GATE — the caller's own position makes the call invalid. Expected, healthy, not an alert.
 * FROZEN — the oracle staleness breaker (SF-2/K-4). By design, but it IS a live capital freeze,
 *   so it gets its own status and is attributed to the oracle signal rather than reported as OK.
 * Anything else — including empty returndata and an unrecognized selector — is the H-1
 *   signature (a creator-chosen module reverting, gas-guzzling, or bombing returndata) and
 *   ALERTS. There is no "could not classify, assume healthy" branch, on purpose.
 */
export const EXIT_GATE_SELECTORS = Object.freeze({
  '0x1f2a2005': 'ZeroAmount',
  '0xf2698fc0': 'ExitAlreadyQueued',
  '0x39996567': 'InsufficientShares',
  '0xa428ab2d': 'CreatorStakeGate',
  '0x07b1ee59': 'ExitNeedsChildSettlement',
  '0xb5ac4fd1': 'ChildSettlementPending',
});

export const EXIT_FROZEN_SELECTORS = Object.freeze({ '0xa2671f4b': 'StaleOracle' });

/** Non-gate selectors we can NAME. Unnamed ones still alert — this only sharpens the message. */
export const EXIT_FAULT_SELECTORS = Object.freeze({
  '0xab143c06': 'Reentrancy',
  '0xe752017c': 'NoQueuedExit',
  '0x885cf1d7': 'ExecutionStillPending',
  '0x08c379a0': 'Error(string)',
  '0x4e487b71': 'Panic(uint256)',
});

/** Canonical `name(type,...)` signature for a fragment — used by the drift test. */
export function signatureOf(fragment) {
  return `${fragment.name}(${fragment.inputs.map((i) => i.type).join(',')})`;
}

/** Turn a right-zero-padded bytes32 string literal back into readable ASCII. */
export function decodeModuleLabel(bytes32) {
  if (typeof bytes32 !== 'string' || !bytes32.startsWith('0x')) return String(bytes32);
  let out = '';
  const hex = bytes32.slice(2);
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    if (code === 0) break; // right-padded: the first zero byte ends the literal
    out += String.fromCharCode(code);
  }
  return out || bytes32;
}
