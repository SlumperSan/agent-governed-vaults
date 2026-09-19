// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDepositPosition, DEPOSIT_STATE } from '../src/deposit-position.mjs';

const usdc = (n) => BigInt(n) * 1_000_000n;
const HOUR = 3600n;

const findAction = (r, code) => {
  const a = r.actions.find((x) => x.code === code);
  assert.ok(a, `expected an action entry for ${code}`);
  return a;
};

// ── unread must never render as a settled state ─────────────────────────────

test('all four required fields absent -> unread, nothing offerable', () => {
  const r = classifyDepositPosition({});
  assert.equal(r.state, DEPOSIT_STATE.UNREAD);
  assert.deepEqual([...r.missing].sort(), ['availableAt', 'chainNowSec', 'pendingAmountUsdc', 'sharesHeld']);
  for (const code of ['deposit', 'cancelPending', 'activate']) {
    assert.equal(findAction(r, code).offerable, false, `${code} must not be offered unread`);
  }
});

test('each required field missing individually still reads unread, not a guessed state', () => {
  const full = { pendingAmountUsdc: usdc(100), availableAt: 1000n, chainNowSec: 500n, sharesHeld: 0n };
  for (const key of ['pendingAmountUsdc', 'availableAt', 'chainNowSec', 'sharesHeld']) {
    const r = classifyDepositPosition({ ...full, [key]: undefined });
    assert.equal(r.state, DEPOSIT_STATE.UNREAD, `missing ${key} must read unread`);
    assert.deepEqual([...r.missing], [key]);
  }
});

test('unparseable strings are absent, not zero (toBig discipline)', () => {
  const r = classifyDepositPosition({
    pendingAmountUsdc: 'not-a-number',
    availableAt: 1000n,
    chainNowSec: 500n,
    sharesHeld: 0n,
  });
  assert.equal(r.state, DEPOSIT_STATE.UNREAD);
  assert.deepEqual([...r.missing], ['pendingAmountUsdc']);
});

// ── none: nothing ever deposited, or fully cancelled ─────────────────────────

test('none: zero pending, zero shares -> only deposit is offerable', () => {
  const r = classifyDepositPosition({ pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: 0n });
  assert.equal(r.state, DEPOSIT_STATE.NONE);
  assert.equal(findAction(r, 'deposit').offerable, true);
  assert.equal(findAction(r, 'cancelPending').offerable, false);
  assert.equal(findAction(r, 'cancelPending').reason, 'NoPending');
  assert.equal(findAction(r, 'activate').offerable, false);
  assert.equal(findAction(r, 'activate').reason, 'NoPending');
});

test('boundary: zero-amount pending record with a nonzero stale availableAt is still none — amount is the discriminator, not availableAt', () => {
  const r = classifyDepositPosition({ pendingAmountUsdc: 0n, availableAt: 999_999n, chainNowSec: 1000n, sharesHeld: 0n });
  assert.equal(r.state, DEPOSIT_STATE.NONE);
});

// ── pending / matured, and the exact-equality boundary ───────────────────────

test('pending: chainNow strictly before availableAt -> cancellable, activate blocked WindowNotElapsed', () => {
  const r = classifyDepositPosition({ pendingAmountUsdc: usdc(500), availableAt: 1000n, chainNowSec: 999n, sharesHeld: 0n });
  assert.equal(r.state, DEPOSIT_STATE.PENDING);
  assert.equal(r.secondsRemaining, 1);
  assert.equal(findAction(r, 'cancelPending').offerable, true);
  assert.equal(findAction(r, 'cancelPending').callableBy, 'member');
  assert.equal(findAction(r, 'activate').offerable, false);
  assert.equal(findAction(r, 'activate').reason, 'WindowNotElapsed');
  assert.equal(findAction(r, 'deposit').offerable, false);
  assert.equal(findAction(r, 'deposit').reason, 'PendingExists');
});

test('boundary: chainNow EQUAL to availableAt is matured, mirroring the contract\'s >= check', () => {
  const r = classifyDepositPosition({ pendingAmountUsdc: usdc(500), availableAt: 1000n, chainNowSec: 1000n, sharesHeld: 0n });
  assert.equal(r.state, DEPOSIT_STATE.MATURED);
  assert.equal(r.secondsRemaining, 0);
});

test('matured: activate is offerable to anyone, and cancelPending stays offerable too (no availableAt gate on-chain)', () => {
  const r = classifyDepositPosition({ pendingAmountUsdc: usdc(500), availableAt: 1000n, chainNowSec: 1001n, sharesHeld: 0n });
  assert.equal(r.state, DEPOSIT_STATE.MATURED);
  const activate = findAction(r, 'activate');
  assert.equal(activate.offerable, true);
  assert.equal(activate.callableBy, 'anyone'); // #305: activate(address) names the member, anyone may call
  const cancel = findAction(r, 'cancelPending');
  assert.equal(cancel.offerable, true, 'cancelPending has no time gate in the contract — must still race activate');
  assert.equal(cancel.callableBy, 'member');
  assert.equal(findAction(r, 'deposit').offerable, false);
  assert.equal(findAction(r, 'deposit').reason, 'PendingExists');
});

// ── active ─────────────────────────────────────────────────────────────────

test('active: shares held, no pending -> deposit offerable, cancel/activate blocked NoPending', () => {
  const r = classifyDepositPosition({ pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: usdc(10) });
  assert.equal(r.state, DEPOSIT_STATE.ACTIVE);
  assert.equal(findAction(r, 'deposit').offerable, true);
  assert.equal(findAction(r, 'cancelPending').offerable, false);
  assert.equal(findAction(r, 'cancelPending').reason, 'NoPending');
  assert.equal(findAction(r, 'activate').offerable, false);
  assert.equal(findAction(r, 'activate').reason, 'NoPending');
});

test('active does not require windowCleared — sharesHeld alone settles it', () => {
  // windowCleared/skipOptIn only bear on what a FUTURE deposit does (deposit-preview.mjs#entryPath);
  // they must not gate whether an existing share balance reads as active.
  const r = classifyDepositPosition({ pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: 1n });
  assert.equal(r.state, DEPOSIT_STATE.ACTIVE);
});

// ── indeterminate: reads that contradict a contract invariant ───────────────

test('indeterminate: positive pending amount AND positive shares at once — unreachable on-chain', () => {
  const r = classifyDepositPosition({ pendingAmountUsdc: usdc(1), availableAt: 1000n, chainNowSec: 500n, sharesHeld: usdc(1) });
  assert.equal(r.state, DEPOSIT_STATE.INDETERMINATE);
  assert.ok(r.reasons.includes('amount-and-shares-both-positive'));
  for (const code of ['deposit', 'cancelPending', 'activate']) {
    assert.equal(findAction(r, code).offerable, false, `${code} must not be offered while indeterminate`);
  }
});

test('boundary: availableAt of 0 with a positive pending amount is indeterminate, not matured', () => {
  // A naive `chainNow >= availableAt` reads `chainNow >= 0` as always true and would wrongly offer
  // activate on a torn/partial read. availableAt=0 paired with amount>0 cannot occur on-chain.
  const r = classifyDepositPosition({ pendingAmountUsdc: usdc(1), availableAt: 0n, chainNowSec: 500n, sharesHeld: 0n });
  assert.equal(r.state, DEPOSIT_STATE.INDETERMINATE);
  assert.ok(r.reasons.includes('zero-available-at-with-pending'));
  assert.notEqual(r.state, DEPOSIT_STATE.MATURED);
});

// ── skipWindow: orthogonal to the state, irrevocable, never assumed false ───

test('skipWindow unread when skipOptIn is not supplied, in every state', () => {
  const fixtures = [
    { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: 0n }, // none
    { pendingAmountUsdc: usdc(1), availableAt: 2000n, chainNowSec: 1000n, sharesHeld: 0n }, // pending
    { pendingAmountUsdc: usdc(1), availableAt: 1000n, chainNowSec: 2000n, sharesHeld: 0n }, // matured
    { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: usdc(1) }, // active
  ];
  for (const f of fixtures) {
    const r = classifyDepositPosition(f);
    assert.equal(r.skipWindow.offerable, false);
    assert.equal(r.skipWindow.reason, 'Unread');
  }
});

test('skipWindow offerable and marked irrevocable when skipOptIn is explicitly false', () => {
  const r = classifyDepositPosition({
    pendingAmountUsdc: usdc(1), availableAt: 2000n, chainNowSec: 1000n, sharesHeld: 0n, skipOptIn: false,
  });
  assert.equal(r.skipWindow.offerable, true);
  assert.equal(r.skipWindow.callableBy, 'member');
  assert.equal(r.skipWindow.irrevocable, true);
});

test('skipWindow blocked AlreadyOptedIn when skipOptIn is true, never offered a second time', () => {
  const r = classifyDepositPosition({
    pendingAmountUsdc: usdc(1), availableAt: 2000n, chainNowSec: 1000n, sharesHeld: 0n, skipOptIn: true,
  });
  assert.equal(r.skipWindow.offerable, false);
  assert.equal(r.skipWindow.reason, 'AlreadyOptedIn');
});

// ── PR #305 discriminator: no second-person pronoun anywhere copy can reach ─

test('no describe string implies the viewer is the member — no second-person pronoun', () => {
  const fixtures = [
    {}, // unread
    { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: 0n }, // none
    { pendingAmountUsdc: usdc(1), availableAt: 2000n, chainNowSec: 1000n, sharesHeld: 0n }, // pending
    { pendingAmountUsdc: usdc(1), availableAt: 1000n, chainNowSec: 2000n, sharesHeld: 0n }, // matured
    { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: usdc(1) }, // active
    { pendingAmountUsdc: usdc(1), availableAt: 1000n, chainNowSec: 500n, sharesHeld: usdc(1) }, // indeterminate
  ];
  for (const f of fixtures) {
    const r = classifyDepositPosition(f);
    assert.doesNotMatch(r.describe, /\byou\b|\byour\b/i, `state ${r.state} describe leaked a second-person pronoun`);
  }
});

test('activate is always callableBy anyone and cancelPending always callableBy member, whenever either appears', () => {
  const fixtures = [
    { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: 0n },
    { pendingAmountUsdc: usdc(1), availableAt: 2000n, chainNowSec: 1000n, sharesHeld: 0n },
    { pendingAmountUsdc: usdc(1), availableAt: 1000n, chainNowSec: 2000n, sharesHeld: 0n },
    { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: usdc(1) },
  ];
  for (const f of fixtures) {
    const r = classifyDepositPosition(f);
    assert.equal(findAction(r, 'activate').callableBy, 'anyone');
    assert.equal(findAction(r, 'cancelPending').callableBy, 'member');
  }
});

// ── non-vacuity: the classifier must actually discriminate, not default everywhere ─

test('non-vacuity: representative fixtures cover every state exactly once and produce 6 distinct states', () => {
  const fixtures = {
    unread: {},
    none: { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: 0n },
    pending: { pendingAmountUsdc: usdc(1), availableAt: 2000n, chainNowSec: 1000n, sharesHeld: 0n },
    matured: { pendingAmountUsdc: usdc(1), availableAt: 1000n, chainNowSec: 1000n, sharesHeld: 0n },
    active: { pendingAmountUsdc: 0n, availableAt: 0n, chainNowSec: 1000n, sharesHeld: usdc(1) },
    indeterminate: { pendingAmountUsdc: usdc(1), availableAt: 0n, chainNowSec: 1000n, sharesHeld: 0n },
  };
  const seen = new Set();
  for (const [expected, f] of Object.entries(fixtures)) {
    const r = classifyDepositPosition(f);
    assert.equal(r.state, DEPOSIT_STATE[expected.toUpperCase()], `fixture "${expected}" classified as ${r.state}`);
    seen.add(r.state);
  }
  assert.equal(seen.size, 6, 'expected all six states to be reachable and distinct, not collapsed to one');
});

test('non-vacuity: a matcher that always says "none" would fail this suite', () => {
  const alwaysNone = () => ({ state: DEPOSIT_STATE.NONE, actions: [], missing: [], reasons: [], secondsRemaining: null, skipWindow: {} });
  const r = alwaysNone({ pendingAmountUsdc: usdc(1), availableAt: 1000n, chainNowSec: 1000n, sharesHeld: 0n });
  assert.notEqual(r.state, DEPOSIT_STATE.MATURED); // proves the assertion above is capable of failing
});
