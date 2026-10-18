// @ts-check
/**
 * Policy decisions over fixture states. Every function under test is pure, so each case states a
 * world and asserts a verdict — no clock, no network, no ordering effects.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';
import { asBigInt, decideCrank, decideEntry, decideExit, decideJoin, decideSettle, decideVote, votePhase } from '../src/policy.mjs';

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

test('join: requireProvenOperator=false accepts a zero-net operator — the flag was inert', () => {
  // Regression. `requireProvenOperator: false` is documented as "Refuse an operator with no
  // realizations at all" being turned OFF, but an extra `net > 0n` in the gate refused them
  // anyway, so the flag did nothing in the one case it exists for. A brand-new operator could
  // therefore never be joined by any configuration. Found live in the Sprint-12 soak, where the
  // agent declined the smoke vault with "net realized $0 (gain $0 / loss $0), floor $0".
  const cfg = { ...CFG.policy.join, requireProvenOperator: false, minOperatorNetRealizedUsdc: '0' };
  const r = join({ operatorRow: goodOp({ netRealizedUsdc: '0', lifetimeGainUsdc: '0', lifetimeLossUsdc: '0' }), config: cfg });
  const gate = r.checks.find((c) => c.name === 'operator-net-positive');
  assert.equal(gate.ok, true, `zero net must clear a zero floor once the flag is off: ${gate.detail}`);
});

test('join: the floor still excludes negatives when requireProvenOperator is off', () => {
  // The safety the removed `net > 0n` was providing is provided by the floor itself.
  const cfg = { ...CFG.policy.join, requireProvenOperator: false, minOperatorNetRealizedUsdc: '0' };
  const r = join({ operatorRow: goodOp({ netRealizedUsdc: '-1' }), config: cfg });
  assert.equal(r.checks.find((c) => c.name === 'operator-net-positive').ok, false);
  assert.equal(r.join, false);
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

test('join: a depth that was never measured is refused, not read as 0', () => {
  // Neither the stacked read nor the discovery row carries a depth: unknown, so refuse.
  const r = join({ vault: { ...goodVault(), depth: null }, fees: goodFees({ depth: null }) });
  assert.equal(r.join, false);
  assert.ok(failed(r).includes('depth-within-limit'));
  assert.match(r.checks.find((c) => c.name === 'depth-within-limit').detail, /unreadable/);
  const absent = join({ vault: { vault: VAULT, operatorId: 1, attested: true }, fees: goodFees({ depth: null }) });
  assert.ok(failed(absent).includes('depth-within-limit'), 'a row with no depth field is unmeasured too');
});

test('join: a failed stacked depth read falls back to the row depth only when the row has one', () => {
  assert.equal(join({ vault: { ...goodVault(), depth: 0 }, fees: goodFees({ depth: null }) }).join, true);
  assert.ok(failed(join({ vault: { ...goodVault(), depth: 1 }, fees: goodFees({ depth: null }) })).includes('depth-within-limit'));
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
  assert.equal(r.modeF, true, 'exiting into a pending execution settles at POST-execution NAV');
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

// ── degraded reads must not masquerade as "nothing to do" ───────────────────

test('an unreadable proposal is reported as UNKNOWN, not as "no active proposal"', () => {
  const r = decideVote({
    governance: { proposal: null, activePid: 42n, proposalUnknown: true, hasOutstandingCommit: false },
    chain: goodChain(),
    votingWeight: 100n * USDC,
    nowSec: 500,
    config: CFG.policy.vote,
    timing: CFG.policy.timing,
  });
  assert.equal(r.action, 'none');
  assert.equal(r.degraded, true);
  assert.match(r.reason, /could NOT be read/);
  assert.doesNotMatch(r.reason, /no active proposal/, 'a failed read must never report an absence');
});

test('an unreadable commitOf is reported as UNKNOWN, not as "we hold no commit"', () => {
  const r = decideVote({
    governance: { proposal: proposal(), activePid: 42n, hasOutstandingCommit: false, commitUnknown: true, revealed: null },
    chain: goodChain(),
    votingWeight: 100n * USDC,
    nowSec: 1500, // reveal phase
    config: CFG.policy.vote,
    timing: CFG.policy.timing,
  });
  assert.equal(r.degraded, true);
  assert.match(r.reason, /UNKNOWN/);
});

test('a genuinely absent proposal is still reported plainly', () => {
  const r = decideVote({
    governance: { proposal: null, activePid: 0n, proposalUnknown: false },
    chain: goodChain(), votingWeight: 1n, nowSec: 0, config: CFG.policy.vote, timing: CFG.policy.timing,
  });
  assert.equal(r.action, 'none');
  assert.equal(r.degraded, undefined);
  assert.match(r.reason, /no active proposal/);
});

// ── crank: finalize / execute / markExpired ─────────────────────────────────
//
// One proposal, three clocks. R is the reveal deadline, E the executable-at, X the expiry. Every
// boundary gets the second either side of it, because the contract's comparisons are `>=` on R,
// `E <= now <= X` for execute and a strict `>` on X for markExpired, and an off-by-one on any of
// them is a transaction that reverts (or, worse, one that is never sent).

const R = 1_000_000;
const E = 1_000_500;
const X = 1_086_900;
const HASH = '0x' + 'ab'.repeat(32);
const PAYLOAD = '0x1234';
const crankProposal = (over = {}) => ({
  pid: 7n, vault: VAULT, ptype: 0, ptypeName: 'Rebalance', status: 1, statusName: 'Active',
  commitDeadline: R - 100, revealDeadline: R, executableAt: E, expiresAt: X, actionHash: HASH, ...over,
});
const crankGov = (over = {}) => ({ available: true, activePid: 7n, proposal: crankProposal(over), hasPendingExecution: true });
const passed = (over = {}) => crankGov({ status: 2, statusName: 'Passed', ...over });
const crank = (over = {}) =>
  decideCrank({
    governance: crankGov(),
    chainNowSec: R,
    nowSec: R,
    timing: CFG.policy.timing,
    config: { ...CFG.policy.crank, markExpired: true },
    knownPayloads: { [HASH]: PAYLOAD },
    held: true,
    ...over,
  });
const failedCrank = (r) => r.checks.filter((c) => !c.ok).map((c) => c.name);

test('crank: the defaults finalize and execute, scope to held vaults, and leave markExpired off', () => {
  assert.deepEqual(CFG.policy.crank, { scope: 'held', finalize: true, execute: true, markExpired: false, knownPayloads: {} });
});

test('crank finalize: the boundary is >= revealDeadline (R - 1 waits, R and R + 1 finalize)', () => {
  const before = crank({ chainNowSec: R - 1 });
  assert.equal(before.action, 'none');
  assert.deepEqual(failedCrank(before), ['reveal-window-over']);
  assert.match(before.reason, /reveal window ends at 1000000 \(in 1s\)/);

  for (const now of [R, R + 1]) {
    const r = crank({ chainNowSec: now });
    assert.equal(r.action, 'finalize', `at ${now}`);
    assert.equal(r.pid, 7n);
    assert.deepEqual(failedCrank(r), []);
  }
});

test('crank finalize: the per-kind switch turns it off, and says so', () => {
  const r = crank({ config: { ...CFG.policy.crank, finalize: false } });
  assert.equal(r.action, 'none');
  assert.deepEqual(failedCrank(r), ['finalize-enabled']);
});

test('crank execute: the window is E <= now <= X, both ends inclusive', () => {
  const gov = passed();
  const early = crank({ governance: gov, chainNowSec: E - 1 });
  assert.equal(early.action, 'none');
  assert.deepEqual(failedCrank(early), ['timelock-elapsed']);
  assert.match(early.reason, /executable at 1000500 \(in 1s\)/);

  for (const now of [E, E + 1, X - 1, X]) {
    const r = crank({ governance: gov, chainNowSec: now });
    assert.equal(r.action, 'execute', `at ${now}`);
    assert.equal(r.payload, PAYLOAD);
    assert.equal(r.actionHash, HASH);
    assert.equal(r.ptype, 0);
  }
});

test('crank markExpired: the boundary is a strict > expiresAt (X is still executable, X + 1 is expired)', () => {
  const gov = passed();
  assert.equal(crank({ governance: gov, chainNowSec: X }).action, 'execute', 'at X the window is still open, so it is not expired');
  // With no payload, X yields nothing at all: it must not fall through to markExpired.
  assert.equal(crank({ governance: gov, chainNowSec: X, knownPayloads: {} }).action, 'none');
  const after = crank({ governance: gov, chainNowSec: X + 1 });
  assert.equal(after.action, 'mark-expired');
  assert.equal(after.pid, 7n);
  assert.equal(crank({ governance: gov, chainNowSec: X + 1, knownPayloads: {} }).action, 'mark-expired', 'it needs no payload');
});

test('crank markExpired: off by default, and then it is a named reason, not silence', () => {
  const r = crank({ governance: passed(), chainNowSec: X + 1, config: CFG.policy.crank });
  assert.equal(r.action, 'none');
  assert.deepEqual(failedCrank(r), ['mark-expired-enabled']);
});

test('crank execute: a window with no matching payload is refused and the reason names the payload', () => {
  const r = crank({ governance: passed(), chainNowSec: E, knownPayloads: {} });
  assert.equal(r.action, 'none');
  assert.deepEqual(failedCrank(r), ['payload-known']);
  assert.match(r.reason, /no verified payload for actionHash 0xabab/);
  assert.match(r.reason, /the chain does not store it/);
  // A payload held under a DIFFERENT hash is not this proposal's payload.
  assert.equal(crank({ governance: passed(), chainNowSec: E, knownPayloads: { ['0x' + 'cd'.repeat(32)]: PAYLOAD } }).action, 'none');
});

test('crank execute: the payload lookup is case-insensitive on the proposal side', () => {
  const upper = '0x' + 'AB'.repeat(32);
  const r = crank({ governance: passed({ actionHash: upper }), chainNowSec: E });
  assert.equal(r.action, 'execute');
});

test('crank execute: only a Rebalance, even with a payload in hand', () => {
  const r = crank({ governance: passed({ ptype: 1, ptypeName: 'RuleChange' }), chainNowSec: E });
  assert.equal(r.action, 'none');
  assert.deepEqual(failedCrank(r), ['rebalance-only']);
  assert.match(r.reason, /a human decides it/);
  // ...but a RuleChange that expired is still bookkept: markExpired takes only a pid.
  assert.equal(crank({ governance: passed({ ptype: 1, ptypeName: 'RuleChange' }), chainNowSec: X + 1 }).action, 'mark-expired');
});

test('crank execute: the per-kind switch turns it off', () => {
  const r = crank({ governance: passed(), chainNowSec: E, config: { ...CFG.policy.crank, execute: false } });
  assert.equal(r.action, 'none');
  assert.deepEqual(failedCrank(r), ['execute-enabled']);
});

test('crank execute: urgent inside revealSafetyMarginSec of expiry, not before', () => {
  const margin = CFG.policy.timing.revealSafetyMarginSec;
  assert.equal(crank({ governance: passed(), chainNowSec: X - margin - 1 }).urgent, false);
  assert.equal(crank({ governance: passed(), chainNowSec: X - margin }).urgent, true);
  assert.equal(crank({ governance: passed(), chainNowSec: X }).urgent, true, 'still sent at the last second: the alternative is certain expiry');
});

test('crank: Defeated, Executed, Expired and None are finished, so nothing is done', () => {
  for (const [status, statusName] of [[3, 'Defeated'], [4, 'Executed'], [5, 'Expired'], [0, 'None']]) {
    for (const now of [R, E, X, X + 1]) {
      const r = crank({ governance: crankGov({ status, statusName }), chainNowSec: now });
      assert.equal(r.action, 'none', `${statusName} at ${now}`);
      assert.notEqual(r.degraded, true);
    }
  }
});

test('crank: a status the agent does not know is degraded and does nothing', () => {
  const r = crank({ governance: crankGov({ status: 9, statusName: 'Unknown' }) });
  assert.equal(r.action, 'none');
  assert.equal(r.degraded, true);
});

test('crank: an UNREADABLE proposal is degraded and does nothing, however late it is', () => {
  const gov = { available: true, activePid: 7n, proposal: null, proposalUnknown: true };
  for (const now of [R, E, X + 1]) {
    const r = crank({ governance: gov, chainNowSec: now });
    assert.equal(r.action, 'none');
    assert.equal(r.degraded, true);
    assert.match(r.reason, /could NOT be read: unknown, not "nothing to do"/);
  }
});

test('crank: no proposal, or no governance contract, is nothing to do and not degraded', () => {
  const none = crank({ governance: { available: true, activePid: 0n, proposal: null } });
  assert.equal(none.action, 'none');
  assert.notEqual(none.degraded, true);
  assert.equal(crank({ governance: { available: false } }).action, 'none');
  assert.equal(crank({ governance: undefined }).action, 'none');
});

test('crank scope: held (the default) skips a vault the agent holds nothing in; all does not; off never acts', () => {
  assert.equal(crank({ held: false }).action, 'none');
  assert.deepEqual(failedCrank(crank({ held: false })), ['scope']);
  assert.equal(crank({ held: true }).action, 'finalize');
  assert.equal(crank({ held: false, config: { ...CFG.policy.crank, scope: 'all' } }).action, 'finalize');
  assert.equal(crank({ held: true, config: { ...CFG.policy.crank, scope: 'off' } }).action, 'none');
  assert.equal(crank({ held: false, config: { ...CFG.policy.crank, scope: 'off' } }).action, 'none');
});

test('crank clock: chain time wins over the local clock in BOTH directions', () => {
  // Local clock ten minutes ahead of the chain: it must not finalize early.
  const ahead = crank({ chainNowSec: R - 1, nowSec: R + 600 });
  assert.equal(ahead.action, 'none');
  assert.match(ahead.checks.find((c) => c.name === 'clock').detail, /^chain time 999999$/);
  // Local clock ten minutes behind: chain time says the window is over, so it finalizes.
  assert.equal(crank({ chainNowSec: R, nowSec: R - 600 }).action, 'finalize');
});

test('crank clock: with no chain time the local clock stands in LESS activateGraceSec, on the near side', () => {
  const grace = CFG.policy.timing.activateGraceSec;
  const at = (nowSec, over = {}) => crank({ chainNowSec: null, nowSec, ...over });
  // finalize: local R + grace - 1 is not yet safely past R.
  assert.equal(at(R + grace - 1).action, 'none');
  assert.equal(at(R + grace).action, 'finalize');
  assert.match(at(R + grace).checks.find((c) => c.name === 'clock').detail, /chain time unreadable: local clock 1000060 less the 60s margin = 1000000/);
  // execute: not before the timelock, with the same margin.
  assert.equal(at(E + grace - 1, { governance: passed() }).action, 'none');
  assert.equal(at(E + grace, { governance: passed() }).action, 'execute');
  // markExpired: never early, so strict > X plus the margin.
  assert.equal(at(X + grace, { governance: passed(), knownPayloads: {} }).action, 'none');
  assert.equal(at(X + grace + 1, { governance: passed(), knownPayloads: {} }).action, 'mark-expired');
});

test('crank: decideCrank is pure (same inputs, same verdict; inputs untouched)', () => {
  const args = { governance: crankGov(), chainNowSec: R, nowSec: R, timing: CFG.policy.timing, config: CFG.policy.crank, knownPayloads: {}, held: true };
  const before = JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  assert.deepEqual(decideCrank(args), decideCrank(args));
  assert.equal(JSON.stringify(args, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), before);
});

// ── the unproven-operator profile and the outside-member figure ──────────────

const ZERO_OP = () => goodOp({ netRealizedUsdc: '0', lifetimeGainUsdc: '0', lifetimeLossUsdc: '0' });
const PROFILE_CFG = (over = {}) => loadConfig({ policy: { join: { profile: 'unproven-operator', ...over } } }).policy.join;

test('join: the DEFAULT config refuses a zero-record operator, on the track-record gate and nothing else', () => {
  const r = join({ operatorRow: ZERO_OP() });
  assert.equal(r.join, false);
  assert.deepEqual(failed(r), ['operator-net-positive']);
  assert.equal(CFG.policy.join.profile, null, 'the profile is opt-in');
});

test('join: the unproven-operator profile admits a zero-record operator and deposits exactly the vault minimum', () => {
  const r = join({ operatorRow: ZERO_OP(), config: PROFILE_CFG() });
  assert.equal(r.join, true, `blocked on ${failed(r).join(', ')}`);
  assert.equal(r.depositUsdc, 10n * USDC, 'goodChain().minDepositUsdc is 10 USDC, not the configured 25');
  const risk = r.checks.find((c) => c.name === 'profile-unproven-operator');
  assert.ok(risk?.ok);
  assert.match(risk.detail, /holders now 5/, 'the live holder count is printed beside the risk');
  assert.match(risk.detail, /Below five holders/);
});

test('join: the profile pins the deposit at the vault minimum whatever depositUsdc says, and the gates use the pinned amount', () => {
  const big = PROFILE_CFG({ depositUsdc: '500' });
  const r = join({ operatorRow: ZERO_OP(), config: big, chain: goodChain({ minDepositUsdc: 100n * USDC, capacityCapUsdc: 150n * USDC, totalAssetsUsdc: 0n }) });
  assert.equal(r.depositUsdc, 100n * USDC);
  assert.equal(r.checks.find((c) => c.name === 'capacity-available').ok, true, '150 free covers the pinned 100; the configured 500 would not fit');
  assert.match(r.checks.find((c) => c.name === 'meets-min-deposit').detail, /pinned at the vault minimum by the unproven-operator profile/);
});

test('join: under the profile an unreadable vault minimum refuses instead of guessing a deposit', () => {
  const r = join({ operatorRow: ZERO_OP(), config: PROFILE_CFG(), chain: goodChain({ minDepositUsdc: null }) });
  assert.equal(r.join, false);
  assert.ok(failed(r).includes('meets-min-deposit'));
  assert.equal(r.depositUsdc, 0n);
});

test('join: the profile keeps every other gate, including a negative operator net and an unattested operator', () => {
  assert.equal(join({ operatorRow: goodOp({ netRealizedUsdc: '-1' }), config: PROFILE_CFG() }).join, false);
  assert.equal(join({ operatorRow: ZERO_OP(), config: PROFILE_CFG(), vault: { ...goodVault(), operatorId: 0 } }).join, false);
  assert.equal(join({ operatorRow: null, config: PROFILE_CFG() }).join, false, 'no leaderboard row is still no record to judge');
});

const outside = (over = {}) => ({
  complete: true,
  gap: null,
  creationBlock: 10,
  scannedFrom: 10,
  scannedTo: 99,
  head: 99,
  included: { gain: 0n, loss: 0n, net: 0n, members: 0 },
  excluded: { gain: 40n * USDC, loss: 0n, members: 1 },
  reconciles: true,
  ...over,
});

test('join: exclusion changes a verdict (a record that exists only for a disclosed address stops counting)', () => {
  assert.equal(join({}).join, true, 'without the figure the registry record admits the operator');
  const r = join({ trackRecordExcludingDisclosed: outside() });
  assert.equal(r.join, false);
  const gate = r.checks.find((c) => c.name === 'outside-track-record');
  assert.equal(gate.ok, false);
  assert.match(gate.detail, /an outside realization is required/);
  assert.match(gate.detail, /left out as disclosed: gain \$40 \/ loss \$0 from 1 address/);
  const real = outside({ included: { gain: 5n * USDC, loss: 0n, net: 5n * USDC, members: 1 } });
  assert.equal(join({ trackRecordExcludingDisclosed: real }).join, true, 'one outside realization is enough');
});

test('join: a figure that was not read in full refuses and names the gap; it is never an operator with no realizations', () => {
  const unread = outside({ complete: false, gap: 'eth_getLogs 5 to 14 failed: rate limit exceeded', included: { gain: 9n * USDC, loss: 0n, net: 9n * USDC, members: 1 } });
  const r = join({ trackRecordExcludingDisclosed: unread });
  assert.equal(r.join, false);
  assert.match(r.checks.find((c) => c.name === 'outside-track-record').detail, /not read in full \(eth_getLogs 5 to 14 failed: rate limit exceeded\)/);
  const profiled = join({ operatorRow: ZERO_OP(), config: PROFILE_CFG(), trackRecordExcludingDisclosed: outside({ complete: false, gap: 'x', excluded: { gain: 0n, loss: 0n, members: 0 } }) });
  assert.equal(profiled.join, false, 'the profile does not turn an unread window into permission');
});

test('join: a window total that differs from the registry is said so in the check', () => {
  const r = join({ trackRecordExcludingDisclosed: outside({ reconciles: false, included: { gain: 5n * USDC, loss: 0n, net: 5n * USDC, members: 1 } }) });
  assert.match(r.checks.find((c) => c.name === 'outside-track-record').detail, /differs from the registry accumulators/);
});
