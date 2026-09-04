// @ts-check
/**
 * Signal (h) — OPERATOR POWER, closing G1 (OPS-5, "operator dilution below `proposalThresholdBps`.
 * Undetected: indefinitely").
 *
 * Every case perturbs exactly one thing against the healthy default fixture: the operator (vault
 * `creator()`) holds 100e18 of 500e18 shares (20%), the same 100e18 of 500e18 VOTING-ELIGIBLE
 * shares (nobody has queued a Mode-F exit), both the Governance `proposalThresholdBps` and
 * VaultCore's `CREATOR_MIN_STAKE_BPS` sit at the launch 500 bps, and `nonCreatorMemberCount` is 1 —
 * comfortably clear of the 750 bps WARN bar. All mocked. No live RPC anywhere.
 *
 * THE SIGNAL EMITS TWO RESULTS PER SWEEP, under the fixed keys `early-warning` (the 1.5x bar) and
 * `critical` (the 1.1x bar). `run()` below returns both, keyed, and each test picks the bar it is
 * about. That shape is not cosmetic and the tests at the bottom of this file prove why: transitions
 * are tracked by STATUS alone, so a single result deteriorating WARN -> CRITICAL emits nothing, and
 * the page that says "decision needed now" would never be delivered.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkOperatorPower, EARLY_WARNING_KEY, CRITICAL_KEY } from '../src/signals/operator-power.mjs';
import { createTransitionTracker } from '../src/transitions.mjs';
import { createTieredWebhookSink } from '../src/sinks.mjs';
import { mockReader, healthyVault, VAULT, CREATOR, GOVERNANCE } from './helpers.mjs';

const lc = (a) => String(a).toLowerCase();

/** Run one sweep; returns `{ warn, crit, all }` so each test names the bar it is asserting about. */
const run = async (overrides = {}) => {
  const all = await checkOperatorPower({
    reader: mockReader({ contracts: healthyVault(overrides), nowSec: 1_700_000_000 }),
    vault: VAULT, operator: CREATOR,
  });
  return {
    all,
    warn: all.find((r) => r.key === EARLY_WARNING_KEY),
    crit: all.find((r) => r.key === CRITICAL_KEY),
  };
};

/**
 * The operator holds `shares` of the (unchanged) 500e18 supply, with NO queued exit — so the raw
 * and voting-eligible books agree, which is what every pre-existing case in this file meant by
 * "the operator holds X%". A case that wants them to DIVERGE overrides the eligible views alone.
 */
const holding = (shares, rest = {}) => ({
  [VAULT]: {
    sharesOf: (a) => (lc(a) === lc(CREATOR) ? shares : 0n),
    votingEligibleShares: (a) => (lc(a) === lc(CREATOR) ? shares : 0n),
    ...rest,
  },
});

/** bps of the 500e18 default supply, exactly. 500e18 * bps / 10000 is integral for every bps used. */
const sharesForBps = (bps) => (500_000000000000000000n * BigInt(bps)) / 10000n;

// ── the healthy baseline ──────────────────────────────────────────────────────

test('a healthy operator stake reads OK against both the Governance and VaultCore gates', async () => {
  const { warn, crit, all } = await run();
  assert.equal(all.length, 2, 'both bars are always emitted');
  assert.deepEqual(all.map((r) => r.key), [EARLY_WARNING_KEY, CRITICAL_KEY]);
  for (const r of [warn, crit]) {
    assert.equal(r.status, 'ok');
    assert.equal(r.signal, 'operator-power');
    assert.equal(r.detail.operatorBps, '2000');
    assert.equal(r.detail.eligibleBps, '2000', 'no queued exit — the two books agree');
    assert.equal(r.detail.thresholds.length, 2, 'both gates are live by default (registered, non-zero, a non-creator member exists)');
    assert.deepEqual(r.detail.thresholds.map((t) => t.name).sort(), ['creatorMinStakeBps', 'proposalThresholdBps']);
    assert.equal(r.detail.thresholdsDiffer, false, 'both are 500 bps at launch');
    assert.match(r.message, /operator power healthy/);
  }
});

test('each leg names the share book its gate actually reads', async () => {
  const { crit } = await run();
  const byName = Object.fromEntries(crit.detail.thresholds.map((t) => [t.name, t]));
  assert.equal(byName.proposalThresholdBps.book, 'voting-eligible',
    'Governance.propose reads pastVotingEligibleShares / pastTotalVotingEligibleShares');
  assert.equal(byName.creatorMinStakeBps.book, 'raw',
    '_checkCreatorGate reads sharesOf / totalShares');
});

// ── F1: the Governance gate is measured on VOTING-ELIGIBLE stake, not the raw book ───

test('a queued Mode-F exit that locks the operator out of propose() ALERTS, though the raw book still reads healthy', async () => {
  // Review115 F1's scenario, verbatim. proposalThresholdBps 1000, CREATOR_MIN_STAKE_BPS 500.
  // Raw: creator 2,000 of 10,000 shares = 2000 bps — clear of the 1500 bps WARN bar on both legs.
  // Queue a 1,500-share Mode-F exit: eligible own 500, eligible total 8,500 = 588 bps.
  // Governance.propose reverts BelowProposalThreshold RIGHT NOW (588 < 1000).
  const { crit } = await run({
    [VAULT]: {
      totalShares: 10_000n,
      sharesOf: (a) => (lc(a) === lc(CREATOR) ? 2_000n : 0n),
      votingEligibleShares: (a) => (lc(a) === lc(CREATOR) ? 500n : 0n),
      totalVotingEligibleShares: () => 8_500n,
    },
    [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 1000, 4000, 21600] },
  });
  assert.equal(crit.detail.operatorBps, '2000', 'the raw book is unchanged and looks fine');
  assert.equal(crit.detail.eligibleBps, '588');
  const gov = crit.detail.thresholds.find((t) => t.name === 'proposalThresholdBps');
  assert.equal(gov.measuredBps, '588', 'the Governance leg is measured on the eligible book');
  assert.equal(gov.level, 'alert', 'and it is the leg that fires');
  const exitGate = crit.detail.thresholds.find((t) => t.name === 'creatorMinStakeBps');
  assert.equal(exitGate.measuredBps, '2000', 'the exit gate genuinely uses the raw book — unchanged');
  assert.equal(exitGate.level, 'ok');
  assert.equal(crit.status, 'alert');
  assert.match(crit.message, /OPERATOR POWER CRITICAL/);
  assert.match(crit.message, /voting-eligible share book/);
});

test('a NON-creator queued exit shrinks eligible total, so operator power is reported HIGHER, not lower', async () => {
  // The noise direction: raw 500 bps (would ALERT), eligible 1000 bps once a member's 250e18 is
  // locked. The Governance leg must not raise a false alarm about a gate that is not close.
  const { crit } = await run({
    [VAULT]: {
      sharesOf: (a) => (lc(a) === lc(CREATOR) ? 25_000000000000000000n : 0n),
      votingEligibleShares: (a) => (lc(a) === lc(CREATOR) ? 25_000000000000000000n : 0n),
      totalVotingEligibleShares: () => 250_000000000000000000n,
    },
  });
  const gov = crit.detail.thresholds.find((t) => t.name === 'proposalThresholdBps');
  assert.equal(gov.measuredBps, '1000');
  assert.equal(gov.level, 'ok', '10.00% against a 5.00% propose gate is not close');
  const exitGate = crit.detail.thresholds.find((t) => t.name === 'creatorMinStakeBps');
  assert.equal(exitGate.level, 'alert', 'the raw-book exit gate IS at its bar, and still fires');
});

test('every eligible holder queued out is zero weight, not a division by zero', async () => {
  // propose() reverts NoWeight() before it reaches the threshold comparison.
  const { crit } = await run({
    [VAULT]: { votingEligibleShares: () => 0n, totalVotingEligibleShares: () => 0n },
  });
  assert.equal(crit.detail.eligibleBps, '0');
  const gov = crit.detail.thresholds.find((t) => t.name === 'proposalThresholdBps');
  assert.equal(gov.level, 'alert');
});

test('an unreadable votingEligibleShares is a BROKEN DETECTOR, never a silent fall back to the raw book', async () => {
  const { warn, crit } = await run({ [VAULT]: { totalVotingEligibleShares: () => ({ revert: '0xdead' }) } });
  for (const r of [warn, crit]) {
    assert.equal(r.status, 'skipped');
    assert.equal(r.detail.detectorBroken, true);
    assert.match(r.message, /totalVotingEligibleShares/);
  }
});

// ── WARN / ALERT bars, asserted ON the boundary (Review115 F5) ────────────────

/**
 * The bars are `measuredBps <= alertAt` (1.1x) and `measuredBps <= warnAt` (1.5x). Against the
 * launch 500 bps gate that is 550 and 750 exactly. Review115 mutated `<=` to `<` on both, and moved
 * ALERT_NUM from 11n to 10n — deleting the entire early warning — with all 256 tests still green,
 * because the two cases NAMED for the boundaries sat at 700 and 500 instead of 750 and 550. These
 * six sit on 549/550/551 and 749/750/751. Only the Governance leg is live (nonCreatorMemberCount 0)
 * so each one pins the bar itself rather than a two-leg interaction.
 */
const oneLeg = (bps) => holding(sharesForBps(bps), { nonCreatorMemberCount: () => 0n });

test('550 bps against a 500 bps gate is exactly the 1.1x ALERT bar, and ALERTS', async () => {
  const { warn, crit } = await run(oneLeg(550));
  assert.equal(crit.detail.thresholds[0].alertAtBps, '550');
  assert.equal(crit.detail.thresholds[0].measuredBps, '550');
  assert.equal(crit.status, 'alert', '`<= alertAt` includes the bar itself');
  assert.equal(crit.detail.level, 'alert');
  assert.equal(warn.status, 'alert', 'the early-warning bar is breached too, necessarily');
});

test('551 bps is one bps outside the ALERT bar — WARN, not CRITICAL', async () => {
  const { warn, crit } = await run(oneLeg(551));
  assert.equal(crit.status, 'ok', 'the critical bar is NOT breached at 551');
  assert.equal(warn.status, 'alert');
  assert.equal(warn.detail.level, 'warn');
  assert.match(warn.message, /OPERATOR POWER WARNING/);
});

test('549 bps is inside the ALERT bar', async () => {
  const { crit } = await run(oneLeg(549));
  assert.equal(crit.status, 'alert');
  assert.equal(crit.detail.level, 'alert');
});

test('750 bps against a 500 bps gate is exactly the 1.5x WARN bar, and WARNS', async () => {
  const { warn, crit } = await run(oneLeg(750));
  assert.equal(warn.detail.thresholds[0].warnAtBps, '750');
  assert.equal(warn.detail.thresholds[0].measuredBps, '750');
  assert.equal(warn.status, 'alert', '`<= warnAt` includes the bar itself');
  assert.equal(warn.detail.level, 'warn');
  assert.equal(crit.status, 'ok');
});

test('751 bps against a 500 bps threshold is still OK — one bps outside the WARN bar', async () => {
  const { warn, crit } = await run(oneLeg(751));
  assert.equal(warn.status, 'ok');
  assert.equal(crit.status, 'ok');
});

test('749 bps is inside the WARN bar', async () => {
  const { warn } = await run(oneLeg(749));
  assert.equal(warn.status, 'alert');
  assert.equal(warn.detail.level, 'warn');
});

test('ALERT fires at exactly 1.1x the threshold, and the headroom is already exhausted at the crossing', async () => {
  // 500 bps IS the threshold itself: alertAt = 550, so 500 <= 550 triggers ALERT (CRITICAL).
  const { crit } = await run(holding(25_000000000000000000n));
  assert.equal(crit.status, 'alert');
  assert.equal(crit.detail.level, 'alert');
  assert.match(crit.message, /OPERATOR POWER CRITICAL/);
  const worst = crit.detail.thresholds.find((t) => t.level === 'alert');
  assert.equal(worst.depositHeadroomUsdc, '0', 'already at the threshold — there is no headroom left to cross');
  assert.match(crit.message, /already at or past .* — no deposit headroom remains/);
});

// ── the exact headroom estimate ───────────────────────────────────────────────

test('depositHeadroomUsdc matches VaultCore._mintShares solved for the crossing point, exactly', async () => {
  // opShares 100e18 / totalShares 1000e18 = 1000 bps. Governance threshold 800 bps: warnAt 1200,
  // alertAt 880 -> 1000 <= 1200 is WARN. sharesAtThreshold = 100e18*10000/800 = 1250e18, needing
  // 250e18 further minted shares. navWad 7e18, usdcScalar 1e12 (unchanged fixture defaults) ->
  // headroom = 250e18 * 7e18 / (1e12 * 1000e18) = 1,750,000 native USDC units ($1.75).
  const { warn } = await run({
    [VAULT]: {
      totalShares: 1_000_000000000000000000n,
      sharesOf: (a) => (lc(a) === lc(CREATOR) ? 100_000000000000000000n : 0n),
      votingEligibleShares: (a) => (lc(a) === lc(CREATOR) ? 100_000000000000000000n : 0n),
      totalVotingEligibleShares: () => 1_000_000000000000000000n,
    },
    [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 800, 4000, 21600] },
  });
  assert.equal(warn.status, 'alert');
  assert.equal(warn.detail.level, 'warn');
  const gov = warn.detail.thresholds.find((t) => t.name === 'proposalThresholdBps');
  assert.equal(gov.bps, '800');
  assert.equal(gov.depositHeadroomUsdc, '1750000');
  assert.match(warn.message, /estimated 1750000 USDC/);
});

test('the headroom estimate is EXACT, not conservative-in-the-wrong-direction: applying it lands on the gate', async () => {
  // Review115 F4: the docstring used to admit an error that does not exist ("a large single deposit
  // crosses sooner"). _mintShares does navWad += amountWad and totalShares += amountWad*ts/navWad,
  // which preserves NAV-per-share exactly — so one deposit of the estimate and a thousand deposits
  // summing to it land in the same place, on the gate and not past it. Simulated here against the
  // signal's own reported number.
  const overrides = {
    [VAULT]: {
      totalShares: 1_000_000000000000000000n,
      sharesOf: (a) => (lc(a) === lc(CREATOR) ? 100_000000000000000000n : 0n),
      votingEligibleShares: (a) => (lc(a) === lc(CREATOR) ? 100_000000000000000000n : 0n),
      totalVotingEligibleShares: () => 1_000_000000000000000000n,
    },
    [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 800, 4000, 21600] },
  };
  const { warn } = await run(overrides);
  const estimate = BigInt(warn.detail.thresholds.find((t) => t.name === 'proposalThresholdBps').depositHeadroomUsdc);

  /** VaultCore._mintShares, exactly: minted = amountWad * totalShares / navWad, then both grow. */
  const mint = (state, amountUsdc) => {
    const amountWad = amountUsdc * 1_000000000000n; // usdcScalar
    const minted = (amountWad * state.totalShares) / state.navWad;
    return { navWad: state.navWad + amountWad, totalShares: state.totalShares + minted };
  };
  const start = { navWad: 7_000000000000000000n, totalShares: 1_000_000000000000000000n };
  const own = 100_000000000000000000n;

  const single = mint(start, estimate);
  assert.equal((own * 10000n) / single.totalShares, 800n, 'one deposit of the estimate lands ON 800 bps');

  let many = start;
  for (let i = 0; i < 1000; i += 1) many = mint(many, estimate / 1000n);
  assert.equal((own * 10000n) / many.totalShares, 800n, 'and so do a thousand small ones');
  assert.equal((many.navWad * 1_000000000000000000n) / many.totalShares,
    (start.navWad * 1_000000000000000000n) / start.totalShares, 'NAV-per-share is preserved exactly');
});

// ── both gates monitored, and named as differing ──────────────────────────────

test('a vault whose proposalThresholdBps differs from CREATOR_MIN_STAKE_BPS monitors and names BOTH', async () => {
  // 1000 bps operator stake; Governance threshold 1000 -> alertAt 1100 -> 1000 <= 1100 is ALERT.
  // VaultCore's creatorMinStakeBps stays 500 -> warnAt 750 -> 1000 > 750 is OK on that leg alone.
  const { crit } = await run({
    ...holding(50_000000000000000000n),
    [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 1000, 4000, 21600] },
  });
  assert.equal(crit.status, 'alert');
  assert.equal(crit.detail.level, 'alert');
  assert.equal(crit.detail.thresholdsDiffer, true);
  assert.deepEqual(crit.detail.thresholds.map((t) => `${t.name}:${t.bps}:${t.level}`).sort(), [
    'creatorMinStakeBps:500:ok', 'proposalThresholdBps:1000:alert',
  ]);
  assert.match(crit.message, /proposalThresholdBps and VaultCore's CREATOR_MIN_STAKE_BPS differ .* both gates are monitored/);
});

// ── F12: which of two same-level legs the line is about ──────────────────────

test('with both legs at ALERT the line reports the TIGHTEST margin, not whichever leg is listed first', async () => {
  // Review115 F12. proposalThresholdBps 300, CREATOR_MIN_STAKE_BPS 500, operator at 320 bps.
  // Both legs alert. The gov leg has 466,666 USDC of dilution headroom; the exit gate has none and
  // the operator's capital is ALREADY frozen (for s/T < 5% every burn amount fails _checkCreatorGate).
  // Array order lists Governance first, so the old code reported 47 cents of margin against the
  // wrong gate and never mentioned the frozen one.
  const { crit } = await run({
    ...holding(16_000000000000000000n), // 320 bps of 500e18
    [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 300, 4000, 21600] },
  });
  const byName = Object.fromEntries(crit.detail.thresholds.map((t) => [t.name, t]));
  assert.equal(byName.proposalThresholdBps.level, 'alert');
  assert.equal(byName.creatorMinStakeBps.level, 'alert', 'both legs are at the worst level');
  assert.equal(byName.proposalThresholdBps.marginBps, '20', 'gov leg: 20 bps of margin');
  assert.equal(byName.creatorMinStakeBps.marginBps, '-180', 'exit gate: already 180 bps BELOW it');
  assert.match(crit.message, /CREATOR_MIN_STAKE_BPS exit gate threshold 5\.00% \(margin -1\.80%\)/,
    'the tighter (negative) margin decides the line');
  assert.doesNotMatch(crit.message, /466666/, 'and the wrong gate\'s headroom never appears');
});

test('a negative margin keeps its sign below one percent', async () => {
  // bpsToPct truncated toward zero, so -50 bps rendered as "0.50%" — a lost minus sign on exactly
  // the numbers that say the gate is already gone. Only operator-power renders a negative bps.
  const { crit } = await run({
    ...holding(sharesForBps(470), { nonCreatorMemberCount: () => 0n }), // 470 vs a 500 bps gate
  });
  assert.equal(crit.detail.thresholds[0].marginBps, '-30');
  assert.match(crit.message, /margin -0\.30%/);
});

// ── the capacity-cap trap: no top-up path (Review115 F2) ─────────────────────

test('an ALERT at capacityCapUsdc says "no top-up path — decision needed now", literally', async () => {
  // The vault pinned at its own committed NAV (navUsdc 7,000,000 + totalPendingUsdc 0) as
  // capacityCapUsdc — no further deposit, by the operator or anyone else, can land.
  const { crit } = await run(holding(25_000000000000000000n, { capacityCapUsdc: () => 7_000000n }));
  assert.equal(crit.status, 'alert');
  assert.equal(crit.detail.atCapacity, true);
  assert.equal(crit.detail.noTopUpPath, true);
  assert.match(crit.message, /no top-up path — decision needed now/);
});

test('an ALERT with capacity headroom remaining does NOT claim there is no top-up path', async () => {
  const { crit } = await run(holding(25_000000000000000000n, { capacityCapUsdc: () => 100_000000n }));
  assert.equal(crit.status, 'alert');
  assert.equal(crit.detail.atCapacity, false);
  assert.equal(crit.detail.noTopUpPath, false);
  assert.ok(!crit.message.includes('no top-up path'));
});

test('less cap headroom than ONE minimum deposit is a lockout, though committed < cap', async () => {
  // Review115 F2a. Committed 7,000,000; cap 7,000,050 leaves 50 units of headroom against a
  // minDepositUsdc of 1,000,000 — _deposit reverts BelowMinDeposit before it ever reaches the cap
  // check (VaultCore.sol:369), so no deposit at all can land. `atCapacity` is false.
  const { crit } = await run(holding(25_000000000000000000n, {
    capacityCapUsdc: () => 7_000050n,
    minDepositUsdc: () => 1_000000n,
  }));
  assert.equal(crit.detail.atCapacity, false, 'the vault is NOT full');
  assert.equal(crit.detail.capacityHeadroomUsdc, '50');
  assert.equal(crit.detail.noTopUpPath, true, 'and yet nothing can be deposited');
  assert.match(crit.message, /no top-up path — decision needed now/);
});

test('the point of no return is the Finance note\'s E > 0.95C, not committed >= C', async () => {
  // Business/Finance/Operator Capital Requirement.md, "The cap race", to the unit. Scaled to the
  // fixture's navWad 7e18 / usdcScalar 1e12: committed 7,000,000 units stands for the note's 49,600,
  // so 1 note-dollar = 141.129... units. Rather than rescale the prose, reproduce the ARITHMETIC:
  // operator 400 bps of a 7,000,000-unit vault against a 500 bps gate, with 400/49,600 of the
  // vault's worth of cap headroom (56,451 units). Restoring 5% needs
  //   m >= ceil((500*T - s*10000) / (10000-500)) shares, i.e. 71,323 USDC units here — more than
  // the 56,451 available. Locked out, with committed (7,000,000) < cap (7,056,451).
  // minDepositUsdc is dropped to 1,000 units so the DEFICIT is the binding term and not the floor —
  // the floor's own lockout case is the test above this one.
  const { crit } = await run(holding(sharesForBps(400), {
    capacityCapUsdc: () => 7_056451n, minDepositUsdc: () => 1_000n,
  }));
  assert.equal(crit.detail.atCapacity, false);
  assert.equal(crit.detail.capacityHeadroomUsdc, '56451');
  const exitGate = crit.detail.thresholds.find((t) => t.name === 'creatorMinStakeBps');
  assert.equal(exitGate.topUpDeficitUsdc, '73685', 'the deposit that would restore 5.00%');
  assert.equal(exitGate.noTopUpPath, true);
  assert.equal(crit.detail.noTopUpPath, true);
  assert.match(crit.message, /no top-up path — decision needed now/);
  assert.match(crit.message, /the cap is not reached yet, but the top-up must LEAD the fill/);
});

test('the same vault with enough headroom for the deficit still HAS a top-up path', async () => {
  // One unit more headroom than the 73,685 the restore needs. This is the pair that proves the
  // determination is the deficit-vs-headroom comparison and not a coincidence of the fixture.
  const { crit } = await run(holding(sharesForBps(400), {
    capacityCapUsdc: () => 7_073686n, minDepositUsdc: () => 1_000n,
  }));
  assert.equal(crit.detail.capacityHeadroomUsdc, '73686');
  assert.equal(crit.detail.noTopUpPath, false);
  assert.ok(!crit.message.includes('no top-up path'));
});

test('an uncapped vault always has a top-up path', async () => {
  const { crit } = await run(holding(25_000000000000000000n)); // capacityCapUsdc 0 by default
  assert.equal(crit.detail.capacityHeadroomUsdc, null);
  assert.equal(crit.detail.noTopUpPath, false);
});

// ── graceful degradation of the optional legs ─────────────────────────────────

test('an unregistered vault drops the Governance leg — propose() reverts NotRegistered regardless of stake', async () => {
  const { crit } = await run({ [GOVERNANCE]: { vaultRegistered: () => false } });
  assert.equal(crit.status, 'ok');
  assert.equal(crit.detail.thresholds.length, 1);
  assert.equal(crit.detail.thresholds[0].name, 'creatorMinStakeBps');
  assert.match(crit.detail.govLegNote, /not registered/);
});

test('a proposalThresholdBps of 0 (M-6: no floor) drops the Governance leg, not the whole signal', async () => {
  const { crit } = await run({ [GOVERNANCE]: { configOf: () => [3600, 3600, 86400, 86400, 2500, 0, 4000, 21600] } });
  assert.equal(crit.status, 'ok');
  assert.equal(crit.detail.thresholds.length, 1);
  assert.equal(crit.detail.thresholds[0].name, 'creatorMinStakeBps');
  assert.match(crit.detail.govLegNote, /no floor, by design/);
});

test('no non-creator member yet drops the VaultCore exit-gate leg — it only binds once one exists', async () => {
  const { crit } = await run({ [VAULT]: { nonCreatorMemberCount: () => 0n } });
  assert.equal(crit.status, 'ok');
  assert.equal(crit.detail.thresholds.length, 1);
  assert.equal(crit.detail.thresholds[0].name, 'proposalThresholdBps');
});

test('neither gate is live: reported skipped under BOTH keys, not a false OK', async () => {
  const { warn, crit } = await run({
    [VAULT]: { nonCreatorMemberCount: () => 0n },
    [GOVERNANCE]: { vaultRegistered: () => false },
  });
  for (const r of [warn, crit]) {
    assert.equal(r.status, 'skipped');
    assert.match(r.message, /no binding threshold is active/);
  }
});

test('totalShares 0 is skipped under BOTH keys, not a division by zero', async () => {
  const { warn, crit } = await run({ [VAULT]: { totalShares: 0n } });
  for (const r of [warn, crit]) {
    assert.equal(r.status, 'skipped');
    assert.match(r.message, /totalShares is 0/);
  }
});

// ── NAV unavailable degrades the headroom estimate only, never the verdict ────

test('navWad reverting (the oracle breaker) degrades the headroom estimate but not the WARN/ALERT verdict', async () => {
  const { crit } = await run(holding(25_000000000000000000n, { navWad: { revert: '0xa2671f4b' } }));
  assert.equal(crit.status, 'alert', 'dilution is exactly as visible during a freeze as any other time');
  assert.equal(crit.detail.navAvailable, false);
  assert.match(crit.message, /NAV is currently unreadable \(see oracle-freshness\)/);
});

test('a tripped breaker says the TOP-UP-PATH determination was skipped too, not just the headroom', async () => {
  // Review115 F2c: `atCapacity` required navAvailable, so a freeze made it false and the message
  // admitted only that the headroom number was missing. "No claim either way" is the honest form.
  const { crit } = await run(holding(25_000000000000000000n, {
    navWad: { revert: '0xa2671f4b' },
    capacityCapUsdc: () => 7_000000n,
  }));
  assert.equal(crit.detail.capacityAssessed, false);
  assert.equal(crit.detail.noTopUpPath, false, 'unknown, and the flag says nothing');
  assert.match(crit.message, /neither the deposit headroom estimate nor the top-up-path determination could be computed/);
  assert.match(crit.message, /no claim is made either way/);
});

// ── detector-broken: the required reads, not the optional ones ───────────────

test('sharesOf unreadable is a BROKEN DETECTOR — the share fraction cannot be computed at all', async () => {
  const { warn, crit } = await run({ [VAULT]: { sharesOf: () => ({ revert: '0xdead' }) } });
  for (const r of [warn, crit]) {
    assert.equal(r.status, 'skipped');
    assert.equal(r.detail.detectorBroken, true);
    assert.match(r.message, /OPERATOR POWER DETECTOR BLIND/);
    assert.match(r.message, /sharesOf/);
  }
});

test('an unreadable minDepositUsdc degrades the capacity leg, it does not blind the signal', async () => {
  const { crit } = await run(holding(25_000000000000000000n, { minDepositUsdc: () => ({ revert: '0xdead' }) }));
  assert.equal(crit.status, 'alert');
  assert.equal(crit.detail.capacityAssessed, false);
});

// ── copy discipline: no outcome/yield language, dilution named as by-design ──

test('the ALERT message names dilution as by-design, not a bug, and never claims the operator risks nothing', async () => {
  const { crit } = await run(holding(25_000000000000000000n));
  assert.match(crit.message, /by design/);
  assert.doesNotMatch(crit.message, /zero capital cost/i);
  assert.doesNotMatch(crit.message, /\bguarantee/i);
  assert.doesNotMatch(crit.message, /\bsafe\b/i);
});

// ── the two bars exist so the CRITICAL page is actually delivered ────────────

test('WARN then CRITICAL: the critical bar makes its own transition, and it PAGES', async () => {
  // The whole reason this signal emits two results. `transitions.mjs` tracks state by STATUS alone,
  // so with one result per sweep the deterioration below is alert -> alert and emits NOTHING: the
  // "decision needed now" line would never be delivered on the ordinary monotone-dilution path.
  // Proven by DISPATCH — the real tracker into the real tiered sink, asserting which endpoint
  // physically received the POST — not by asserting membership of a set.
  const tracker = createTransitionTracker();
  const hits = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://page.invalid/hook',
    logUrl: 'https://log.invalid/hook',
    fetchImpl: async (url, init) => {
      const b = JSON.parse(init.body);
      hits.push({ endpoint: url.includes('page.invalid') ? 'PAGE' : 'LOG', key: b.key, status: b.status, tier: b.tier });
      return { ok: true, status: 200 };
    },
  });
  const sweep = async (bps, poll) => {
    const results = await checkOperatorPower({
      reader: mockReader({ contracts: healthyVault(oneLeg(bps)), nowSec: 1_700_000_000 }),
      vault: VAULT, operator: CREATOR,
    });
    for (const t of tracker.observe(results, { poll })) await sink.emit(t);
  };

  await sweep(900, 1);  // healthy: no transition at all
  assert.deepEqual(hits, [], 'a healthy first sighting announces nothing');

  await sweep(700, 2);  // crosses the 1.5x bar
  assert.deepEqual(hits.map((h) => `${h.key}:${h.status}:${h.endpoint}`), ['early-warning:alert:LOG'],
    'the early warning is delivered, and to the LOG endpoint — it is not worth waking anyone');

  await sweep(500, 3);  // crosses the 1.1x bar
  assert.deepEqual(hits.map((h) => `${h.key}:${h.status}:${h.endpoint}`), [
    'early-warning:alert:LOG',
    'critical:alert:PAGE',
  ], 'the critical bar transitions on its own key and PAGES');

  await sweep(500, 4);  // standing alert: structurally bounded at one page per crossing
  assert.equal(hits.filter((h) => h.endpoint === 'PAGE').length, 1, 'a standing alert never re-pages');

  await sweep(900, 5);  // full recovery
  const recoveries = hits.filter((h) => h.status === 'ok');
  assert.equal(recoveries.length, 2, 'both bars recover');
  assert.ok(recoveries.every((h) => h.endpoint === 'LOG'), 'recoveries must never page');
});

test('a DETECTOR BLIND sweep routes to LOG, not to the pager', async () => {
  const tracker = createTransitionTracker();
  const hits = [];
  const sink = createTieredWebhookSink({
    pageUrl: 'https://page.invalid/hook',
    logUrl: 'https://log.invalid/hook',
    fetchImpl: async (url, init) => {
      hits.push({ endpoint: url.includes('page.invalid') ? 'PAGE' : 'LOG', status: JSON.parse(init.body).status });
      return { ok: true, status: 200 };
    },
  });
  const results = await checkOperatorPower({
    reader: mockReader({ contracts: healthyVault({ [VAULT]: { sharesOf: () => ({ revert: '0xdead' }) } }), nowSec: 1_700_000_000 }),
    vault: VAULT, operator: CREATOR,
  });
  for (const t of tracker.observe(results, { poll: 1 })) await sink.emit(t);
  assert.equal(hits.length, 2, 'both keys report blind');
  assert.ok(hits.every((h) => h.endpoint === 'LOG' && h.status === 'skipped'),
    'a blind detector is not an incident — it escalates on the backoff, it does not page');
});

test('EVERY emitted result carries detail.bar matching its key — the predicate reads that field', async () => {
  // #121's coverage invariant proves the signal NAME is classified. Nothing in it proves that every
  // `alert()` inside a signal sets the field its CONDITIONAL_PAGE predicate reads — that is this
  // signal's own obligation, so it is asserted here across every branch that can emit.
  const branches = {
    healthy: {},
    warn: oneLeg(700),
    critical: oneLeg(500),
    'no binding threshold': { [VAULT]: { nonCreatorMemberCount: () => 0n }, [GOVERNANCE]: { vaultRegistered: () => false } },
    'totalShares 0': { [VAULT]: { totalShares: 0n } },
    'detector blind': { [VAULT]: { sharesOf: () => ({ revert: '0xdead' }) } },
    'nav unreadable': holding(25_000000000000000000n, { navWad: { revert: '0xa2671f4b' } }),
    'gov unreadable': { [VAULT]: { governance: () => `0x${'0'.repeat(40)}` } },
  };
  for (const [name, overrides] of Object.entries(branches)) {
    const { all } = await run(overrides);
    assert.equal(all.length, 2, `${name}: both keys`);
    for (const r of all) {
      assert.equal(r.detail.bar, r.key, `${name}: detail.bar must equal the transition key`);
      assert.ok([EARLY_WARNING_KEY, CRITICAL_KEY].includes(r.detail.bar), `${name}: a known bar`);
    }
  }
});
