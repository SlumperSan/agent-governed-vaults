// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deposit,
  cancelPending,
  skipWindow,
  requestExit,
  activate,
  settleQueuedExit,
  creatorGate,
  canSign,
} from '../src/wallet-refusals.mjs';

const CREATOR = '0x1111111111111111111111111111111111111111';
const MEMBER = '0x2222222222222222222222222222222222222222';

/**
 * Assert that the given canonical, fully-readable fixture is signable, THEN null each key in
 * `requiredKeys` one at a time and assert the verdict degrades to 'unknown' with `canSign` false.
 * Non-vacuous by construction: the baseline assertion fails loudly if the fixture itself is wrong,
 * so a module that always returns 'unknown' fails the baseline rather than passing the loop for
 * the wrong reason.
 */
function assertFailsClosedOnEachMissingField(fn, fixture, requiredKeys) {
  const base = fn(fixture);
  assert.ok(canSign(base), `baseline fixture must be signable, got ${base.kind}: ${base.reason}`);
  for (const key of requiredKeys) {
    const v = fn({ ...fixture, [key]: null });
    assert.equal(v.kind, 'unknown', `nulling '${key}' must yield 'unknown', got '${v.kind}' (${v.reason})`);
    assert.equal(canSign(v), false, `'${key}' missing must never be signable`);
    assert.ok(v.missing && v.missing.length > 0, `'unknown' verdict must name what is missing`);
  }
}

// ─────────────────────────────────── deposit ──────────────────────────────────

const depositFixture = {
  amountUsdc: 1_000n,
  minDepositUsdc: 100n,
  frozen: false,
  capacityCapUsdc: 1_000_000n, // nonzero: makes navUsdc/totalPendingUsdcVault load-bearing
  navUsdc: 10_000n,
  totalPendingUsdcVault: 0n,
  windowCleared: false, // window path: makes pendingDeposit load-bearing too
  sharesOf: 0n,
  pendingDeposit: { amountUsdc: 0n },
};

test('deposit: canonical fixture is allowed, and every required field fails closed when unread', () => {
  assertFailsClosedOnEachMissingField(deposit, depositFixture, [
    'minDepositUsdc', 'frozen', 'capacityCapUsdc', 'navUsdc', 'totalPendingUsdcVault',
    'windowCleared', 'sharesOf', 'pendingDeposit',
  ]);
  // nested field, tested separately since it is not a top-level key
  const v = deposit({ ...depositFixture, pendingDeposit: { amountUsdc: null } });
  assert.equal(v.kind, 'unknown');
});

test('deposit: a zero or absent amount refuses ZeroAmount — never unknown, never allowed', () => {
  for (const amountUsdc of [null, undefined, 0n, -1n]) {
    const v = deposit({ ...depositFixture, amountUsdc });
    assert.equal(v.kind, 'refused');
    assert.equal(v.code, 'ZeroAmount');
  }
});

test('deposit: below minDepositUsdc refuses BelowMinDeposit', () => {
  const v = deposit({ ...depositFixture, amountUsdc: 50n });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'BelowMinDeposit');
});

test('deposit: frozen refuses StaleOracle even when uncapped (navWad() is read unconditionally)', () => {
  const v = deposit({ ...depositFixture, frozen: true, capacityCapUsdc: 0n });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'StaleOracle');
});

test('deposit: capacityCapUsdc === 0n means uncapped, not unknown — navUsdc/pending become irrelevant', () => {
  const v = deposit({ ...depositFixture, capacityCapUsdc: 0n, navUsdc: null, totalPendingUsdcVault: null });
  assert.equal(canSign(v), true);
});

test('deposit: over the cap refuses CapacityExceeded, exactly at the cap is allowed', () => {
  const atCap = deposit({ ...depositFixture, navUsdc: 999_000n, totalPendingUsdcVault: 0n, amountUsdc: 1_000n });
  assert.equal(canSign(atCap), true, 'nav + pending + amount == cap exactly must pass (<=)');
  const overCap = deposit({ ...depositFixture, navUsdc: 999_001n, totalPendingUsdcVault: 0n, amountUsdc: 1_000n });
  assert.equal(overCap.kind, 'refused');
  assert.equal(overCap.code, 'CapacityExceeded');
});

test('deposit: pending deposit already exists on the window path refuses PendingExists', () => {
  const v = deposit({ ...depositFixture, pendingDeposit: { amountUsdc: 5n } });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'PendingExists');
});

test('deposit: immediate path via windowCleared never needs pendingDeposit', () => {
  const v = deposit({ ...depositFixture, windowCleared: true, pendingDeposit: null });
  assert.equal(canSign(v), true);
});

test('deposit: immediate path via existing shares never needs pendingDeposit', () => {
  const v = deposit({ ...depositFixture, windowCleared: false, sharesOf: 1n, pendingDeposit: null });
  assert.equal(canSign(v), true);
});

test('deposit: a queued exit gets a tenure-reset warning naming the mechanism, not just "be careful"', () => {
  const v = deposit({ ...depositFixture, windowCleared: true, sharesOf: 10n, queuedExitShares: 5n });
  assert.equal(canSign(v), true);
  assert.ok(v.notes.some((n) => /queued/i.test(n) && /reset/i.test(n) && /raise/i.test(n)));
});

// ─────────────────────────────── cancelPending ─────────────────────────────────

test('cancelPending: allowed with a pending deposit, fails closed when unread, refuses at exactly zero', () => {
  const fixture = { pendingDeposit: { amountUsdc: 500n } };
  assertFailsClosedOnEachMissingField(cancelPending, fixture, ['pendingDeposit']);
  const nested = cancelPending({ pendingDeposit: { amountUsdc: null } });
  assert.equal(nested.kind, 'unknown');

  const zero = cancelPending({ pendingDeposit: { amountUsdc: 0n } });
  assert.equal(zero.kind, 'refused');
  assert.equal(zero.code, 'NoPending');
});

test('cancelPending: never depends on frozen — it is the one call that reads no oracle', () => {
  const v = cancelPending({ pendingDeposit: { amountUsdc: 1n } });
  assert.equal(canSign(v), true);
  assert.ok(v.notes.some((n) => /frozen/i.test(n)));
});

// ──────────────────────────────── skipWindow ───────────────────────────────────

const skipFixture = { skipOptIn: false, pendingDeposit: { amountUsdc: 500n }, frozen: false };

test('skipWindow: canonical fixture is allowed-irreversible, and every field fails closed', () => {
  assertFailsClosedOnEachMissingField(skipWindow, skipFixture, ['skipOptIn', 'pendingDeposit', 'frozen']);
  const v = skipWindow(skipFixture);
  assert.equal(v.kind, 'allowed-irreversible');
});

test('skipWindow: already opted in refuses AlreadyOptedIn regardless of anything else', () => {
  const v = skipWindow({ ...skipFixture, skipOptIn: true, frozen: null, pendingDeposit: null });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'AlreadyOptedIn');
});

test('skipWindow: with nothing pending, it is irreversible and needs no frozen read at all', () => {
  const v = skipWindow({ skipOptIn: false, pendingDeposit: { amountUsdc: 0n }, frozen: null });
  assert.equal(v.kind, 'allowed-irreversible');
});

test('skipWindow: with a pending deposit AND frozen, it refuses rather than silently burning the opt-in', () => {
  const v = skipWindow({ ...skipFixture, frozen: true });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'StaleOracle');
});

test('skipWindow: irreversibility is never silent — the reason says so, always', () => {
  for (const f of [skipFixture, { skipOptIn: false, pendingDeposit: { amountUsdc: 0n }, frozen: null }]) {
    const v = skipWindow(f);
    assert.equal(v.kind, 'allowed-irreversible');
    assert.match(v.reason, /irrevocable/i);
  }
});

// ─────────────────────────────── creatorGate ───────────────────────────────────

test('creatorGate: a non-creator always passes, without needing stake data', () => {
  const g = creatorGate({
    creator: CREATOR, member: MEMBER, sharesOf: null, totalShares: null,
    nonCreatorMemberCount: null, burnShares: null,
  });
  assert.deepEqual(g, { known: true, blocked: false });
});

test('creatorGate: a creator with no other members always passes, without needing stake data', () => {
  const g = creatorGate({
    creator: CREATOR, member: CREATOR, sharesOf: null, totalShares: null,
    nonCreatorMemberCount: 0n, burnShares: null,
  });
  assert.deepEqual(g, { known: true, blocked: false });
});

test('creatorGate: exactly 5% after the burn PASSES (>=, not >) — the exact boundary case', () => {
  const g = creatorGate({
    creator: CREATOR, member: CREATOR, sharesOf: 50_000n, totalShares: 1_000_000n,
    nonCreatorMemberCount: 1n, burnShares: 0n,
  });
  assert.equal(g.known, true);
  assert.equal(g.blocked, false, '50,000 / 1,000,000 is exactly the 5% floor and must pass');
});

test('creatorGate: one share below 5% BLOCKS — the boundary companion case', () => {
  const g = creatorGate({
    creator: CREATOR, member: CREATOR, sharesOf: 49_999n, totalShares: 1_000_000n,
    nonCreatorMemberCount: 1n, burnShares: 0n,
  });
  assert.equal(g.known, true);
  assert.equal(g.blocked, true);
});

test('creatorGate: missing inputs are unknown, never blocked=false by default', () => {
  assert.equal(creatorGate({ creator: null, member: MEMBER, sharesOf: null, totalShares: null, nonCreatorMemberCount: null, burnShares: null }).known, false);
  assert.equal(creatorGate({ creator: CREATOR, member: null, sharesOf: null, totalShares: null, nonCreatorMemberCount: null, burnShares: null }).known, false);
  assert.equal(creatorGate({ creator: CREATOR, member: CREATOR, sharesOf: null, totalShares: null, nonCreatorMemberCount: null, burnShares: null }).known, false);
  assert.equal(creatorGate({ creator: CREATOR, member: CREATOR, sharesOf: 1n, totalShares: null, nonCreatorMemberCount: 1n, burnShares: 0n }).known, false);
  assert.equal(creatorGate({ creator: CREATOR, member: CREATOR, sharesOf: null, totalShares: 1n, nonCreatorMemberCount: 1n, burnShares: 0n }).known, false);
  assert.equal(creatorGate({ creator: CREATOR, member: CREATOR, sharesOf: 1n, totalShares: 1n, nonCreatorMemberCount: 1n, burnShares: null }).known, false);
});

// ─────────────────────────────── requestExit ───────────────────────────────────

// Member IS the creator, comfortably above 5%, other members present — makes every creator-gate
// input load-bearing in the SAME fixture as the rest of requestExit's reads.
const exitFixture = {
  burnShares: 100n,
  queuedExitShares: 0n,
  sharesOf: 900_000n,
  hasPendingExecution: false,
  creator: CREATOR,
  member: CREATOR,
  totalShares: 1_000_000n,
  nonCreatorMemberCount: 3n,
  frozen: false,
};

test('requestExit: canonical Mode-I fixture is allowed, and every required field fails closed', () => {
  assertFailsClosedOnEachMissingField(requestExit, exitFixture, [
    'queuedExitShares', 'sharesOf', 'hasPendingExecution', 'creator', 'member',
    'totalShares', 'nonCreatorMemberCount', 'frozen',
  ]);
});

test('requestExit: a zero or absent share amount refuses ZeroAmount', () => {
  for (const burnShares of [null, undefined, 0n]) {
    const v = requestExit({ ...exitFixture, burnShares });
    assert.equal(v.kind, 'refused');
    assert.equal(v.code, 'ZeroAmount');
  }
});

test('requestExit: an exit already queued refuses ExitAlreadyQueued — exactly zero is the boundary that passes', () => {
  const zero = requestExit({ ...exitFixture, queuedExitShares: 0n });
  assert.equal(canSign(zero), true, 'queuedExitShares === 0n means nothing queued yet');
  const one = requestExit({ ...exitFixture, queuedExitShares: 1n });
  assert.equal(one.kind, 'refused');
  assert.equal(one.code, 'ExitAlreadyQueued');
});

test('requestExit: insufficient shares refuses InsufficientShares', () => {
  const v = requestExit({ ...exitFixture, sharesOf: 50n, burnShares: 100n });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'InsufficientShares');
});

test('requestExit: the creator gate is checked BEFORE the mode branch and blocks both modes', () => {
  const gated = { ...exitFixture, sharesOf: 40_000n, totalShares: 1_000_000n, burnShares: 100n };
  for (const hasPendingExecution of [true, false]) {
    const v = requestExit({ ...gated, hasPendingExecution });
    assert.equal(v.kind, 'refused', `hasPendingExecution=${hasPendingExecution} must still respect the gate`);
    assert.equal(v.code, 'CreatorStakeGate');
  }
});

test('requestExit: hasPendingExecution flips Mode I -> Mode F at the exact moment of request', () => {
  const modeI = requestExit({ ...exitFixture, hasPendingExecution: false });
  assert.equal(modeI.kind, 'allowed');
  assert.match(modeI.reason, /^$/); // plain allowed carries no top-level reason

  const modeF = requestExit({ ...exitFixture, hasPendingExecution: true });
  assert.equal(modeF.kind, 'allowed-irreversible');
  assert.match(modeF.reason, /irrevocable/i);
  assert.match(modeF.reason, /DEFEATED/, 'must say the queued price applies even to a vote that is defeated');
  assert.match(modeF.reason, /vote/i);
});

test('requestExit: Mode I refuses StaleOracle while frozen; Mode F needs no frozen read at all', () => {
  const frozenModeI = requestExit({ ...exitFixture, hasPendingExecution: false, frozen: true });
  assert.equal(frozenModeI.kind, 'refused');
  assert.equal(frozenModeI.code, 'StaleOracle');

  const frozenModeF = requestExit({ ...exitFixture, hasPendingExecution: true, frozen: null });
  assert.equal(frozenModeF.kind, 'allowed-irreversible', 'the Mode-F queue branch reads no oracle');
});

test('requestExit: the exit-fee ceiling caveat never claims to be the amount charged', () => {
  const v = requestExit({
    ...exitFixture, hasPendingExecution: true,
    exitFeeMaxBps: 100n, exitFeeDecayPeriodSec: 1000n, tenureSec: 0n,
  });
  assert.equal(v.kind, 'allowed-irreversible');
  const note = v.notes.find((n) => /ceiling/i.test(n));
  assert.ok(note);
  assert.match(note, /NOT the amount/i);
  assert.match(note, /waived/i);
  assert.match(note, /not fixed today/i);
});

// ────────────────────────────────── activate ───────────────────────────────────

const activateFixture = { pendingDeposit: { amountUsdc: 500n, availableAt: 1_000 }, nowSec: 1_000, frozen: false };

test('activate: canonical fixture is allowed at the EXACT boundary (now === availableAt), and fails closed', () => {
  assertFailsClosedOnEachMissingField(activate, activateFixture, ['pendingDeposit', 'nowSec', 'frozen']);
  const v = activate(activateFixture);
  assert.equal(canSign(v), true);
});

test('activate: nothing pending refuses NoPending, exactly zero is the boundary', () => {
  const v = activate({ ...activateFixture, pendingDeposit: { amountUsdc: 0n, availableAt: 1_000 } });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'NoPending');
});

test('activate: one second before the window elapses refuses WindowNotElapsed; at the boundary it is allowed', () => {
  const early = activate({ ...activateFixture, nowSec: 999 });
  assert.equal(early.kind, 'refused');
  assert.equal(early.code, 'WindowNotElapsed');
  const exact = activate({ ...activateFixture, nowSec: 1_000 });
  assert.equal(canSign(exact), true);
});

test('activate: frozen refuses StaleOracle', () => {
  const v = activate({ ...activateFixture, frozen: true });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'StaleOracle');
});

test('activate: names that this credits the member, not the signer (discriminator #305)', () => {
  const v = activate(activateFixture);
  assert.ok(v.notes.some((n) => /member/i.test(n) && /not.*(who|whoever) signs/i.test(n)));
});

// ─────────────────────────────── settleQueuedExit ──────────────────────────────

const settleFixture = { queuedExitShares: 100n, hasPendingExecution: false, frozen: false };

test('settleQueuedExit: canonical fixture is allowed, fails closed on every field', () => {
  assertFailsClosedOnEachMissingField(settleQueuedExit, settleFixture, ['queuedExitShares', 'hasPendingExecution', 'frozen']);
});

test('settleQueuedExit: exactly zero queued shares refuses NoQueuedExit — the boundary the task names', () => {
  const v = settleQueuedExit({ ...settleFixture, queuedExitShares: 0n });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'NoQueuedExit');
  const justAbove = settleQueuedExit({ ...settleFixture, queuedExitShares: 1n });
  assert.equal(canSign(justAbove), true);
});

test('settleQueuedExit: hasPendingExecution true at the moment of the call refuses ExecutionStillPending', () => {
  const v = settleQueuedExit({ ...settleFixture, hasPendingExecution: true });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'ExecutionStillPending');
});

test('settleQueuedExit: frozen refuses StaleOracle', () => {
  const v = settleQueuedExit({ ...settleFixture, frozen: true });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'StaleOracle');
});

test('settleQueuedExit: never re-checks the creator gate (fromQueue=true) — no creator fields required at all', () => {
  const v = settleQueuedExit(settleFixture);
  assert.equal(canSign(v), true, 'settleQueuedExit takes no creator/member/totalShares input by design');
});

// ───────────────────────────────── canSign ─────────────────────────────────────

test('canSign is true only for allowed and allowed-irreversible', () => {
  assert.equal(canSign({ kind: 'allowed', reason: '' }), true);
  assert.equal(canSign({ kind: 'allowed-irreversible', reason: 'x' }), true);
  assert.equal(canSign({ kind: 'refused', reason: 'x', code: 'X' }), false);
  assert.equal(canSign({ kind: 'unknown', reason: 'x', missing: ['y'] }), false);
});
