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
 * a live testnet deployment. Every `contracts/src` merge silently invalidates them, and the
 * obvious check does not catch it: **comparing the SINGLETON codesizes gives a false all-clear.**
 * `VaultFactory`, `Governance`, `FeeEngine` and friends are deployed once and never change size
 * when `VaultCore` does, because the vault's code is not in any of them — `VaultDeployer` pins it
 * as two SSTORE2 chunks (`codeChunkA`/`codeChunkB`, see `contracts/src/VaultDeployer.sol:28-39`)
 * and stamps a fresh vault from those bytes. So the singletons can be byte-identical while every
 * vault the factory creates is a stale `VaultCore`.
 *
 * The reliable tests are therefore (a) git: did `contracts/src` move after `sourceCommit`, and
 * (b) on-chain: read the pinned chunks, or call a function that only the newer `VaultCore` has.
 * This module owns (a) and the comparison half of (b); the runner does the git and RPC I/O.
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
    return {chainName, sourceCommit: '(none)', current: null, changedPaths: [], notes, hardFail: false};
  }

  if (!deps.gitResolves(sourceCommit)) {
    // Same reasoning: unresolvable `sourceCommit` is reproducibility's failure, not currency's.
    notes.push(`${sourceCommit} does not resolve here — currency not checked (see verify-deployment-reproducibility)`);
    return {chainName, sourceCommit, current: null, changedPaths: [], notes, hardFail: false};
  }

  if (!deps.haveMainline) {
    // A shallow clone or a sandboxed CI checkout may not carry the mainline ref. Advisory, never
    // a failure — refusing to answer is honest; guessing "current" would be the dangerous default.
    notes.push(`mainline ref ${deps.mainlineRef} not present — currency not checked`);
    return {chainName, sourceCommit, current: null, changedPaths: [], notes, hardFail: false};
  }

  const changedPaths = deps.changedSourcePaths(sourceCommit);
  const current = changedPaths.length === 0;
  return {chainName, sourceCommit, current, changedPaths, notes, hardFail: !current};
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

/**
 * Compare the VaultCore creation code pinned in `VaultDeployer`'s two SSTORE2 chunks against the
 * locally built artifact. This is the on-chain half of the check and the one that survives a lost
 * or wrong `sourceCommit`, because it reads what is actually deployed.
 *
 * SSTORE2 prepends a single `STOP` (0x00) byte to each chunk so the data can never be called as
 * code, so the pinned payload is `sum(chunk sizes) - one byte per chunk`.
 *
 * A size match is NOT proof of equality — two different builds can coincide in length — so a match
 * is reported as "consistent", never as "verified". A MISMATCH, however, is conclusive.
 *
 * @param {number[]} chunkSizes            byte length of each chunk's deployed code, in order
 * @param {number} localCreationCodeBytes  byte length of the locally built VaultCore creation code
 * @returns {{pinnedBytes: number, localBytes: number, delta: number, match: boolean}}
 */
export function compareVaultCoreChunks(chunkSizes, localCreationCodeBytes) {
  const pinnedBytes = chunkSizes.reduce((sum, n) => sum + n, 0) - chunkSizes.length;
  return {
    pinnedBytes,
    localBytes: localCreationCodeBytes,
    delta: pinnedBytes - localCreationCodeBytes,
    match: pinnedBytes === localCreationCodeBytes,
  };
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
