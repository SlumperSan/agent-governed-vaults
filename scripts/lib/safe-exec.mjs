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
 * WHY `getTransactionHash` IS RECOMPUTED LOCALLY, NOT TRUSTED FROM THE CHAIN ALONE (2026-09-23,
 * MAJOR-1, `Obsidian Vault/Agent-Governed Vaults/Verdicts/2026-09-23-security-safe-signing-path.md`).
 * An earlier version of this file read `getTransactionHash` off the RPC and signed those 32 bytes
 * directly with `cast wallet sign --no-hash`. Nothing tied the signed bytes to `plan`: a malicious or
 * compromised RPC could answer `getTransactionHash` with the hash of a SafeTx of ITS choosing (e.g.
 * `addOwnerWithThreshold(attacker, 1)`, or a DELEGATECALL to a drainer), and the owner would produce a
 * raw ECDSA signature over it with no way to know — a `--no-hash` signature also hides the preimage
 * from a hardware wallet, which can only display the 32 bytes it is asked to sign. On a 1-of-1 Safe
 * that single signature is full takeover. This is the Bybit (Feb 2025) class: the signer never checks
 * the content behind the hash.
 *
 * The fix: `buildSafeTypedData` constructs the EIP-712 typed data (domain + `SafeTx` struct) LOCALLY
 * from `plan`, and `safeTransactionHashLocal` recomputes the exact same digest Safe v1.4.1's own
 * `Safe.sol` `getTransactionHash`/`encodeTransactionData` compute on-chain — `keccak256(0x19 0x01 ||
 * domainSeparator || structHash)`, with `domainSeparator = keccak256(abi.encode(
 * DOMAIN_SEPARATOR_TYPEHASH, chainId, safe))` and `structHash = keccak256(abi.encode(
 * SAFE_TX_TYPEHASH, to, value, keccak256(data), operation, safeTxGas, baseGas, gasPrice, gasToken,
 * refundReceiver, nonce))`. The type strings, and the fact that Safe's domain carries ONLY
 * `chainId`/`verifyingContract` (no `name`/`version`), are taken verbatim from
 * `safe-global/safe-smart-account` tag `v1.4.1`, `contracts/Safe.sol`:
 *   `DOMAIN_SEPARATOR_TYPEHASH = keccak256("EIP712Domain(uint256 chainId,address verifyingContract)")`
 *   `SAFE_TX_TYPEHASH = keccak256("SafeTx(address to,uint256 value,bytes data,uint8 operation,` +
 *     `uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,` +
 *     `uint256 nonce)")`
 *   (`encodeTransactionData`/`getTransactionHash`, same file, ~lines 383-438).
 * `chainId` comes from the CALLER's declared deployment record (cross-checked against the chain
 * config's own `chainId`, which `smoke-test.mjs` cross-checks against the RPC's `eth_chainId` before
 * any of this runs) — never read from the RPC inside this file, so a malicious RPC cannot steer the
 * domain by lying about the chain it is on.
 *
 * `safeTransactionHash` below reads the RPC's `getTransactionHash` AND computes the local digest, and
 * THROWS `SafeTxHashMismatch` — before a single signature is collected — unless the two agree. Neither
 * leg is trusted alone: the on-chain read stays as the cross-check that this file's own EIP-712
 * encoding matches the REAL deployed Safe's (a transcription error here would show up as a permanent
 * mismatch against every real Safe, not as a broadcast that already spent the owner's signature), and
 * the local recompute is what ties the signed bytes to `plan`, which the RPC alone could never do.
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

/** Safe v1.4.1 `Safe.sol` `DOMAIN_SEPARATOR_TYPEHASH`'s preimage, verbatim from
 *  `safe-global/safe-smart-account` tag `v1.4.1` `contracts/Safe.sol` (~line 49). Note: NO
 *  `name`/`version` fields — Safe's own EIP-712 domain carries only `chainId`/`verifyingContract`. */
export const SAFE_EIP712_DOMAIN_TYPE_STRING = 'EIP712Domain(uint256 chainId,address verifyingContract)';

/** Safe v1.4.1 `Safe.sol` `SAFE_TX_TYPEHASH`'s preimage, verbatim from the same file (~line 54) —
 *  field order and types matter: this is hashed as a string, and any deviation produces a different
 *  typehash and therefore a different digest than the real deployed Safe computes. */
export const SAFE_TX_TYPE_STRING =
  'SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,'
  + 'uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)';

/** Thrown by `safeTransactionHash` when the RPC's `getTransactionHash` and this file's own local
 *  EIP-712 recompute (`safeTransactionHashLocal`) disagree — see the file header for why that must
 *  refuse rather than sign. Deliberately NOT `smoke-preflight.mjs`'s `CreationRefused`: this file
 *  keeps its own module graph independent of that one (see the header note by `normAddr` below). */
export class SafeTxHashMismatch extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafeTxHashMismatch';
  }
}

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
 * The EIP-712 typed data for `plan`, shaped for `cast wallet sign --data` (and identical to what
 * `eth_signTypedData_v4` / viem's `hashTypedData` expect): `domain` + `types` + `primaryType` +
 * `message`. Safe's own domain carries only `chainId`/`verifyingContract` — see the file header for
 * why there is no `name`/`version`. Every BigInt plan field is stringified: JSON has no BigInt.
 *
 * @param {object} p
 * @param {ReturnType<typeof buildPlan>} p.plan
 * @param {number|string} p.chainId the DECLARED deployment chain id (never read from the RPC here)
 */
export function buildSafeTypedData({ plan, chainId }) {
  return {
    types: {
      EIP712Domain: [
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    primaryType: 'SafeTx',
    domain: { chainId: Number(chainId), verifyingContract: plan.safe },
    message: {
      to: plan.to,
      value: String(plan.value),
      data: plan.data,
      operation: plan.operation,
      safeTxGas: String(plan.safeTxGas),
      baseGas: String(plan.baseGas),
      gasPrice: String(plan.gasPrice),
      gasToken: plan.gasToken,
      refundReceiver: plan.refundReceiver,
      nonce: String(plan.nonce),
    },
  };
}

/**
 * The EIP-712 digest for `plan`, computed ENTIRELY LOCALLY — no RPC involved — via `cast keccak` /
 * `cast abi-encode` / `cast concat-hex`, mirroring Safe v1.4.1's own `encodeTransactionData` exactly
 * (see the file header for the cited typehash preimages and the term-by-term correspondence). Every
 * `cast keccak <hex>` call below hashes RAW BYTES, not the literal string: `cast keccak 0x3132` and
 * `cast keccak "12"` produce the identical digest (verified empirically against this installed cast),
 * confirming `0x`-prefixed input is hex-decoded before hashing, exactly as Solidity's
 * `keccak256(bytes)` requires.
 *
 * @param {object} p
 * @param {(args: string[]) => string} p.cast the caller's raw `cast` runner (no RPC flag needed —
 *   every call here is local hashing/encoding, never a chain read)
 * @param {ReturnType<typeof buildPlan>} p.plan
 * @param {number|string} p.chainId the DECLARED deployment chain id
 * @returns {string} the 32-byte digest
 */
export function safeTransactionHashLocal({ cast, plan, chainId }) {
  const domainTypeHash = cast(['keccak', SAFE_EIP712_DOMAIN_TYPE_STRING]).trim();
  const domainEncoded = cast([
    'abi-encode', 'f(bytes32,uint256,address)',
    domainTypeHash, String(Number(chainId)), plan.safe,
  ]).trim();
  const domainSeparator = cast(['keccak', domainEncoded]).trim();

  const txTypeHash = cast(['keccak', SAFE_TX_TYPE_STRING]).trim();
  const dataHash = cast(['keccak', plan.data]).trim();
  const structEncoded = cast([
    'abi-encode', 'f(bytes32,address,uint256,bytes32,uint8,uint256,uint256,uint256,address,address,uint256)',
    txTypeHash, plan.to, String(plan.value), dataHash, String(plan.operation),
    String(plan.safeTxGas), String(plan.baseGas), String(plan.gasPrice),
    plan.gasToken, plan.refundReceiver, String(plan.nonce),
  ]).trim();
  const structHash = cast(['keccak', structEncoded]).trim();

  const packed = cast(['concat-hex', '0x1901', domainSeparator, structHash]).trim();
  return cast(['keccak', packed]).trim();
}

/**
 * The hash every owner signs. Reads `getTransactionHash` from the Safe itself AND recomputes the
 * same digest locally from `plan` (`safeTransactionHashLocal`) — THROWS `SafeTxHashMismatch` unless
 * they agree, before a single signature is collected. See the file header for why neither leg is
 * trusted alone: the RPC read alone is exactly MAJOR-1 (an RPC can return the hash of a SafeTx of
 * its choosing), and the local recompute alone would never catch a transcription error against the
 * REAL deployed Safe's own encoding.
 *
 * @param {object} p
 * @param {(to: string, sig: string, ...args: (string|bigint|number)[]) => string[]} p.call
 * @param {(args: string[]) => string} p.cast the caller's raw `cast` runner
 * @param {ReturnType<typeof buildPlan>} p.plan
 * @param {number|string} p.chainId the DECLARED deployment chain id (never read from the RPC here)
 * @returns {string} the 32-byte hash, agreed by both legs
 * @throws {SafeTxHashMismatch}
 */
export function safeTransactionHash({ call, cast, plan, chainId }) {
  const onChain = call(
    plan.safe, SIG.txHash,
    plan.to, plan.value, plan.data, plan.operation, plan.safeTxGas, plan.baseGas,
    plan.gasPrice, plan.gasToken, plan.refundReceiver, plan.nonce,
  )[0];
  const local = safeTransactionHashLocal({ cast, plan, chainId });
  if (normAddr(onChain) !== normAddr(local)) {
    throw new SafeTxHashMismatch(
      `refusing to sign: Safe ${plan.safe}'s own getTransactionHash() returned ${onChain}, but the `
        + `EIP-712 digest recomputed locally from this exact plan is ${local}. These MUST agree — a `
        + 'disagreement means the RPC answered with the hash of a DIFFERENT SafeTx than the one this '
        + 'plan describes (MAJOR-1, 2026-09-23-security-safe-signing-path.md), and signing it would '
        + `hand a valid signature over whatever transaction the RPC chose. Refusing before any `
        + 'signature was collected.',
    );
  }
  return onChain;
}

/**
 * One owner's signature over the EIP-712 typed data built from `plan` (`buildSafeTypedData`), via
 * `cast wallet sign --data` — cast COMPUTES THE DIGEST ITSELF from the domain/types/message, so the
 * signature is provably over `plan`'s own fields, not an opaque hash handed to it. This is what
 * replaces the old `cast wallet sign --no-hash <rpcHash>` (see file header, MAJOR-1): a `--no-hash`
 * signature signs whatever 32 bytes it is given with no way to know what they mean; `--data` signs a
 * human/hardware-wallet-checkable struct. Lands in the identical Safe `v ∈ {27,28}` branch of
 * `checkNSignatures` (Safe.sol) as before — EIP-712 signing already produces that branch, no
 * `--no-hash` needed to reach it.
 *
 * @param {object} p
 * @param {(args: string[]) => string} p.cast the caller's raw `cast` runner
 * @param {ReturnType<typeof buildPlan>} p.plan
 * @param {number|string} p.chainId the DECLARED deployment chain id
 * @param {string[]} p.signerArgs tokenised `cast` signer flags for exactly one owner
 * @returns {{signer: string, signature: string}}
 */
export function signAsOwner({ cast, plan, chainId, signerArgs }) {
  const signer = cast(['wallet', 'address', ...signerArgs]).split('\n').pop().trim();
  const typedData = buildSafeTypedData({ plan, chainId });
  const signature = cast(['wallet', 'sign', '--data', JSON.stringify(typedData), ...signerArgs]).trim();
  return { signer, signature };
}

/** Case/whitespace-insensitive equality with no accidental true on two empty/non-string values — the
 * same normaliser `smoke-preflight.normAddr` uses, duplicated only as a primitive string transform
 * (not re-imported) so this file has no dependency on smoke-preflight.mjs's own module graph. Used
 * for addresses below, and reused as-is by `safeTransactionHash` above for its hash comparison — the
 * trim/lowercase transform is generic and correct for both. */
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

/**
 * A "pre-validated" owner signature — Safe v1.4.1 `Safe.sol` `checkNSignatures`'s `v == 1` branch
 * (`contracts/Safe.sol`, `safe-global/safe-smart-account` tag `v1.4.1`, the signature-decoding loop
 * a few lines below the `v == 0` contract-signature branch): for a packed 65-byte signature with
 * `v == 1`, `currentOwner = address(uint160(uint256(r)))` and the check passes when
 * `msg.sender == currentOwner` — `s` is never read on this branch. NO ECDSA SIGNING HAPPENS: this
 * is the documented shortcut for "the owner is the one calling `execTransaction` right now", which
 * is exactly the dashboard Sign queue's shape (MetaMask submits the transaction with `from` equal
 * to the Safe owner) and needs no private key held anywhere outside the owner's own wallet.
 *
 * WHY THIS DOES NOT REOPEN MAJOR-1 (`Obsidian Vault/Agent-Governed Vaults/Verdicts/
 * 2026-09-23-security-safe-signing-path.md`, `scripts/lib/safe-exec.mjs`'s own file-header fix on
 * branch `fix/safe-exec-local-eip712`). MAJOR-1 is about a SIGNED HASH whose preimage the signer
 * never saw — a malicious RPC could return the hash of a different SafeTx and collect a valid
 * signature over it. There is no signed hash here at all: `Safe.execTransaction` computes
 * `getTransactionHash` itself, ON CHAIN, from the exact `(to,value,data,...)` calldata the caller
 * (the browser's `eth_sendTransaction`) supplies directly — nothing this repository resolved or
 * displayed off-chain is trusted for what gets hashed. The owner's authorisation is `msg.sender`,
 * enforced by the EVM itself, not a signature this file or an RPC could be tricked about.
 *
 * @param {string} owner a Safe owner address (20 bytes)
 * @returns {string} 65-byte `0x`-prefixed signature: `pad32(owner) ‖ 0x00×32 ‖ 0x01`
 */
export function preValidatedSignature(owner) {
  const addr = String(owner).trim().toLowerCase().replace(/^0x/, '');
  if (!/^[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`preValidatedSignature: ${JSON.stringify(owner)} is not a 20-byte address`);
  }
  const r = addr.padStart(64, '0');
  const s = '0'.repeat(64);
  const v = '01';
  return `0x${r}${s}${v}`;
}
