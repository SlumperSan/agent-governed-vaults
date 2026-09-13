// @ts-check
/**
 * Pure logic behind `scripts/verify-deployment-currency.mjs`, split out so it is testable without
 * a real git repository or an RPC. Sibling of `deployment-reproducibility.mjs` — same shape, a
 * DIFFERENT question, and the two must not be confused:
 *
 *   - `deployment-reproducibility` asks: can the deployment still be SOURCE-VERIFIED? (does its
 *     pinned `sourceCommit` still resolve and sit on the mainline). It says nothing about whether
 *     the deployed code is still the code we intend to ship, and its own header says so.
 *   - `deployment-currency` (this one) asks: is the deployment BEHIND the mainline? i.e. has
 *     `contracts/src` changed since `sourceCommit`, so that gates resting on this deployment are
 *     evidence about superseded contracts.
 *
 * WHY THIS EXISTS. Launch gates 2, 3 and 6 in `docs/LAUNCH-READINESS.md` are earned by exercising
 * a live deployment. Every `contracts/src` merge silently invalidates them, and the obvious check
 * does not catch it: **comparing the SINGLETON codesizes gives a false all-clear.** `VaultFactory`,
 * `Governance`, `FeeEngine` and friends are deployed once and never change size when `VaultCore`
 * does, because the vault's code is not in any of them — `VaultDeployer` pins it as two SSTORE2
 * chunks (`codeChunkA`/`codeChunkB`, see `contracts/src/VaultDeployer.sol`) and stamps a fresh
 * vault from those bytes. So the singletons can be byte-identical while every vault the factory
 * creates is a stale `VaultCore`.
 *
 * ## Why the on-chain leg compares BYTES and not sizes
 *
 * Measuring the chunks instead of the singletons fixes the first false all-clear and walks straight
 * into a second one. Measured on chain 4663 on 2026-09-13, against the `VaultDeployer` at
 * 0xc36198FD2c7C62738159ED1FF965679105FAF05a:
 *
 *   pinned creation code 22,391 B   local build 22,391 B   -> a size check says "consistent"
 *   31 of those bytes differ, the first at offset 22,348   -> the bytes say MISMATCH
 *
 * The differing run is the CBOR metadata trailer's IPFS hash, which is FIXED LENGTH. `contracts/
 * foundry.toml` sets no `bytecode_hash`, so solc appends that hash, and it is a digest of the
 * metadata — which includes each source file's keccak and its license string. The BUSL-1.1 -> MIT
 * relicense therefore changed the deployed bytes of every contract while changing the length of
 * none of them. `contracts/config/deployments/robinhood-mainnet.json` makes exactly this point
 * about itself under `bytecodeCurrency.whyThisAndNotCodesize`, and then that record relies on a
 * byte comparison rather than a size one.
 *
 * A size comparison is therefore not a weak version of this check, it is a check that PASSES ON THE
 * REAL DRIFT THAT EXISTS TODAY. The sizes are still reported, because seeing "same length, different
 * bytes" printed side by side is what stops the next reader reaching for the length again.
 *
 * @typedef {object} DeploymentRecord
 * @property {string} [chainName]
 * @property {string} [sourceCommit]
 * @property {Record<string, unknown>} [verifiedWiring]
 *
 * @typedef {object} CurrencyResult
 * @property {string} chainName
 * @property {string} sourceCommit          '(none)' when unset
 * @property {boolean|null} current         null = not checked (no pinned commit, or no mainline)
 * @property {string[]} changedPaths        contracts/src paths that moved since sourceCommit
 * @property {string[]} notes               advisory findings, never a hard fail on their own
 * @property {boolean} hardFail
 */

/** Launch closes C-1 by shipping root vaults only; see LAUNCH-READINESS gate 0. */
const LAUNCH_ALLOW_SUB_VAULTS = false;

/**
 * @param {DeploymentRecord} cfg
 * @param {{
 *   gitResolves: (commit: string) => boolean,
 *   changedSourcePaths: (commit: string) => string[],
 *   haveMainline: boolean,
 *   mainlineRef: string,
 *   fallbackChainName: string,
 * }} deps
 * @returns {CurrencyResult}
 */
export function checkDeploymentCurrency(cfg, deps) {
  const chainName = cfg.chainName ?? deps.fallbackChainName;
  const notes = launchConfigNotes(cfg);

  const sourceCommit = cfg.sourceCommit;
  if (!sourceCommit) {
    // Nothing pinned: there is no commit to measure currency against. That is a content problem
    // with the record, and `verify-deployment-reproducibility` is the script that owns it — so it
    // is skipped here rather than double-reported as a failure.
    return { chainName, sourceCommit: '(none)', current: null, changedPaths: [], notes, hardFail: false };
  }

  if (!deps.gitResolves(sourceCommit)) {
    // Same reasoning: unresolvable `sourceCommit` is reproducibility's failure, not currency's.
    notes.push(
      `${sourceCommit} does not resolve here — currency not checked (see verify-deployment-reproducibility)`,
    );
    return { chainName, sourceCommit, current: null, changedPaths: [], notes, hardFail: false };
  }

  if (!deps.haveMainline) {
    // A shallow clone or a sandboxed CI checkout may not carry the mainline ref. Advisory, never
    // a failure — refusing to answer is honest; guessing "current" would be the dangerous default.
    notes.push(`mainline ref ${deps.mainlineRef} not present — currency not checked`);
    return { chainName, sourceCommit, current: null, changedPaths: [], notes, hardFail: false };
  }

  const changedPaths = deps.changedSourcePaths(sourceCommit);
  const current = changedPaths.length === 0;
  return { chainName, sourceCommit, current, changedPaths, notes, hardFail: !current };
}

/**
 * Configuration divergences that do not make the deployment stale, but do change what evidence
 * gathered against it is evidence OF. Advisory by design: a testnet stack may legitimately run a
 * non-launch configuration — the point is that nobody should read its gate evidence as if it did not.
 *
 * @param {DeploymentRecord} cfg
 * @returns {string[]}
 */
export function launchConfigNotes(cfg) {
  const notes = [];
  const wiring = cfg.verifiedWiring ?? {};
  const allowSubVaults = wiring['factory.allowSubVaults()'];
  if (typeof allowSubVaults === 'boolean' && allowSubVaults !== LAUNCH_ALLOW_SUB_VAULTS) {
    notes.push(
      `factory.allowSubVaults() = ${allowSubVaults}, but launch ships ${LAUNCH_ALLOW_SUB_VAULTS} ` +
        '(C-1 closed by root-vaults-only) — lifecycle/soak evidence from this deployment is about a ' +
        'DIFFERENT configuration than the one that launches',
    );
  }
  return notes;
}

/** '0x'-tolerant, case-insensitive hex normaliser. @param {string} h @returns {string} */
function hex(h) {
  return String(h ?? '')
    .trim()
    .replace(/^0x/i, '')
    .toLowerCase();
}

/**
 * Compare the VaultCore creation code pinned in `VaultDeployer`'s two SSTORE2 chunks against the
 * locally built artifact, BYTE FOR BYTE. This is the on-chain half of the check and the one that
 * survives a lost or wrong `sourceCommit`, because it reads what is actually deployed.
 *
 * The reassembly rule is `VaultDeployer.deploy`'s own, not a guess: each chunk's code is
 * `0x00 || data` (SSTORE2 prepends one STOP so the blob can never be executed), and `deploy` does
 * `extcodecopy(chunk, ..., 1, extcodesize(chunk) - 1)` for A then B. So the pinned creation code is
 * every chunk's deployed code minus its first byte, concatenated in order.
 *
 * `sizeMatch` is reported SEPARATELY from `byteMatch` and is never the verdict. See the module
 * header: on chain 4663 today the two disagree, and the one that says "fine" is the size.
 *
 * @param {string[]} chunkCodes  each chunk's deployed code as hex (with or without 0x), in order
 * @param {string} localCreationCode  the locally built VaultCore creation code as hex
 * @returns {{pinnedBytes:number, localBytes:number, delta:number, sizeMatch:boolean,
 *            byteMatch:boolean, differingBytes:number|null, firstDifferenceAt:number|null}}
 */
export function compareVaultCoreChunks(chunkCodes, localCreationCode) {
  // Drop one leading STOP byte (two hex chars) per chunk, then concatenate in the order given.
  const pinned = chunkCodes.map((c) => hex(c).slice(2)).join('');
  const local = hex(localCreationCode);
  const pinnedBytes = pinned.length / 2;
  const localBytes = local.length / 2;
  const sizeMatch = pinnedBytes === localBytes;

  let differingBytes = 0;
  let firstDifferenceAt = null;
  const common = Math.min(pinned.length, local.length);
  for (let i = 0; i < common; i += 2) {
    if (pinned.slice(i, i + 2) !== local.slice(i, i + 2)) {
      differingBytes += 1;
      if (firstDifferenceAt === null) firstDifferenceAt = i / 2;
    }
  }
  // A length difference is itself a difference; count the unmatched tail so the number is honest.
  differingBytes += Math.abs(pinnedBytes - localBytes);
  if (firstDifferenceAt === null && !sizeMatch) firstDifferenceAt = common / 2;

  return {
    pinnedBytes,
    localBytes,
    delta: pinnedBytes - localBytes,
    sizeMatch,
    byteMatch: sizeMatch && differingBytes === 0,
    differingBytes,
    firstDifferenceAt,
  };
}

/**
 * One printable line for an on-chain comparison. Here rather than in the runner so the wording is
 * unit-testable — the whole point of this check is what an operator reads off it.
 *
 * @param {string} name chain name
 * @param {ReturnType<typeof compareVaultCoreChunks> & {skipped?:string}} o
 * @returns {string}
 */
export function formatOnchainLine(name, o) {
  if (o.skipped) return `  onchain ${name}: SKIP (${o.skipped})`;
  const sizes = `pinned VaultCore creation code ${o.pinnedBytes} B vs local ${o.localBytes} B (delta ${o.delta})`;
  if (o.byteMatch) return `  onchain ${name}: ${sizes} — byte-for-byte identical to this build`;
  // The interesting case, and the one a size check reports as fine.
  const sameLength = o.sizeMatch
    ? ' — SAME LENGTH, DIFFERENT BYTES: a codesize comparison would have passed this'
    : '';
  return (
    `  onchain ${name}: ${sizes} — MISMATCH: deployed VaultCore is not this build ` +
    `(${o.differingBytes} byte(s) differ, first at offset ${o.firstDifferenceAt})${sameLength}`
  );
}

/**
 * @param {CurrencyResult[]} results
 * @returns {boolean} true if any record hard-failed
 */
export function anyHardFail(results) {
  return results.some((r) => r.hardFail);
}

/**
 * @param {CurrencyResult} r
 * @param {number} [maxPaths] how many changed paths to name before eliding
 * @returns {string}
 */
export function formatResultLine(r, maxPaths = 6) {
  if (r.current === null) return `SKIP  ${r.chainName}  ${r.sourceCommit}  (not checked)`;
  if (r.current) return `OK    ${r.chainName}  ${r.sourceCommit}  contracts/src unchanged since deploy`;

  const shown = r.changedPaths.slice(0, maxPaths);
  const rest = r.changedPaths.length - shown.length;
  const tail = rest > 0 ? `, +${rest} more` : '';
  return (
    `BEHIND ${r.chainName}  ${r.sourceCommit}  ${r.changedPaths.length} contracts/src path(s) ` +
    `changed since deploy: ${shown.join(', ')}${tail}`
  );
}
