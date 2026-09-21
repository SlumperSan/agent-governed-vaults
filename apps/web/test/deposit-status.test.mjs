// @ts-check
/**
 * Deposit-status classification. These are the tests that stop the wallet UI showing a member
 * "nothing pending" when the read simply failed, or "waiting" when the window has already cleared
 * and nothing but an `activate()` call stands between them and shares.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDepositStatus } from '../src/deposit-status.mjs';

const T = 1_800_000_000; // an arbitrary "now", in seconds
const HOUR = 3600;
const OBSERVATION_WINDOW = 4 * HOUR; // VaultCore.sol:52

test('no pending deposit and no shares reads as none', () => {
  const s = classifyDepositStatus({ pendingAmountUsdc: 0n, availableAt: 0, sharesOf: 0n, now: T });
  assert.equal(s.state, 'none');
  assert.equal(s.availableAt, null);
  assert.equal(s.secondsRemaining, null);
});

test('a live pending deposit before its window clears reads as waiting, with a countdown', () => {
  const at = T + OBSERVATION_WINDOW;
  const s = classifyDepositStatus({ pendingAmountUsdc: 1_000_000n, availableAt: at, sharesOf: 0n, now: T });
  assert.equal(s.state, 'waiting');
  assert.equal(s.availableAt, at);
  assert.equal(s.secondsRemaining, at - T, 'countdown is derived from availableAt and now, not restated');
});

test('boundary: just before availableAt is still waiting, at and just after are available', () => {
  const at = T + OBSERVATION_WINDOW;
  const base = { pendingAmountUsdc: 1_000_000n, availableAt: at, sharesOf: 0n };

  const justBefore = classifyDepositStatus({ ...base, now: at - 1 });
  assert.equal(justBefore.state, 'waiting');
  assert.equal(justBefore.secondsRemaining, 1);

  // VaultCore.activate: `require(block.timestamp >= p.availableAt, ...)` — the boundary itself
  // is already activatable, matching the contract's `>=` exactly.
  const atBoundary = classifyDepositStatus({ ...base, now: at });
  assert.equal(atBoundary.state, 'available');
  assert.equal(atBoundary.secondsRemaining, null);

  const justAfter = classifyDepositStatus({ ...base, now: at + 1 });
  assert.equal(justAfter.state, 'available');
});

test('a matured pending deposit reads as available, not active — activation is a separate call', () => {
  // VaultCore.activate(address member) is permissionless but not automatic (line 441-446): shares
  // have not minted yet even though the window has cleared. Reading this as "active" would tell a
  // member their shares exist when the mapping still says otherwise.
  const at = T - 1;
  const s = classifyDepositStatus({ pendingAmountUsdc: 5_000_000n, availableAt: at, sharesOf: 0n, now: T });
  assert.equal(s.state, 'available');
  assert.match(s.detail, /not automatic/i);
  assert.doesNotMatch(s.detail, /skip/i, 'skipOptIn is not one of this classifier\'s inputs — it must not be implied');
});

test('shares with no pending deposit reads as active', () => {
  const s = classifyDepositStatus({ pendingAmountUsdc: 0n, availableAt: 0, sharesOf: 42n, now: T });
  assert.equal(s.state, 'active');
  assert.doesNotMatch(s.detail, /settle/i, 'the window path vs immediate path is not distinguishable from these inputs — do not claim it');
});

test('a pending amount with both no shares reads waiting/available; WITH shares is a torn read, not a position', () => {
  // `_mintShares` is the only path that raises `sharesOf`, and both its callers either take the
  // immediate-mint branch (never creates a pending entry) or delete the pending entry before
  // minting (VaultCore.sol:448-450). pending>0 && shares>0 from one atomic read cannot happen —
  // only from two reads taken far enough apart that activate() landed in between.
  const at = T + OBSERVATION_WINDOW;
  const s = classifyDepositStatus({ pendingAmountUsdc: 1_000_000n, availableAt: at, sharesOf: 7n, now: T });
  assert.equal(s.state, 'unknown');
  assert.match(s.detail, /different times|disagree/i);
});

test('UNKNOWN INPUTS RESOLVE TO unknown, never to none — the defect this module exists to prevent', () => {
  const missingEverything = classifyDepositStatus({ pendingAmountUsdc: undefined, availableAt: undefined, sharesOf: undefined, now: undefined });
  assert.equal(missingEverything.state, 'unknown');
  assert.notEqual(missingEverything.state, 'none', 'an unread position must never render identically to an empty one');

  const missingSharesOnly = classifyDepositStatus({ pendingAmountUsdc: 0n, availableAt: 0, sharesOf: null, now: T });
  assert.equal(missingSharesOnly.state, 'unknown');

  const missingNowOnly = classifyDepositStatus({ pendingAmountUsdc: 0n, availableAt: 0, sharesOf: 0n, now: null });
  assert.equal(missingNowOnly.state, 'unknown');

  const malformedPending = classifyDepositStatus({ pendingAmountUsdc: 'not-a-number', availableAt: T + HOUR, sharesOf: 0n, now: T });
  assert.equal(malformedPending.state, 'unknown');

  const negativePending = classifyDepositStatus({ pendingAmountUsdc: -1n, availableAt: T + HOUR, sharesOf: 0n, now: T });
  assert.equal(negativePending.state, 'unknown', 'a negative amount is malformed, not a real position');
});

test('a pending amount with an unreadable availableAt is unknown, never waiting or available', () => {
  const missingAt = classifyDepositStatus({ pendingAmountUsdc: 1_000_000n, availableAt: undefined, sharesOf: 0n, now: T });
  assert.equal(missingAt.state, 'unknown');

  const malformedAt = classifyDepositStatus({ pendingAmountUsdc: 1_000_000n, availableAt: 'soon', sharesOf: 0n, now: T });
  assert.equal(malformedAt.state, 'unknown');
});

test('every state carries a distinct label and a one-sentence detail the UI can render as-is', () => {
  const states = [
    classifyDepositStatus({ pendingAmountUsdc: 0n, availableAt: 0, sharesOf: 0n, now: T }),
    classifyDepositStatus({ pendingAmountUsdc: 1n, availableAt: T + HOUR, sharesOf: 0n, now: T }),
    classifyDepositStatus({ pendingAmountUsdc: 1n, availableAt: T - 1, sharesOf: 0n, now: T }),
    classifyDepositStatus({ pendingAmountUsdc: 0n, availableAt: 0, sharesOf: 1n, now: T }),
    classifyDepositStatus({ pendingAmountUsdc: undefined, availableAt: undefined, sharesOf: undefined, now: undefined }),
  ];
  const labels = new Set(states.map((s) => s.label));
  assert.equal(labels.size, new Set(states.map((s) => s.state)).size, 'one label per distinct state');
  for (const s of states) {
    assert.equal(typeof s.detail, 'string');
    assert.ok(s.detail.length > 0);
    assert.ok(Object.isFrozen(s), 'result is frozen, like assembleLegSafety\'s records');
  }
});
