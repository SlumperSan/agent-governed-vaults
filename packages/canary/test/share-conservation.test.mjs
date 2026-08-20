// @ts-check
/**
 * Signal (c) — share conservation, indexer projection vs chain read.
 *
 * The interesting coverage here is the HEIGHT handling: the indexer lags head by CONFIRMATIONS,
 * so an unpinned comparison would false-alarm on every deposit in the confirmation window. These
 * tests prove the read is pinned to the snapshot height, and that the pruned-node fallback stays
 * alive rather than going silently dead.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkShareConservation } from '../src/signals/share-conservation.mjs';
import { mockReader, healthyVault, VAULT, MEMBER, CREATOR } from './helpers.mjs';

const TOTAL = 500_000000000000000000n;
const book = new Map([[MEMBER, 400_000000000000000000n], [CREATOR, 100_000000000000000000n]]);

test('OK when the projection, the share book, and the chain all agree', async () => {
  const reader = mockReader({ contracts: healthyVault() });
  const [r] = await checkShareConservation({
    reader, vault: VAULT, projectedTotalShares: TOTAL, shareBook: book, atBlock: 995,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.pinned, true);
  assert.equal(r.detail.holders, 2);
});

test('pins the chain read to the indexer snapshot height, not to head', async () => {
  const reader = mockReader({ contracts: healthyVault() });
  await checkShareConservation({
    reader, vault: VAULT, projectedTotalShares: TOTAL, shareBook: book, atBlock: 995,
  });
  assert.equal(reader.calls[0].blockNumber, 995, 'an unpinned read races the confirmation lag');
});

test('ALERTS when the projection total disagrees with the chain', async () => {
  const reader = mockReader({ contracts: healthyVault() });
  const [r] = await checkShareConservation({
    reader, vault: VAULT, projectedTotalShares: TOTAL - 1n, shareBook: book, atBlock: 995,
  });
  assert.equal(r.status, 'alert');
  assert.match(r.message, /share conservation broken/);
  assert.match(r.message, /indexer totalShares .* vs chain/);
  assert.equal(r.measured, 'Δ 1 shares');
  assert.equal(r.threshold, 'exactly 0');
});

test('ALERTS when Σ sharesOf disagrees with the chain even though the folded total matches', async () => {
  const reader = mockReader({ contracts: healthyVault() });
  const skewed = new Map([[MEMBER, 399_000000000000000000n], [CREATOR, 100_000000000000000000n]]);
  const [r] = await checkShareConservation({
    reader, vault: VAULT, projectedTotalShares: TOTAL, shareBook: skewed, atBlock: 995,
  });
  assert.equal(r.status, 'alert');
  assert.match(r.message, /Σ sharesOf over 2 holders/);
});

test('falls back to head when the RPC has no archive state, and asks for two observations', async () => {
  const reader = mockReader({ contracts: healthyVault(), archiveBlocks: new Set() }); // pruned node
  const [r] = await checkShareConservation({
    reader, vault: VAULT, projectedTotalShares: TOTAL, shareBook: book, atBlock: 995,
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.detail.pinned, false);
  assert.equal(r.detail.minConsecutive, 2, 'an unpinned mismatch is racy — require it twice before paging');
  assert.match(r.message, /UNPINNED/);
});

test('DEGRADED, not OK, when totalShares() cannot be read at all', async () => {
  const reader = mockReader({ contracts: {} });
  const [r] = await checkShareConservation({
    reader, vault: VAULT, projectedTotalShares: TOTAL, shareBook: book, atBlock: 995,
  });
  assert.equal(r.status, 'skipped');
  assert.notEqual(r.status, 'ok');
});

test('an empty projection against a nonzero chain total ALERTS rather than reading as agreement', async () => {
  const reader = mockReader({ contracts: healthyVault() });
  const [r] = await checkShareConservation({
    reader, vault: VAULT, projectedTotalShares: 0n, shareBook: new Map(), atBlock: 995,
  });
  assert.equal(r.status, 'alert');
});
