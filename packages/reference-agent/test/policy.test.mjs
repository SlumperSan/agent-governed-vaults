// @ts-check
/**
 * Policy decisions over fixture states. Every function under test is pure, so each case states a
 * world and asserts a verdict — no clock, no network, no ordering effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { asBigInt, decideEntry, decideExit, decideJoin, decideSettle, decideVote, votePhase } from '../src/policy.mjs';

const USDC = 10n ** 6n;
const WAD = 10n ** 18n;
const CFG = loadConfig();
const VAULT = '0x1111111111111111111111111111111111111111';

const goodVault = () => ({ vault: VAULT, operatorId: 1, memberCount: 5, depth: 0, parent: null, attested: true });
const goodChain = (over = {}) => ({
  vault: VAULT,
  navPerShareWad: WAD,
  navReadable: true,
  navError: null,
  navConsecutiveFailures: 0,
  totalAssetsUsdc: 100_000n * USDC,
  totalPendingUsdc: 0n,
  idleUsdc: 2_000n * USDC,
  capacityCapUsdc: 500_000n * USDC,
  isCapped: true,
  minDepositUsdc: 10n * USDC,
  self: {},
  ...over,
});
const goodOp = (over = {}) => ({
  operatorId: 1,
  operator: '0x' + 'a'.repeat(40),
  netRealizedUsdc: (36_000n * USDC).toString(),
  lifetimeGainUsdc: (42_000n * USDC).toString(),
  lifetimeLossUsdc: (6_000n * USDC).toString(),
  ...over,
});
const goodFees = (over = {}) => ({ stackedPerfFeeBps: 1000, stackedExitFeeCapBps: 100, depth: 0, ...over });

const join = (over = {}) =>
  decideJoin({
    vault: goodVault(),
    chain: goodChain(),
    operatorRow: goodOp(),
    fees: goodFees(),
    heldVaultCount: 0,
    config: CFG.policy.join,
    ...over,
  });

const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

// ── join ────────────────────────────────────────────────────────────────────

test('join: a clean vault passes every gate', () => {
  const r = join();
  assert.equal(r.join, true, `unexpectedly blocked on ${failed(r).join(', ')}`);
  assert.equal(r.depositUsdc, 25n * USDC);
});

test('join: an UNATTESTED vault is refused (operatorId 0 is the scam-quarantine signal)', () => {
  const r = join({ vault: { ...goodVault(), operatorId: 0 }, operatorRow: null });
  assert.equal(r.join, false);
  assert.ok(failed(r).includes('operator-attested'));
});

test('join: the REGISTRY overrides the API, and a disagreement is itself disqualifying', () => {
  // A spoofed vault can claim any branding; operator identity is the registry key.
  const r = join({ registryOperatorId: 7 }); // API says 1
  assert.equal(r.join, false);
  const c = r.checks.find((x) => x.name === 'operator-attested');
  assert.match(c.detail, /registry says operatorId=7 but the API says 1/);
});

test('join: a registry-confirmed operator id passes', () => {
  assert.equal(join({ registryOperatorId: 1 }).join, true);
});

test('join: a NEGATIVE operator net is refused', () => {
  const r = join({
    operatorRow: goodOp({ netRealizedUsdc: (-15_500n * USDC).toString(), lifetimeGainUsdc: (4_000n * USDC).toString(), lifetimeLossUsdc: (19_500n * USDC).toString() }),
  });
  assert.equal(r.join, false);
  assert.ok(failed(r).includes('operator-net-positive'));
});

test('join: net realized is compared as a BigInt, not a Number or a string', () => {
  // A string compare would rank "-1" above "0"; a Number would lose precision up here.
  const huge = 10n ** 30n;
  assert.equal(asBigInt(huge.toString()), huge);
  assert.equal(join({ operatorRow: goodOp({ netRealizedUsdc: (-1n).toString() }) }).join, false);
  assert.equal(asBigInt('not a number'), null);
  assert.equal(asBigInt(null), null);
});

test('join: an operator with NO realizations is refused — "not yet negative" is not a record', () => {
  const r = join({ operatorRow: goodOp({ netRealizedUsdc: '0', lifetimeGainUsdc: '0', lifetimeLossUsdc: '0' }) });
  assert.equal(r.join, false);
  assert.match(r.checks.find((c) => c.name === 'operator-net-positive').detail, /no realizations/);
});

test('join: an UNCAPPED vault (capacityCapUsdc == 0) has capacity, it is not full', () => {
  // The bug this pins: a naive `deposit <= cap` refuses every uncapped vault.
  const r = join({ chain: goodChain({ capacityCapUsdc: 0n, isCapped: false }) });
  const c = r.checks.find((x) => x.name === 'capacity-available');
  assert.equal(c.ok, true);
  assert.match(c.detail, /uncapped/);
});

test('join: a FULL capped vault is refused, counting escrowed pending against the cap', () => {
  const r = join({ chain: goodChain({ capacityCapUsdc: 100_000n * USDC, totalAssetsUsdc: 99_990n * USDC, totalPendingUsdc: 10n * USDC }) });
  assert.equal(r.join, false);
  assert.ok(failed(r).includes('capacity-available'));
});

test('join: STACKED fees above the ceiling are refused', () => {
  assert.equal(join({ fees: goodFees({ stackedPerfFeeBps: 1900 }) }).join, false, 'stacked perf fee');
  assert.equal(join({ fees: goodFees({ stackedExitFeeCapBps: 150 }) }).join, false, 'stacked exit fee');
});

test('join: unreadable fees fail CLOSED — never join blind to what you will pay', () => {
  const r = join({ fees: { stackedPerfFeeBps: null, stackedExitFeeCapBps: null, depth: 0 }, chain: goodChain({ self: {} }) });
  assert.equal(r.join, false);
  assert.ok(failed(r).includes('fees-in-bounds'));
});

test('join: an unreadable NAV fails closed — a stale oracle freezes exits too', () => {
  const r = join({ chain: goodChain({ navReadable: false, navPerShareWad: null, navError: 'StaleOracle()' }) });
  assert.equal(r.join, false);
  assert.ok(failed(r).includes('nav-readable'));
});

test('join: sub-vault depth beyond the configured ceiling is refused', () => {
  assert.equal(join({ fees: goodFees({ depth: 1 }) }).join, false);
});

test('join: the concurrency limit stops the agent holding everything at once', () => {
  assert.equal(join({ heldVaultCount: 3 }).join, false);
  assert.equal(join({ heldVaultCount: 2 }).join, true);
});

test('join: a deposit below the vault minimum is refused', () => {
  assert.equal(join({ chain: goodChain({ minDepositUsdc: 1_000n * USDC }) }).join, false);
});

// ── exit ────────────────────────────────────────────────────────────────────

const exit = (over = {}) =>
  decideExit({ chain: goodChain(), entryNavPerShareWad: WAD, operatorRow: goodOp(), governance: { hasPendingExecution: false }, config: CFG.policy.exit, ...over });

test('exit: a healthy position stays put', () => {
  const r = exit();
  assert.equal(r.exit, false);
  assert.equal(r.modeF, false);
});

test('exit: drawdown past the threshold triggers', () => {
  const r = exit({ chain: goodChain({ navPerShareWad: (WAD * 85n) / 100n }) }); // -1500bps
  assert.equal(r.exit, true);
  assert.ok(r.triggers.find((t) => t.name === 'drawdown').ok);
});

test('exit: drawdown just inside the threshold does NOT trigger', () => {
  const r = exit({ chain: goodChain({ navPerShareWad: (WAD * 9001n) / 10000n }) }); // -999bps
  assert.equal(r.triggers.find((t) => t.name === 'drawdown').ok, false);
  assert.equal(r.exit, false);
});

test('exit: gains never trigger a drawdown exit', () => {
  assert.equal(exit({ chain: goodChain({ navPerShareWad: WAD * 2n }) }).exit, false);
});

test('exit: no entry mark means drawdown is not computable, not "fine"', () => {
  const r = exit({ entryNavPerShareWad: null });
  const t = r.triggers.find((x) => x.name === 'drawdown');
  assert.equal(t.ok, false);
  assert.match(t.detail, /not computable/);
});

test('exit: an unreadable NAV trips the oracle-freeze trigger', () => {
  const r = exit({ chain: goodChain({ navReadable: false, navPerShareWad: null, navError: 'StaleOracle()', navConsecutiveFailures: 3 }) });
  assert.equal(r.exit, true);
  const t = r.triggers.find((x) => x.name === 'oracle-freeze');
  assert.ok(t.ok);
  assert.match(t.detail, /a frozen oracle freezes exits too/);
});

test('exit: an operator whose net has gone negative triggers', () => {
  const r = exit({ operatorRow: goodOp({ netRealizedUsdc: (-1n).toString() }) });
  assert.equal(r.exit, true);
  assert.ok(r.triggers.find((t) => t.name === 'operator-net-negative').ok);
});

test('exit: triggers are OR-ed — any one is sufficient', () => {
  const r = exit({ chain: goodChain({ navPerShareWad: (WAD * 50n) / 100n }), operatorRow: goodOp({ netRealizedUsdc: '-1' }) });
  assert.equal(r.exit, true);
  assert.equal(r.triggers.filter((t) => t.ok).length, 2);
});

test('exit: a pending execution marks the exit MODE F (forward-priced)', () => {
  const r = exit({ chain: goodChain({ navPerShareWad: (WAD * 50n) / 100n }), governance: { hasPendingExecution: true } });
  assert.equal(r.exit, true);
  assert.equal(r.modeF, true, 'exiting into a pending rebalance settles at POST-rebalance NAV');
});

test('exit: disabling a trigger in config actually disables it', () => {
  const cfg = { ...CFG.policy.exit, onOperatorNetNegative: false, onOracleFreezeWarning: false };
  const r = exit({ operatorRow: goodOp({ netRealizedUsdc: '-1' }), config: cfg });
  assert.equal(r.exit, false);
  assert.equal(r.triggers.length, 1, 'only the drawdown trigger should remain');
});

// ── entry lifecycle ─────────────────────────────────────────────────────────

const pendingChain = (availableAt) => goodChain({ self: { pendingAmount: 25n * USDC, pendingAvailableAt: availableAt } });

test('entry: a pending deposit inside the window WAITS and schedules the activate', () => {
  const r = decideEntry({ chain: pendingChain(2000), nowSec: 1000, timing: CFG.policy.timing, danger: CFG.danger });
  assert.equal(r.action, 'wait');
  assert.equal(r.dueAtSec, 2000 + CFG.policy.timing.activateGraceSec, 'scheduled from the REAL availableAt, not a guessed now+4h');
});

test('entry: past the window (plus grace) it activates', () => {
  assert.equal(decideEntry({ chain: pendingChain(2000), nowSec: 2061, timing: CFG.policy.timing, danger: CFG.danger }).action, 'activate');
});

test('entry: inside the grace period it still waits', () => {
  assert.equal(decideEntry({ chain: pendingChain(2000), nowSec: 2030, timing: CFG.policy.timing, danger: CFG.danger }).action, 'wait');
});

test('entry: the DEFAULT config can never produce a skipWindow decision', () => {
  // The irreversible action. Pinned across the whole window, not just one instant.
  for (const now of [0, 1, 999, 1999, 2000]) {
    const r = decideEntry({ chain: pendingChain(2000), nowSec: now, timing: CFG.policy.timing, danger: CFG.danger });
    assert.notEqual(r.action, 'skip-window', `skipWindow leaked at nowSec=${now}`);
  }
});

test('entry: skipWindow appears ONLY behind the explicit danger flag', () => {
  const r = decideEntry({ chain: pendingChain(9999), nowSec: 1000, timing: CFG.policy.timing, danger: { allowSkipWindow: true } });
  assert.equal(r.action, 'skip-window');
  assert.match(r.reason, /IRREVERSIBLE/);
});

test('entry: no pending deposit means nothing to do', () => {
  assert.equal(decideEntry({ chain: goodChain(), nowSec: 1000, timing: CFG.policy.timing, danger: CFG.danger }).action, 'none');
});

// ── Mode F settlement ───────────────────────────────────────────────────────

test('settle: queued shares settle once the rebalance has executed', () => {
  const chain = goodChain({ self: { queuedExitShares: 500n * USDC } });
  assert.equal(decideSettle({ chain, governance: { hasPendingExecution: false } }).action, 'settle-queued-exit');
});

test('settle: queued shares wait while the rebalance is still pending', () => {
  const chain = goodChain({ self: { queuedExitShares: 500n * USDC } });
  assert.equal(decideSettle({ chain, governance: { hasPendingExecution: true } }).action, 'none');
});

test('settle: nothing queued, nothing to do', () => {
  assert.equal(decideSettle({ chain: goodChain(), governance: {} }).action, 'none');
});

// ── voting ──────────────────────────────────────────────────────────────────

const proposal = (over = {}) => ({
  pid: 42n, vault: VAULT, ptype: 0, ptypeName: 'Rebalance', proposer: '0x' + 'a'.repeat(40),
  createdAt: 0, commitDeadline: 1000, revealDeadline: 2000, executableAt: 3000, expiresAt: 9000,
  status: 1, statusName: 'Active', actionHash: '0x' + 'ab'.repeat(32),
  snapshotTotal: 100n * USDC, memberCount: 9, forWeight: 0n, againstWeight: 0n, revealedWeight: 0n, revealedVoterCount: 0n,
  ...over,
});
const vote = (over = {}) =>
  decideVote({
    governance: { proposal: proposal(), hasOutstandingCommit: false, revealed: false },
    chain: goodChain(),
    votingWeight: 100n * USDC,
    nowSec: 500,
    config: CFG.policy.vote,
    timing: CFG.policy.timing,
    ...over,
  });

test('votePhase maps the commit-reveal lifecycle', () => {
  const p = proposal();
  assert.equal(votePhase(p, 999), 'commit');
  assert.equal(votePhase(p, 1000), 'reveal');
  assert.equal(votePhase(p, 1999), 'reveal');
  assert.equal(votePhase(p, 2000), 'closed');
  assert.equal(votePhase(null, 0), 'none');
});

test('vote: drift above the band commits FOR', () => {
  // idle 30_000 of 100_000 = 3000bps, above the 500bps band and below the 5000bps max.
  const r = vote({ chain: goodChain({ idleUsdc: 30_000n * USDC }) });
  assert.equal(r.action, 'commit');
  assert.equal(r.support, true);
});

test('vote: drift inside the band commits AGAINST — rebalancing is churn and fees', () => {
  const r = vote({ chain: goodChain({ idleUsdc: 100n * USDC }) }); // 10bps
  assert.equal(r.action, 'commit');
  assert.equal(r.support, false);
});

test('vote: drift beyond the max band commits AGAINST — that is a mandate change', () => {
  const r = vote({ chain: goodChain({ idleUsdc: 90_000n * USDC }) }); // 9000bps
  assert.equal(r.action, 'commit');
  assert.equal(r.support, false);
  assert.match(r.reason, /mandate change/);
});

test('vote: no drift signal ⇒ ABSTAIN by not committing (an uninformed vote moves the tally)', () => {
  const r = vote({ chain: goodChain({ totalAssetsUsdc: null, idleUsdc: null }) });
  assert.equal(r.action, 'none');
  assert.match(r.reason, /abstaining by not committing/);
});

test('vote: zero voting weight means no vote — pending deposits do not vote', () => {
  assert.equal(vote({ votingWeight: 0n }).action, 'none');
});

test('vote: non-Rebalance proposal types are left to a human', () => {
  const r = vote({ governance: { proposal: proposal({ ptype: 1, ptypeName: 'RuleChange' }), hasOutstandingCommit: false, revealed: false } });
  assert.equal(r.action, 'none');
  assert.match(r.reason, /not in the agent's mandate/);
});

test('vote: no commit once the commit window has closed', () => {
  assert.equal(vote({ nowSec: 1500 }).action, 'none');
});

test('REVEAL outranks everything: an outstanding commit is revealed as soon as the window opens', () => {
  // A reveal window comfortably longer than the 1800s safety margin, so "not yet urgent" is a
  // meaningful state rather than an artefact of a short window.
  const p = proposal({ revealDeadline: 11000 });
  const r = vote({ governance: { proposal: p, hasOutstandingCommit: true, revealed: false }, nowSec: 1001 });
  assert.equal(r.action, 'reveal', 'we reveal at once — the commitment already bound the direction, so waiting only adds risk');
  assert.equal(r.urgent, false);
  assert.equal(r.secondsToDeadline, 9999);
});

test('reveal is flagged URGENT inside the safety margin', () => {
  const r = vote({ governance: { proposal: proposal(), hasOutstandingCommit: true, revealed: false }, nowSec: 1900 });
  assert.equal(r.action, 'reveal');
  assert.equal(r.urgent, true, '100s left against an 1800s margin');
});

test('reveal-margin boundary: a margin wider than the whole window still reveals immediately', () => {
  // The failure this pins: treating the margin as "wait until then" would never reveal at all when
  // the margin exceeds the window length.
  const timing = { ...CFG.policy.timing, revealSafetyMarginSec: 100000 };
  const r = vote({ governance: { proposal: proposal(), hasOutstandingCommit: true, revealed: false }, nowSec: 1001, timing });
  assert.equal(r.action, 'reveal');
  assert.equal(r.urgent, true);
});

test('an outstanding commit during the COMMIT phase waits for the reveal window', () => {
  const r = vote({ governance: { proposal: proposal(), hasOutstandingCommit: true, revealed: false }, nowSec: 500 });
  assert.equal(r.action, 'none');
  assert.match(r.reason, /reveal window opens/);
});

test('a missed reveal window is reported as the forfeiture it is', () => {
  const r = vote({ governance: { proposal: proposal(), hasOutstandingCommit: true, revealed: false }, nowSec: 5000 });
  assert.equal(r.action, 'none');
  assert.match(r.reason, /forfeit/);
});

test('vote: voteAgainstWhenUnknown turns an abstention into an AGAINST when configured', () => {
  const cfg = { ...CFG.policy.vote, voteAgainstWhenUnknown: true };
  const r = vote({ chain: goodChain({ totalAssetsUsdc: null }), config: cfg });
  assert.equal(r.action, 'commit');
  assert.equal(r.support, false);
});

test('vote: requireKnownAction abstains on an unverifiable payload', () => {
  const cfg = { ...CFG.policy.vote, requireKnownAction: true };
  const r = vote({ chain: goodChain({ idleUsdc: 30_000n * USDC }), config: cfg });
  assert.equal(r.action, 'none');
  assert.match(r.reason, /payload behind this actionHash is unknown/);
});

test('vote: a custom evaluator object can be plugged in directly', () => {
  const cfg = { ...CFG.policy.vote, evaluator: { name: 'always-for', evaluate: () => ({ support: true, reason: 'because', detail: {} }) } };
  const r = vote({ config: cfg });
  assert.equal(r.action, 'commit');
  assert.equal(r.support, true);
  assert.match(r.reason, /always-for/);
});

test('vote: no active proposal, no action', () => {
  assert.equal(decideVote({ governance: { proposal: null }, chain: goodChain(), votingWeight: 1n, nowSec: 0, config: CFG.policy.vote, timing: CFG.policy.timing }).action, 'none');
});
