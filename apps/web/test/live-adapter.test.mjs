// @ts-check
/**
 * Tests the live-API → UI shape mappers. These guard the join between the metered API's
 * event-derived JSON and the fields the Vault Atlas renderers read, so a live-mode render can't
 * crash on a missing field or misread base-unit amounts as dollars.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usdFromBase, shortAddr, mapLeaderboard, mapVaults } from '../src/live-adapter.mjs';

test('usdFromBase converts 6dp base units to whole dollars', () => {
  assert.equal(usdFromBase('6000000000000'), 6_000_000); // $6M cap
  assert.equal(usdFromBase('10000'), 0.01);
  assert.equal(usdFromBase('-100000000'), -100); // net can be negative
  assert.equal(usdFromBase(undefined), 0);
  assert.equal(usdFromBase('not-a-number'), 0);
});

test('shortAddr truncates, tolerates junk', () => {
  assert.equal(shortAddr('0x1234567890abcdef1234567890abcdef12345678'), '0x1234…5678');
  assert.equal(shortAddr(''), '?');
});

test('mapLeaderboard: base units → dollars, address → label, rank by order', () => {
  const rows = [
    { operatorId: 2, operator: '0x' + 'a'.repeat(40), netRealizedUsdc: '412000000000', lifetimeGainUsdc: '512000000000', lifetimeLossUsdc: '100000000000', lifetimeFeesUsdc: '41200000000', vaultCount: 2 },
  ];
  const [o] = mapLeaderboard(rows);
  assert.equal(o.rank, 1);
  assert.equal(o.operator, '0xaaaa…aaaa');
  assert.equal(o.net, 412_000);
  assert.equal(o.gain, 512_000);
  assert.equal(o.vaultCount, 2);
  assert.deepEqual(mapLeaderboard(undefined), []);
});

test('mapVaults produces every field the renderers read, with safe placeholders', () => {
  const V = '0x' + '1'.repeat(40);
  const list = [{ vault: V, operatorId: 3, memberCount: 5, depth: 1, parent: '0x' + '2'.repeat(40), capacityCapUsdc: '1000000000', attested: true }];
  const board = [{ operatorId: 3, operator: '0x' + 'b'.repeat(40) }];
  const [v] = mapVaults(list, board, 42);

  // Fields renderVault/vaultCard dereference without guards:
  assert.equal(typeof v.navPs.toFixed, 'function');
  assert.equal(v.exitFee.reduce((a, b) => a + b, 0), 0);
  assert.deepEqual(v.hist, [1]);
  assert.deepEqual(v.basket, []);
  assert.equal(v.proposal, null);
  assert.equal(v.frozen, false);
  // Mapped data:
  assert.equal(v.vault, V);
  assert.equal(v.members, 5);
  assert.equal(v.depth, 1);
  assert.equal(v.capUsd, 1000); // $1000 cap from base units
  assert.equal(v.operator, '0xbbbb…bbbb'); // resolved via leaderboard join
  assert.equal(v.verified, true);
  assert.equal(v.asOf, 'block 42');
  assert.equal(v.live, true);
});

test('mapVaults flags an unattested vault (operatorId 0) as quarantined', () => {
  const [v] = mapVaults([{ vault: '0x' + '5'.repeat(40), operatorId: 0, memberCount: 0, capacityCapUsdc: '0' }], [], 7);
  assert.equal(v.unattested, true);
  assert.equal(v.verified, false);
  assert.equal(v.operator, 'unattested');
  assert.equal(v.capUsd, 0); // uncapped renders as "uncapped" in the UI
});
