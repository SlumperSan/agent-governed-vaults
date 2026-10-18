// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduce } from '../src/ledger.mjs';
import { usdcDaysString } from '../src/board.mjs';
import { DAY, USDC, A, B, C, VAULT, addr, dep, exit, rng, shuffled, chrono } from './helpers.mjs';

const W = { windowStart: 0, windowEnd: 7 * DAY };
const secs = (r, m) => r.usdcSeconds.get(m) ?? 0n;

test('time held is exact: 100 USDC for one day is 100 USDC-days', () => {
  const r = reduce([dep(A, 100n * USDC, 1000n, 0), exit(A, 1000n, DAY)], W);
  assert.equal(secs(r, A), 100n * USDC * BigInt(DAY));
  assert.equal(usdcDaysString(secs(r, A)), '100.000000');
});

test('event field: a repeat deposit sets the share balance and does not add it', () => {
  // The contract emits the balance AFTER the deposit as the third field. Two deposits of 100 USDC at
  // 1000 shares per deposit emit 1000 then 2000. Reading the field as a delta would hold 3000 shares.
  const events = [dep(A, 100n * USDC, 1000n, 0), dep(A, 100n * USDC, 2000n, 10)];
  const r = reduce(events, W);
  const pos = r.positions.get(`${VAULT}|${A}`);
  assert.equal(pos?.shares, 2000n);
  assert.equal(pos?.basis, 200n * USDC);
  // With the delta reading, a full exit of 2000 shares would leave 1000 shares and a nonzero basis.
  const r2 = reduce([...events, exit(A, 2000n, 100)], W);
  assert.equal(r2.positions.get(`${VAULT}|${A}`)?.shares, 0n);
  assert.equal(r2.positions.get(`${VAULT}|${A}`)?.basis, 0n);
});

test('exit removes basis pro rata with a floor, as VaultCore does', () => {
  // basis 100 USDC, 3 shares, burn 1: removed = floor(100e6 * 1 / 3) = 33333333.
  const r = reduce([dep(A, 100n * USDC, 3n, 0), exit(A, 1n, 10)], W);
  assert.equal(r.positions.get(`${VAULT}|${A}`)?.basis, 100n * USDC - 33_333_333n);
  assert.equal(r.positions.get(`${VAULT}|${A}`)?.shares, 2n);
});

test('a deposit and exit in the same instant measure zero', () => {
  const r = reduce([dep(A, 1_000_000n * USDC, 1000n, 500), exit(A, 1000n, 500)], W);
  assert.equal(secs(r, A), 0n);
  assert.equal(r.usdcSeconds.has(A), false);
});

test('deposit/exit loops measure only the time held', () => {
  // Held 100 USDC for 1000 s, out for 1000 s, in again for 500 s, out, in for 250 s. The number of
  // deposits and exits appears nowhere: only seconds held do.
  const events = [
    dep(A, 100n * USDC, 100n, 0), exit(A, 100n, 1000),
    dep(A, 100n * USDC, 100n, 2000), exit(A, 100n, 2500),
    dep(A, 100n * USDC, 100n, 3000), exit(A, 100n, 3250),
  ];
  assert.equal(secs(reduce(events, W), A), 100n * USDC * (1000n + 500n + 250n));
  // The same capital held once for the same total seconds measures the same.
  const once = reduce([dep(A, 100n * USDC, 100n, 0), exit(A, 100n, 1750)], W);
  assert.equal(secs(once, A), 100n * USDC * 1750n);
});

test('a queued exit keeps counting until the exit settles', () => {
  // Only ExitSettled changes the ledger; a queued request emits a different event the reducer ignores.
  const r = reduce([dep(A, 100n * USDC, 100n, 0), exit(A, 100n, 5000)], W);
  assert.equal(secs(r, A), 100n * USDC * 5000n);
});

test('positions in several vaults of one address are summed', () => {
  const v2 = addr(0xaa02);
  const e2 = { ...dep(A, 50n * USDC, 50n, 0), vault: v2 };
  const r = reduce([dep(A, 100n * USDC, 100n, 0), e2], { windowStart: 0, windowEnd: 100 });
  assert.equal(secs(r, A), 150n * USDC * 100n);
});

test('epoch boundary: a change stamped at the start applies to the new epoch; at the end it does not', () => {
  const S = 1_000_000;
  const E = S + 7 * DAY;
  // Deposit exactly at the epoch start: counted from the first second.
  const atStart = reduce([dep(A, 10n * USDC, 10n, S)], { windowStart: S, windowEnd: E });
  assert.equal(secs(atStart, A), 10n * USDC * BigInt(7 * DAY));
  // Deposit one second before the end: exactly one second.
  const lastSecond = reduce([dep(A, 10n * USDC, 10n, E - 1)], { windowStart: S, windowEnd: E });
  assert.equal(secs(lastSecond, A), 10n * USDC);
  // Deposit exactly at the end: nothing in this epoch.
  const atEnd = reduce([dep(A, 10n * USDC, 10n, E)], { windowStart: S, windowEnd: E });
  assert.equal(atEnd.usdcSeconds.has(A), false);
  // Exit exactly at the start of the epoch: the position was held zero seconds of it.
  const exitAtStart = reduce([dep(A, 10n * USDC, 10n, S - 100), exit(A, 10n, S)], { windowStart: S, windowEnd: E });
  assert.equal(exitAtStart.usdcSeconds.has(A), false);
  // Exit exactly at the end: held the full epoch.
  const exitAtEnd = reduce([dep(A, 10n * USDC, 10n, S - 100), exit(A, 10n, E)], { windowStart: S, windowEnd: E });
  assert.equal(secs(exitAtEnd, A), 10n * USDC * BigInt(7 * DAY));
});

test('consecutive epochs add up to the whole: no second is counted twice or dropped', () => {
  const events = [dep(A, 7n * USDC, 70n, 123), exit(A, 30n, 9 * DAY + 5), exit(A, 40n, 20 * DAY)];
  const whole = reduce(events, { windowStart: 0, windowEnd: 21 * DAY });
  const parts = [0, 1, 2].map((i) => reduce(events, { windowStart: i * 7 * DAY, windowEnd: (i + 1) * 7 * DAY }));
  assert.equal(parts.reduce((s, p) => s + secs(p, A), 0n), secs(whole, A));
});

test('events after the window still move the state (for the head check) but add nothing', () => {
  const r = reduce([dep(A, 10n * USDC, 10n, 100), dep(A, 10n * USDC, 20n, 5 * DAY)], { windowStart: 0, windowEnd: DAY });
  assert.equal(secs(r, A), 10n * USDC * BigInt(DAY - 100));
  assert.equal(r.positions.get(`${VAULT}|${A}`)?.shares, 20n);
});

test('determinism: input order does not matter', () => {
  const rand = rng(7);
  const events = [];
  let t = 0;
  const bal = new Map();
  for (let i = 0; i < 60; i += 1) {
    const m = [A, B, C][Math.floor(rand() * 3)];
    t += Math.floor(rand() * 5000);
    const held = bal.get(m) ?? 0n;
    if (held > 0n && rand() < 0.4) {
      const burn = 1n + BigInt(Math.floor(rand() * Number(held)));
      events.push(exit(m, burn > held ? held : burn, t));
      bal.set(m, held - (burn > held ? held : burn));
    } else {
      const amt = BigInt(1 + Math.floor(rand() * 500)) * USDC;
      bal.set(m, held + amt);
      events.push(dep(m, amt, held + amt, t));
    }
  }
  const base = reduce(events, W);
  for (let k = 0; k < 5; k += 1) {
    const again = reduce(shuffled(events, rand), W);
    assert.deepEqual([...again.usdcSeconds].sort(), [...base.usdcSeconds].sort());
  }
});

test('splitting capital across identities never beats one identity (deposit-only)', () => {
  const rand = rng(99);
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 1 + Math.floor(rand() * 10);
    const total = BigInt(1 + Math.floor(rand() * 1_000_000)) * 7n; // raw USDC units
    const t0 = Math.floor(rand() * 3 * DAY);
    const single = reduce([dep(A, total, total, t0)], W);
    const events = [];
    let left = total;
    for (let i = 0; i < n; i += 1) {
      const part = i === n - 1 ? left : left / BigInt(n - i);
      left -= part;
      if (part > 0n) events.push(dep(addr(0x2000 + i), part, part, t0 + (i % 2 === 0 ? 0 : Math.floor(rand() * 1000))));
    }
    const split = reduce(chrono(events), W);
    const sum = [...split.usdcSeconds.values()].reduce((s, v) => s + v, 0n);
    assert.ok(sum <= secs(single, A), `trial ${trial}: split ${sum} > single ${secs(single, A)}`);
    // Rendered per identity, the floors can only lose: the sum of rendered rows never exceeds the single row.
    const microSum = [...split.usdcSeconds.values()].reduce((s, v) => s + v / 86_400n, 0n);
    assert.ok(microSum <= secs(single, A) / 86_400n);
  }
});

test('splitting with exits: the contract rounding can favour a splitter by at most (n-1) raw units per exit, per second held after it', () => {
  // basisRemoved is floored per identity, so n identities each remove floor(x/n) and together leave up
  // to n-1 raw USDC units (10^-6 USDC) more basis than one identity would. That is a property of the
  // contract's own accounting, and it is bounded here rather than hidden.
  const rand = rng(5);
  for (let trial = 0; trial < 200; trial += 1) {
    const n = 2 + Math.floor(rand() * 8);
    const each = BigInt(1 + Math.floor(rand() * 50_000));
    const total = each * BigInt(n);
    const burnFrac = BigInt(1 + Math.floor(rand() * 7)); // burn burnFrac/8 of the shares
    const sharesPer = 8n * each;
    const tExit = 1000 + Math.floor(rand() * DAY);
    const single = reduce([dep(A, total, sharesPer * BigInt(n), 0), exit(A, (sharesPer * BigInt(n) * burnFrac) / 8n, tExit)], W);
    const events = [];
    for (let i = 0; i < n; i += 1) {
      events.push(dep(addr(0x3000 + i), each, sharesPer, 0));
      events.push(exit(addr(0x3000 + i), (sharesPer * burnFrac) / 8n, tExit));
    }
    const split = reduce(chrono(events), W);
    const sum = [...split.usdcSeconds.values()].reduce((s, v) => s + v, 0n);
    const slack = BigInt(n - 1) * BigInt(7 * DAY - tExit);
    assert.ok(sum <= secs(single, A) + slack, `trial ${trial}: split ${sum} exceeds single ${secs(single, A)} by more than ${slack}`);
  }
});

test('a missing log is an error, not a guess', () => {
  assert.throws(() => reduce([exit(A, 5n, 10)], W), /burns 5 of 0 shares/);
  assert.throws(() => reduce([dep(A, USDC, 10n, 0), dep(A, USDC, 10n, 5)], W), /does not raise the share balance/);
  assert.throws(() => reduce([dep(A, USDC, 10n, 100), dep(B, USDC, 10n, 50, { blockNumber: 5000 })], W), /timestamp goes backwards/);
  assert.throws(() => reduce([dep(A, USDC, 10n, 0, { blockNumber: 7 }), dep(B, USDC, 10n, 0, { blockNumber: 7 })], W), /share block 7 log 0/);
});
