// @ts-check
/**
 * Minimal event-ABI fragments for the contracts the indexer projects from.
 *
 * These are plain JSON ABI event objects (the standard `{type:'event', name, inputs, anonymous}`
 * shape) — viem's `getLogs({ events })` consumes them directly to decode logs into
 * `{ eventName, args }`. Kept embedded (not read from `contracts/out`) so the runtime indexer is
 * self-contained and needs no built-contracts directory in production.
 *
 * To guarantee these never drift from the deployed contracts, test/abis.test.mjs cross-checks
 * every fragment here against the compiled Foundry ABIs when they are present — a Solidity event
 * signature change breaks that test instead of silently producing wrong logs at runtime.
 *
 * Grouped by the on-chain source that emits them:
 *   - `factory`, `operatorRegistry`, `subvaultRegistry`, `governance` are SINGLETONS (one address).
 *   - `vault` events are emitted by every VaultCore instance — a dynamic address set the runner
 *     discovers from VaultCreated logs (see rpc.mjs).
 */

/** @typedef {{type:'event', name:string, anonymous:boolean, inputs:Array<{name:string,type:string,indexed:boolean}>}} AbiEvent */

const ev = (name, inputs) => ({ type: 'event', name, anonymous: false, inputs });
const addr = (name, indexed = false) => ({ name, type: 'address', indexed });
const u256 = (name, indexed = false) => ({ name, type: 'uint256', indexed });

/** @type {Record<string, AbiEvent[]>} */
export const CONTRACT_ABIS = Object.freeze({
  factory: [
    ev('VaultCreated', [addr('vault', true), addr('creator', true), addr('usdc'), u256('capacityCapUsdc')]),
  ],
  operatorRegistry: [
    ev('OperatorRegistered', [u256('opId', true), addr('operator', true)]),
    ev('VaultAttested', [addr('vault', true), u256('opId', true)]),
    ev('RealizationRecorded', [
      addr('vault', true), u256('opId', true), addr('member', true),
      u256('gainUsdc'), u256('lossUsdc'), u256('carryAfter'),
    ]),
    ev('FeeRecorded', [u256('opId', true), u256('amountUsdc')]),
  ],
  subvaultRegistry: [
    ev('ChildRegistered', [addr('parent', true), addr('child', true), u256('depth')]),
  ],
  governance: [
    ev('Proposed', [
      u256('pid', true), addr('vault', true),
      { name: 'ptype', type: 'uint8', indexed: false }, addr('proposer', true),
      { name: 'actionHash', type: 'bytes32', indexed: false },
    ]),
    ev('Revealed', [u256('pid', true), addr('voter', true), { name: 'support', type: 'bool', indexed: false }, u256('weight')]),
    ev('DefaultApplied', [u256('pid', true), addr('member', true), { name: 'support', type: 'bool', indexed: false }, u256('weight')]),
    ev('DelegatedRevealed', [u256('pid', true), addr('delegator', true), addr('delegate', true), u256('weight')]),
    ev('Finalized', [u256('pid', true), { name: 'status', type: 'uint8', indexed: false }]),
    ev('Executed', [u256('pid', true)]),
    ev('ProposalExpired', [u256('pid', true)]),
  ],
  vault: [
    ev('DepositActivated', [addr('member', true), u256('amountUsdc'), u256('sharesMinted')]),
    ev('DepositPending', [addr('member', true), u256('amountUsdc'), { name: 'availableAt', type: 'uint64', indexed: false }]),
    ev('PendingCancelled', [addr('member', true), u256('amountUsdc')]),
    ev('ExitSettled', [addr('member', true), u256('sharesBurned'), u256('usdcPaid'), u256('exitFeeBps'), u256('perfFeeUsdc')]),
  ],
});

/** Which config label supplies each singleton contract's address. `vault` is dynamic (not here). */
export const SINGLETON_LABELS = Object.freeze(['factory', 'operatorRegistry', 'subvaultRegistry', 'governance']);

/** Every event fragment, flattened — used by the drift test and by callers that want a union. */
export function allEventFragments() {
  return Object.values(CONTRACT_ABIS).flat();
}

/** Canonical `name(type,type,...)` signature for an event fragment (for drift comparison). */
export function eventSignature(fragment) {
  return `${fragment.name}(${fragment.inputs.map((i) => i.type).join(',')})`;
}
