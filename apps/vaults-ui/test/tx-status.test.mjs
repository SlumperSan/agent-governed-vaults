// @ts-check
/**
 * `EscrowClaims.tsx` used to set "Claimed." the moment `writeContract` returned a hash, before any
 * receipt, so a claim that reverted on chain still read "Claimed." (PR #441 review, item 4).
 * `MemberActions.tsx` had the same shape for deposit, exit, commit and reveal. Both now go through
 * `confirmTx` (`src/lib/tx-status.ts`), which waits for the receipt and reads its `status`.
 *
 * Two layers, because the components are TSX and `node --test` has no JSX loader:
 *  1. `confirmTx` itself runs for real against a fake client: pending, success, reverted, and a
 *     receipt wait that throws.
 *  2. Source guards pin that each component sets its success line only on a `confirmed` outcome,
 *     after the receipt wait, and never straight after the write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmTx, submittedLine, unconfirmedLine } from '../src/lib/tx-status.ts';

const APP = fileURLToPath(new URL('..', import.meta.url));
const ESCROW = readFileSync(join(APP, 'src/components/EscrowClaims.tsx'), 'utf8');
const MEMBER = readFileSync(join(APP, 'src/components/MemberActions.tsx'), 'utf8');
const HASH = '0x' + 'ab'.repeat(32);

// ───────────────────────────── layer 1: confirmTx against a fake client ─────────────────────────────

test('pending: confirmTx does not resolve while the receipt is outstanding', async () => {
  /** @type {(r: { status: string }) => void} */
  let release = () => {};
  const client = { waitForTransactionReceipt: () => new Promise((res) => { release = res; }) };
  let settled = false;
  const p = confirmTx(client, HASH).then((o) => { settled = true; return o; });
  await new Promise((r) => setImmediate(r));
  assert.equal(settled, false, 'confirmTx resolved with no receipt: a hash alone must not read as an outcome');
  release({ status: 'success' });
  assert.deepEqual(await p, { state: 'confirmed' });
});

test('success: a receipt with status success is confirmed', async () => {
  const client = { waitForTransactionReceipt: async () => ({ status: 'success' }) };
  assert.deepEqual(await confirmTx(client, HASH), { state: 'confirmed' });
});

test('reverted: a mined receipt with status reverted is reverted, not confirmed', async () => {
  const client = { waitForTransactionReceipt: async () => ({ status: 'reverted' }) };
  assert.deepEqual(await confirmTx(client, HASH), { state: 'reverted' });
});

test('a receipt wait that throws is unconfirmed, never confirmed and never reverted', async () => {
  const client = { waitForTransactionReceipt: async () => { throw new Error('timed out'); } };
  assert.deepEqual(await confirmTx(client, HASH), { state: 'unconfirmed', detail: 'timed out' });
});

test('an unrecognised receipt status is unconfirmed', async () => {
  const client = { waitForTransactionReceipt: async () => ({ status: 'weird' }) };
  const o = await confirmTx(client, HASH);
  assert.equal(o.state, 'unconfirmed');
});

test('the pending and unconfirmed lines name the hash and claim neither success nor failure', () => {
  const pending = submittedLine('claimEscrowed', HASH);
  assert.ok(pending.includes(HASH));
  assert.doesNotMatch(pending, /Claimed\.|Deposited\.|reverted|failed/i);
  const unc = unconfirmedLine('claimEscrowed', HASH, 'timed out');
  assert.ok(unc.includes(HASH));
  assert.doesNotMatch(unc, /Claimed\.|reverted|failed/i);
});

// ───────────────────────────── layer 2: the components wire it ─────────────────────────────

test('EscrowClaims: "Claimed." is set only inside the confirmed branch, after confirmTx', () => {
  const claimed = [...ESCROW.matchAll(/`Claimed\./g)];
  assert.equal(claimed.length, 1, 'expected exactly one "Claimed." line');
  const at = claimed[0].index;
  const wait = ESCROW.indexOf('await confirmTx(publicClient, r.claimHash)');
  const gate = ESCROW.indexOf("outcome.state === 'confirmed'");
  assert.ok(wait > 0 && gate > wait && at > gate, '"Claimed." must come after the receipt wait and its confirmed check');
  const sendAt = ESCROW.indexOf('await sendClaimEscrowed');
  assert.doesNotMatch(
    ESCROW.slice(sendAt, wait),
    /Claimed\./,
    '"Claimed." is set between the write and the receipt wait: it fires on the hash again',
  );
});

test('EscrowClaims: the row leaves the list only on a confirmed claim, and a revert says the balance is unchanged', () => {
  const gate = ESCROW.indexOf("outcome.state === 'confirmed'");
  const drop = ESCROW.indexOf('setClaimable((prev) => (prev ? prev.filter');
  const rev = ESCROW.indexOf("outcome.state === 'reverted'");
  assert.ok(gate > 0 && drop > gate && rev > drop, 'the local list drop must sit inside the confirmed branch');
  assert.match(ESCROW, /reverted on chain[^`]*Your escrowed balance was not changed[^`]*network fee was still charged/);
});

test('contract anchor: claimEscrowed zeroes then transfers, so a revert leaves the balance escrowed', () => {
  const sol = readFileSync(join(APP, '../../contracts/src/VaultCore.sol'), 'utf8');
  const fn = /function claimEscrowed\(address asset\) external nonReentrant \{([\s\S]*?)\n    \}/.exec(sol);
  assert.ok(fn, 'claimEscrowed not found in VaultCore.sol');
  assert.match(fn[1], /claimable\[msg\.sender\]\[asset\] = 0;\s*asset\.safeTransfer\(msg\.sender, amt\);/);
});

test('MemberActions: deposit, exit, commit and reveal all settle through settleFlow, none set success on the hash', () => {
  for (const [label, hash] of [['deposit', 'r.depositHash'], ['requestExit', 'r.exitHash'], ['commitVote', 'r.commitHash'], ['revealVote', 'r.revealHash']]) {
    const call = MEMBER.split(String.fromCharCode(10)).find((l) => l.includes("await settleFlow(publicClient, set") && l.includes(`'${label}', ${hash},`));
    assert.ok(call, `${label} no longer settles through settleFlow with ${hash}`);
  }
  assert.doesNotMatch(
    MEMBER,
    /set(Deposit|Exit|Commit|Reveal)\(\{ busy: false, message: `(Deposited|Sent|Committed|Revealed)/,
    'a success line is set directly after the write again',
  );
  assert.match(MEMBER, /if \(outcome\.state === 'confirmed'\)/);
});
