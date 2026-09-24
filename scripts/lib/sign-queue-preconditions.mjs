// @ts-check
/**
 * Server-side preconditions for the Sign queue: does the CHAIN currently agree it is safe to
 * enable a given item's Sign button? Every function here is read-only (`eth_call`/
 * `eth_getCode`/`eth_getTransactionCount`) via `scripts/lib/chain-rpc.mjs`, and every one returns
 * `{ok:true}` or `{ok:false, reason}` — never throws for an ordinary chain disagreement, so a
 * single item's failed read cannot take the rest of the panel down (`scripts/dashboard.mjs` wraps
 * each call in `Promise.allSettled` on top of this, matching `runLaunchChecks`'s own discipline).
 */
import {
  ethCall, ethChainId, ethGetCode, ethGetTransactionCountPending, rpcCall,
} from './chain-rpc.mjs';
import { creatorCodeRefusal, safeRoutingPlanRefusal } from '../smoke-preflight.mjs';
import { P, STATUS } from './proposal-decode.mjs';

const ARC_RPC = 'https://rpc.mainnet.arc.io';
const ARC_CHAIN_ID = 5042;
const BASE_SEPOLIA_RPC = 'https://sepolia.base.org';

const encodeAddr = (a) => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const encodeUint = (n) => BigInt(n).toString(16).padStart(64, '0');
const decodeAddr = (word) => `0x${word.slice(-40)}`;
const decodeBool = (word) => BigInt(`0x${word}`) !== 0n;

/**
 * The nonce gate: MetaMask picks the nonce, so a stray transaction from the same deployer between
 * this item's build and its send would silently put a CREATE at a different address than what was
 * predicted and baked into every dependent item's calldata. Refuse to enable Sign unless the
 * live pending nonce is EXACTLY the frozen `expectedNonce`.
 * @param {typeof fetch} fetchImpl @param {string} rpcUrl @param {string} from @param {number} expectedNonce
 */
export async function nonceGateRefusal(fetchImpl, rpcUrl, from, expectedNonce) {
  const r = await ethGetTransactionCountPending(fetchImpl, rpcUrl, from);
  if (!r.ok) return `could not read the live nonce for ${from}: ${r.reason}`;
  const live = Number(BigInt(r.result));
  if (live !== expectedNonce) {
    return `live nonce for ${from} is ${live}, this item was built expecting ${expectedNonce} — a `
      + 'transaction landed out of order, or a prior item in this sequence has not been mined yet. '
      + 'Refusing: signing now would put this CREATE at a different address than every dependent '
      + 'item already assumes.';
  }
  return null;
}

/** #329/card 208: the SAME preconditions `scripts/smoke-test.mjs`'s `stepCreateVault`/
 * `routeThroughSafe` check before broadcasting — `creatorCodeRefusal` (the declared contract
 * creator must actually have code, on the declared chain) and `safeRoutingPlanRefusal` (the built
 * plan must route through that same Safe, at the right target, calling the right function, as a
 * plain CALL with zero value/safeTxGas/baseGas/gasPrice) — plus a live
 * `getThreshold()==1 && getOwners()==[from]` read, since the pre-validated signature
 * (`scripts/lib/safe-exec.mjs`'s `preValidatedSignature`) is only valid when `from` is a CURRENT
 * Safe owner and `msg.sender==owner` is sufficient authorisation, which is only true at
 * threshold 1.
 * @param {typeof fetch} fetchImpl
 * @param {{safe:string, owner:string, plan:{to:string,action:string,expectedTo:string,data:string,operation:number,value:string|number,safeTxGas:string|number,baseGas:string|number,gasPrice:string|number}}} p
 */
export async function safeRoutedRefusal(fetchImpl, { safe, owner, plan, expectedSafeNonce }) {
  const [codeR, chainR] = await Promise.all([
    ethGetCode(fetchImpl, ARC_RPC, safe), ethChainId(fetchImpl, ARC_RPC),
  ]);
  if (!codeR.ok || !chainR.ok) {
    return `could not read the creator Safe's code/chain id: ${[!codeR.ok && codeR.reason, !chainR.ok && chainR.reason].filter(Boolean).join('; ')}`;
  }
  const codeRefusal = creatorCodeRefusal({
    address: safe, code: codeR.result, observedChainId: Number(BigInt(chainR.result)),
    declaredChainId: ARC_CHAIN_ID, kind: 'contract',
  });
  if (codeRefusal) return codeRefusal;

  const planRefusal = safeRoutingPlanRefusal({ intended: safe, safe, ...plan });
  if (planRefusal) return planRefusal;

  const [thresholdR, ownersR] = await Promise.all([
    ethCall(fetchImpl, ARC_RPC, safe, '0xe75235b8'), // getThreshold()
    ethCall(fetchImpl, ARC_RPC, safe, '0xa0e67e2b'), // getOwners()
  ]);
  if (!thresholdR.ok) return `could not read Safe.getThreshold(): ${thresholdR.reason}`;
  const threshold = BigInt(thresholdR.result);
  if (threshold !== 1n) {
    return `Safe ${safe} now reports getThreshold() ${threshold}, not 1 — a pre-validated `
      + '(no-ECDSA) signature is only valid when the Safe requires exactly 1 signature and `from` '
      + 'is itself an owner. Raise this to a real multi-owner signature flow before signing.';
  }
  if (!ownersR.ok) return `could not read Safe.getOwners(): ${ownersR.reason}`;
  // Dynamic array ABI decoding, minimal: offset word, length word, then N address words.
  const hex = ownersR.result.replace(/^0x/, '');
  const len = Number(BigInt(`0x${hex.slice(64, 128)}`));
  const owners = Array.from({ length: len }, (_, i) => decodeAddr(hex.slice(128 + i * 64, 128 + (i + 1) * 64)));
  if (owners.length !== 1 || owners[0].toLowerCase() !== owner.toLowerCase()) {
    return `Safe ${safe} owners are [${owners.join(', ')}], expected exactly [${owner}]`;
  }
  // The Safe-nonce gate (V-381-r2). The pre-validated signature authorises by msg.sender alone, so
  // nothing in the Safe stops the SAME execTransaction running twice. The item was built for one
  // Safe nonce; once any Safe transaction has executed at it, this item must never be signable
  // again. Throws rather than skipping when the expected nonce is absent.
  if (expectedSafeNonce === undefined || expectedSafeNonce === null) {
    return 'this Safe-routed item carries no expected Safe nonce — refusing rather than risking a duplicate execution';
  }
  const nonceR = await ethCall(fetchImpl, ARC_RPC, safe, '0xaffed0e0'); // nonce()
  if (!nonceR.ok) return `could not read Safe.nonce(): ${nonceR.reason}`;
  const live = BigInt(nonceR.result);
  if (live !== BigInt(expectedSafeNonce)) {
    return `Safe ${safe} nonce is ${live}, this item was built for Safe nonce ${expectedSafeNonce} — a Safe transaction has already executed at that nonce (possibly this very one), so signing again could execute a duplicate`;
  }
  return null;
}

/**
 * `Governance.finalize`'s own precondition (`Governance.sol:577-579`): `status == Active &&
 * block.timestamp >= revealDeadline`. Reads `proposals(id)` and the chain's own clock on the SAME
 * connection, the identical discipline `scripts/lib/launch-checks.mjs`'s `checkStaleProposal` uses
 * (a local wall clock is not guaranteed to agree with the chain's).
 * @param {typeof fetch} fetchImpl @param {string} governance @param {number} proposalId
 */
export async function finalizePreconditionRefusal(fetchImpl, governance, proposalId) {
  const [propR, blockR] = await Promise.all([
    ethCall(fetchImpl, BASE_SEPOLIA_RPC, governance, `0x013cf08b${encodeUint(proposalId)}`),
    rpcCall(fetchImpl, BASE_SEPOLIA_RPC, 'eth_getBlockByNumber', ['latest', false]),
  ]);
  if (!propR.ok) return `could not read proposals(${proposalId}): ${propR.reason}`;
  if (!blockR.ok) return `could not read the chain's own clock: ${blockR.reason}`;
  const nowSec = Number(BigInt(blockR.result.timestamp));
  const hex = propR.result.replace(/^0x/, '');
  // Tuple layout and STATUS ordering imported from scripts/lib/proposal-decode.mjs's own `P`/
  // `STATUS` — NOT re-derived here. STATUS[0] is 'None': an earlier draft of this file hand-wrote
  // a 5-element array starting at 'Active', which is off by one against the real 6-element
  // ['None','Active','Passed','Defeated','Executed','Expired'] and would have misread every status.
  const word = (i) => hex.slice(i * 64, (i + 1) * 64);
  const revealDeadline = Number(BigInt(`0x${word(P.REVEAL_DEADLINE)}`));
  const statusByte = Number(BigInt(`0x${word(P.STATUS)}`));
  const status = STATUS[statusByte] ?? `unknown(${statusByte})`;
  if (status !== 'Active') {
    return `proposal ${proposalId} is ${status}, not Active — finalize() would revert WrongPhase`;
  }
  if (nowSec < revealDeadline) {
    return `proposal ${proposalId} is Active but still within its reveal window (chain time ${nowSec}, `
      + `deadline ${revealDeadline}) — finalize() would revert WrongPhase before then`;
  }
  return null;
}
