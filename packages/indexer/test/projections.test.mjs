// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyAll, leaderboard, vaultView, emptyState, apply, memberPosition, modeFExitRateBps, queuedExitBacklog, MAX_TRACKED_ADAPTERS } from '../src/projections.mjs';

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

test('vaultCount increments on attestation (regression: leaderboard was always 0)', () => {
  const V2 = '0x' + '5'.repeat(40);
  const s = applyAll([
    ev('OperatorRegistered', 1, 0, V, { opId: 1, operator: A }),
    ev('VaultCreated', 1, 1, V, { creator: A, usdc: A, capacityCapUsdc: 0n }),
    ev('VaultAttested', 1, 2, V, { opId: 1 }),
    ev('VaultCreated', 2, 0, V2, { vault: V2, creator: A, usdc: A, capacityCapUsdc: 0n }),
    { name: 'VaultAttested', vault: V2, blockNumber: 2, logIndex: 1, args: { vault: V2, opId: 1 } },
  ]);
  assert.equal(leaderboard(s)[0].vaultCount, 2, 'both attested vaults counted');
});

test('proposal lifecycle projects Active -> Passed -> Executed', () => {
  const s = applyAll([
    ev('VaultCreated', 1, 0, V, { creator: A, usdc: A, capacityCapUsdc: 0n }),
    { name: 'Proposed', vault: V, blockNumber: 2, logIndex: 0, args: { pid: 1, vault: V, ptype: 0, proposer: A } },
    { name: 'Revealed', vault: V, blockNumber: 3, logIndex: 0, args: { pid: 1, voter: A, support: true, weight: 1000n } },
    { name: 'Revealed', vault: V, blockNumber: 3, logIndex: 1, args: { pid: 1, voter: B, support: false, weight: 300n } },
    { name: 'Finalized', vault: V, blockNumber: 4, logIndex: 0, args: { pid: 1, status: 2 } },
  ]);
  const p = vaultView(s, V).activeProposal;
  assert.equal(p.status, 'Passed');
  assert.equal(p.forWeight, 1000n);
  assert.equal(p.againstWeight, 300n);
  assert.equal(p.revealedVoters, 2);

  apply(s, { name: 'Executed', vault: V, blockNumber: 5, logIndex: 0, args: { pid: 1 } });
  assert.equal(vaultView(s, V).activeProposal, null, 'executed clears the active proposal');
  assert.equal(s.proposals.get(1).status, 'Executed');
});

test('standing default counts in tally but not quorum (revealedWeight)', () => {
  const s = applyAll([
    { name: 'Proposed', vault: V, blockNumber: 1, logIndex: 0, args: { pid: 2, vault: V, ptype: 0, proposer: A } },
    { name: 'Revealed', vault: V, blockNumber: 2, logIndex: 0, args: { pid: 2, voter: A, support: true, weight: 500n } },
    { name: 'DefaultApplied', vault: V, blockNumber: 2, logIndex: 1, args: { pid: 2, member: B, support: true, weight: 400n } },
  ]);
  const p = s.proposals.get(2);
  assert.equal(p.forWeight, 900n, 'default in tally');
  assert.equal(p.revealedWeight, 500n, 'default NOT in quorum');
});

test('a queued exit settled by its own member is counted as Mode-F', () => {
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 100n }),
    ev('ExitQueued', 2, 0, V, { member: A, shares: 100n }),
    ev('ExitSettled', 3, 0, V, { member: A, sharesBurned: 100n }),
  ]);
  assert.equal(vaultView(s, V).exitQueuedCount, 1);
  assert.equal(vaultView(s, V).exitSettledCount, 1);
  assert.equal(vaultView(s, V).modeFSettledCount, 1);
  assert.equal(modeFExitRateBps(s, V), 10000, 'one queued, one settled == 100% Mode-F');
  assert.equal(queuedExitBacklog(s, V), 0, 'the queue entry was consumed by the settlement');
});

test('an ExitSettled with no queue entry for that member is Mode I, not Mode-F', () => {
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 100n }),
    ev('DepositActivated', 1, 1, V, { member: B, sharesMinted: 100n }),
    ev('ExitQueued', 2, 0, V, { member: A, shares: 100n }),
    ev('ExitSettled', 3, 0, V, { member: B, sharesBurned: 100n }), // B never queued -> Mode I
    ev('ExitSettled', 4, 0, V, { member: A, sharesBurned: 100n }), // A queued -> Mode F
  ]);
  assert.equal(vaultView(s, V).exitSettledCount, 2);
  assert.equal(vaultView(s, V).modeFSettledCount, 1, "B's instant exit must not be attributed to the queue");
  assert.equal(modeFExitRateBps(s, V), 5000, 'one of two settled exits went through the queue');
});

test('modeFExitRateBps is null for an unknown vault or a vault with no settled exits', () => {
  const unknown = '0x' + '9'.repeat(40);
  const s = applyAll([ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 100n })]);
  assert.equal(modeFExitRateBps(s, unknown), null);
  assert.equal(modeFExitRateBps(s, V), null, 'no ExitSettled yet');
});

test('modeFExitRateBps is a partition and can never exceed 10000, backlog is reported separately', () => {
  // Three members queue; only one settles. The old counts-over-counts shortcut read this as 300%.
  // VaultCore permits ONE queued exit per member (requestExit: ExitAlreadyQueued), so three queue
  // entries mean three distinct members — and two of them are still stranded (§3.6).
  const C = '0x' + '7'.repeat(40);
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 100n }),
    ev('DepositActivated', 1, 1, V, { member: B, sharesMinted: 100n }),
    ev('DepositActivated', 1, 2, V, { member: C, sharesMinted: 100n }),
    ev('ExitQueued', 2, 0, V, { member: A, shares: 100n }),
    ev('ExitQueued', 3, 0, V, { member: B, shares: 100n }),
    ev('ExitQueued', 4, 0, V, { member: C, shares: 100n }),
    ev('ExitSettled', 5, 0, V, { member: A, sharesBurned: 100n }),
  ]);
  assert.equal(vaultView(s, V).exitQueuedCount, 3);
  assert.equal(modeFExitRateBps(s, V), 10000, 'the ONE settled exit was a Mode-F one: 100%, never 300%');
  assert.ok(modeFExitRateBps(s, V) <= 10000, 'a partition can never exceed 100%');
  assert.equal(queuedExitBacklog(s, V), 2, 'B and C are still stranded in the queue');
});

test('stat-only events (SliceEscrowed, EscrowClaimed, ModuleCallFailed, FeeAssessed, FeeCredited, '
  + 'FeesClaimed, VaultRegistered, Committed, SwapExecuted) are counted with a last-seen cursor, not dropped', () => {
  const s = emptyState();
  apply(s, ev('SliceEscrowed', 1, 0, V, { member: A, asset: '0x' + '3'.repeat(40), amount: 10n }));
  apply(s, ev('SliceEscrowed', 2, 0, V, { member: A, asset: '0x' + '3'.repeat(40), amount: 5n }));
  apply(s, ev('EscrowClaimed', 3, 0, V, { member: A, asset: '0x' + '3'.repeat(40), amount: 10n }));
  apply(s, ev('ModuleCallFailed', 4, 0, V, { module: '0x' + '0'.repeat(64), member: A }));
  apply(s, ev('FeeAssessed', 5, 0, V, { member: A, netGain: 100n, fee: 10n }));
  apply(s, ev('FeeCredited', 6, 0, V, { opId: 1, token: A, amount: 10n }));
  apply(s, ev('FeesClaimed', 7, 0, V, { operator: A, token: A, amount: 10n }));
  apply(s, ev('VaultRegistered', 8, 0, V, {
    config: { commitDuration: 3600, revealDuration: 3600, timelockDuration: 0, executionWindow: 3600, quorumBps: 2500, proposalThresholdBps: 0, concentrationCapBps: 5000, proposalCooldown: 0 },
  }));
  apply(s, ev('Committed', 9, 0, V, { pid: 1, voter: A }));
  apply(s, ev('SwapExecuted', 10, 0, V, { tokenIn: A, tokenOut: B, amountIn: 100n, amountOut: 99n }));

  assert.equal(s.eventStats.get('SliceEscrowed').count, 2);
  assert.equal(s.eventStats.get('SliceEscrowed').lastBlock, 2);
  assert.equal(s.eventStats.get('EscrowClaimed').count, 1);
  assert.equal(s.eventStats.get('ModuleCallFailed').count, 1);
  assert.equal(s.eventStats.get('FeeAssessed').count, 1);
  assert.equal(s.eventStats.get('FeeCredited').count, 1);
  assert.equal(s.eventStats.get('FeesClaimed').count, 1);
  assert.equal(s.eventStats.get('VaultRegistered').count, 1);
  assert.equal(s.eventStats.get('Committed').count, 1);
  assert.equal(s.eventStats.get('SwapExecuted').lastLogIndex, 0);
});

test('RebalanceExecuted learns the adapter address into state.adapters', () => {
  const ADAPTER = '0x' + '7'.repeat(40);
  const s = applyAll([ev('RebalanceExecuted', 1, 0, V, { adapter: ADAPTER, orderCount: 3n })]);
  assert.ok(s.adapters.has(ADAPTER));
  assert.equal(s.eventStats.get('RebalanceExecuted').count, 1);
});

test('memberPosition reports shares and vault fraction', () => {
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 750n }),
    ev('DepositActivated', 1, 1, V, { member: B, sharesMinted: 250n }),
  ]);
  assert.equal(memberPosition(s, V, A).shares, 750n);
  assert.equal(memberPosition(s, V, A).shareOfVaultBps, 7500);
  assert.equal(memberPosition(s, V, '0x' + '9'.repeat(40)).shares, 0n);
});

/**
 * `state.adapters` is the PERSISTED adapter set: it is written into every snapshot and it is what a
 * restart re-seeds the poller from. It is reachable by anybody — `createVault` is permissionless and
 * `allowedAdapters` is caller-supplied — so it needs the same ceiling the poll set has.
 *
 * It did not have one. An earlier revision bounded only the rpc-module-local set while a comment in
 * that module claimed the bound covered the set "persisted in the snapshot forever"; 500 hostile
 * RebalanceExecuted in one batch left 64 polled and 500 persisted. The bound is written as a
 * LITERAL here for the same reason as in rpc.test.mjs: `MAX_TRACKED_ADAPTERS + 1` follows the
 * constant and would stay green if the constant were raised to 100000.
 */
test('the persisted adapter set is bounded at exactly 64, at and above the boundary', () => {
  const adapterAt = (i) => '0x' + i.toString(16).padStart(40, '0');
  const rebalances = (n) => Array.from({ length: n }, (_, i) => ev('RebalanceExecuted', 14, i, V, { adapter: adapterAt(i + 1), orderCount: 0n }));

  assert.equal(MAX_TRACKED_ADAPTERS, 64, 'the literal these boundaries are written against');

  const under = applyAll(rebalances(64));
  assert.equal(under.adapters.size, 64, 'the 64th adapter must still be recorded');
  assert.ok(under.adapters.has(adapterAt(64)));

  const over = applyAll(rebalances(500));
  assert.equal(over.adapters.size, 64, 'the persisted set must not grow past the ceiling');
  assert.ok(!over.adapters.has(adapterAt(65)), 'the 65th must not be persisted');
});

/**
 * THE SOAK FINDING. During the Base Sepolia soak a member holding roughly a fifth of a vault read
 * `votingEligibleShares` 0 on-chain and nothing off-chain said so: `memberPosition` returned
 * `shares` and `shareOfVaultBps` only, so the member's own position page could show 20% of the
 * vault beside a weight the contract treats as nothing.
 *
 * The two assertions belong in one block deliberately. A material `shareOfVaultBps` alone is not
 * the finding, and a zero eligible weight alone is not either — the finding is the two coexisting
 * with no third field reconciling them.
 */
test('a member holding a fifth of the vault with a queued Mode-F exit reads zero voting weight, and the projection says so', () => {
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 2_000n }),
    ev('DepositActivated', 1, 1, V, { member: B, sharesMinted: 8_000n }),
    ev('ExitQueued', 2, 0, V, { member: A, shares: 2_000n }),
  ]);
  const pos = memberPosition(s, V, A);

  assert.equal(pos.shares, 2_000n, 'queued shares stay outstanding until settlement');
  assert.equal(pos.shareOfVaultBps, 2000, 'a fifth of the vault');
  assert.equal(pos.queuedExitShares, 2_000n);
  assert.equal(pos.votingEligibleShares, 0n, 'VaultCore.votingEligibleShares: sharesOf - queuedExitShares');
  assert.ok(pos.votingEligibleNote, 'the zero must be explained, not merely reported');
  assert.match(pos.votingEligibleNote, /2000/, 'the note names the locked amount');
  assert.match(pos.votingEligibleNote, /settleQueuedExit/, 'and how it resolves');

  // B queued nothing, so B keeps a full weight and gets no note.
  const other = memberPosition(s, V, B);
  assert.equal(other.queuedExitShares, 0n);
  assert.equal(other.votingEligibleShares, 8_000n);
  assert.equal(other.votingEligibleNote, null);
});

test('a PARTIAL queued exit subtracts rather than zeroing', () => {
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 1_000n }),
    ev('ExitQueued', 2, 0, V, { member: A, shares: 400n }),
  ]);
  const pos = memberPosition(s, V, A);
  assert.equal(pos.queuedExitShares, 400n);
  assert.equal(pos.votingEligibleShares, 600n);
  assert.ok(pos.votingEligibleNote, 'a partial lock is still withheld weight and still needs saying');
});

test('settling the queued exit clears the lock from the projection', () => {
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 1_000n }),
    ev('ExitQueued', 2, 0, V, { member: A, shares: 400n }),
    ev('ExitSettled', 3, 0, V, { member: A, sharesBurned: 400n }),
  ]);
  const pos = memberPosition(s, V, A);
  assert.equal(pos.shares, 600n);
  assert.equal(pos.queuedExitShares, 0n);
  assert.equal(pos.votingEligibleShares, 600n);
  assert.equal(pos.votingEligibleNote, null);
});

/**
 * The second way `votingEligibleShares` returns zero on material stake, and the one a lock-only
 * field would report wrongly: `VaultCore.votingEligibleShares` opens with
 * `if (member == parentVault()) return 0` (VaultCore.sol:1025-1027), so a registered parent's
 * position in its child carries no weight at all, queued exit or not.
 */
test('a registered parent vault holds shares in its child and votes with none of them', () => {
  const P = '0x' + 'p'.replace('p', '2').repeat(40);
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: P, sharesMinted: 5_000n }),
    ev('DepositActivated', 1, 1, V, { member: B, sharesMinted: 5_000n }),
    ev('ChildRegistered', 2, 0, V, { child: V, parent: P, depth: 1 }),
  ]);
  const pos = memberPosition(s, V, P);
  assert.equal(pos.shares, 5_000n);
  assert.equal(pos.shareOfVaultBps, 5000);
  assert.equal(pos.queuedExitShares, 0n, 'nothing is queued: the lock is not why this reads zero');
  assert.equal(pos.votingEligibleShares, 0n);
  assert.ok(pos.votingEligibleNote, 'and the reason must be the parent carve-out, not a queued exit');
  assert.match(pos.votingEligibleNote, /parent/i);
});

/**
 * The same over-report reachable without a snapshot at all: an ExitQueued whose `shares` argument
 * is missing. `abis.mjs` decodes `shares` from a non-indexed field of a two-field event, so a
 * well-formed log always carries it and this is unreachable in production — but it is the identical
 * class to the resumed-snapshot gap, and the old `?? 0n` default failed the same way: the size book
 * would record "nothing locked" for a member the queued set says IS locked. The entry is left out
 * instead, which puts the member in the honest "locked, amount unknown" state.
 */
test('an ExitQueued with no amount records the lock as unknown, never as zero', () => {
  const s = applyAll([
    ev('DepositActivated', 1, 0, V, { member: A, sharesMinted: 2_000n }),
    ev('DepositActivated', 1, 1, V, { member: B, sharesMinted: 8_000n }),
    ev('ExitQueued', 2, 0, V, { member: A }), // no `shares`
  ]);
  assert.equal(queuedExitBacklog(s, V), 1, 'the member is queued either way');
  assert.equal(s.queuedExitShares.get(V)?.has(A) ?? false, false, 'and no size was invented for them');

  const pos = memberPosition(s, V, A);
  assert.equal(pos.shares, 2_000n);
  assert.equal(pos.queuedExitShares, null, 'unknown, not 0n');
  assert.equal(pos.votingEligibleShares, null, 'so no eligible number is served');
  assert.notEqual(pos.votingEligibleNote, null);
  assert.match(pos.votingEligibleNote, /does not know/);

  // And the discriminator still resolves at settlement, exactly as it does with a known size.
  apply(s, ev('ExitSettled', 3, 0, V, { member: A, sharesBurned: 2_000n }));
  assert.equal(s.vaults.get(V).modeFSettledCount, 1, 'an unknown size is still a Mode-F settlement');
  assert.equal(memberPosition(s, V, A).votingEligibleNote, null, 'and the lock is gone from the report');
});
