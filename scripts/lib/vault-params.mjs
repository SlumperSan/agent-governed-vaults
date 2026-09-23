// @ts-check
/**
 * The two ABI-tuple strings `VaultFactory.createVault` and `Governance.registerVault` take,
 * factored out of `scripts/smoke-test.mjs` so a second caller (the dashboard Sign queue's
 * `scripts/sign-queue/first-vault.mjs`, which builds the SAME two calls routed through the Arc
 * creator Safe instead of sent directly) can produce byte-identical calldata without re-deriving
 * the tuple shape by hand — the exact "untested arithmetic" this repository has already paid for
 * elsewhere (see `scripts/lib/safe-exec.mjs`'s own header).
 *
 * PURE STRING BUILDERS ONLY. Neither function reads a config file, shells out to `cast`, or knows
 * about a chain — every value is a parameter, so `smoke-test.mjs`'s own values (`cfg`/`smoke`) and
 * `first-vault.mjs`'s (a curated queue item's own resolved fields) go through the identical code
 * path. `scripts/test/smoke-test-harness.test.mjs`'s spawned-child e2e harness is what proves this
 * factoring changed no byte of what `smoke-test.mjs` sends: it drives the real runner end to end
 * and asserts on the transactions it broadcasts, so a tuple shape regression here fails there.
 */

/**
 * `VaultFactory.createVault`'s single tuple argument:
 *   (address usdc, address[] tokens, address oracle, uint256 capacityCapUsdc,
 *    uint256 minDepositUsdc, uint256 exitFeeMaxBps, uint256 exitFeeDecayPeriod, address[] adapters)
 *
 * @param {object} p
 * @param {string} p.usdc
 * @param {string[]} p.tokens
 * @param {string} p.oracle
 * @param {string|number|bigint} p.capacityCapUsdc
 * @param {string|number|bigint} p.minDepositUsdc
 * @param {string|number|bigint} p.exitFeeMaxBps
 * @param {string|number|bigint} p.exitFeeDecayPeriod
 * @param {string[]} p.adapters
 * @returns {string} the tuple, ready for `cast calldata`/`cast abi-encode`'s `(...)` argument
 */
export function createVaultParamsTuple({
  usdc, tokens, oracle, capacityCapUsdc, minDepositUsdc, exitFeeMaxBps, exitFeeDecayPeriod, adapters,
}) {
  return `(${usdc},[${tokens.join(',')}],${oracle},${capacityCapUsdc},${minDepositUsdc},${exitFeeMaxBps},${exitFeeDecayPeriod},[${adapters.join(',')}])`;
}

/**
 * `Governance.registerVault`'s second argument, the gov-config tuple:
 *   (uint32 commitDuration, uint32 revealDuration, uint32 timelockDuration, uint32 executionWindow,
 *    uint16 quorumBps, uint16 proposalThresholdBps, uint16 concentrationCapBps, uint32 proposalCooldown)
 *
 * @param {{commitDuration:string|number, revealDuration:string|number, timelockDuration:string|number,
 *   executionWindow:string|number, quorumBps:string|number, proposalThresholdBps:string|number,
 *   concentrationCapBps:string|number, proposalCooldown:string|number}} g
 * @returns {string}
 */
export function registerVaultGovTuple(g) {
  return `(${g.commitDuration},${g.revealDuration},${g.timelockDuration},${g.executionWindow},${g.quorumBps},${g.proposalThresholdBps},${g.concentrationCapBps},${g.proposalCooldown})`;
}
