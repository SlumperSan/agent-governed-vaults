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
 * Throw unless `signer` is the creator this deployment record declares. Returns the declared address
 * so the caller compares its post-broadcast reads against the DECLARATION rather than against the
 * signer — comparing the emitted creator to the signer who just signed is true by construction and
 * passed on 4663 every time.
 *
 * @param {{intendedCreator?: unknown}|null|undefined} deployment the deployment record
 * @param {unknown} signer the address that would broadcast
 * @returns {string} the declared intendedCreator
 * @throws {CreationRefused} on a missing record, a missing declaration, an unknown signer, or a
 *   mismatch. There is no return path that does not either throw or hand back a verified address.
 */
export function requireIntendedCreator(deployment, signer) {
  const refusal = intendedCreatorRefusal(deployment?.intendedCreator, signer);
  if (refusal) throw new CreationRefused(refusal);
  return /** @type {string} */ (deployment.intendedCreator);
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
