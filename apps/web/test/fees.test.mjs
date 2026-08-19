// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stackedPerfFeeBps, stackedExitFeeCapBps, effectiveFees, bpsToPct } from '../src/fees.mjs';

test('stacked perf fee compounds, not adds (matches SubVaultRegistry)', () => {
  assert.equal(stackedPerfFeeBps(1), 1000); // 10%
  assert.equal(stackedPerfFeeBps(2), 1900); // 19%, not 20%
  assert.equal(stackedPerfFeeBps(3), 2710); // 27.1%
});

test('stacked exit fee cap sums the chain', () => {
  assert.equal(stackedExitFeeCapBps([50, 50]), 100);
  assert.equal(stackedExitFeeCapBps([100, 100, 50]), 250);
});

test('effectiveFees breakdown for a depth-2 grandchild', () => {
  const f = effectiveFees(2, [50, 50, 50]);
  assert.equal(f.levels, 3);
  assert.equal(f.stackedPerfFeeBps, 2710);
  assert.equal(f.stackedExitFeeCapBps, 150);
});

test('bpsToPct formatting', () => {
  assert.equal(bpsToPct(1900), '19.00%');
  assert.equal(bpsToPct(50), '0.50%');
});
