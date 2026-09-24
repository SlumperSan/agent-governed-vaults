// @ts-check
/**
 * Tests for the governance startup preflight: `proposalPreflightVerdict` (pure, in `lib.mjs`) and
 * `checkVault` (its chain wiring, in `preflight-governance.mjs`, with the chain reads injected).
 *
 * Why `proposalPreflightVerdict` is pure and importable while the drills are not (per
 * `soak-deployment.test.mjs`'s own header): it takes an already-decoded proposal object and a
 * chain timestamp, no `cast`, no RPC. `checkVault` DOES reach the chain (`callU`/`readProposal`),
 * but takes them as injectable parameters specifically so this suite can drive it without one —
 * the same shape `buildIndexer(cfg, { client })` uses in `packages/indexer/test/index-runner.test.mjs`.
 *
 * These pin the exact scenario the coordinator diagnosed on chain (proposal 11 on the smoke vault,
 * Governance `0xD963f553e3eCd1872aF1622b3e4664f133A51805`: created 2026-09-09 21:49:20Z, reveal
 * deadline 23:49:20Z, still Active twelve days later, revealedVoterCount 0) as one of the cases,
 * plus the two others the addendum asked to be graded on: no active proposal, and one Active but
 * not yet past its reveal deadline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalPreflightVerdict } from '../soak/lib.mjs';
import { checkVault } from '../soak/preflight-governance.mjs';

// ── the exact measured scenario: proposal 11 on the smoke vault ──────────────────────────────

const CREATED_AT = Date.parse('2026-09-09T21:49:20Z') / 1000;
const COMMIT_DEADLINE = Date.parse('2026-09-09T22:49:20Z') / 1000;
const REVEAL_DEADLINE = Date.parse('2026-09-09T23:49:20Z') / 1000;
const TWELVE_DAYS_LATER = REVEAL_DEADLINE + 12 * 24 * 3600;

const measuredProposal11 = {
  status: 'Active', createdAt: CREATED_AT, commitDeadline: COMMIT_DEADLINE,
  revealDeadline: REVEAL_DEADLINE, expiresAt: 0,
};

test('the exact diagnosed case: proposal 11, Active, twelve days past its reveal deadline', () => {
  const v = proposalPreflightVerdict(measuredProposal11, { now: TWELVE_DAYS_LATER, pid: 11 });
  assert.equal(v.blocking, true);
  assert.equal(v.state, 'active-finalizable');
  assert.equal(v.remedyFn, 'finalize(uint256)');
  assert.match(v.message, /PAST its reveal deadline/);
  assert.match(v.message, /11/, 'must name the pid');
});

// ── the three cases the addendum specifically asked to be graded on ──────────────────────────

test('case 1: no active proposal — clear to proceed, says something true', () => {
  const v = proposalPreflightVerdict(null, { now: 1_000_000, pid: 0 });
  assert.equal(v.blocking, false);
  assert.equal(v.state, 'none');
  assert.equal(v.remedyFn, undefined);
});

test('case 2: Active, past its reveal deadline — blocks, and names finalize as the remedy', () => {
  const p = { status: 'Active', revealDeadline: 1000, expiresAt: 0 };
  const v = proposalPreflightVerdict(p, { now: 1500, pid: 42 });
  assert.equal(v.blocking, true);
  assert.equal(v.state, 'active-finalizable');
  assert.equal(v.remedyFn, 'finalize(uint256)');
  assert.match(v.message, /500s ago/);
});

test('case 3: Active, NOT yet past its reveal deadline — blocks, but gives no finalize remedy and states the ETA', () => {
  const p = { status: 'Active', revealDeadline: 1000, expiresAt: 0 };
  const v = proposalPreflightVerdict(p, { now: 400, pid: 42 });
  assert.equal(v.blocking, true);
  assert.equal(v.state, 'active-live');
  assert.equal(v.remedyFn, undefined, 'finalize would revert WrongPhase right now — must not be offered as a remedy');
  assert.match(v.message, /finalizable in 600s/);
  assert.match(v.message, /still in flight|wait/i);
});

// ── boundary: exactly at the deadline is finalizable (>=, matching Governance.sol:579) ───────

test('boundary: now === revealDeadline is finalizable, not "still live"', () => {
  const p = { status: 'Active', revealDeadline: 1000, expiresAt: 0 };
  const v = proposalPreflightVerdict(p, { now: 1000, pid: 1 });
  assert.equal(v.state, 'active-finalizable', 'Governance.sol:579 gates on >=, not >');
});

// ── settled statuses never block ──────────────────────────────────────────────────────────────

for (const status of ['Executed', 'Defeated', 'Expired']) {
  test(`a settled proposal (${status}) does not block`, () => {
    const v = proposalPreflightVerdict({ status, revealDeadline: 0, expiresAt: 0 }, { now: 999_999, pid: 5 });
    assert.equal(v.blocking, false);
    assert.equal(v.state, 'settled');
  });
}

// ── Passed: not the measured defect, but a verdict that must not be wrong either ─────────────

test('Passed, past its execution window, unmarked — blocks, and names markExpired (needs no payload)', () => {
  const p = { status: 'Passed', revealDeadline: 0, expiresAt: 1000 };
  const v = proposalPreflightVerdict(p, { now: 1001, pid: 7 });
  assert.equal(v.blocking, true);
  assert.equal(v.state, 'passed-expired-unmarked');
  assert.equal(v.remedyFn, 'markExpired(uint256)');
});

test('Passed, within its execution window — blocks, and offers NO generic remedy (execute needs the original payload)', () => {
  const p = { status: 'Passed', revealDeadline: 0, expiresAt: 1000 };
  const v = proposalPreflightVerdict(p, { now: 500, pid: 7 });
  assert.equal(v.blocking, true);
  assert.equal(v.state, 'passed-pending-execution');
  assert.equal(v.remedyFn, undefined, 'execute() needs a payload this preflight does not have — must not invent a remedy');
});

test('an unrecognised status blocks rather than silently reading as clear', () => {
  const v = proposalPreflightVerdict({ status: 'SomeFutureStatus', revealDeadline: 0, expiresAt: 0 }, { now: 1, pid: 9 });
  assert.equal(v.blocking, true, 'an unknown status must never default to "clear to proceed"');
  assert.equal(v.state, 'unknown');
});

// ── checkVault: the chain-reading wiring, with the reads injected ────────────────────────────

test('checkVault: activeProposalOf reading 0 never calls the proposal reader at all', () => {
  let readCalled = false;
  const r = checkVault('0xVault', {
    governance: '0xGov', now: 123,
    readActive: () => 0n,
    read: () => { readCalled = true; return { status: 'Active', revealDeadline: 0, expiresAt: 0 }; },
  });
  assert.equal(readCalled, false, 'reading a proposal that was never raised would be reading pid 0, a real (empty) struct — must be skipped, not read');
  assert.equal(r.verdict.blocking, false);
  assert.equal(r.verdict.state, 'none');
});

test('checkVault: wires the live pid through to the proposal reader and the verdict', () => {
  const r = checkVault('0xVault', {
    governance: '0xGov', now: TWELVE_DAYS_LATER,
    readActive: (gov, sig, vault) => {
      assert.equal(gov, '0xGov');
      assert.equal(sig, 'activeProposalOf(address)(uint256)');
      assert.equal(vault, '0xVault');
      return 11n;
    },
    read: (gov, pid) => {
      assert.equal(gov, '0xGov');
      assert.equal(pid, '11');
      return measuredProposal11;
    },
  });
  assert.equal(r.pid, 11n);
  assert.equal(r.verdict.state, 'active-finalizable');
});
