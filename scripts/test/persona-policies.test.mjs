// @ts-check
/**
 * Pure, fixture-based unit + mutation coverage for `scripts/lib/persona-policies.mjs` and the two
 * settlement formulas in `scripts/test/lib/persona-fork-chain.mjs`
 * (`expectedExitFeeBps`/`computeNoOpExitUsdcPaid`) that `scripts/test/persona-round-sim.test.mjs`'s
 * live fork assertions depend on.
 *
 * DELIBERATELY SEPARATE FROM persona-round-sim.test.mjs, which has a `before()` hook requiring
 * `anvil`/`forge` and two real, network-dependent `DeployTestnet.s.sol` deployments (tens of
 * seconds each) before a single assertion in that file can run. Nothing here starts a fork,
 * deploys anything, or makes an RPC call — `persona-fork-chain.mjs`'s two settlement-formula
 * exports used below are pure functions; only the MODULE ITSELF still computes a few `cast keccak`
 * topic hashes at import time (no RPC, no anvil/forge — `cast` alone must be on PATH, the same
 * baseline every fork suite in this repository already assumes). This file runs in milliseconds
 * and is the one the "Mutations" section of that PR's body points at for the live red/green record.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../lib/persona-policies.mjs';
import { expectedExitFeeBps, computeNoOpExitUsdcPaid } from './lib/persona-fork-chain.mjs';

test('computeNoOpExitUsdcPaid matches the contract\'s own no-swap/no-child formula', () => {
  // Fixture: 200 USDC idle (6 decimals), 200e18 total shares (2 equal depositors), one full exit
  // of 100e18 shares at 35 bps fee (mirrors Vault 1's measured tenure case in the fork suite) --
  // expected 99.65 USDC.
  const usdcScalar = 10n ** 12n;
  const idleUsdcBefore = 200_000_000n;
  const totalSharesBefore = 200n * 10n ** 18n;
  const burnShares = 100n * 10n ** 18n;
  const feeBps = 35n;
  const result = computeNoOpExitUsdcPaid({ idleUsdcBefore, totalSharesBefore, burnShares, feeBps, usdcScalar });
  assert.equal(result, 99_650_000n, '100 USDC minus 35 bps must be exactly 99.65 USDC');
});

test('expectedExitFeeBps matches VaultCore._exitFeeBps\'s decay formula exactly', () => {
  const maxBps = 50n, period = 604800n;
  assert.equal(expectedExitFeeBps({ maxBps, period, tenure: 0n }), 50n, 'zero tenure: full fee');
  assert.equal(expectedExitFeeBps({ maxBps, period, tenure: period }), 0n, 'tenure >= period: fully decayed');
  assert.equal(expectedExitFeeBps({ maxBps, period, tenure: 172800n }), 35n, 'the exact Vault-1-shaped tenure case (2 rounds\' worth of seconds) must floor to 35 bps, not round');
});

test('ballastVoteDecide flips direction on the 1% cap, the derived-safe bound, and the ordersEmpty shortcut', () => {
  const noOpCase = policy.ballastVoteDecide({ maxSlippageBps: 999n, derivedSlipBps: null, reducesExposure: false, ordersEmpty: true });
  assert.equal(noOpCase.action, 'commitFor', 'an empty-orders proposal must vote FOR regardless of the placeholder maxSlippageBps');
  const forCase = policy.ballastVoteDecide({ maxSlippageBps: 50n, derivedSlipBps: 60n, reducesExposure: false });
  assert.equal(forCase.action, 'commitFor', 'under the derived-safe bound must vote FOR');
  const forExposureCase = policy.ballastVoteDecide({ maxSlippageBps: 90n, derivedSlipBps: null, reducesExposure: true });
  assert.equal(forExposureCase.action, 'commitFor', 'reducing exposure votes FOR even with no derivation available, as long as it clears the cap');
  const againstCapCase = policy.ballastVoteDecide({ maxSlippageBps: 150n, derivedSlipBps: 200n, reducesExposure: false });
  assert.equal(againstCapCase.action, 'commitAgainst', 'at/above the 1% (100 bps) line must vote AGAINST regardless of the derived bound');
  const againstOverDerivedCase = policy.ballastVoteDecide({ maxSlippageBps: 80n, derivedSlipBps: 60n, reducesExposure: false });
  assert.equal(againstOverDerivedCase.action, 'commitAgainst', 'over the derived-safe bound (and not reducing exposure) must vote AGAINST');
});

test('momentumVoteDecide flips direction with the measured trend, and the no-op short-circuit', () => {
  assert.equal(policy.momentumVoteDecide({ trendUp: true, orderDirection: 'intoAsset' }).action, 'commitFor');
  assert.equal(policy.momentumVoteDecide({ trendUp: true, orderDirection: 'intoUsdc' }).action, 'commitAgainst');
  assert.equal(policy.momentumVoteDecide({ trendUp: false, orderDirection: 'intoUsdc' }).action, 'commitFor');
  assert.equal(policy.momentumVoteDecide({ trendUp: false, orderDirection: 'intoAsset' }).action, 'commitAgainst');
  assert.equal(policy.momentumVoteDecide({ trendUp: true, orderDirection: 'noOp' }).action, 'commitFor', 'no-op carries no directional risk');
  assert.equal(policy.momentumVoteDecide({ trendUp: false, orderDirection: 'noOp' }).action, 'commitFor', 'no-op carries no directional risk regardless of trend');
});

test('momentumProposeDecide reads a majority of up/down rounds, and holds on no data', () => {
  assert.equal(policy.momentumProposeDecide({ roundDeltas: [] }).action, 'hold');
  assert.equal(policy.momentumProposeDecide({ roundDeltas: [1n, 2n, -1n] }).action, 'proposeIntoAsset');
  assert.equal(policy.momentumProposeDecide({ roundDeltas: [-1n, -2n, 1n] }).action, 'proposeIntoUsdc');
});

test('momentumExitDecide fires on outvoted-twice or round-complete, independently', () => {
  assert.equal(policy.momentumExitDecide({ outvotedCount: 2, roundComplete: false }).action, 'requestExit');
  assert.equal(policy.momentumExitDecide({ outvotedCount: 0, roundComplete: true }).action, 'requestExit');
  assert.equal(policy.momentumExitDecide({ outvotedCount: 0, roundComplete: false }).action, 'hold');
});

test('ballastDepositDecide sizes to minDepositUsdc, refuses a non-positive minimum', () => {
  assert.deepEqual(policy.ballastDepositDecide({ minDepositUsdc: 100_000_000n }), { action: 'deposit', amountUsdc: 100_000_000n });
  assert.equal(policy.ballastDepositDecide({ minDepositUsdc: 0n }).action, 'skip');
});

test('contrarianDecide: unfunded always dissents-only; funded commits opposite when its case clears its own bar', () => {
  assert.equal(policy.contrarianDecide({ funded: false, prevailingSupport: true, caseStrength: 10, ownBar: 1 }).action, 'publishDissent');
  assert.equal(policy.contrarianDecide({ funded: true, prevailingSupport: true, caseStrength: 5, ownBar: 5 }).action, 'commitAgainstPrevailing');
  assert.equal(policy.contrarianDecide({ funded: true, prevailingSupport: true, caseStrength: 1, ownBar: 5 }).action, 'watch');
  assert.equal(policy.contrarianDecide({ funded: true, prevailingSupport: null, caseStrength: 10, ownBar: 1 }).action, 'watch', 'nothing to argue against yet');
});

test('auditorDecide is a pure passthrough that never votes', () => {
  const readout = { navUsdc: 1n, idleUsdc: 1n, queuedExitShares: 0n, oracleAgeSeconds: 0, feeAccruedUsdc: 0n, voters: [] };
  assert.deepEqual(policy.auditorDecide(readout), { action: 'publishReadout', readout });
});
