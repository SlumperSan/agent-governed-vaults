// @ts-check
/**
 * Fixture pins for the `proposals(uint256)` decode that scripts/smoke-test.mjs runs (issue #196).
 *
 * WHAT WAS UNREACHABLE. Before the extraction, smoke-test.mjs decoded a proposal status inline as
 * `STATUS[Number(p[P_STATUS])]` in two places and read four fields by bare index constant. That
 * file resolves a deployment file, builds `cast` argument lists and runs the whole testnet
 * lifecycle at import, so no test could execute any of it. A respelt `STATUS` entry makes
 * `stepFinalize` reject a proposal that did pass; a shifted index hands `classifyProposal` a
 * timestamp from a different field. Neither shows up in any suite.
 *
 * PROVENANCE, stated precisely because a fixture that claims to be captured and is not is worse
 * than no fixture. NEITHER TUPLE BELOW WAS CAPTURED FROM A CHAIN OR A LOG — both are CONSTRUCTED.
 * Four values in `PROPOSAL_3_EXECUTED` are carried from the only place in this repository that
 * already pins them: the `votableNow` regression at scripts/test/soak-drills.test.mjs:980-983,
 * whose literal at :981 uses createdAt 1788479808, commitDeadline 1788483408 and status Executed
 * for the proposal 3 that drill 5 met on 2026-09-04, and whose comment at :975 names it ptype 2,
 * ChildAllocation. Those are values that file asserts, not a chain read taken here. The `vault`
 * field is scripts/soak/soak-vaults.json's `smokeVault.address`, which that file's `smokeVault`
 * note names as drill 5's host vault. The remaining eleven fields are
 * synthetic, chosen only so that all sixteen decoded values are pairwise distinct — which is what
 * makes an index shift change an ASSERTED value rather than swap two equal ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { P, PROPOSAL_SIG, STATUS, decodeProposal } from '../lib/proposal-decode.mjs';
import { classifyProposal } from '../proposal-recovery.mjs';

/** One cleaned `cast call` output line per tuple member, in `P` order — what `call()` returns. */
const PROPOSAL_3_EXECUTED = [
  '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98',                         // 0  vault
  '2',                                                                  // 1  ptype (ChildAllocation)
  '0x00000000000000000000000000000000000000b2',                         // 2  proposer (synthetic)
  '1788479808',                                                         // 3  createdAt
  '1788483408',                                                         // 4  commitDeadline
  '1788487008',                                                         // 5  revealDeadline (synthetic)
  '1788487009',                                                         // 6  executableAt (synthetic)
  '1788573408',                                                         // 7  expiresAt (synthetic)
  '4',                                                                  // 8  status (Executed)
  `0x${'ab'.repeat(32)}`,                                               // 9  actionHash (synthetic)
  '7000000000000000000',                                                // 10 snapshotTotal (synthetic)
  '5',                                                                  // 11 memberCount (synthetic)
  '6000000000000000000',                                                // 12 forWeight (synthetic)
  '1000000000000000000',                                                // 13 againstWeight (synthetic)
  '8000000000000000000',                                                // 14 revealedWeight (synthetic)
  '3',                                                                  // 15 revealedVoterCount (synthetic)
];

/** Wholly synthetic, status byte 1 — the tuple that exercises `STATUS[1] === 'Active'`. */
const PROPOSAL_ACTIVE = [
  '0x00000000000000000000000000000000000000a1', '0',
  '0x00000000000000000000000000000000000000b2',
  '1000', '4600', '8200', '8201', '94600',
  '1',
  `0x${'11'.repeat(32)}`,
  '9000', '4', '0', '0', '0', '0',
];

/** The same tuple with one status byte changed — the enum index is the only thing that moves. */
const withStatus = (tuple, byte) => tuple.map((v, i) => (i === P.STATUS ? String(byte) : v));

test('decodeProposal maps every tuple index to its named field, and no two land on the same one', () => {
  const p = decodeProposal(PROPOSAL_3_EXECUTED);
  assert.deepEqual(
    {
      vault: p.vault, ptype: p.ptype, proposer: p.proposer, createdAt: p.createdAt,
      commitDeadline: p.commitDeadline, revealDeadline: p.revealDeadline,
      executableAt: p.executableAt, expiresAt: p.expiresAt, status: p.status,
      actionHash: p.actionHash, snapshotTotal: p.snapshotTotal, memberCount: p.memberCount,
      forWeight: p.forWeight, againstWeight: p.againstWeight, revealedWeight: p.revealedWeight,
      revealedVoterCount: p.revealedVoterCount,
    },
    {
      vault: '0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98',
      ptype: 2,
      proposer: '0x00000000000000000000000000000000000000b2',
      createdAt: 1788479808,
      commitDeadline: 1788483408,
      revealDeadline: 1788487008,
      executableAt: 1788487009,
      expiresAt: 1788573408,
      status: 'Executed',
      actionHash: `0x${'ab'.repeat(32)}`,
      snapshotTotal: 7000000000000000000n,
      memberCount: 5,
      forWeight: 6000000000000000000n,
      againstWeight: 1000000000000000000n,
      revealedWeight: 8000000000000000000n,
      revealedVoterCount: 3,
    },
  );
  // The timestamps and counts are Numbers and the weight fields BigInts; `deepEqual` from
  // node:assert/strict is exact about that, so a Number/BigInt swap is caught rather than coerced
  // away. It matters at the call sites: `classifyProposal` tests `revealedVoterCount === 0`, which
  // a BigInt `0n` would fail.
  assert.equal(p.raw, PROPOSAL_3_EXECUTED, 'raw must carry the input lines through unchanged');
});

test('decodeProposal produces the exact status strings smoke-test.mjs compares against', () => {
  // THE MUTATION ISSUE #196 DESCRIBES. `stepFinalize` asserts `status === 'Passed'` and
  // `classifyProposal` branches on the literals 'Passed', 'Active', 'Expired' and 'Defeated'
  // (scripts/proposal-recovery.mjs:26-38). Every one of those strings is produced only by this
  // array, so respell an entry — 'Active' -> 'Activ' — and the smoke run rejects a healthy
  // proposal, or fails to recognise a stranded one, with no test anywhere going red.
  const decoded = STATUS.map((_, i) => decodeProposal(withStatus(PROPOSAL_ACTIVE, i)).status);
  assert.deepEqual(decoded, ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired'],
    'the six Governance.Status names, in declaration order (contracts/src/Governance.sol:95-102)');
  assert.equal(decodeProposal(PROPOSAL_ACTIVE).status, 'Active');
});

test('a status byte outside the enum still decodes to undefined, as it did before the extraction', () => {
  // FAITHFULNESS, NOT A PREFERENCE. The inline lookup this module replaced had no `?? 'Unknown'`
  // fallback, so an out-of-range byte produced `undefined` and `stepFinalize` printed "proposal
  // finalized as undefined". Adding a fallback here would change that message, so the behaviour is
  // preserved and pinned. packages/reference-agent/src/chain.mjs:136 makes the opposite choice for
  // its own decode; that divergence is deliberate and is pinned separately in
  // packages/reference-agent/test/chain.test.mjs.
  assert.equal(decodeProposal(withStatus(PROPOSAL_ACTIVE, 6)).status, undefined);
  assert.equal(STATUS.length, 6, 'six is the first out-of-range byte only while the enum has six members');
});

test('the P index map still matches the arity and order of PROPOSAL_SIG', () => {
  // A fixture is only evidence if it has the shape the signature returns. `cast call` prints one
  // line per return value, so the tuple length and the highest index in `P` must agree with the
  // signature smoke-test.mjs actually sends.
  const returns = /\)\(([^)]*)\)$/.exec(PROPOSAL_SIG);
  assert.ok(returns, 'PROPOSAL_SIG must still declare a return tuple');
  const arity = returns[1].split(',').length;
  assert.equal(arity, 16, 'proposals(uint256) returns sixteen values');
  assert.equal(PROPOSAL_3_EXECUTED.length, arity, 'the fixture must be one line per return value');
  assert.equal(PROPOSAL_ACTIVE.length, arity);
  assert.equal(Math.max(...Object.values(P)), arity - 1, 'P must not index past the tuple');
  assert.equal(new Set(Object.values(P)).size, arity, 'every index used exactly once');
  assert.equal(new Set(PROPOSAL_3_EXECUTED).size, arity,
    'the fixture values must be pairwise distinct, or an index swap decodes identically');
});

test('a decoded Passed proposal past its execution window routes recovery to markExpired', () => {
  // ACROSS THE SEAM. `recoverStrandedProposal` feeds the decode straight into `classifyProposal`,
  // so this pins `STATUS[2]` and `P.EXPIRES_AT` to the branch that consumes them rather than each
  // to a literal of its own. `now` is derived from the decoded value, so the literal assert below
  // is what makes an index shift visible here: without it, EXPIRES_AT landing on EXECUTABLE_AT
  // would still be one second behind a derived `now` and this test would pass on the wrong field.
  const p = decodeProposal(withStatus(PROPOSAL_3_EXECUTED, 2));
  assert.equal(p.status, 'Passed');
  assert.equal(p.expiresAt, 1788573408, 'index 7, not its neighbour executableAt at index 6');
  const r = classifyProposal({
    status: p.status,
    now: p.expiresAt + 1,
    expiresAt: p.expiresAt,
    revealDeadline: p.revealDeadline,
    revealedVoterCount: p.revealedVoterCount,
  });
  assert.equal(r.stranded, true);
  assert.equal(r.action, 'markExpired');
});

test('a decoded Active proposal with the reveal window shut and nothing revealed routes to finalize', () => {
  // The 2026-08-21 restart case (scripts/test/proposal-recovery.test.mjs). It needs THREE decoded
  // fields to agree — status, revealDeadline and revealedVoterCount — and the last of those must
  // be a Number, because `classifyProposal` tests `revealedVoterCount === 0` and a BigInt `0n`
  // fails that comparison silently, leaving the proposal unrecovered and every later propose()
  // reverting ProposalActive().
  const p = decodeProposal(PROPOSAL_ACTIVE);
  assert.equal(p.revealedVoterCount, 0);
  const r = classifyProposal({
    status: p.status,
    now: p.revealDeadline,
    expiresAt: p.expiresAt,
    revealDeadline: p.revealDeadline,
    revealedVoterCount: p.revealedVoterCount,
  });
  assert.equal(r.stranded, true);
  assert.equal(r.action, 'finalize');
});

test('smoke-test.mjs reads every proposal through decodeProposal, so the fixtures pin a decoder it uses', () => {
  // WHAT A FIXTURE CANNOT REACH. smoke-test.mjs runs `cast` and the whole lifecycle at import, so
  // no test can drive it in-process, and a fixture could therefore pin a decoder no caller
  // reaches. This is a text-and-count pin over the source instead, and it catches the edit that
  // actually happens here — one site re-inlined while the other two keep the helper.
  const src = readFileSync(new URL('../smoke-test.mjs', import.meta.url), 'utf8');
  const uses = src.match(/decodeProposal\(call\(dep\.governance, PROPOSAL_SIG, state\.pid\)\)/g) ?? [];
  assert.equal(uses.length, 3, 'stepPropose, stepFinalize and recoverStrandedProposal each read one proposal');
  assert.match(src, /import \{ PROPOSAL_SIG, decodeProposal \} from '\.\/lib\/proposal-decode\.mjs';/);
  assert.doesNotMatch(src, /STATUS\[/, 'no inline enum-index decode may remain in smoke-test.mjs');
  assert.doesNotMatch(src, /const PROPOSAL_SIG =/, 'the signature must have one definition, in the pure module');
});
