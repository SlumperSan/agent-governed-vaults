// @ts-check
/**
 * Construct and sign a Safe `execTransaction` whose inner call is `createVault` — the routed-send
 * path `scripts/smoke-preflight.mjs`'s `contractCreatorRoutingRefusal` names as missing: "Creating
 * on behalf of a contract creator needs the transaction ROUTED THROUGH IT (e.g. a Safe
 * execTransaction that itself calls createVault)". Card 208.
 *
 * NOT SPECIALISED TO ANY ONE SAFE. Every function here reads the Safe's own `getThreshold`,
 * `getOwners`, `nonce` and `getTransactionHash` from whichever address the caller passes — nothing
 * is hardcoded to the Arc mainnet Safe (`0x99e8…`) or to 1-of-1. A second Safe, or the same Safe
 * after the owner raises its threshold, works identically because nothing here assumes otherwise.
 *
 * WHY `getTransactionHash` IS READ FROM THE CHAIN, NEVER RECOMPUTED. Reimplementing Safe's EIP-712
 * domain separator and struct encoding here would be exactly the untested-arithmetic shape this
 * repository has already paid for (`scripts/lib/proposal-decode.mjs`'s own header, `abiEncode`
 * fixtures elsewhere): a transcription error would sign a hash the REAL deployed Safe disagrees
 * with, and the only way to find out would be a reverted broadcast — against a real account, for the
 * real Safe this script exists to route through. The deployed Safe's own view function is the single
 * source of truth for what it will accept a signature over, so every field below is read from it
 * or handed to it, never independently derived.
 *
 * SIGNATURE VALIDATION IS THE REAL SAFE'S, NOT REIMPLEMENTED HERE. `execTransaction` on the actual
 * deployed contract enforces who may sign, how many, and in what order (Safe.sol's own
 * `checkNSignatures`) — a wrong signer or too few signatures fails there, on real bytecode, which is
 * why this file contains no owner/threshold arithmetic of its own to get subtly wrong.
 *
 * KEY HANDLING. Nothing here reads, stores or prompts for a private key on its own — every function
 * takes already-tokenised `cast` signer args (the same shape `scripts/smoke-test.mjs`'s own
 * `SMOKE_SIGNER_ARGS` already uses) or a raw `--private-key` array a caller builds, and hands them
 * straight to `cast`. The key stays inside Foundry's keystore, a Ledger, or — for the fork proof this
 * module is exercised against — a throwaway key `apps/vaults-ui/test/lib/ui-smoke-chain.mjs`
 * generates from viem's own CSPRNG and funds only on a local anvil fork.
 */

/** Safe's `Enum.Operation`. `execTransaction`'s inner call MUST be CALL: a DELEGATECALL would run
 * the target's code AS the Safe, inside the Safe's own storage, instead of calling it — `msg.sender`
 * inside `createVault` would not be the Safe at all, and the Safe's storage could be corrupted by
 * code that was never written to run there. `smoke-preflight.safeRoutingPlanRefusal` refuses any
 * plan that is not CALL; this constant is what both that check and the plan builder below agree on. */
export const SAFE_OPERATION_CALL = 0;
export const SAFE_OPERATION_DELEGATECALL = 1;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const SIG = {
  threshold: 'getThreshold()(uint256)',
  owners: 'getOwners()(address[])',
  nonce: 'nonce()(uint256)',
  txHash: 'getTransactionHash(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,uint256)(bytes32)',
  execTransaction: 'execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes)',
};
export const SAFE_EXEC_TRANSACTION_SIG = SIG.execTransaction;

/**
 * What the chain currently says about a Safe: threshold, owner set, next nonce. Read fresh every
 * call, never cached — a stale nonce signs a transaction the Safe will refuse, and a stale threshold
 * could under-collect signatures for a Safe whose owner has since raised it (the Arc Safe is 1-of-1
 * today; the owner may raise it at his own pace, and this file must not assume he has not).
 *
 * @param {object} p
 * @param {(to: string, sig: string, ...args: (string|bigint|number)[]) => string[]} p.call the
 *   caller's `call()` helper (same shape as `scripts/smoke-test.mjs`'s own) — decoded output lines
 * @param {(to: string, sig: string, ...args: (string|bigint|number)[]) => bigint} p.callU same, for
 *   a single uint256 result
 * @param {string} p.safe the Safe address to read
 * @returns {{threshold: bigint, owners: string[], nonce: bigint}}
 */
export function readSafeState({ call, callU, safe }) {
  const threshold = callU(safe, SIG.threshold);
  const raw = call(safe, SIG.owners)[0] ?? '[]';
  const owners = raw
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const nonce = callU(safe, SIG.nonce);
  return { threshold, owners, nonce };
}

/**
 * The exact inner-call plan this module signs and sends — also what
 * `smoke-preflight.safeRoutingPlanRefusal` checks BEFORE any signature is collected. `operation` is
 * always `SAFE_OPERATION_CALL`; there is no parameter to set it otherwise; a caller wanting to prove
 * the DELEGATECALL refusal builds the refused shape directly against `safeRoutingPlanRefusal`; this
 * builder never produces one.
 *
 * @param {object} p
 * @param {string} p.safe
 * @param {string} p.to the inner call target — the deployed VaultFactory
 * @param {string} p.data the inner calldata — `createVault(...)`'s encoded call
 * @param {bigint} p.nonce the Safe's CURRENT nonce (from `readSafeState`)
 * @param {bigint} [p.value] wei sent with the inner call; defaults to 0 — createVault needs none
 */
export function buildPlan({ safe, to, data, nonce, value = 0n }) {
  return {
    safe,
    to,
    value,
    data,
    operation: SAFE_OPERATION_CALL,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
}

/**
 * The hash every owner signs — READ FROM THE SAFE ITSELF (see file header for why). Every plan field
 * is passed through unchanged; this function decides nothing about what the plan means.
 *
 * @param {object} p
 * @param {(to: string, sig: string, ...args: (string|bigint|number)[]) => string[]} p.call
 * @param {ReturnType<typeof buildPlan>} p.plan
 * @returns {string} the 32-byte hash, as `cast` decoded it
 */
export function safeTransactionHash({ call, plan }) {
  const out = call(
    plan.safe, SIG.txHash,
    plan.to, plan.value, plan.data, plan.operation, plan.safeTxGas, plan.baseGas,
    plan.gasPrice, plan.gasToken, plan.refundReceiver, plan.nonce,
  );
  return out[0];
}

/**
 * One owner's signature over `hash`, via `cast wallet sign --no-hash` — a DIRECT ECDSA signature
 * over the exact bytes the Safe's own `getTransactionHash` returned, with no further prefix.
 * `--no-hash` is load-bearing: a plain `cast wallet sign` applies the EIP-191 personal-message
 * prefix, which signs a DIFFERENT hash than the one the Safe computed, and the Safe would reject
 * every resulting signature. This lands in Safe's `v ∈ {27,28}` branch of `checkNSignatures`
 * (Safe.sol): `ecrecover(dataHash, v, r, s)` against the hash exactly as given — the same branch a
 * plain secp256k1 signature over a raw digest always produces.
 *
 * @param {object} p
 * @param {(args: string[]) => string} p.cast the caller's raw `cast` runner
 * @param {string} p.hash the safeTxHash to sign
 * @param {string[]} p.signerArgs tokenised `cast` signer flags for exactly one owner
 * @returns {{signer: string, signature: string}}
 */
export function signAsOwner({ cast, hash, signerArgs }) {
  const signer = cast(['wallet', 'address', ...signerArgs]).split('\n').pop().trim();
  const signature = cast(['wallet', 'sign', '--no-hash', hash, ...signerArgs]).trim();
  return { signer, signature };
}

/** Case/whitespace-insensitive address equality with no accidental true on two non-addresses — the
 * same normaliser `smoke-preflight.normAddr` uses, duplicated only as a primitive string transform
 * (not re-imported) so this file has no dependency on smoke-preflight.mjs's own module graph. */
const normAddr = (a) => (typeof a === 'string' ? a.trim().toLowerCase() : '');

/**
 * Safe's packed-signature format: each owner's 65-byte `r‖s‖v` signature, concatenated in STRICTLY
 * ASCENDING owner-address order. Safe's own `checkNSignatures` requires a strictly increasing
 * `currentOwner` across the loop and reverts `GS026` otherwise — an unsorted set fails on-chain even
 * when every individual signature is genuine, which is why this is not left to caller ordering.
 * Deduplicates by signer (case/whitespace-insensitive) so a repeated signer cannot count twice
 * toward the threshold — the real Safe would reject a duplicate the same way, via the same
 * strictly-increasing check, but this keeps this function's own contract ("one signature per owner")
 * honest independent of that.
 *
 * @param {{signer: string, signature: string}[]} sigs
 * @returns {string} `0x`-prefixed concatenated signatures
 */
export function packSignatures(sigs) {
  const bySigner = new Map();
  for (const { signer, signature } of sigs) bySigner.set(normAddr(signer), signature);
  const sorted = [...bySigner.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `0x${sorted.map(([, sig]) => sig.replace(/^0x/, '')).join('')}`;
}

/**
 * The ordered argument list for `execTransaction`, ready to spread into the caller's `send()`
 * helper: `send(label, plan.safe, SAFE_EXEC_TRANSACTION_SIG, ...execTransactionArgs(plan, sigs))`.
 *
 * @param {ReturnType<typeof buildPlan>} plan
 * @param {string} packedSignatures from `packSignatures`
 */
export function execTransactionArgs(plan, packedSignatures) {
  return [
    plan.to, plan.value, plan.data, plan.operation, plan.safeTxGas, plan.baseGas,
    plan.gasPrice, plan.gasToken, plan.refundReceiver, packedSignatures,
  ];
}
