// @ts-check
/**
 * The pre-flight refusal gate a signing UI relies on to never let a member pay gas for a
 * predictable revert, and to never let "unknown" quietly resolve to "go ahead".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canSign, skipWindowRefusal, requestExitPricingRefusal, creatorGateRefusal, exitFeeCeiling,
  CREATOR_MIN_STAKE_BPS,
} from '../src/wallet-refusals.mjs';

const T = 1_800_000_000; // an arbitrary "now", in seconds (matches governance.test.mjs's T)
const HOUR = 3600;
const DAY = 86_400;

// ───────────────────────── 1. skipWindow — irrevocable ─────────────────────────

test('skipWindow: a second call is refused, never re-offered as an undo', () => {
  const v = skipWindowRefusal({ skipOptIn: true });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'AlreadyOptedIn');
  assert.equal(canSign(v), false);
});

test('skipWindow: the first call is allowed but flagged irreversible, and warns before signing', () => {
  const v = skipWindowRefusal({ skipOptIn: false });
  assert.equal(v.kind, 'allowed-irreversible');
  assert.equal(canSign(v), true, 'a first-time opt-in is a real, signable call');
  assert.match(v.reason, /permanent|no undo/i);
});

test('skipWindow: an unread skipOptIn never resolves to signable', () => {
  const v = skipWindowRefusal({ skipOptIn: undefined });
  assert.equal(v.kind, 'unknown');
  assert.equal(canSign(v), false);
});

// ────────────── 2. requestExit pricing once a proposal has been DEFEATED ──────────────

test('requestExit after a Defeat settles NOW, at current NAV — same as no proposal at all', () => {
  const v = requestExitPricingRefusal({ proposal: { status: 'Defeated' }, nowSec: T });
  assert.equal(v.kind, 'allowed');
  assert.equal(canSign(v), true);
  assert.match(v.reason, /settles now|current NAV/i);

  // Executed / Expired / no proposal all read the same way — hasPendingExecution is false for all.
  for (const proposal of [{ status: 'Executed' }, { status: 'Expired' }, null]) {
    assert.equal(requestExitPricingRefusal({ proposal, nowSec: T }).kind, 'allowed');
  }
});

test('requestExit during reveal-through-execution-window is irrevocable, and Defeat does not retroactively fix it', () => {
  // Past the commit deadline, still Active: Mode F (Governance.sol:740-741).
  const reveal = { status: 'Active', commitDeadline: T - 1, revealDeadline: T + HOUR };
  const v = requestExitPricingRefusal({ proposal: reveal, nowSec: T });
  assert.equal(v.kind, 'allowed-irreversible');
  assert.equal(canSign(v), true, 'this call itself does not revert — it queues');
  assert.match(v.reason, /queue/i);
  assert.match(v.reason, /Defeat/i, 'must state that a later Defeat does not undo or reprice the queue');

  // Passed and still inside its execution window is the same Mode-F case.
  const passed = { status: 'Passed', executableAt: T - HOUR, expiresAt: T + HOUR };
  assert.equal(requestExitPricingRefusal({ proposal: passed, nowSec: T }).kind, 'allowed-irreversible');
});

test('requestExit pricing: a proposal with no commitDeadline is unknown, never assumed instant', () => {
  // Mirrors governance.test.mjs's "missing deadlines resolve to unknown" case.
  const v = requestExitPricingRefusal({ proposal: { status: 'Active' }, nowSec: T });
  assert.equal(v.kind, 'unknown');
  assert.equal(canSign(v), false);

  const noData = requestExitPricingRefusal({ proposal: 'unknown', nowSec: T });
  assert.equal(noData.kind, 'unknown');
});

// ──────────────────────── 3. the creator 5% withdrawal gate ────────────────────────

test('creator gate: a request that would drop the creator below 5% is refused', () => {
  // sharesOf=600, totalShares=10_000 (6%), burn=200 -> post 400/9800 = 4.08% < 5%.
  const v = creatorGateRefusal({
    creator: '0xCafe', member: '0xCafe',
    sharesOf: 600n, totalShares: 10_000n, nonCreatorMemberCount: 1n, burnShares: 200n,
  });
  assert.equal(v.kind, 'refused');
  assert.equal(v.code, 'CreatorStakeGate');
  assert.equal(canSign(v), false);
});

test('creator gate: a request that keeps the creator at/above 5% is allowed', () => {
  // sharesOf=600, totalShares=10_000, burn=50 -> post 550/9950 = 5.53% >= 5%.
  const v = creatorGateRefusal({
    creator: '0xCafe', member: '0xCafe',
    sharesOf: 600n, totalShares: 10_000n, nonCreatorMemberCount: 1n, burnShares: 50n,
  });
  assert.equal(v.kind, 'allowed');
  assert.equal(canSign(v), true);
});

test('creator gate: the boundary is >=, not >  — exactly 5% post-exit passes', () => {
  // totalShares=10_100, burn=100 -> post total=10_000. sharesOf=600, burn=100 -> post shares=500.
  // 500 * BPS == CREATOR_MIN_STAKE_BPS * 10_000 exactly (500*10000 == 500*10000).
  assert.equal(500n * 10_000n, CREATOR_MIN_STAKE_BPS * 10_000n, 'fixture is a genuine equality, not near it');
  const v = creatorGateRefusal({
    creator: '0xCafe', member: '0xCafe',
    sharesOf: 600n, totalShares: 10_100n, nonCreatorMemberCount: 1n, burnShares: 100n,
  });
  assert.equal(v.kind, 'allowed', 'VaultCore._checkCreatorGate uses >=, so exactly 5% must pass');
});

test('creator gate: does not bind a non-creator, or a creator with no other members', () => {
  const notCreator = creatorGateRefusal({
    creator: '0xCafe', member: '0xBeef',
    sharesOf: 1n, totalShares: 10_000n, nonCreatorMemberCount: 5n, burnShares: 1n,
  });
  assert.equal(notCreator.kind, 'allowed');

  const soleMember = creatorGateRefusal({
    creator: '0xCafe', member: '0xCafe',
    sharesOf: 10_000n, totalShares: 10_000n, nonCreatorMemberCount: 0n, burnShares: 10_000n,
  });
  assert.equal(soleMember.kind, 'allowed', 'no other members means the gate never binds, regardless of burn size');
});

test('creator gate: unread inputs never resolve to signable', () => {
  assert.equal(creatorGateRefusal({ creator: null, member: null }).kind, 'unknown');
  assert.equal(
    creatorGateRefusal({ creator: '0xCafe', member: '0xCafe', nonCreatorMemberCount: null }).kind,
    'unknown',
  );
  assert.equal(
    creatorGateRefusal({
      creator: '0xCafe', member: '0xCafe', nonCreatorMemberCount: 1n,
      sharesOf: null, totalShares: 10_000n, burnShares: 1n,
    }).kind,
    'unknown',
  );
});

// ──────────────────── 4. exitFeeBpsOf is a CEILING, not a promise ────────────────────

test('exitFeeCeiling reports the tenure-decayed reading and calls it a ceiling, not a promise', () => {
  // Same fixture as exit-preview.test.mjs: 1% max, 90-day decay, 45 days in -> 50 bps.
  const v = exitFeeCeiling({ exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90 * DAY, tenureSec: 45 * DAY });
  assert.equal(v.kind, 'allowed');
  assert.equal(v.ceilingBps, 50n);
  assert.match(v.reason, /ceiling/i);
  assert.match(v.reason, /sole holder/i, 'must name the waiver that can zero it');
  assert.match(v.reason, /deposit again/i, 'must name the one direction the reading does NOT bound');
});

test('exitFeeCeiling refuses to show a number when the tenure inputs are unread', () => {
  const v = exitFeeCeiling({ exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90 * DAY, tenureSec: undefined });
  assert.equal(v.kind, 'unknown');
  assert.equal(v.ceilingBps, null);
});

test('exitFeeCeiling at day zero is the full max — an honest worst case, not an average', () => {
  const v = exitFeeCeiling({ exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90 * DAY, tenureSec: 0 });
  assert.equal(v.ceilingBps, 100n);
});
