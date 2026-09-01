// @ts-check
/**
 * Pure logic behind `scripts/verify-deployment-reproducibility.mjs`, split out so it is testable
 * without a real git repository. See that script's header for the full "why" — in short: solc's
 * default `ipfs` metadata mode keys the CBOR trailer by source path, so HEAD is not guaranteed to
 * reproduce a historical deployment's bytecode after files move; only the exact `sourceCommit`
 * pinned in the deployment record is. This module checks that the pinned commit still resolves
 * and is still reachable from the shared mainline — the one thing that silently rots.
 *
 * @typedef {object} DeploymentRecord
 * @property {string} [chainName]
 * @property {string} [sourceCommit]
 *
 * @typedef {object} CheckResult
 * @property {string} chainName
 * @property {string} sourceCommit   '(none)' when unset
 * @property {boolean} resolves
 * @property {boolean|null} isAncestor   null = not checked (no mainline ref, or does not resolve)
 * @property {boolean} hardFail
 */

/**
 * @param {DeploymentRecord} cfg
 * @param {{
 *   gitResolves: (commit: string) => boolean,
 *   gitIsAncestor: (commit: string) => boolean,
 *   haveMainline: boolean,
 *   fallbackChainName: string,
 * }} deps
 * @returns {CheckResult}
 */
export function checkDeploymentRecord(cfg, deps) {
  const chainName = cfg.chainName ?? deps.fallbackChainName;
  const sourceCommit = cfg.sourceCommit;

  if (!sourceCommit) {
    // Nothing pinned yet -- a content problem with the record, not a reproducibility-of-what's-
    // pinned problem, so this is skipped rather than failed.
    return {chainName, sourceCommit: '(none)', resolves: false, isAncestor: null, hardFail: false};
  }

  const resolves = deps.gitResolves(sourceCommit);
  if (!resolves) {
    return {chainName, sourceCommit, resolves: false, isAncestor: null, hardFail: true};
  }

  if (!deps.haveMainline) {
    return {chainName, sourceCommit, resolves: true, isAncestor: null, hardFail: false};
  }

  const isAncestor = deps.gitIsAncestor(sourceCommit);
  return {chainName, sourceCommit, resolves: true, isAncestor, hardFail: !isAncestor};
}

/**
 * @param {CheckResult[]} results
 * @returns {boolean} true if any record hard-failed
 */
export function anyHardFail(results) {
  return results.some((r) => r.hardFail);
}

/**
 * @param {CheckResult} r
 * @returns {string}
 */
export function formatResultLine(r) {
  if (r.sourceCommit === '(none)') {
    return `  SKIP  ${r.chainName}: no sourceCommit recorded`;
  }
  if (!r.resolves) {
    return (
      `  FAIL  ${r.chainName}: sourceCommit ${r.sourceCommit} does not resolve in local git ` +
      `history -- this deployment can no longer be reproduced or source-verified from this checkout.`
    );
  }
  if (r.isAncestor === false) {
    return (
      `  FAIL  ${r.chainName}: sourceCommit ${r.sourceCommit} resolves locally but is NOT an ` +
      `ancestor of the mainline -- it depends on a ref that can be pruned or force-pushed away. ` +
      `Re-record a commit that is on the shared mainline.`
    );
  }
  const ancestorNote = r.isAncestor === true ? ', ancestor of the mainline' : '';
  return `  OK    ${r.chainName}: sourceCommit ${r.sourceCommit} resolves${ancestorNote}`;
}
