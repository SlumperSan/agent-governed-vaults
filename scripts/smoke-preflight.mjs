// @ts-check
/**
 * Pure verdicts for the two preflight probes in smoke-test.mjs, extracted the way
 * proposal-recovery.mjs was so they can be tested without executing the runner (which drives
 * `cast` and reads a deployment on import).
 *
 * Both probes EXPECT a revert, and that is the trap: `cast` fails the same way for a contract
 * revert and for a 429, a timeout or a DNS miss, and smoke-test.mjs used to swallow every failure
 * with a bare catch whose only content was the comment "expected revert". Only a CONFIRMED revert
 * is evidence about the contract.
 * Anything else is a call that reached no verdict, and has to be reported as exactly that — never
 * as the revert the probe was waiting for. The classifier is the one the soak harness and the
 * canary already share, `classifyCallError` in packages/canary/src/call-error.mjs, so the three
 * harnesses cannot disagree about which failures count.
 */
import { classifyCallError } from '../packages/canary/src/call-error.mjs';

/**
 * What a probe did. On failure `error` is `cast`'s own stderr, which is the text
 * `classifyCallError` is measured against (smoke-test.mjs's `cast()` carries it on the thrown
 * Error as `detail`, without the "cast call … failed:" prefix).
 * @typedef {{ ok: true, value?: unknown } | { ok: false, error: string }} ProbeOutcome
 */

const firstLine = (s) => String(s).split('\n')[0];

/**
 * Wiring is one-shot: an eth_call of `OperatorRegistry.wire(factory, feeEngine)` against a
 * deployed registry MUST revert — `OnlyDeployer()` for any other caller, `AlreadyWired()` for the
 * deployer (contracts/src/OperatorRegistry.sol:74-76).
 *
 * Returns null when the lock is CONFIRMED, otherwise the FAIL message. smoke-test.mjs exits the
 * process on a non-null result, so there is no third state.
 *
 *   ok:true                          the registry accepted a re-wire. The original finding.
 *   ok:false, a recognised revert    null — the one outcome that proves the lock.
 *   ok:false, anything else          nothing was learned. This case used to PASS.
 *
 * @param {ProbeOutcome} outcome
 * @returns {string | null}
 */
export function wiringImmutabilityFailure(outcome) {
  if (outcome.ok) return 'registry.wire() did NOT revert — deployment is not wired/locked correctly';
  if (classifyCallError(outcome.error) === 'revert') return null;
  return `registry.wire() could not be confirmed to revert (${firstLine(outcome.error)}) — the wiring lock is UNVERIFIED, not broken: this failure is not a contract revert (rate limit, timeout, DNS, cast itself, or wording the classifier does not recognise); preflight runs from the top on every start, so re-run the same command once the RPC answers`;
}

/**
 * The oracle probe reads `priceWad(asset)` through the deployed ChainlinkOracle. A confirmed
 * revert is the contract refusing to price the asset: `priceWad` reverts `StaleOracle(asset)` for
 * an unlisted asset, a downed sequencer, an idle feed past its heartbeat, an out-of-band price or
 * a feed that itself reverts (contracts/src/oracle/ChainlinkOracle.sol:279-305). A call that
 * produced no revert says nothing about the feed in either direction.
 *
 * Both are a WARN, not a FAIL, for the reason smoke-test.mjs already gives: the no-op lifecycle
 * never prices a non-zero basket balance, so neither can change the run's outcome. What this
 * function changes is only that the two are no longer reported with one sentence — the old line
 * attributed every failure to a stale feed and a working breaker.
 *
 * @param {string} symbol   the asset, for the log line
 * @param {string} error    cast's stderr for the failed call
 * @returns {{ kind: 'revert' | 'transport', message: string }}
 */
/**
 * May this signer create a vault, given what the deployment record declares?
 *
 * WHY A VERDICT AND NOT AN INLINE COMPARE. `VaultCore.createVault` fixes `msg.sender` as the vault's
 * immutable creator and attested operator, and no later transaction can correct it. On chain 4663
 * both vaults were created by the deployer EOA while the deployment record named the creator Safe,
 * and NOTHING COMPARED THE TWO: the divergence surfaced when a human read the record months later,
 * by which time the remedy was a new vault rather than a correction.
 *
 * The check that existed compared the creator in the event against the SIGNER — true by construction,
 * and it passed on 4663 every time. This compares both against a DECLARED intent.
 *
 * MISSING IS A REFUSAL, NOT A PASS. A record with no `intendedCreator` is the state that produced the
 * 4663 divergence, so it fails rather than skipping: there is nothing to check against, which is the
 * problem rather than an excuse to proceed.
 *
 * @param {string|undefined|null} intended the record's `intendedCreator`
 * @param {string|undefined|null} signer the address that would send `createVault`
 * @returns {string|null} a refusal message, or null when the signer may proceed
 */
/**
 * The ONE normaliser for address comparison, exported so the pre-broadcast verdict and the
 * post-broadcast confirmations cannot disagree. They did: this verdict trimmed and `smoke-test`'s
 * `eq` did not, so a declaration with surrounding whitespace passed the refusal, BROADCAST, and only
 * then failed on the event comparison - the one ordering this whole check exists to prevent.
 * Returns '' for anything that is not a string, so an absent value is never equal to another.
 */
export function normAddr(a) {
  return typeof a === 'string' ? a.trim().toLowerCase() : '';
}

/** A 20-byte hex address. Nothing shorter, longer, or non-hex is one. */
const ADDRESS_SHAPE = /^0x[0-9a-f]{40}$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

/**
 * Why SHAPE is checked and not only equality: the round-3 verdict compared two normalised strings, so
 * every pair below was accepted as a verified creator.
 *
 *   '0xabc' vs '0xABC'          a typo that agrees with itself
 *   'TBD' vs 'TBD'              a placeholder nobody replaced
 *   the zero address, twice     a burn address as the permanent creator
 *   a 39-hex address, twice     one character short, and cast would have rejected it later
 *
 * Equality is not identity. Two copies of the same wrong value agree perfectly, and `creator` is
 * immutable with no rotation path — this is the check that exists because chain 4663 has two vaults
 * carrying a creator nobody compared.
 *
 * @returns {string|null} a refusal, or null when `a` is a usable address
 */
export function addressShapeRefusal(label, a) {
  const n = normAddr(a);
  if (!n) return `${label} is missing or not a string, so it cannot be an address`;
  if (!ADDRESS_SHAPE.test(n)) {
    return `${label} is ${JSON.stringify(a)}, which is not a 20-byte hex address (0x + 40 hex chars). `
      + 'A placeholder or a truncated address that happens to match on both sides is not a verified creator.';
  }
  if (n === ZERO_ADDRESS) return `${label} is the zero address, which cannot create or own anything`;
  return null;
}

/**
 * The signer must be DERIVED from the key that will actually broadcast, every run.
 *
 * THE DEFECT THIS EXISTS FOR, reproduced executably by the round-3 reader: `smoke-test.mjs` derived
 * the signer only `if (!state.signer)` and cached it in the state file, while `send()` broadcasts with
 * the LIVE `SMOKE_SIGNER_ARGS`. So on any resumed run the creation guard validated a persisted STRING
 * while a different key was on the wire — record declares the Safe, state caches the Safe, run with
 * `--account deployerEOA`, preflight passes, broadcast reaches the chain under the EOA, and
 * `cast wallet address` is never called.
 *
 * That is chain 4663 reproduced through the new guard. And the workflow that produces it is the one
 * the guard itself creates: the refusal fires, the operator switches `SMOKE_SIGNER_ARGS`, and re-runs
 * against the old state file.
 *
 * So: derive every run, and refuse if the derived address disagrees with a cached one. A mid-lifecycle
 * key change is a loud stop rather than a silent overwrite, because half a lifecycle belongs to the
 * first signer and the vault's `creator` is immutable.
 *
 * @param {string} derived the address just read from the live signer args
 * @param {string|undefined} cached whatever the state file carried
 * @returns {string|null} a refusal, or null
 */
export function signerCacheRefusal(derived, cached) {
  const bad = addressShapeRefusal('the signer derived from SMOKE_SIGNER_ARGS', derived);
  if (bad) return `${bad} \`cast wallet address\` must answer with an address before anything is broadcast.`;
  if (!normAddr(cached)) return null; // first run: nothing to disagree with
  if (normAddr(cached) !== normAddr(derived)) {
    return `REFUSING TO CONTINUE: the state file records signer ${cached} but SMOKE_SIGNER_ARGS now `
      + `derives ${derived}. Earlier steps of this lifecycle ran as ${cached}, and a vault's creator is `
      + 'immutable — finish as that signer, or set SMOKE_RESET=1 and start a fresh lifecycle. Do not '
      + 'carry a half-finished run onto a different key.';
  }
  return null;
}

export function intendedCreatorRefusal(intended, signer) {
  const norm = normAddr;
  if (!norm(intended)) {
    return 'this deployment record declares no `intendedCreator`, so there is nothing to check the '
      + 'signer against. Declare it before creating a vault: `creator` is immutable and a wrong one '
      + 'is permanent - chain 4663 has two vaults that prove it.';
  }
  if (!norm(signer)) {
    return 'the signer is unknown, so it cannot be compared with the declared intendedCreator '
      + `${intended}. Refusing rather than creating a vault whose permanent creator nobody checked.`;
  }
  // SHAPE before equality, and on both sides.
  const badIntended = addressShapeRefusal('the declared intendedCreator', intended);
  if (badIntended) {
    return `${badIntended} Refusing rather than creating a vault whose permanent creator is not even an address.`;
  }
  const badSigner = addressShapeRefusal('the signer', signer);
  if (badSigner) return `${badSigner} Refusing rather than comparing two values that cannot both be addresses.`;

  if (norm(intended) !== norm(signer)) {
    return `REFUSING TO CREATE: the signer is ${signer} but this deployment record declares `
      + `intendedCreator ${intended}. Whichever is right, the vault would carry the SIGNER forever - `
      + 'switch the signer or change the record deliberately, but do not let them disagree silently.';
  }
  return null;
}

/**
 * The creation guard, EXTRACTED so a test can call it rather than grep for it.
 *
 * WHY THIS MOVED. `gate.mjs` only `node --check`s `smoke-test.mjs` — it is never executed, because
 * executing it needs a signer, an RPC and a funded account. So every assertion about that runner was
 * a regex over its source, and a regex can see that a call exists, and where it sits, and never that
 * it DOES anything. Round 1 asserted the call existed; round 2 asserted its position; and replacing
 * `assert(!refusal, refusal)` with a `log(refusal)` kept all 17 tests green — a guard that provably
 * runs in the right place and provably enforces nothing.
 *
 * Both earlier rounds were standing in for the same property, and neither could reach it from
 * outside. The throw lives here now, where a test calls it with a wrong declaration and asserts what
 * happens. The runner keeps only the call.
 *
 * This is what stands between a typo and a permanently wrong `creator` — the field is immutable with
 * no rotation path, chain 4663 has two vaults that prove it, and the owner is about to name a
 * brand-new address for exactly this. A green suite over an unenforced check reproduces 4663.
 */
export class CreationRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'CreationRefused';
  }
}

/**
 * WHY A SECOND REFUSAL, AND WHY IT NEVER PASSES. `intendedCreatorRefusal` compares the SIGNER's own
 * address against the declared creator — correct when the declared creator is an EOA, because under a
 * direct `cast send`, `msg.sender` for `createVault` IS the signer. It is the WRONG comparison when
 * the declared creator is a CONTRACT: `msg.sender` only becomes the contract when the transaction is
 * ROUTED THROUGH IT (a Safe's `execTransaction` calling `createVault` internally, for example) — the
 * signer is at most an OWNER of it, never equal to it, by construction. Address equality therefore
 * refuses EVERY contract-kind declaration, including a correctly authorised one: the owner recorded
 * creator Safe 0x99e805294F1f1465C96f68e36264E99991Ef9E82 on Arc on 2026-09-21, and the old check
 * refused every Safe-routed creation attempt regardless of who signed.
 *
 * THE FIX IS NOT "compare against the contract's owners instead". This script's `send()` only ever
 * broadcasts a DIRECT transaction signed by the EOA — there is no `execTransaction` path here, so
 * `msg.sender` for `createVault` can never be the declared contract no matter who signs or how
 * authorised they are to act for it. An owner-of-the-contract probe could not change that outcome
 * under direct routing, so it would add a chain read and a branch that can never flip pass/refuse —
 * exactly the "property asserted vs property claimed" shape this PR keeps being rejected for. So a
 * contract-kind declaration refuses UNCONDITIONALLY, and the message says why: no routed-execution
 * path exists, not "the signer typed the wrong thing" (which is what the address-equality message
 * would otherwise imply, and did, for card 179's read).
 *
 * KIND-DERIVED, NOT ADDRESS-DERIVED. This refuses any contract-kind creator, not the one Safe address
 * by name — a second Safe declared tomorrow refuses for the identical reason without this file naming
 * it, and `requireCreatorCode` is what confirms `kind` actually matches what the chain reports.
 *
 * @param {unknown} intended the declared intendedCreator (already established as kind "contract")
 * @returns {string} a refusal — there is no passing outcome for this branch under direct-send routing
 */
export function contractCreatorRoutingRefusal(intended) {
  return `REFUSING TO CREATE: this deployment record declares intendedCreator ${intended} as a `
    + 'CONTRACT (intendedCreatorKind "contract"), but this script only broadcasts createVault as a '
    + 'DIRECT transaction signed by SMOKE_SIGNER_ARGS -- msg.sender would be that EOA, not the '
    + 'declared contract, no matter who signs or whether they are authorised to act for it. Creating '
    + 'on behalf of a contract creator needs the transaction ROUTED THROUGH IT (e.g. a Safe '
    + 'execTransaction that itself calls createVault), which this script does not do. Execute '
    + 'createVault through the contract directly, or extend this script with a routed-send path '
    + 'before using it against a contract-kind record.';
}

/**
 * Throw unless `signer` may become the creator this deployment record declares. Returns the declared
 * address so the caller compares its post-broadcast reads against the DECLARATION rather than against
 * the signer — comparing the emitted creator to the signer who just signed is true by construction and
 * passed on 4663 every time.
 *
 * `intendedCreatorKind` is what selects the comparison: "contract" routes to
 * `contractCreatorRoutingRefusal`, which never passes (see its own doc). Anything else — including a
 * record with no kind at all — keeps the original address-equality check, so every existing EOA-kind
 * record and every test written against this function before kind existed is unaffected.
 *
 * @param {{intendedCreator?: unknown, intendedCreatorKind?: unknown}|null|undefined} deployment
 * @param {unknown} signer the address that would broadcast
 * @returns {string} the declared intendedCreator
 * @throws {CreationRefused} on a missing record, a missing declaration, an unknown signer, a
 *   mismatch, or a contract-kind declaration. There is no return path that does not either throw or
 *   hand back a verified address.
 */
export function requireIntendedCreator(deployment, signer) {
  const kind = typeof deployment?.intendedCreatorKind === 'string'
    ? deployment.intendedCreatorKind.trim().toLowerCase() : undefined;
  const refusal = kind === 'contract'
    ? contractCreatorRoutingRefusal(deployment?.intendedCreator)
    : intendedCreatorRefusal(deployment?.intendedCreator, signer);
  if (refusal) throw new CreationRefused(refusal);
  return /** @type {string} */ (deployment.intendedCreator);
}

/** The account kinds a record may declare for its creator. Anything else is a refusal, not a pass. */
const CREATOR_KINDS = Object.freeze(['eoa', 'contract']);

/** `eth_getCode` answers for an account with no bytecode. `'0x0'` is not standard but some providers
 *  return it, and treating it as "has code" is a false pass on the exact thing this checks. */
const NO_CODE = Object.freeze(['0x', '0x0', '']);

/**
 * DOES THE DECLARED CREATOR ACTUALLY EXIST, AS THE KIND OF ACCOUNT THE RECORD SAYS IT IS?
 *
 * THE DEFECT THIS EXISTS FOR, measured on 2026-09-21. The owner recorded a Gnosis Safe as the Arc
 * mainnet creator: `0x99e805294F1f1465C96f68e36264E99991Ef9E82`. On chain 5042 (`rpc.mainnet.arc.io`)
 * `eth_getCode` for it returns `0x` and `eth_getTransactionCount` returns `0x0` — and no bytecode
 * exists for it on Arc testnet, Base, Base Sepolia, Ethereum, Arbitrum or Optimism either. A Safe's
 * address is deterministic and knowable BEFORE deployment, so a predicted-but-unactivated address
 * looks exactly like a real one to any check that compares strings. `requireIntendedCreator` above
 * compares the address used against the address declared; it never asks whether anything is THERE.
 * `creator` is immutable with no rotation path, so a first vault created against an unactivated Safe
 * is the one item on the launch list that cannot be re-run.
 *
 * WHY THIS IS NOT "the address must have code", which was the obvious version and is wrong. This
 * deployment's own `intendedCreator` is `0x0f80606a…9f35`, an EOA, and it is CORRECT — verified
 * against Base Sepolia on 2026-09-21: `eth_getCode` returns `0x`, exactly as an EOA must. A blanket
 * code-exists rule refuses the working testnet path. So the record declares WHICH KIND of account it
 * intends and the chain has to agree, in both directions:
 *
 *   `intendedCreatorKind: 'contract'` and no code  → REFUSE. The Arc Safe case: not activated yet.
 *   `intendedCreatorKind: 'eoa'` and code present  → REFUSE. The declared EOA is really a contract,
 *                                                    so the operator is wrong about what they hold.
 *
 * Constraining identity rather than presence, which is the same correction round 4 of this PR asked
 * for on the post-broadcast asserts.
 *
 * WHY THE CHAIN ID IS AN ARGUMENT. A code read is only an answer about the chain it was taken on.
 * Reading Base Sepolia and reporting "the Arc creator exists" is the adjacent-property failure this
 * repository has now paid for five times, and it is easy here because the smoke path routinely holds
 * two chains at once. So the caller must pass the chain id the SAME connection answered, it must
 * match the record's own, and a mismatch or an unreadable id refuses rather than proceeding.
 *
 * @param {object} p
 * @param {unknown} p.address the declared `intendedCreator`
 * @param {unknown} p.code the `eth_getCode` result, as the provider returned it
 * @param {unknown} p.observedChainId the `eth_chainId` THAT SAME connection answered (hex or number)
 * @param {unknown} p.declaredChainId the record's own `chainId`
 * @param {unknown} p.kind the record's `intendedCreatorKind`
 * @returns {string|null} a refusal, or null when the chain agrees with the declaration
 */
export function creatorCodeRefusal({ address, code, observedChainId, declaredChainId, kind }) {
  const badAddress = addressShapeRefusal('the declared intendedCreator', address);
  if (badAddress) return `${badAddress} Refusing before asking the chain about it.`;

  // MISSING IS A REFUSAL. An absent `intendedCreatorKind` must not skip this check — that is the
  // shape where a guard is present and enforces nothing, and it would let the Arc record omit one
  // field to silently opt out of the check that exists for the Arc record.
  if (typeof kind !== 'string' || !CREATOR_KINDS.includes(kind.trim().toLowerCase())) {
    return 'this deployment record declares no usable `intendedCreatorKind` '
      + `(got ${JSON.stringify(kind)}; expected one of ${CREATOR_KINDS.join(', ')}). Without it there is no `
      + 'way to tell an unactivated Safe from a correct EOA, because both read back as having no code. '
      + 'Declare it before creating a vault: `creator` is immutable and a wrong one is permanent.';
  }
  const want = kind.trim().toLowerCase();

  const observed = Number(observedChainId);
  const declared = Number(declaredChainId);
  if (!Number.isFinite(observed) || observed === 0) {
    return `the chain id of the connection that read this code is ${JSON.stringify(observedChainId)}, which `
      + 'is not a usable chain id. A code read is only an answer about the chain it was taken on, so '
      + 'refusing rather than treating an unknown chain as the right one.';
  }
  if (!Number.isFinite(declared) || declared === 0) {
    return `this deployment record declares chainId ${JSON.stringify(declaredChainId)}, which is not usable, `
      + 'so the code read cannot be attributed to the chain the record is about.';
  }
  if (observed !== declared) {
    return `REFUSING TO CREATE: the creator's code was read on chain ${observed}, but this deployment `
      + `record is for chain ${declared}. Whether ${address} exists on ${observed} says nothing about `
      + `whether it exists on ${declared} — point the RPC at the record's own chain and read again.`;
  }

  if (typeof code !== 'string') {
    return `the code read for ${address} on chain ${declared} came back as ${JSON.stringify(code)} rather than `
      + 'a hex string, so the read failed. Refusing rather than assuming the account exists.';
  }
  const hasCode = !NO_CODE.includes(code.trim().toLowerCase());

  if (want === 'contract' && !hasCode) {
    return `REFUSING TO CREATE: this record declares intendedCreator ${address} as a ${want}, but chain `
      + `${declared} reports NO BYTECODE at that address (eth_getCode returned ${JSON.stringify(code)}). `
      + 'A Safe address is deterministic and can be known before it is deployed, so this is what a '
      + 'predicted-but-never-activated address looks like. Activate it and confirm bytecode exists '
      + 'before creating the first vault: `creator` is immutable with no rotation path, so a vault '
      + 'created against an address that is not there cannot be corrected, only replaced.';
  }
  if (want === 'eoa' && hasCode) {
    return `REFUSING TO CREATE: this record declares intendedCreator ${address} as an ${want}, but chain `
      + `${declared} reports bytecode at that address. It is a contract, so whatever key the operator `
      + 'holds is not what would own this vault. Correct the record or the address deliberately.';
  }
  return null;
}

/**
 * The code check as a throw, for the same reason `requireIntendedCreator` is one: the runner that
 * calls it is `node --check`ed and never executed, so a refusal it merely LOGS is a guard that
 * provably runs and provably enforces nothing.
 *
 * @param {object} p see `creatorCodeRefusal`
 * @param {unknown} p.address
 * @param {unknown} p.code
 * @param {unknown} p.observedChainId
 * @param {unknown} p.declaredChainId
 * @param {unknown} p.kind
 * @returns {string} the verified address
 * @throws {CreationRefused}
 */
export function requireCreatorCode(p) {
  const refusal = creatorCodeRefusal(p);
  if (refusal) throw new CreationRefused(refusal);
  return /** @type {string} */ (p.address);
}

/**
 * Read the deployment record that declares who may create a vault, and refuse rather than skip.
 *
 * THROWS on a missing file. An `existsSync`-skip here would restore the state where the check is
 * present and checks nothing, and the ban on that shape is now a behaviour rather than a forbidden
 * spelling: round 2's test grepped for `if (!fs.existsSync`, which a rename evades.
 *
 * Also refuses a record for the wrong chain. That check was disarmable with `true ||` while its only
 * coverage was a regex for the comparison's text.
 *
 * @param {{deploymentPath: string, configPath: string, readFileSync: (p: string, e: string) => string, existsSync: (p: string) => boolean}} io
 * @returns {Record<string, unknown>}
 * @throws {CreationRefused}
 */
export function loadDeploymentRecord({ deploymentPath, configPath, readFileSync, existsSync }) {
  if (!existsSync(deploymentPath)) {
    throw new CreationRefused(
      `deployment record not found at ${deploymentPath} -- it declares intendedCreator, which this `
        + 'script refuses to create a vault without. Set SMOKE_DEPLOYMENT, or add the record.',
    );
  }
  let rec;
  try {
    rec = JSON.parse(readFileSync(deploymentPath, 'utf8'));
  } catch (err) {
    throw new CreationRefused(`deployment record ${deploymentPath} is not readable JSON: ${String(err?.message ?? err)}`);
  }
  const cfgChain = JSON.parse(readFileSync(configPath, 'utf8')).chainId;
  if (!Number.isFinite(Number(cfgChain)) || Number(cfgChain) === 0) {
    throw new CreationRefused(`chain config ${configPath} declares no usable chainId, so the record cannot be matched against it`);
  }
  if (Number(rec?.chainId) !== Number(cfgChain)) {
    throw new CreationRefused(
      `deployment record ${deploymentPath} is for chain ${rec?.chainId} but the chain config `
        + `${configPath} is chain ${cfgChain} -- the wrong record would declare the wrong creator.`,
    );
  }
  return rec;
}

export function oracleProbeWarning(symbol, error) {
  const kind = classifyCallError(error);
  const why = firstLine(error);
  if (kind === 'revert') {
    return {
      kind,
      message: `WARN oracle ${symbol}: priceWad reverted (${why}) — the oracle refused to price ${symbol} (ChainlinkOracle reverts StaleOracle for an idle feed, an unlisted asset, a downed sequencer or an out-of-band price; docs/TESTNET-CHECKLIST.md §6); the no-op lifecycle never prices a basket balance, so the run continues`,
    };
  }
  return {
    kind,
    message: `WARN oracle ${symbol}: priceWad could not be read (${why}) — this failure is not a contract revert, so it says nothing about the feed either way; the run continues`,
  };
}
