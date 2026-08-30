// @ts-check
/**
 * Exit-mode resolution. These are the tests that stop the app telling someone their exit settles
 * instantly when the chain would queue it irrevocably.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalPhase, hasPendingExecution, resolveExitMode, quorumReadout, proposalRight } from '../src/governance.mjs';

const T = 1_800_000_000; // an arbitrary "now", in seconds
const HOUR = 3600;

test('Mode F begins at the COMMIT DEADLINE, not at passage', () => {
  // Governance.hasPendingExecution: status Active && now >= commitDeadline.
  // The brief and the UX spec both say "a rebalance has passed and is pending" — the contract
  // flips earlier, because once reveals start the outcome leaks on-chain (Governance.sol:27-30).
  const p = { status: 'Active', commitDeadline: T + HOUR, revealDeadline: T + 3 * HOUR };
  assert.equal(hasPendingExecution(p, T), false, 'still in commit — exits settle instantly');
  assert.equal(hasPendingExecution(p, T + HOUR), true, 'reveal opens: exits queue from here');
  assert.equal(hasPendingExecution(p, T + 2 * HOUR), true);
});

test('Mode F is not rebalance-specific — any proposal type forward-prices exits', () => {
  // activeProposalOf holds ONE proposal of ANY type; hasPendingExecution never reads ptype.
  for (const ptype of ['Rebalance', 'RuleChange', 'ChildAllocation']) {
    const p = { status: 'Active', ptype, commitDeadline: T - 1, revealDeadline: T + HOUR };
    assert.equal(resolveExitMode(p, T).mode, 'F', `${ptype} in reveal must still queue exits`);
  }
});

test('a Passed proposal holds Mode F until its execution window expires', () => {
  const p = { status: 'Passed', executableAt: T + HOUR, expiresAt: T + 10 * HOUR };
  assert.equal(hasPendingExecution(p, T), true);
  assert.equal(hasPendingExecution(p, T + 10 * HOUR), true);
  assert.equal(hasPendingExecution(p, T + 10 * HOUR + 1), false, 'EE-10: queued exits always settle eventually');
});

test('resolved outcomes release Mode F', () => {
  for (const status of ['Defeated', 'Executed', 'Expired']) {
    assert.equal(hasPendingExecution({ status }, T), false);
  }
  assert.equal(hasPendingExecution(null, T), false, 'no active proposal is a knowable Mode I');
});

test('MISSING DEADLINES RESOLVE TO UNKNOWN, never to Mode I', () => {
  // Governance.Proposed emits (pid, vault, ptype, proposer, actionHash) and no deadlines, so the
  // indexer cannot carry commitDeadline and the API cannot serve it. Assuming "instant" here is
  // the most expensive lie the app could tell.
  const fromApi = { status: 'Active', pid: 7, forWeight: '0', againstWeight: '0' };
  assert.equal(hasPendingExecution(fromApi, T), null);
  const m = resolveExitMode(fromApi, T);
  assert.equal(m.mode, 'unknown');
  assert.match(m.detail, /irrevocable|deadlines/i);

  assert.equal(hasPendingExecution({ status: 'Passed' }, T), null, 'Passed without expiresAt is also unknown');
});

test('proposalPhase walks commit → reveal → tally and marks the forfeit deadline', () => {
  const p = { status: 'Active', commitDeadline: T + HOUR, revealDeadline: T + 3 * HOUR };
  assert.equal(proposalPhase(p, T).phase, 'commit');
  assert.equal(proposalPhase(p, T).deadline, T + HOUR);
  const reveal = proposalPhase(p, T + 2 * HOUR);
  assert.equal(reveal.phase, 'reveal');
  assert.match(reveal.deadlineLabel, /forfeit/, 'an unrevealed commit is lost — say so on the countdown');
  assert.equal(proposalPhase(p, T + 4 * HOUR).phase, 'tally');
});

test('proposalPhase covers timelock, executable and terminal states', () => {
  const passed = { status: 'Passed', executableAt: T + HOUR, expiresAt: T + 10 * HOUR };
  assert.equal(proposalPhase(passed, T).phase, 'timelock');
  assert.equal(proposalPhase(passed, T + 2 * HOUR).phase, 'executable');
  assert.equal(proposalPhase(passed, T + 11 * HOUR).phase, 'expired');
  assert.equal(proposalPhase({ status: 'Executed' }, T).phase, 'executed');
  assert.equal(proposalPhase({ status: 'Defeated' }, T).phase, 'defeated');
  assert.equal(proposalPhase({ status: 'Active' }, T).phase, 'unknown', 'no deadlines ⇒ unknown');
});

test('quorum counts REVEALED weight only — standing defaults never count toward it', () => {
  // ARCHITECTURE §6 / K-3: defaults move the tally but not the quorum numerator, which is why a
  // proposal can look like it is passing while still short of quorum.
  const q = quorumReadout({ revealedWeight: 3000n, snapshotTotal: 10_000n, memberCount: 20 });
  assert.equal(q.regime, 'stake');
  assert.equal(q.bps, 3000);
  assert.equal(q.met, true);
  const short = quorumReadout({ revealedWeight: 1000n, snapshotTotal: 10_000n, memberCount: 20 });
  assert.equal(short.met, false);
});

test('under 5 members quorum is signers, so a percentage is the wrong unit', () => {
  const q = quorumReadout({ revealedWeight: 1n, snapshotTotal: 10n, memberCount: 4, revealedVoterCount: 3 });
  assert.equal(q.regime, 'signers');
  assert.equal(q.met, null);
  assert.match(q.text, /3 of 4/);
});

test('quorum is unknown, not zero, when the snapshot is not exposed', () => {
  const q = quorumReadout({ revealedWeight: undefined, snapshotTotal: undefined, memberCount: 20 });
  assert.equal(q.met, null);
  assert.match(q.text, /unknown/i);
});

test('proposalRight reports passive dilution below the proposal threshold', () => {
  // An operator diluted below the threshold permanently loses the right to propose anything —
  // including the RuleChange that would lower it (docs/NOW.md, Governance.sol M-6).
  const healthy = proposalRight({ stake: 800n, eligibleTotal: 10_000n, proposalThresholdBps: 500 });
  assert.equal(healthy.ok, true);
  assert.equal(healthy.bps, 800);
  assert.equal(healthy.headroomBps, 300);

  const diluted = proposalRight({ stake: 400n, eligibleTotal: 10_000n, proposalThresholdBps: 500 });
  assert.equal(diluted.ok, false);
  assert.equal(diluted.headroomBps, -100);

  assert.equal(proposalRight({ stake: 1n, eligibleTotal: 0n, proposalThresholdBps: 500 }), null);
});
