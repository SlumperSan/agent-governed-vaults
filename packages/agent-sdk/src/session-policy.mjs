// @ts-check
/**
 * Session key call policy for an agent smart account: data only, viem only.
 *
 * Imported by path (`packages/agent-sdk/src/session-policy.mjs`), deliberately NOT exported from
 * `index.mjs`. It states what the session key may call; the account-specific encoding of it
 * (Kernel permission rows) is built from this table elsewhere. Nothing here signs or sends.
 *
 * Source: the agent stack spec, "Session key policy, minimum" (allow and deny lists), plus the
 * crank calls decided 2026-10-21 (see CRANK below).
 *
 * Targets are roles, not addresses: `usdc` is the chain's USDC token, `vault` is a vault the
 * OWNER listed, `governance` is the chain's Governance contract. The owner's vault list is the
 * `ownerVaults` input of the `arg-in-owner-vaults` rule.
 */

import { parseAbi, toFunctionSelector, getAbiItem } from 'viem';

/** USDC ERC-20 fragment: `approve` only. `transfer` and `transferFrom` are never declared here. */
export const USDC_ABI = parseAbi(['function approve(address spender, uint256 value) returns (bool)']);

/** VaultCore write fragments the session key may call. `deposit(uint256)` is the one-argument
 * overload the reference agent uses; the two-argument overload is not allowed. */
export const VAULT_ABI = parseAbi([
  'function deposit(uint256 amountUsdc)',
  'function requestExit(uint256 shares)',
  'function cancelPending()',
  'function claimEscrowed(address asset)',
  'function settleQueuedExit(address member)',
  // crank: contracts/src/VaultCore.sol:462-468, `activate` has no caller check, only state
  // (a pending deposit exists and the window has elapsed); its natspec says "Callable by anyone".
  'function activate(address member)',
]);

/** Governance write fragments. */
export const GOVERNANCE_ABI = parseAbi([
  'function propose(address vault, uint8 ptype, bytes32 actionHash) returns (uint256 pid)',
  'function commitVote(uint256 pid, bytes32 commitment)',
  'function revealVote(uint256 pid, bool support, bytes32 salt)',
  // crank, each permissionless (no msg.sender check, state and time gates only), on protocol/main:
  //   finalize     contracts/src/Governance.sol:587-589  (Active and past revealDeadline)
  //   execute      contracts/src/Governance.sol:689-694  (Passed, timelock over, window open, payload hash)
  //   markExpired  contracts/src/Governance.sol:721-723  (Passed and past expiresAt)
  'function finalize(uint256 pid)',
  'function execute(uint256 pid, bytes payload)',
  'function markExpired(uint256 pid)',
]);

const ABIS = { usdc: USDC_ABI, vault: VAULT_ABI, governance: GOVERNANCE_ABI };

/** @typedef {{ kind: 'any' } | { kind: 'arg-in-owner-vaults', index: number }} ArgRule */
/** @typedef {{ target: 'usdc'|'vault'|'governance', name: string, selector: string, argRule: ArgRule }} PolicyRow */

/**
 * @param {'usdc'|'vault'|'governance'} target
 * @param {string} name
 * @param {ArgRule} argRule
 * @returns {PolicyRow}
 */
function row(target, name, argRule = { kind: 'any' }) {
  const item = getAbiItem({ abi: ABIS[target], name });
  if (!item || item.type !== 'function') throw new Error(`session-policy: ${target}.${name} is not in its ABI`);
  return Object.freeze({ target, name, selector: toFunctionSelector(item), argRule: Object.freeze(argRule) });
}

const IN_VAULTS = (index) => ({ kind: /** @type {const} */ ('arg-in-owner-vaults'), index });

/** The allow list. A call is allowed only if a row matches its target role and selector and the
 * row's argRule holds. Everything not listed is denied. */
export const ALLOW = Object.freeze([
  // approve only to an owner-listed vault, so the key cannot grant an allowance to anyone else.
  row('usdc', 'approve', IN_VAULTS(0)),
  row('vault', 'deposit'),
  row('vault', 'requestExit'),
  row('vault', 'cancelPending'),
  row('vault', 'claimEscrowed'),
  row('vault', 'settleQueuedExit'),
  row('vault', 'activate'),
  // shortcut: commitVote, revealVote, finalize, execute and markExpired take a proposal id, not a
  // vault, so the policy cannot scope them to the owner's vaults by argument; the account only
  // ever commits and reveals as itself, and a vote needs stake in that proposal's vault.
  // Upgrade if a policy engine can read Governance state.
  row('governance', 'propose', IN_VAULTS(0)),
  row('governance', 'commitVote'),
  row('governance', 'revealVote'),
  row('governance', 'finalize'),
  row('governance', 'execute'),
  row('governance', 'markExpired'),
]);

/** Calls the key must never make, with the reason. Kept as data so a test and an encoder read the
 * same list. `skipWindow` is irrevocable per vault, so it stays with the owner. */
export const DENY = Object.freeze([
  { name: 'transfer', reason: 'USDC.transfer to anyone' },
  { name: 'transferFrom', reason: 'USDC.transferFrom to anyone' },
  { name: 'transferWithAuthorization', reason: 'EIP-3009 move of USDC' },
  { name: 'createVault', reason: 'a creator-chosen adapter plus a self deposit can drain the deposit' },
  { name: 'createAgentVault', reason: 'same as createVault' },
  { name: 'skipWindow', reason: 'irrevocable per vault opt-in, an owner decision' },
  { name: 'installModule', reason: 'module installation' },
  { name: 'uninstallModule', reason: 'module removal' },
  { name: 'transferOwnership', reason: 'owner change' },
  { name: 'changeRootValidator', reason: 'owner change' },
]);

/** Any target outside the three roles above (an adapter, an arbitrary contract) is denied. */
export const DENY_UNLISTED_TARGETS = true;

/**
 * The key must never be an accepted ERC-1271 signer for the USDC token: USDC settles a smart
 * account payment through `isValidSignature`, so an accepted session signature would let the key
 * sign an EIP-3009 `transferWithAuthorization` of any amount, bypassing the UserOp call policy.
 * The x402 payer is a separate small-float EOA.
 */
export const signaturePolicy = 'deny-usdc-1271';

export const SESSION_POLICY = Object.freeze({ allow: ALLOW, deny: DENY, denyUnlistedTargets: DENY_UNLISTED_TARGETS, signaturePolicy });
