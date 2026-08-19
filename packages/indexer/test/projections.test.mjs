// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll, leaderboard, vaultView, emptyState, apply } from '../src/projections.mjs';

const V = '0x' + '1'.repeat(40);
const A = '0x' + 'a'.repeat(40);
const B = '0x' + 'b'.repeat(40);

function ev(name, blockNumber, logIndex, vault, args) {
  return { name, vault, blockNumber, logIndex, args: { vault, ...args } };
}

test('vault creation + attestation + membership from events', () => {
  const events = [
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: '0x' + 'c'.repeat(40), capacityCapUsdc: 1000n }),
    ev('OperatorRegistered', 1, 1, V, { opId: 1, operator: A }),
    ev('VaultAttested', 1, 2, V, { opId: 1 }),
    ev('DepositActivated', 2, 0, V, { member: A, amountUsdc: 100n, sharesMinted: 100n * 10n ** 12n }),
    ev('DepositActivated', 3, 0, V, { member: B, amountUsdc: 50n, sharesMinted: 50n * 10n ** 12n }),
  ];
  const s = applyAll(events);
  const v = vaultView(s, V);
  assert.equal(v.creator, A);
  assert.equal(v.operatorId, 1);
  assert.equal(v.memberCount, 2);
  assert.equal(v.totalShares, 150n * 10n ** 12n);
  assert.equal(v.holders, 2);
});

test('exit reduces shares and member count', () => {
  const events = [
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 100n }),
    ev('ExitSettled', 2, 0, V, { member: A, sharesBurned: 100n }),
  ];
  const s = applyAll(events);
  assert.equal(vaultView(s, V).memberCount, 0);
  assert.equal(vaultView(s, V).totalShares, 0n);
});

test('replay is order-independent (sorted by block, logIndex)', () => {
  const events = [
    ev('DepositActivated', 3, 0, V, { member: B, sharesMinted: 50n }),
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 0n }),
    ev('DepositActivated', 2, 0, V, { member: A, sharesMinted: 100n }),
  ];
  const forward = applyAll(events);
  const reversed = applyAll([...events].reverse());
  assert.equal(forward.vaults.get(V).totalShares, reversed.vaults.get(V).totalShares);
  assert.equal(forward.vaults.get(V).creator, A); // creation applied before deposits
});

test('observation-window pending count tracks pending/activate/cancel', () => {
  const s = emptyState();
  apply(s, ev('DepositPending', 1, 0, V, { member: A }));
  apply(s, ev('DepositPending', 1, 1, V, { member: B }));
  assert.equal(vaultView(s, V).pendingCount, 2);
  apply(s, ev('PendingCancelled', 2, 0, V, { member: B }));
  assert.equal(vaultView(s, V).pendingCount, 1);
  apply(s, ev('DepositActivated', 3, 0, V, { member: A, sharesMinted: 10n }));
  assert.equal(vaultView(s, V).pendingCount, 0);
});

test('sub-vault parent/depth from ChildRegistered', () => {
  const child = '0x' + '2'.repeat(40);
  const s = applyAll([
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 0n }),
    ev('VaultCreated', 1, 1, child, { creator: A, usdc: A, capacityCapUsdc: 0n }),
    { name: 'ChildRegistered', vault: child, blockNumber: 1, logIndex: 2, args: { parent: V, child, depth: 1 } },
  ]);
  assert.equal(vaultView(s, child).parent, V);
  assert.equal(vaultView(s, child).depth, 1);
});

test('leaderboard aggregates all vaults, sorts by net realized (SF-4)', () => {
  const s = applyAll([
    ev('OperatorRegistered', 1, 0, V, { opId: 1, operator: A }),
    ev('OperatorRegistered', 1, 1, V, { opId: 2, operator: B }),
    // op1: +300 gain, -100 loss => net +200
    { name: 'RealizationRecorded', vault: V, blockNumber: 2, logIndex: 0, args: { opId: 1, gainUsdc: 300n, lossUsdc: 0n } },
    { name: 'RealizationRecorded', vault: V, blockNumber: 2, logIndex: 1, args: { opId: 1, gainUsdc: 0n, lossUsdc: 100n } },
    // op2: +500 net
    { name: 'RealizationRecorded', vault: V, blockNumber: 2, logIndex: 2, args: { opId: 2, gainUsdc: 500n, lossUsdc: 0n } },
    { name: 'FeeRecorded', vault: V, blockNumber: 3, logIndex: 0, args: { opId: 1, amountUsdc: 30n } },
  ]);
  const lb = leaderboard(s);
  assert.equal(lb.length, 2);
  assert.equal(lb[0].operatorId, 2); // higher net first
  assert.equal(lb[0].netRealizedUsdc, 500n);
  assert.equal(lb[1].netRealizedUsdc, 200n);
  assert.equal(lb[1].lifetimeFeesUsdc, 30n);
});

test('a closed vault keeps contributing to operator net (no cherry-picking, SF-5)', () => {
  // losses recorded stay in the aggregate even after everyone exits.
  const s = applyAll([
    ev('OperatorRegistered', 1, 0, V, { opId: 1, operator: A }),
    { name: 'RealizationRecorded', vault: V, blockNumber: 2, logIndex: 0, args: { opId: 1, gainUsdc: 0n, lossUsdc: 400n } },
    ev('DepositActivated', 1, 1, V, { member: A, sharesMinted: 10n }),
    ev('ExitSettled', 3, 0, V, { member: A, sharesBurned: 10n }), // vault emptied
  ]);
  assert.equal(vaultView(s, V).totalShares, 0n);
  assert.equal(leaderboard(s)[0].lifetimeLossUsdc, 400n); // loss persists
});
