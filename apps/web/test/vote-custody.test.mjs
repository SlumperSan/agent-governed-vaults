// @ts-check
/**
 * The S-4 tests for the member surface. A failure in any of these means a member can commit a vote
 * this app cannot reveal, or — worse, because it is silent — that the app tells a member with an
 * outstanding commitment they have not voted.
 *
 * THREE THINGS ARE PINNED TO SOMETHING OTHER THAN THIS CODEBASE, because a test that compares an
 * implementation to itself passes just as happily with the wrong field order:
 *
 *  1. The commitment encoding is pinned to a FOUNDRY-derived vector (the same one
 *     `packages/reference-agent/test/salt.test.mjs` uses) — agreement with it proves this module and
 *     the agent encode identically as well.
 *  2. Every read name, every mapping type and the `abi.encode` FIELD ORDER are pinned by reading
 *     `contracts/src/Governance.sol`. That file is the authority and it needs no build step, so this
 *     guard cannot skip its way to green; it throws when the source is missing.
 *  3. The salt derivation is cross-checked against `packages/reference-agent/src/salt.mjs` by
 *     deriving one salt through each implementation with one key. A member may commit through an
 *     agent and reveal here; a one-byte divergence would strand that vote.
 *
 * `viem` is imported unconditionally, as in `packages/reference-agent/test/salt.test.mjs` and
 * `packages/canary/test/exit-liveness.test.mjs`: it is a root dependency, and this file supplies it
 * as the injected `keccak256` the module deliberately does not import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keccak256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  ZERO_BYTES32,
  SALT_MESSAGE_PREFIX,
  SALT_SIGNATURE_WARNING,
  GOVERNANCE_VOTE_VIEWS,
  planVoteReads,
  saltMessage,
  saltFromSignature,
  commitmentPreimage,
  commitmentFor,
  candidateCommitments,
  assertReproducibleSignature,
  reconcileVote,
  VOTE_STATUS,
} from '../src/vote-custody.mjs';

import {
  deriveSalt as agentDeriveSalt,
  commitmentFor as agentCommitmentFor,
  saltMessage as agentSaltMessage,
  SALT_MESSAGE_PREFIX as AGENT_PREFIX,
} from '../../../packages/reference-agent/src/salt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');
const GOVERNANCE_SOL = join(REPO, 'contracts/src/Governance.sol');
const AGENT_SALT_SRC = join(REPO, 'packages/reference-agent/src/salt.mjs');
const MODULE_SRC = join(HERE, '../src/vote-custody.mjs');

const CHAIN_ID = 5042;
const VAULT = '0x3333333333333333333333333333333333333333';
const MEMBER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const SALT22 = `0x${'22'.repeat(32)}`;
const k = (hex) => keccak256(/** @type {`0x${string}`} */ (hex));

/** A wallet, reduced to the one thing the derivation needs. No storage, no provider. */
const walletFor = (privateKey) => {
  const account = privateKeyToAccount(privateKey);
  return {
    address: account.address,
    sign: (message) => account.signMessage({ message }),
  };
};

/** What a surface does end to end: one signature in, a salt and both candidates out. */
async function derive(wallet, { chainId = CHAIN_ID, vault = VAULT, pid }) {
  const signature = await wallet.sign(saltMessage({ chainId, vault, pid }));
  const salt = saltFromSignature(signature, k);
  return { signature, salt, candidates: candidateCommitments({ pid, voter: wallet.address, salts: [salt] }, k) };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. The encoding, pinned outside this codebase
// ───────────────────────────────────────────────────────────────────────────────────────────────

test('commitmentFor matches the Foundry-derived vector, so it matches Solidity', () => {
  // cast keccak $(cast abi-encode "f(uint256,address,bool,bytes32)" 7 0x1111…1111 true 0x2222…2222)
  assert.equal(
    commitmentFor({ pid: 7, voter: MEMBER, support: true, salt: SALT22 }, k),
    '0x5aab197fb111f4360d00844270879be5f50e5c29da252537813f5c11a0145b4a',
  );
});

test('the preimage is four 32-byte words in Governance.sol order, and the matcher can fail', () => {
  const got = commitmentPreimage({ pid: 7, voter: MEMBER, support: true, salt: SALT22 });
  const words = got.slice(2).match(/.{64}/g) ?? [];
  assert.equal(words.length, 4, 'abi.encode of four static types is exactly 4 words');
  assert.equal(words[0], '7'.padStart(64, '0'), 'word 0 is pid, left-padded');
  assert.equal(words[1], `${'0'.repeat(24)}${'11'.repeat(20)}`, 'word 1 is the voter, left-padded to 32 bytes');
  assert.equal(words[2], '1'.padStart(64, '0'), 'word 2 is the bool as a full word');
  assert.equal(words[3], '22'.repeat(32), 'word 3 is the salt, unpadded');

  // NON-VACUITY: the three ways this is plausibly got wrong must all be distinguishable here.
  const packed = `0x${'7'.padStart(64, '0')}${'11'.repeat(20)}01${'22'.repeat(32)}`; // encodePacked
  const transposed = commitmentPreimage({ pid: 7, voter: MEMBER, support: false, salt: SALT22 });
  assert.notEqual(got, packed, 'encodePacked must not equal encode');
  assert.notEqual(got, transposed, 'flipping support must change the preimage');
  assert.notEqual(
    commitmentFor({ pid: 7, voter: MEMBER, support: true, salt: SALT22 }, k),
    commitmentFor({ pid: 8, voter: MEMBER, support: true, salt: SALT22 }, k),
    'the pid must be bound — otherwise a commitment replays across proposals',
  );
});

test('GOVERNANCE_SOL pins the reads, the mapping types and the abi.encode FIELD ORDER', () => {
  // Deliberately a throw and not a skip: this file is the authority for every claim above, needs no
  // build step, and a guard that can skip is a guard that will.
  assert.ok(existsSync(GOVERNANCE_SOL), `Governance.sol not found at ${GOVERNANCE_SOL} — this guard must not skip`);
  const sol = readFileSync(GOVERNANCE_SOL, 'utf8');

  // The commitment expression, exactly. If anyone reorders these four, every commitment this module
  // builds becomes unrevealable, and this is the only line in the repository that says the order.
  assert.match(
    sol,
    /c == keccak256\(abi\.encode\(pid, msg\.sender, support, salt\)\)/,
    'revealVote no longer re-derives keccak256(abi.encode(pid, msg.sender, support, salt))',
  );
  assert.match(sol, /function commitVote\(uint256 pid, bytes32 commitment\) external/);
  assert.match(sol, /function revealVote\(uint256 pid, bool support, bytes32 salt\) external/);

  // Every fragment this module declares must exist on Governance with those exact types.
  const declared = new Map(GOVERNANCE_VOTE_VIEWS.map((f) => [f.name, f]));
  const expectedMapping = {
    commitOf: /mapping\(uint256 => mapping\(address => bytes32\)\) public commitOf/,
    revealedOf: /mapping\(uint256 => mapping\(address => bool\)\) public revealedOf/,
    revealedSupportOf: /mapping\(uint256 => mapping\(address => bool\)\) public revealedSupportOf/,
    defaultApplied: /mapping\(uint256 => mapping\(address => bool\)\) public defaultApplied/,
  };
  assert.deepEqual([...declared.keys()].sort(), Object.keys(expectedMapping).sort());
  for (const [name, re] of Object.entries(expectedMapping)) {
    assert.match(sol, re, `Governance.${name} is not the public mapping this module encodes against`);
    const frag = declared.get(name);
    assert.deepEqual(
      frag.inputs.map((i) => i.type),
      ['uint256', 'address'],
      `${name} inputs`,
    );
    assert.equal(frag.outputs[0].type, name === 'commitOf' ? 'bytes32' : 'bool', `${name} output`);
  }

  // NON-VACUITY: the same matcher over a mutated source must red, or it proves nothing.
  const mutated = sol.replace('abi.encode(pid, msg.sender, support, salt)', 'abi.encode(msg.sender, pid, support, salt)');
  assert.notEqual(mutated, sol, 'the mutation did not apply — the pinned expression has moved');
  assert.doesNotMatch(mutated, /c == keccak256\(abi\.encode\(pid, msg\.sender, support, salt\)\)/);
});

test('planVoteReads names every read the reconciliation needs, defaultApplied included', () => {
  const calls = planVoteReads('0x9999999999999999999999999999999999999999', 7, MEMBER);
  assert.deepEqual(calls.map((c) => c.fn), ['commitOf', 'revealedOf', 'revealedSupportOf', 'defaultApplied']);
  for (const c of calls) {
    assert.equal(c.address, '0x9999999999999999999999999999999999999999');
    assert.equal(c.abi, 'GOVERNANCE_VOTE_VIEWS', 'never name a fragment table this module does not own');
    assert.deepEqual([...c.args], [7n, MEMBER]);
  }
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. The derivation: domain separation, and interop with the reference agent
// ───────────────────────────────────────────────────────────────────────────────────────────────

test('the salt message is domain-separated, address-case-insensitive, and scoped per vote', () => {
  const m = saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42 });
  assert.match(m, /^x402-vaults:reveal-salt:v1:5042:0x3{40}:42$/);
  assert.equal(m, saltMessage({ chainId: CHAIN_ID, vault: VAULT.toUpperCase().replace('0X', '0x'), pid: 42 }));
  for (const other of [
    saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 43 }),
    saltMessage({ chainId: CHAIN_ID, vault: OTHER, pid: 42 }),
    saltMessage({ chainId: 8453, vault: VAULT, pid: 42 }),
  ]) {
    assert.notEqual(m, other, 'one leaked salt must not unmask a second vote');
  }
  assert.throws(() => saltMessage({ chainId: CHAIN_ID, vault: 'not-an-address', pid: 1 }), /not an address/);
  assert.throws(() => saltMessage({ chainId: 0, vault: VAULT, pid: 1 }), /not a chain id/);
});

test('THE AGENT AND THIS MODULE DERIVE THE SAME SALT — a cross-surface commit is revealable', async () => {
  // Byte-identical prefix, checked against the agent's SOURCE as well as its export, because the
  // export could be re-pointed while the file's own documented string stayed behind.
  assert.equal(SALT_MESSAGE_PREFIX, AGENT_PREFIX);
  const agentSrc = readFileSync(AGENT_SALT_SRC, 'utf8');
  assert.ok(
    agentSrc.includes(`'${SALT_MESSAGE_PREFIX}'`),
    `the agent no longer declares '${SALT_MESSAGE_PREFIX}' — the two derivations have split`,
  );

  const key = generatePrivateKey();
  const account = privateKeyToAccount(key);
  const wallet = walletFor(key);

  for (const pid of [1, 42, 2n ** 40n]) {
    assert.equal(saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid }), agentSaltMessage({ chainId: CHAIN_ID, vault: VAULT, pid }));
    const mine = await derive(wallet, { pid });
    const theirs = await agentDeriveSalt({ account, chainId: CHAIN_ID, vault: VAULT, pid });
    assert.equal(mine.salt, theirs, `salt divergence at pid ${pid}`);
    assert.equal(
      commitmentFor({ pid, voter: account.address, support: true, salt: mine.salt }, k),
      await agentCommitmentFor({ pid, voter: account.address, support: true, salt: theirs }),
      `commitment divergence at pid ${pid}`,
    );
  }
});

test('a salt is not producible without the key, and a truncated signature is refused', async () => {
  const pid = 42;
  const a = await derive(walletFor(generatePrivateKey()), { pid });
  const b = await derive(walletFor(generatePrivateKey()), { pid });
  assert.notEqual(a.salt, b.salt, 'two wallets must not derive one salt');
  assert.match(a.salt, /^0x[0-9a-f]{64}$/);

  assert.throws(() => saltFromSignature('0x', k), /whole-byte hex/);
  assert.throws(() => saltFromSignature(`${a.signature}f`, k), /whole-byte hex/);
  assert.throws(() => saltFromSignature(a.signature, null), /needs a keccak256/);
  // NON-VACUITY: the accepted form really is accepted, so the throws above are about the input.
  assert.match(saltFromSignature(a.signature, k), /^0x[0-9a-f]{64}$/);
});

test('a leaked salt discloses the direction but cannot cast, move or block the vote', async () => {
  const pid = 42;
  const wallet = walletFor(generatePrivateKey());
  const { salt, candidates } = await derive(wallet, { pid });
  const onChain = candidates.find((c) => c.support === false).commitment;

  // What the leak buys: both directions are testable against the public commitment, so the direction
  // is learnable. This is the property the module header states, asserted rather than asserted-in-prose.
  const guessed = [true, false].filter((support) => commitmentFor({ pid, voter: wallet.address, support, salt }, k) === onChain);
  assert.deepEqual(guessed, [false]);

  // What it does not buy: the commitment binds msg.sender, so the same salt under another address
  // produces a different commitment — the attacker's own commitOf stays zero and revealVote reverts
  // with NoCommit. Nothing here lets them reveal, flip or forfeit the member's vote.
  assert.notEqual(commitmentFor({ pid, voter: OTHER, support: false, salt }, k), onChain);
  assert.notEqual(commitmentFor({ pid, voter: OTHER, support: true, salt }, k), onChain);
});

test('assertReproducibleSignature refuses a wallet that signs one message two ways', async () => {
  const wallet = walletFor(generatePrivateKey());
  const msg = saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42 });
  const one = await wallet.sign(msg);
  const two = await wallet.sign(msg);
  assert.deepEqual(assertReproducibleSignature(one, two), { reproducible: true }, 'a local RFC-6979 signer is reproducible');

  // A passkey or entropy-adding signer looks exactly like this, and must be refused BEFORE the commit.
  const entropic = `${one.slice(0, -2)}${one.endsWith('ff') ? 'ee' : 'ff'}`;
  assert.throws(() => assertReproducibleSignature(one, entropic), /cannot be re-derived|forfeit/);
  assert.throws(() => assertReproducibleSignature(one, '0x'), /whole-byte hex/);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. Reconstruction from chain reads alone
// ───────────────────────────────────────────────────────────────────────────────────────────────

const clean = { commitment: ZERO_BYTES32, revealed: false, defaultApplied: false, candidates: null };

test('COMMITTED ON ONE DEVICE, REVEALED ON ANOTHER — no storage crosses between them', async () => {
  const key = generatePrivateKey();
  const pid = 42;

  // Device A: commit. Everything it computed is then thrown away; only the commitment is on-chain.
  const deviceA = await derive(walletFor(key), { pid });
  const onChain = deviceA.candidates.find((c) => c.support === true).commitment;

  // Device B: a fresh wallet object over the same key, no memory of device A at all.
  const deviceB = await derive(walletFor(key), { pid });
  assert.equal(deviceB.salt, deviceA.salt, 'the salt is a function of the key and public inputs only');

  const r = reconcileVote({
    pid,
    member: walletFor(key).address,
    commitment: onChain,
    revealed: false,
    defaultApplied: false,
    candidates: deviceB.candidates,
    phase: 'reveal',
  });
  assert.equal(r.status, VOTE_STATUS.RECOVERABLE);
  assert.deepEqual(r.reveal, { pid: 42n, support: true, salt: deviceA.salt });
  assert.equal(r.forfeited, false);

  // NON-VACUITY: device C holds a DIFFERENT key. The same matcher must now fail.
  const deviceC = await derive(walletFor(generatePrivateKey()), { pid });
  const wrong = reconcileVote({
    pid,
    member: deviceC.candidates[0].voter,
    commitment: onChain,
    revealed: false,
    defaultApplied: false,
    candidates: deviceC.candidates,
    phase: 'reveal',
  });
  assert.equal(wrong.status, VOTE_STATUS.UNRECOVERABLE);
  assert.equal(wrong.reveal, null);
});

test('A CHANGED WALLET: state is per address, and stale candidates throw rather than mislead', async () => {
  const pid = 42;
  const walletA = walletFor(generatePrivateKey());
  const walletB = walletFor(generatePrivateKey());
  const a = await derive(walletA, { pid });

  // B has genuinely not voted: commitOf is keyed by address, so B's read is zero.
  const forB = reconcileVote({ pid, member: walletB.address, ...clean, phase: 'commit', votingWeight: 1n });
  assert.equal(forB.status, VOTE_STATUS.NONE);
  assert.equal(forB.canCommit, true);

  // Reusing A's candidates against B's read is the bug that would report B as UNRECOVERABLE — a
  // false alarm shaped exactly like the real one. It throws instead.
  assert.throws(
    () => reconcileVote({ pid, member: walletB.address, commitment: ZERO_BYTES32, revealed: false, defaultApplied: false, candidates: a.candidates, phase: 'reveal' }),
    /binds msg\.sender|can never match/,
  );
  // Same for candidates built for another proposal.
  const other = await derive(walletA, { pid: 43 });
  assert.throws(
    () => reconcileVote({ pid, member: walletA.address, commitment: ZERO_BYTES32, revealed: false, defaultApplied: false, candidates: other.candidates, phase: 'reveal' }),
    /proposal 43/,
  );
});

test('A FAILED READ IS UNKNOWN, NEVER "not voted"', () => {
  for (const patch of [{ commitment: null }, { commitment: undefined }, { revealed: null }, { revealed: undefined }]) {
    const r = reconcileVote({ pid: 7, member: MEMBER, ...clean, ...patch, phase: 'reveal' });
    assert.equal(r.status, VOTE_STATUS.UNKNOWN, `read failure ${JSON.stringify(patch)} must not resolve`);
    assert.equal(r.canCommit, false);
    assert.match(r.detail, /could not read|will not tell/i);
  }
  // A failed defaultApplied read is also unknown: without it, "no commit" cannot be called "no vote",
  // because revealDelegated counts weight without ever setting revealedOf.
  const d = reconcileVote({ pid: 7, member: MEMBER, ...clean, defaultApplied: null, phase: 'commit', votingWeight: 5n });
  assert.equal(d.status, VOTE_STATUS.UNKNOWN);
  assert.equal(d.canCommit, false);

  // NON-VACUITY: with every read present the same call resolves, so the nulls above are what did it.
  assert.equal(reconcileVote({ pid: 7, member: MEMBER, ...clean, phase: 'commit', votingWeight: 5n }).status, VOTE_STATUS.NONE);
});

test('a non-zero commitOf with no matching salt is its own LOUD state, never "not voted"', async () => {
  const pid = 42;
  const wallet = walletFor(generatePrivateKey());
  const mine = await derive(wallet, { pid });
  const foreign = `0x${'ab'.repeat(32)}`; // committed under a scheme this wallet cannot reproduce

  const open = reconcileVote({ pid, member: wallet.address, commitment: foreign, revealed: false, defaultApplied: false, candidates: mine.candidates, phase: 'reveal' });
  assert.equal(open.status, VOTE_STATUS.UNRECOVERABLE);
  assert.equal(open.forfeited, false);
  assert.equal(open.reveal, null);
  assert.match(open.detail, /NOT abstained|cannot be shown as not having voted/);
  assert.match(open.detail, /entering the salt used to commit/, 'the recovery path must be offered while the window is open');
  assert.deepEqual([...open.triedSalts], [mine.salt]);

  // Past the reveal window the same reads mean the vote is gone, and the surface must say so.
  const closed = reconcileVote({ pid, member: wallet.address, commitment: foreign, revealed: false, defaultApplied: false, candidates: mine.candidates, phase: 'tally' });
  assert.equal(closed.status, VOTE_STATUS.UNRECOVERABLE);
  assert.equal(closed.forfeited, true);
  assert.match(closed.detail, /counted toward nothing/);

  // The written-down-salt escape hatch turns it back into a reveal, through the same code path.
  const written = candidateCommitments({ pid, voter: wallet.address, salts: [mine.salt, `0x${'cd'.repeat(32)}`] }, k);
  const real = candidateCommitments({ pid, voter: wallet.address, salts: [`0x${'cd'.repeat(32)}`] }, k).find((c) => c.support === false);
  const rescued = reconcileVote({ pid, member: wallet.address, commitment: real.commitment, revealed: false, defaultApplied: false, candidates: written, phase: 'reveal' });
  assert.equal(rescued.status, VOTE_STATUS.RECOVERABLE);
  assert.deepEqual(rescued.reveal, { pid: 42n, support: false, salt: `0x${'cd'.repeat(32)}` });
});

test('a commitment with no signature yet is UNDERIVED, and asks for one', () => {
  const r = reconcileVote({ pid: 7, member: MEMBER, commitment: `0x${'ab'.repeat(32)}`, revealed: false, defaultApplied: false, candidates: null, phase: 'reveal' });
  assert.equal(r.status, VOTE_STATUS.UNDERIVED);
  assert.equal(r.needsSignature, true);
  assert.equal(r.reveal, null);
  assert.match(r.detail, /not stored anywhere/);
});

test('delegated weight is not "no vote": defaultApplied is read and reported', () => {
  const r = reconcileVote({ pid: 7, member: MEMBER, commitment: ZERO_BYTES32, revealed: false, defaultApplied: true, candidates: null, phase: 'reveal' });
  assert.equal(r.status, VOTE_STATUS.DELEGATED);
  assert.equal(r.canCommit, false);
  assert.match(r.detail, /already been counted/);
  // NON-VACUITY: the one differing field is what produced it.
  assert.equal(reconcileVote({ pid: 7, member: MEMBER, ...clean, phase: 'reveal' }).status, VOTE_STATUS.NONE);
});

test('a revealed vote is terminal, and its direction comes from the chain rather than a salt', () => {
  const base = { pid: 7, member: MEMBER, commitment: `0x${'ab'.repeat(32)}`, revealed: true, defaultApplied: false, candidates: null, phase: 'reveal' };
  const yes = reconcileVote({ ...base, revealedSupport: true });
  assert.equal(yes.status, VOTE_STATUS.REVEALED);
  assert.equal(yes.revealedSupport, true);
  assert.match(yes.detail, /counted FOR/);
  assert.equal(reconcileVote({ ...base, revealedSupport: false }).revealedSupport, false);
  assert.equal(reconcileVote(base).revealedSupport, null, 'an unread direction is null, not false');
  assert.equal(reconcileVote(base).reveal, null);
});

test('revealed with a zero commitment is INCONSISTENT — revealVote cannot produce it', () => {
  const r = reconcileVote({ pid: 7, member: MEMBER, commitment: ZERO_BYTES32, revealed: true, defaultApplied: false, candidates: null, phase: 'reveal' });
  assert.equal(r.status, VOTE_STATUS.INCONSISTENT);
  assert.equal(r.reveal, null);
  assert.match(r.detail, /contradictory|cannot produce/i);
});

test('canCommit is three-valued: the commit phase AND weight, or null', () => {
  const at = (phase, votingWeight) => reconcileVote({ pid: 7, member: MEMBER, ...clean, phase, votingWeight }).canCommit;
  assert.equal(at('commit', 5n), true);
  assert.equal(at('commit', 0n), false, 'zero voting weight reverts with NoWeight');
  assert.equal(at('commit', undefined), null, 'unread weight is unknown, never true');
  assert.equal(at('commit', null), null);
  for (const phase of ['reveal', 'tally', 'timelock', 'executable', 'executed', 'defeated', 'expired', 'unknown']) {
    assert.equal(at(phase, 5n), false, `commitVote requires now < commitDeadline, so ${phase} is not commitable`);
  }
  // sharesOf is not voting weight; this module never guesses one from the other.
  assert.match(reconcileVote({ pid: 7, member: MEMBER, ...clean, phase: 'commit', votingWeight: 0n }).detail, /NoWeight/);
});

test('a recovered reveal is still offered past the window, with forfeited set rather than hidden', async () => {
  const pid = 42;
  const wallet = walletFor(generatePrivateKey());
  const { candidates, salt } = await derive(wallet, { pid });
  const r = reconcileVote({
    pid,
    member: wallet.address,
    commitment: candidates.find((c) => c.support === true).commitment,
    revealed: false,
    defaultApplied: false,
    candidates,
    phase: 'tally',
  });
  assert.equal(r.status, VOTE_STATUS.RECOVERABLE);
  assert.equal(r.forfeited, true);
  assert.deepEqual(r.reveal, { pid: 42n, support: true, salt });
  assert.match(r.label, /window has closed/);
});

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. The property the whole module claims: nothing is held anywhere
// ───────────────────────────────────────────────────────────────────────────────────────────────

test('THE MODULE TOUCHES NO STORAGE, NO DOM AND NO NETWORK — checked over code, not prose', () => {
  const src = readFileSync(MODULE_SRC, 'utf8');
  const code = codeOnly(src);
  const banned =
    /\b(localStorage|sessionStorage|indexedDB|cookie|document|window|fetch|XMLHttpRequest|WebSocket|require|process|globalThis|Math)\b/g;
  assert.deepEqual(code.match(banned) ?? [], [], 'this module must be pure: no storage, no DOM, no network, no host globals, no randomness');
  assert.deepEqual([...src.matchAll(/^import\b/gm)], [], 'apps/web/src carries zero imports — see chain-reader.mjs');
  assert.ok(code.includes('export function reconcileVote'), 'the stripper must leave the code behind, or this guard reads an empty file');

  // NON-VACUITY, in both directions. The matcher must catch a real use…
  assert.match(codeOnly('const x = 1;\nlocalStorage.setItem("a", "b");\n'), banned);
  assert.match(codeOnly('const p = window.fetch;\n'), banned);
  // …and the stripping must be what excuses the module rather than a matcher that never fires: the
  // banned words ARE in this file's prose and its user-facing strings, and are meant to be.
  assert.ok(src.includes('localStorage'), 'the module names localStorage in prose; the guard is about code');
  assert.ok(src.includes('reveal window is open'), 'the module says "window" to members; that is not a DOM reference');
  assert.deepEqual(codeOnly('// localStorage.getItem()\n/* window.fetch */\nconst a = "process"; // document\n').match(banned) ?? [], []);
});

test('the signature request carries the disclosure a member needs to judge it', () => {
  assert.match(SALT_SIGNATURE_WARNING, /not a transaction/i);
  assert.match(SALT_SIGNATURE_WARNING, /any device/i, 'the recovery property is the reason to sign');
  assert.match(SALT_SIGNATURE_WARNING, /which way you voted/i, 'the leak consequence must be stated, not implied');
  assert.match(SALT_SIGNATURE_WARNING, /cannot vote for you/i, 'and so must the limit of that leak');
});

/**
 * Everything that is not prose: block comments out, then string and template literals, then line
 * comments. Both halves matter. Without comment stripping the guard would red on a module that only
 * DESCRIBES storage — which this one has to do, since that is what it refuses to use. Without string
 * stripping it would red on the word "window" in a sentence about the reveal window. The test above
 * proves it in both directions rather than trusting either.
 */
function codeOnly(s) {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, "''")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, "''")
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\s\/\/.*$/, '')))
    .join('\n');
}
