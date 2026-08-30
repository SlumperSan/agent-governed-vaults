// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actions, vaultStatus } from '../src/vault-state.mjs';

/** A healthy, open, attested vault the user is a member of. */
const open = {
  frozen: false, attested: true, exitMode: /** @type {const} */ ('I'), isMember: true,
  hasPendingDeposit: false, pendingMatured: false, hasQueuedExit: false, capacityFull: false,
};
const noticeIds = (f) => actions(f).notices.map((n) => n.id);

test('an open vault permits deposit and exit', () => {
  const a = actions(open);
  assert.equal(a.deposit.available, true);
  assert.equal(a.exit.available, true);
  assert.equal(a.notices.length, 0);
});

test('FROZEN blocks deposit, activation and exit — and leaves cancel available', () => {
  // cancelPending() reads no oracle (VaultCore M-2), which is the one promise the frozen state
  // can honestly make.
  const a = actions({ ...open, frozen: true, hasPendingDeposit: true, pendingMatured: true });
  assert.equal(a.deposit.available, false);
  assert.equal(a.activate.available, false);
  assert.equal(a.exit.available, false);
  assert.equal(a.cancelPending.available, true, 'pending capital is never frozen');
  assert.match(a.activate.reason, /cancellable/i);
});

test('the frozen notice frames a freeze as the safety mechanism, not a fault', () => {
  const n = actions({ ...open, frozen: true }).notices.find((x) => x.id === 'frozen');
  assert.ok(n);
  assert.match(n.body, /safety mechanism/i);
  assert.match(n.body, /no emergency withdrawal|no admin/i);
  assert.match(n.body, /observation window/i, 'must say what the user CAN still do');
  // Never promise a lever that does not exist.
  assert.doesNotMatch(n.body, /contact support|emergency exit|request withdrawal/i);
});

test('TRAP 1 — a Mode-F queue is withheld while frozen even though the contract would accept it', () => {
  // requestExit's Mode-F branch queues without reading the oracle, so this succeeds on-chain.
  // Its entire effect while frozen is harm: irrevocable, strips the vote at once, and cannot
  // settle until BOTH the proposal resolves and the oracle recovers.
  const a = actions({ ...open, frozen: true, exitMode: 'F' });
  assert.equal(a.exit.available, false);
  assert.match(a.exit.reason, /irrevocable/i);
  assert.match(a.exit.reason, /vote/i);
});

test('TRAP 2 — skipWindow is never offered without a pending deposit to attach it to', () => {
  // skipWindow() with nothing pending succeeds and permanently burns the once-per-vault opt-in
  // while minting nothing at all.
  assert.equal(actions({ ...open, hasPendingDeposit: false }).skipWindow.available, false);
  assert.match(actions(open).skipWindow.reason, /permanently burn/i);
  assert.equal(actions({ ...open, hasPendingDeposit: true }).skipWindow.available, true);
});

test('an unresolved exit mode still permits exit, but warns instead of reassuring', () => {
  const a = actions({ ...open, exitMode: 'unknown' });
  assert.equal(a.exit.available, true);
  assert.equal(a.exit.severity, 'warn');
  assert.match(a.exit.reason, /irrevocab/i);
  assert.ok(noticeIds({ ...open, exitMode: 'unknown' }).includes('mode-unknown'));
});

test('Mode F permits exit and labels the consequence', () => {
  const a = actions({ ...open, exitMode: 'F' });
  assert.equal(a.exit.available, true);
  assert.equal(a.exit.severity, 'warn');
  assert.match(a.exit.reason, /irrevocab/i);
});

test('an unattested vault is quarantined from deposits and says why', () => {
  const a = actions({ ...open, attested: false });
  assert.equal(a.deposit.available, false);
  const n = a.notices.find((x) => x.id === 'unattested');
  assert.match(n.body, /operator #0/);
  assert.match(n.body, /registry is the trust signal/i);
});

test('a queued exit blocks a second one and is announced', () => {
  const a = actions({ ...open, hasQueuedExit: true });
  assert.equal(a.exit.available, false);
  assert.match(a.exit.reason, /one at a time/i);
  assert.ok(a.notices.some((n) => n.id === 'queued-exit'));
});

test('capacity, pending and membership gates', () => {
  assert.equal(actions({ ...open, capacityFull: true }).deposit.available, false);
  assert.match(actions({ ...open, capacityFull: true }).deposit.reason, /pending/i, 'the cap includes escrowed pending');
  assert.equal(actions({ ...open, hasPendingDeposit: true }).deposit.available, false);
  assert.equal(actions({ ...open, isMember: false }).exit.available, false);
  assert.equal(actions({ ...open, walletConnected: false }).deposit.available, false);
});

test('activation waits for the window and then opens', () => {
  assert.equal(actions({ ...open, hasPendingDeposit: true, pendingMatured: false }).activate.available, false);
  assert.equal(actions({ ...open, hasPendingDeposit: true, pendingMatured: true }).activate.available, true);
  assert.equal(actions(open).activate.available, false);
});

test('the creator 5% withdrawal gate blocks the exit it would breach', () => {
  const a = actions({ ...open, isCreatorBelowGate: true });
  assert.equal(a.exit.available, false);
  assert.match(a.exit.reason, /5%/);
});

test('vaultStatus ranks the most decision-changing fact first', () => {
  assert.equal(vaultStatus({ ...open, attested: false, frozen: true }).key, 'unattested');
  assert.equal(vaultStatus({ ...open, frozen: true, exitMode: 'F' }).key, 'frozen');
  assert.equal(vaultStatus({ ...open, exitMode: 'unknown' }).key, 'unknown');
  assert.equal(vaultStatus({ ...open, exitMode: 'F' }).key, 'modeF');
  assert.equal(vaultStatus({ ...open, capacityFull: true }).key, 'full');
  assert.equal(vaultStatus(open).key, 'open');
});

test('every status carries a text label and a glyph — never colour alone (WCAG 1.4.1)', () => {
  for (const f of [open, { ...open, frozen: true }, { ...open, attested: false }, { ...open, exitMode: 'F' }]) {
    const s = vaultStatus(f);
    assert.ok(s.label.length > 0);
    assert.ok(s.glyph.length > 0);
  }
});
