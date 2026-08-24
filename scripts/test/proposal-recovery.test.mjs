import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProposal } from '../proposal-recovery.mjs';

// The regression this file exists for: a real Base Sepolia run (2026-08-21) was interrupted by a
// machine restart between commit and reveal. On resume the runner walked straight into
// revealVote() against a shut window and died with WrongPhase, because recovery only handled
// Passed-and-lapsed proposals. These are the observed on-chain values from proposals(1).
const STRANDED_ACTIVE = {
  status: 'Active',
  now: 1787598122,
  expiresAt: 0,
  revealDeadline: 1787368590,
  revealedVoterCount: 0,
};

test('Active with a shut reveal window and no reveals is stranded, and finalize settles it', () => {
  const r = classifyProposal(STRANDED_ACTIVE);
  assert.equal(r.stranded, true);
  assert.equal(r.action, 'finalize', 'markExpired would revert — it rejects non-Passed proposals');
});

test('Active with a reveal already landed is NOT stranded — stepFinalize owns it', () => {
  const r = classifyProposal({ ...STRANDED_ACTIVE, revealedVoterCount: 1 });
  assert.equal(r.stranded, false, 'a revealed proposal past its deadline is ordinary work, not a recovery case');
  assert.equal(r.action, null);
});

test('Active still inside the reveal window is not stranded', () => {
  const r = classifyProposal({ ...STRANDED_ACTIVE, now: STRANDED_ACTIVE.revealDeadline - 1 });
  assert.equal(r.stranded, false);
  assert.equal(r.action, null);
});

test('Active exactly at the reveal deadline is stranded — finalize() uses >=', () => {
  const r = classifyProposal({ ...STRANDED_ACTIVE, now: STRANDED_ACTIVE.revealDeadline });
  assert.equal(r.stranded, true);
  assert.equal(r.action, 'finalize');
});

test('Passed past its execution window expires', () => {
  const r = classifyProposal({
    status: 'Passed', now: 2000, expiresAt: 1000, revealDeadline: 500, revealedVoterCount: 1,
  });
  assert.equal(r.stranded, true);
  assert.equal(r.action, 'markExpired');
});

test('Passed still inside its execution window is left alone', () => {
  const r = classifyProposal({
    status: 'Passed', now: 900, expiresAt: 1000, revealDeadline: 500, revealedVoterCount: 1,
  });
  assert.equal(r.stranded, false);
  assert.equal(r.action, null);
});

for (const status of ['Expired', 'Defeated']) {
  test(`${status} is stranded but needs no transaction`, () => {
    const r = classifyProposal({
      status, now: 2000, expiresAt: 1000, revealDeadline: 500, revealedVoterCount: 0,
    });
    assert.equal(r.stranded, true);
    assert.equal(r.action, null, 'already settled — sending anything would revert');
  });
}

test('Executed is never reclassified as stranded', () => {
  const r = classifyProposal({
    status: 'Executed', now: 9e9, expiresAt: 1000, revealDeadline: 500, revealedVoterCount: 1,
  });
  assert.equal(r.stranded, false);
});
