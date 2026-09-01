// @ts-check
/**
 * Signal (h) — OPERATOR POWER, closing G1 (OPS-5, "operator dilution below `proposalThresholdBps`.
 * Undetected: indefinitely").
 *
 * Every case perturbs exactly one thing against the healthy default fixture: the operator (vault
 * `creator()`) holds 100e18 of 500e18 shares (20%), both the Governance `proposalThresholdBps` and
 * VaultCore's `CREATOR_MIN_STAKE_BPS` sit at the launch 500 bps, and `nonCreatorMemberCount` is 1 —
 * comfortably clear of the 750 bps WARN bar. All mocked. No live RPC anywhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOperatorPower } from '../src/signals/operator-power.mjs';
import { mockReader, healthyVault, VAULT, CREATOR, GOVERNANCE } from './helpers.mjs';

const run = async (overrides = {}) => (
  await checkOperatorPower({
    reader: mockReader({ contracts: healthyVault(overrides), nowSec: 1_700_000_000 }),
    vault: VAULT, operator: CREATOR,
  })
)[0];

// ── the healthy baseline ──────────────────────────────────────────────────────

test('a healthy operator stake reads OK against both the Governance and VaultCore gates', async () => {
  const r = await run();
  assert.equal(r.status, 'ok');
  assert.equal(r.signal, 'operator-power');
  assert.equal(r.detail.operatorBps, '2000');
  assert.equal(r.detail.thresholds.length, 2, 'both gates are live by default (registered, non-zero, a non-creator member exists)');
  assert.deepEqual(r.detail.thresholds.map((t) => t.name).sort(), ['creatorMinStakeBps', 'proposalThresholdBps']);
  assert.equal(r.detail.thresholdsDiffer, false, 'both are 500 bps at launch');
  assert.match(r.message, /operator power healthy/);
});

// ── WARN / ALERT bars ─────────────────────────────────────────────────────────

test('WARN fires at exactly 1.5x the threshold, and not a wei above it', async () => {
  // 700 bps against a 500 bps threshold: warnAt = 750, so 700 <= 750 triggers WARN.
  const r = await run({
    [VAULT]: { sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 35_000000000000000000n : 0n) },
  });
  assert.equal(r.status, 'alert', "this package's vocabulary has no fourth status — WARN maps to alert()");
  assert.equal(r.detail.level, 'warn');
  assert.match(r.message, /OPERATOR POWER WARNING/);
  assert.match(r.message, /within 1.5x/);
});

test('751 bps against a 500 bps threshold is still OK — one bps outside the WARN bar', async () => {
  const r = await run({
    [VAULT]: { sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 37_550000000000000000n : 0n) },
  });
  assert.equal(r.status, 'ok');
});

test('ALERT fires at exactly 1.1x the threshold, and the headroom is already exhausted at the crossing', async () => {
  // 500 bps IS the threshold itself: alertAt = 550, so 500 <= 550 triggers ALERT (CRITICAL).
  const r = await run({
    [VAULT]: { sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 25_000000000000000000n : 0n) },
  });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.level, 'alert');
  assert.match(r.message, /OPERATOR POWER CRITICAL/);
  const worst = r.detail.thresholds.find((t) => t.level === 'alert');
  assert.equal(worst.depositHeadroomUsdc, '0', 'already at the threshold — there is no headroom left to cross');
  assert.match(r.message, /already at or past .* — no deposit headroom remains/);
});

// ── the exact headroom estimate ───────────────────────────────────────────────

test('depositHeadroomUsdc matches VaultCore._mintShares solved for the crossing point, exactly', async () => {
  // opShares 100e18 / totalShares 1000e18 = 1000 bps. Governance threshold 800 bps: warnAt 1200,
  // alertAt 880 -> 1000 <= 1200 is WARN. sharesAtThreshold = 100e18*10000/800 = 1250e18, needing
  // 250e18 further minted shares. navWad 7e18, usdcScalar 1e12 (unchanged fixture defaults) ->
  // headroom = 250e18 * 7e18 / (1e12 * 1000e18) = 1,750,000 native USDC units ($1.75).
  const r = await run({
    [VAULT]: {
      totalShares: 1_000_000000000000000000n,
      sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 100_000000000000000000n : 0n),
    },
    [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 800, 4000, 21600] },
  });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.level, 'warn');
  const gov = r.detail.thresholds.find((t) => t.name === 'proposalThresholdBps');
  assert.equal(gov.bps, '800');
  assert.equal(gov.depositHeadroomUsdc, '1750000');
  assert.match(r.message, /estimated 1750000 USDC/);
});

// ── both gates monitored, and named as differing ──────────────────────────────

test('a vault whose proposalThresholdBps differs from CREATOR_MIN_STAKE_BPS monitors and names BOTH', async () => {
  // 1000 bps operator stake; Governance threshold 1000 -> alertAt 1100 -> 1000 <= 1100 is ALERT.
  // VaultCore's creatorMinStakeBps stays 500 -> warnAt 750 -> 1000 > 750 is OK on that leg alone.
  const r = await run({
    [VAULT]: { sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 50_000000000000000000n : 0n) },
    [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 1000, 4000, 21600] },
  });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.level, 'alert');
  assert.equal(r.detail.thresholdsDiffer, true);
  assert.deepEqual(r.detail.thresholds.map((t) => `${t.name}:${t.bps}:${t.level}`).sort(), [
    'creatorMinStakeBps:500:ok', 'proposalThresholdBps:1000:alert',
  ]);
  assert.match(r.message, /proposalThresholdBps and VaultCore's CREATOR_MIN_STAKE_BPS differ .* both gates are monitored/);
});

// ── the capacity-cap trap: no top-up path ─────────────────────────────────────

test('an ALERT at capacityCapUsdc says "no top-up path — decision needed now", literally', async () => {
  // Same ALERT-at-threshold fixture as above, plus the vault pinned at its own committed NAV
  // (navUsdc 7,000,000 + totalPendingUsdc 0) as capacityCapUsdc — no further deposit, by the
  // operator or anyone else, can land.
  const r = await run({
    [VAULT]: {
      sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 25_000000000000000000n : 0n),
      capacityCapUsdc: () => 7_000000n,
    },
  });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.atCapacity, true);
  assert.match(r.message, /no top-up path — decision needed now/);
});

test('an ALERT with capacity headroom remaining does NOT claim there is no top-up path', async () => {
  const r = await run({
    [VAULT]: {
      sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 25_000000000000000000n : 0n),
      capacityCapUsdc: () => 100_000000n, // far above the 7,000,000 committed
    },
  });
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.atCapacity, false);
  assert.ok(!r.message.includes('no top-up path'));
});

// ── graceful degradation of the optional legs ─────────────────────────────────

test('an unregistered vault drops the Governance leg — propose() reverts NotRegistered regardless of stake', async () => {
  const r = await run({ [GOVERNANCE]: { vaultRegistered: () => false } });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.thresholds.length, 1);
  assert.equal(r.detail.thresholds[0].name, 'creatorMinStakeBps');
  assert.match(r.detail.govLegNote, /not registered/);
});

test('a proposalThresholdBps of 0 (M-6: no floor) drops the Governance leg, not the whole signal', async () => {
  const r = await run({ [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 0, 4000, 21600] } });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.thresholds.length, 1);
  assert.equal(r.detail.thresholds[0].name, 'creatorMinStakeBps');
  assert.match(r.detail.govLegNote, /no floor, by design/);
});

test('no non-creator member yet drops the VaultCore exit-gate leg — it only binds once one exists', async () => {
  const r = await run({ [VAULT]: { nonCreatorMemberCount: () => 0n } });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.thresholds.length, 1);
  assert.equal(r.detail.thresholds[0].name, 'proposalThresholdBps');
});

test('neither gate is live: reported skipped, not a false OK', async () => {
  const r = await run({
    [VAULT]: { nonCreatorMemberCount: () => 0n },
    [GOVERNANCE]: { vaultRegistered: () => false },
  });
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /no binding threshold is active/);
});

test('totalShares 0 is skipped, not a division by zero', async () => {
  const r = await run({ [VAULT]: { totalShares: 0n } });
  assert.equal(r.status, 'skipped');
  assert.match(r.message, /totalShares is 0/);
});

// ── NAV unavailable degrades the headroom estimate only, never the verdict ────

test('navWad reverting (the oracle breaker) degrades the headroom estimate but not the WARN/ALERT verdict', async () => {
  const r = await run({
    [VAULT]: {
      sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 25_000000000000000000n : 0n),
      navWad: { revert: '0xa2671f4b' },
    },
  });
  assert.equal(r.status, 'alert', 'dilution is exactly as visible during a freeze as any other time');
  assert.equal(r.detail.navAvailable, false);
  assert.match(r.message, /NAV is currently unreadable \(see oracle-freshness\)/);
});

// ── detector-broken: the required reads, not the optional ones ───────────────

test('sharesOf unreadable is a BROKEN DETECTOR — the share fraction cannot be computed at all', async () => {
  const r = await run({ [VAULT]: { sharesOf: () => ({ revert: '0xdead' }) } });
  assert.equal(r.status, 'skipped');
  assert.equal(r.detail.detectorBroken, true);
  assert.match(r.message, /OPERATOR POWER DETECTOR BLIND/);
  assert.match(r.message, /sharesOf/);
});

// ── copy discipline: no outcome/yield language, dilution named as by-design ──

test('the ALERT message names dilution as by-design, not a bug, and never claims the operator risks nothing', async () => {
  const r = await run({
    [VAULT]: { sharesOf: (a) => (a.toLowerCase() === CREATOR.toLowerCase() ? 25_000000000000000000n : 0n) },
  });
  assert.match(r.message, /by design/);
  assert.doesNotMatch(r.message, /zero capital cost/i);
  assert.doesNotMatch(r.message, /\bguarantee/i);
  assert.doesNotMatch(r.message, /\bsafe\b/i);
});
