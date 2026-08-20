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
]);

/** OracleAggregator: the immutable per-asset source config the freshness margin is measured against. */
export const ORACLE_VIEWS = Object.freeze([
  view('priceWad', ['address'], ['uint256']),
  view('assetConfig', ['address'], [
    { name: 'sources', type: 'address[]' },
    { name: 'maxStaleness', type: 'uint32' },
    { name: 'quorum', type: 'uint8' },
  ]),
  view('assets', ['uint256'], ['address']),
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
