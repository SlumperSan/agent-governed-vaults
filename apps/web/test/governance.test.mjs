// @ts-check
/**
 * Exit-mode resolution. These are the tests that stop the app telling someone their exit settles
 * instantly when the chain would queue it irrevocably.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  proposalPhase, hasPendingExecution, resolveExitMode, quorumReadout, proposalRight,
  PROPOSAL_UNKNOWN, QUORUM_FLOOR_BPS,
} from '../src/governance.mjs';

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

test('NO PROPOSAL DATA is a sentinel, and never reads as "no proposal"', () => {
  // GET /vaults carries no proposal field at all. `null` means KNOWN-ABSENT and resolves to
  // Mode I — "exits settle in the same transaction" — on every live vault, while the banner two
  // inches above says the mode cannot be resolved. The source must say unknown instead.
  assert.equal(hasPendingExecution(PROPOSAL_UNKNOWN, T), null);
  assert.equal(hasPendingExecution(null, T), false, 'and a known-absent proposal still resolves');

  const m = resolveExitMode(PROPOSAL_UNKNOWN, T);
  assert.equal(m.mode, 'unknown');
  assert.match(m.detail, /no proposal information/i);
  assert.match(m.detail, /irrevocable/i);
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

test('quorum is measured against the VAULT’s quorumBps, not the 2500 protocol floor', () => {
  // Governance.sol:547 — `revealedWeight * BPS >= configOf[vault].quorumBps * snapshotTotal`.
  // QUORUM_FLOOR_BPS is only the lower BOUND on what a vault may configure; a vault set at 50%
  // is not at quorum because it cleared 26%.
  const shortOfIts60 = quorumReadout({ revealedWeight: 3000n, snapshotTotal: 10_000n, memberCount: 20, quorumBps: 6000 });
  assert.equal(shortOfIts60.regime, 'stake');
  assert.equal(shortOfIts60.bps, 3000);
  assert.equal(shortOfIts60.met, false, '30% does not meet a vault configured at 60%');
  assert.match(shortOfIts60.text, /60\.00% required by this vault/);

  const atFloor = quorumReadout({ revealedWeight: 3000n, snapshotTotal: 10_000n, memberCount: 20, quorumBps: QUORUM_FLOOR_BPS });
  assert.equal(atFloor.met, true);
  assert.equal(quorumReadout({ revealedWeight: 1000n, snapshotTotal: 10_000n, memberCount: 20, quorumBps: 2500 }).met, false);

  // ARCHITECTURE §6 / K-3: the numerator is revealed weight — standing defaults move the tally
  // but never the quorum, which is why a proposal can read as passing and still fail.
  assert.equal(quorumReadout({ revealedWeight: 0n, forWeight: 9000n, snapshotTotal: 10_000n, memberCount: 20, quorumBps: 2500 }).met, false);
});

test('an unexposed quorumBps is unknown — never silently the floor', () => {
  const q = quorumReadout({ revealedWeight: 3000n, snapshotTotal: 10_000n, memberCount: 20 });
  assert.equal(q.met, null);
  assert.equal(q.quorumBps, null);
  assert.match(q.text, /25% to 100%/);
});

test('a RuleChange has NO stake quorum — it needs FULL CONSENSUS', () => {
  // Governance.sol:511-514 — revealedWeight == snapshotTotal && forWeight >= snapshotTotal.
  // Reporting "0.00% of eligible stake revealed · 25% floor" against this is the wrong answer,
  // not a rounding one.
  const base = { ptype: 'RuleChange', memberCount: 20, quorumBps: 2500 };
  const none = quorumReadout({ ...base, revealedWeight: 0n, forWeight: 0n, snapshotTotal: 10_000n });
  assert.equal(none.regime, 'consensus');
  assert.equal(none.met, false);
  assert.match(none.text, /full consensus/i);
  assert.match(none.text, /100%/);

  const partial = quorumReadout({ ...base, revealedWeight: 9_999n, forWeight: 9_999n, snapshotTotal: 10_000n });
  assert.equal(partial.met, false, 'one unrevealed share defeats it');

  const full = quorumReadout({ ...base, revealedWeight: 10_000n, forWeight: 10_000n, snapshotTotal: 10_000n });
  assert.equal(full.met, true);

  // Revealed in full but not all FOR: consensus is on the FOR side, not on turnout.
  const against = quorumReadout({ ...base, revealedWeight: 10_000n, forWeight: 9_000n, snapshotTotal: 10_000n });
  assert.equal(against.met, false);
});

test('under 5 members it is headMajorityWithStake OR forStakeMajority, not a signer count', () => {
  // Governance.sol:530-544. Both branches count FOR weight; `revealedVoterCount` alone decides
  // nothing, and branch 2 passes on stake with no head majority at all.
  // `delegatedForWeight` is stated as 0n rather than omitted: every assertion below is about the
  // NO-CRANKED-WEIGHT case, and omitting it makes the readout `null` (unknown) by design (VO-2b).
  const base = { memberCount: 4, snapshotTotal: 10_000n, quorumBps: 2500, delegatedForWeight: 0n };

  // 3 of 4 revealed, FOR weight 3000 ≥ 25% of snapshot ⇒ branch 1 passes.
  const b1 = quorumReadout({ ...base, revealedVoterCount: 3, revealedWeight: 3000n, forWeight: 3000n });
  assert.equal(b1.regime, 'signers');
  assert.equal(b1.met, true);
  assert.match(b1.text, /3 of 4/);

  // Same head majority, but the FOR side carries only 1% — branch 1 fails on stake, and the old
  // bare-signer reading would have called this quorum.
  assert.equal(quorumReadout({ ...base, revealedVoterCount: 3, revealedWeight: 3000n, forWeight: 100n }).met, false);

  // One voter of four, but 60% of stake voting FOR ⇒ branch 2 passes with no head majority.
  assert.equal(quorumReadout({ ...base, revealedVoterCount: 1, revealedWeight: 6000n, forWeight: 6000n }).met, true);

  // Head majority but no configured quorum to test branch 1 against, and no stake majority:
  // genuinely unknown, not false.
  assert.equal(quorumReadout({ ...base, quorumBps: undefined, revealedVoterCount: 3, forWeight: 3000n }).met, null);
});

test('sub-five: cranked FOR weight is subtracted out of both stake terms (VO-2b)', () => {
  // The contract measures `forWeight - delegatedForWeight[pid]`. A readout that used raw `forWeight`
  // would tell a member a proposal is at quorum that `finalize` will Defeat.
  const base = { memberCount: 3, snapshotTotal: 3_000n, quorumBps: 2500, revealedVoterCount: 1 };

  // One member's own 1000 plus one cranked 1000: raw forWeight 2000 clears a FOR majority of 3000,
  // self-directed 1000 does not. This is the three-member attack from AuditDelegatedQuorum.t.sol.
  const cranked = quorumReadout({ ...base, revealedWeight: 1_000n, forWeight: 2_000n, delegatedForWeight: 1_000n });
  assert.equal(cranked.met, false, 'one live voter does not carry a sub-five FOR majority');
  assert.equal(cranked.forBps, 3333, 'the FOR figure shown is the self-directed one');

  // The same tally with that weight self-revealed instead passes: the quantity, not the total.
  const selfRevealed = quorumReadout({ ...base, revealedVoterCount: 2, revealedWeight: 2_000n, forWeight: 2_000n, delegatedForWeight: 0n });
  assert.equal(selfRevealed.met, true);

  // Omitted entirely ⇒ unknown, never guessed at zero.
  const unknown = quorumReadout({ ...base, revealedWeight: 1_000n, forWeight: 2_000n });
  assert.equal(unknown.met, null);
  assert.match(unknown.text, /not exposed/);
});

test('sub-five BRANCH 1: the subtraction decides the stake gate, with branch 2 false throughout', () => {
  // The cases above never reach branch 1's stake term. At 3 members with 1 revealer there is no head
  // majority, so `met` is settled by `!headMajority ? false` and the term is never evaluated; the
  // 4-member case in the test above that DOES reach it passes `delegatedForWeight: 0n`, so the
  // subtraction is a no-op there. Computing this gate on raw `forW` therefore survived all 232 node
  // tests -- the same gap the contract had until
  // `AuditDelegatedQuorum.t.sol:test_ATTACK_subFive_branchOne_isNotCarriedByCrankedWeight`.
  //
  // 4 members, 3 revealed (head majority), quorum 25% of 10,000 = 2,500. Branch 2 is false in every
  // case below, so branch 1 alone decides each one.
  const SNAP = 10_000n;
  const base = { memberCount: 4, snapshotTotal: SNAP, quorumBps: 2500, revealedVoterCount: 3 };
  // Derived from each case's OWN inputs, never asserted over literals: a comparison of two constants
  // tests its own arithmetic and would stay green if the inputs below were edited out from under it.
  const branchTwoIsFalse = ({ forWeight, delegatedForWeight }) => (forWeight - delegatedForWeight) * 2n <= SNAP;

  // RAW forWeight 3,000 clears 2,500; self-directed 2,000 does not. Reverting the subtraction here
  // flips this to `true` and tells a member they are at quorum that `finalize` will Defeat.
  const crankedIn = { revealedWeight: 2_000n, forWeight: 3_000n, delegatedForWeight: 1_000n };
  const cranked = quorumReadout({ ...base, ...crankedIn });
  assert.ok(branchTwoIsFalse(crankedIn), 'branch 2 must be false here, or branch 1 is not what decides');
  assert.equal(cranked.met, false, 'a crank must not supply the stake branch 1 asks for');
  assert.equal(cranked.forBps, 2000, 'and the figure shown is the self-directed one');

  // The other direction, so the term is not merely always-false: self-directed 3,000 clears 2,500 on
  // its own with a crank still present, and branch 2 is still false.
  const passesIn = { revealedWeight: 3_000n, forWeight: 4_000n, delegatedForWeight: 1_000n };
  const passes = quorumReadout({ ...base, ...passesIn });
  assert.ok(branchTwoIsFalse(passesIn), 'branch 2 must be false here too');
  assert.equal(passes.met, true, 'branch 1 still passes on self-directed stake alone');
  assert.equal(passes.forBps, 3000);
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
