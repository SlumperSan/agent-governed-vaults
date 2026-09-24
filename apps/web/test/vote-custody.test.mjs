// @ts-check
/**
 * The S-4-on-the-web-app tests. If any of these fail, a member's committed vote can be forfeited
 * (revealed off a wrong salt) or, in the mismatch case mishandled, silently lost with no
 * recovery — see `../src/vote-custody.mjs`'s module header.
 *
 * `../src/vote-custody.mjs` carries no crypto dependency by design (it is loaded raw into the
 * browser with no bundler). This test file is NOT under that constraint — it runs under `node
 * --test` from the repo root, where the root `viem` dependency is on the module path — so it is
 * the thing that plays the role of "the wallet + the chain" the module expects to be handed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { keccak256, encodeAbiParameters } from 'viem';
import {
  CUSTODY_MISMATCH,
  CUSTODY_NONE,
  CUSTODY_READY,
  CUSTODY_REVEALED,
  CUSTODY_UNREAD,
  SALT_MESSAGE_PREFIX,
  canReveal,
  commitmentFor,
  deriveSalt,
  reconstructVoteCustody,
  saltMessage,
} from '../src/vote-custody.mjs';
import { assembleVoteCommit, planVoteCommit, VOTE_COMMIT_ZERO } from '../src/chain-reader.mjs';
import { GOVERNANCE_VIEWS } from '../../../packages/canary/src/abis.mjs';

const VAULT = '0x3333333333333333333333333333333333333333';
const GOV = '0x9999999999999999999999999999999999999999';
const CHAIN_ID = 84532;

/** A viem-shaped `signMessage` adapter, matching what `deriveSalt`/`reconstructVoteCustody` expect. */
const signerFor = (account) => ({ message }) => account.signMessage({ message });

// ── message + commitment encoding: pinned against the contract, and against the sibling module ──

test('salt message is domain-separated (chainId, vault, pid) and address-case-insensitive', () => {
  const lower = saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42 });
  const upper = saltMessage({ chainId: CHAIN_ID, vault: VAULT.toUpperCase().replace('0X', '0x'), pid: 42 });
  assert.equal(lower, upper, 'a checksummed vs lowercase address must not derive two different salts');
  assert.equal(lower, `${SALT_MESSAGE_PREFIX}:${CHAIN_ID}:${VAULT.toLowerCase()}:42`);
  assert.notEqual(lower, saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 43 }), '(a) different proposal ⇒ different message');
  assert.notEqual(lower, saltMessage({ chainId: 8453, vault: VAULT, pid: 42 }), 'different chain ⇒ different message');
});

test('the message format matches packages/reference-agent/src/salt.mjs exactly — cross-surface portability is deliberate', async () => {
  // Same prefix, same field order, same separators. A member who commits from this app and
  // reveals from the reference agent (or vice versa) must re-derive the identical salt.
  const { saltMessage: agentSaltMessage } = await import('../../../packages/reference-agent/src/salt.mjs');
  assert.equal(saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 7 }), agentSaltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 7 }));
});

test('commitmentFor matches the Solidity encoding exactly (cast-derived vector, shared with the reference agent)', async () => {
  // cast keccak $(cast abi-encode "f(uint256,address,bool,bytes32)" 7 0x1111…1111 true 0x2222…2222)
  const got = await commitmentFor({
    pid: 7,
    voter: '0x1111111111111111111111111111111111111111',
    support: true,
    salt: '0x' + '22'.repeat(32),
    keccak256, encodeAbiParameters,
  });
  assert.equal(got, '0x5aab197fb111f4360d00844270879be5f50e5c29da252537813f5c11a0145b4a');
});

test('commitment binds support and voter: flipping either changes the hash', async () => {
  const base = { pid: 7, salt: '0x' + '22'.repeat(32), keccak256, encodeAbiParameters };
  const A = '0x1111111111111111111111111111111111111111';
  const B = '0x2222222222222222222222222222222222222222';
  const yes = await commitmentFor({ ...base, voter: A, support: true });
  const no = await commitmentFor({ ...base, voter: A, support: false });
  const other = await commitmentFor({ ...base, voter: B, support: true });
  assert.notEqual(yes, no);
  assert.notEqual(yes, other);
});

test('commitmentFor rejects malformed input rather than producing a wrong hash', async () => {
  const voter = '0x1111111111111111111111111111111111111111';
  await assert.rejects(
    () => commitmentFor({ pid: 1, voter, support: 'true', salt: '0x' + '22'.repeat(32), keccak256, encodeAbiParameters }),
    /boolean/,
  );
  await assert.rejects(
    () => commitmentFor({ pid: 1, voter, support: true, salt: '0xdeadbeef', keccak256, encodeAbiParameters }),
    /32-byte hex/,
  );
});

test('deriveSalt refuses to hash garbage: rejects an empty or malformed signature', async () => {
  await assert.rejects(
    () => deriveSalt({ signMessage: async () => '0x', chainId: CHAIN_ID, vault: VAULT, pid: 1, keccak256 }),
    /not return signature hex/,
  );
});

test('salt derivation is deterministic and per-proposal-distinct (a local EOA)', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signMessage = signerFor(account);
  const a = await deriveSalt({ signMessage, chainId: CHAIN_ID, vault: VAULT, pid: 42, keccak256 });
  const b = await deriveSalt({ signMessage, chainId: CHAIN_ID, vault: VAULT, pid: 42, keccak256 });
  assert.equal(a, b);
  assert.notEqual(a, await deriveSalt({ signMessage, chainId: CHAIN_ID, vault: VAULT, pid: 43, keccak256 }), '(a) distinct per proposal');
});

// ── chain-reader plumbing: planVoteCommit / assembleVoteCommit ──

test('planVoteCommit reads exactly commitOf, revealedOf, revealedSupportOf, matching the ABI table', () => {
  const calls = planVoteCommit(GOV, 7, '0xabc');
  assert.deepEqual(calls.map((c) => c.fn), ['commitOf', 'revealedOf', 'revealedSupportOf']);
  const names = new Set(GOVERNANCE_VIEWS.map((f) => f.name));
  for (const c of calls) assert.ok(names.has(c.fn), `${c.fn} must be declared in GOVERNANCE_VIEWS`);
});

test('assembleVoteCommit: only an exact typed value is KNOWN — everything else is unread, never coerced', () => {
  const known = assembleVoteCommit({ commitOfValue: VOTE_COMMIT_ZERO, revealedValue: false, revealedSupportValue: false });
  assert.equal(known.onChainCommitment, VOTE_COMMIT_ZERO);
  assert.equal(known.revealed, false);

  for (const badCommit of [null, undefined, '0xnothex', 42, '']) {
    const r = assembleVoteCommit({ commitOfValue: badCommit, revealedValue: false, revealedSupportValue: false });
    assert.equal(r.onChainCommitment, undefined, `commitOfValue=${JSON.stringify(badCommit)} must not be coerced`);
  }
  for (const badRevealed of [null, undefined, 0, 1, 'false']) {
    const r = assembleVoteCommit({ commitOfValue: VOTE_COMMIT_ZERO, revealedValue: badRevealed, revealedSupportValue: false });
    assert.equal(r.revealed, undefined, `revealedValue=${JSON.stringify(badRevealed)} must not be coerced to a boolean`);
  }
});

// ── reconstructVoteCustody: the four states a member can actually be in, from chain alone ──

function crypto() {
  return { keccak256, encodeAbiParameters };
}

test('STATE: fresh / no commit — CUSTODY_NONE, derived from a genuine on-chain zero', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const read = assembleVoteCommit({ commitOfValue: VOTE_COMMIT_ZERO, revealedValue: false, revealedSupportValue: false });
  const state = await reconstructVoteCustody({
    chainId: CHAIN_ID, vault: VAULT, pid: 1, voter: account.address,
    ...read, signMessage: signerFor(account), ...crypto(),
  });
  assert.equal(state.status, CUSTODY_NONE);
  assert.equal(canReveal(state), false);
});

test('STATE: commit + matching derivation — CUSTODY_READY, reveal-safe', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signMessage = signerFor(account);
  const pid = 42;
  // Simulate what commitVote put on-chain: the member derived a salt and committed FOR.
  const salt = await deriveSalt({ signMessage, chainId: CHAIN_ID, vault: VAULT, pid, keccak256 });
  const onChainCommitment = await commitmentFor({ pid, voter: account.address, support: true, salt, ...crypto() });

  const read = assembleVoteCommit({ commitOfValue: onChainCommitment, revealedValue: false, revealedSupportValue: false });
  const state = await reconstructVoteCustody({
    chainId: CHAIN_ID, vault: VAULT, pid, voter: account.address,
    ...read, signMessage, ...crypto(),
  });
  assert.equal(state.status, CUSTODY_READY);
  assert.equal(state.support, true);
  assert.equal(state.salt, salt);
  assert.equal(canReveal(state), true);

  // And what the state claims genuinely reproduces the on-chain commitment — the actual safety
  // property, not just an internal-consistency check.
  const rebuilt = await commitmentFor({ pid, voter: account.address, support: state.support, salt: state.salt, ...crypto() });
  assert.equal(rebuilt, onChainCommitment);
});

test('STATE: commit + matching derivation, AGAINST direction — recovered from the same single signature', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signMessage = signerFor(account);
  const pid = 9;
  const salt = await deriveSalt({ signMessage, chainId: CHAIN_ID, vault: VAULT, pid, keccak256 });
  const onChainCommitment = await commitmentFor({ pid, voter: account.address, support: false, salt, ...crypto() });
  const read = assembleVoteCommit({ commitOfValue: onChainCommitment, revealedValue: false, revealedSupportValue: false });
  const state = await reconstructVoteCustody({ chainId: CHAIN_ID, vault: VAULT, pid, voter: account.address, ...read, signMessage, ...crypto() });
  assert.equal(state.status, CUSTODY_READY);
  assert.equal(state.support, false);
});

test('STATE: commit exists, MISMATCHED derivation — CUSTODY_MISMATCH, the loss case, never silently "none" or "ready"', async () => {
  // Two distinct accounts stand in for "the same wallet produced a different signature this
  // time" (e.g. a non-deterministic signer) — the observable symptom is identical either way:
  // the current derivation does not reproduce the on-chain commitment.
  const committedWith = privateKeyToAccount(generatePrivateKey());
  const revealingWith = privateKeyToAccount(generatePrivateKey());
  const pid = 5;
  const support = true;
  const committedSalt = await deriveSalt({ signMessage: signerFor(committedWith), chainId: CHAIN_ID, vault: VAULT, pid, keccak256 });
  const onChainCommitment = await commitmentFor({ pid, voter: committedWith.address, support, salt: committedSalt, ...crypto() });

  const read = assembleVoteCommit({ commitOfValue: onChainCommitment, revealedValue: false, revealedSupportValue: false });
  const state = await reconstructVoteCustody({
    chainId: CHAIN_ID, vault: VAULT, pid, voter: committedWith.address, // same voter address
    ...read, signMessage: signerFor(revealingWith), ...crypto(), // but a DIFFERENT signer now
  });

  assert.equal(state.status, CUSTODY_MISMATCH);
  assert.equal(state.onChainCommitment, onChainCommitment);
  assert.equal(canReveal(state), false);
  // The two error-adjacent states this must never be confused with:
  assert.notEqual(state.status, CUSTODY_NONE);
  assert.notEqual(state.status, CUSTODY_READY);
  // And it must carry nothing a careless caller could mistake for a reveal-ready payload.
  assert.equal('salt' in state, false);
  assert.equal('support' in state, false);
});

test('STATE: already revealed — CUSTODY_REVEALED, read from chain, derivation never runs', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const read = assembleVoteCommit({ commitOfValue: '0x' + 'ab'.repeat(32), revealedValue: true, revealedSupportValue: true });
  const state = await reconstructVoteCustody({
    chainId: CHAIN_ID, vault: VAULT, pid: 1, voter: account.address,
    ...read,
    // A signer that would throw if ever called — proves derivation is skipped for a revealed vote.
    signMessage: async () => { throw new Error('must not sign — already revealed'); },
    ...crypto(),
  });
  assert.equal(state.status, CUSTODY_REVEALED);
  assert.equal(state.support, true);
  assert.equal(canReveal(state), false);
});

test('STATE: unread — an incomplete chain read must never be reported as none/ready/revealed', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const signMessage = async () => { throw new Error('must not sign — reads are incomplete'); };

  // revealedOf failed to read at all.
  const partial = assembleVoteCommit({ commitOfValue: VOTE_COMMIT_ZERO, revealedValue: undefined, revealedSupportValue: undefined });
  const s1 = await reconstructVoteCustody({ chainId: CHAIN_ID, vault: VAULT, pid: 1, voter: account.address, ...partial, signMessage, ...crypto() });
  assert.equal(s1.status, CUSTODY_UNREAD);

  // commitOf failed to read at all (revealedOf came back false).
  const partial2 = assembleVoteCommit({ commitOfValue: null, revealedValue: false, revealedSupportValue: false });
  const s2 = await reconstructVoteCustody({ chainId: CHAIN_ID, vault: VAULT, pid: 1, voter: account.address, ...partial2, signMessage, ...crypto() });
  assert.equal(s2.status, CUSTODY_UNREAD);

  // revealed came back true, but revealedSupportOf failed.
  const partial3 = assembleVoteCommit({ commitOfValue: '0x' + 'ab'.repeat(32), revealedValue: true, revealedSupportValue: undefined });
  const s3 = await reconstructVoteCustody({ chainId: CHAIN_ID, vault: VAULT, pid: 1, voter: account.address, ...partial3, signMessage, ...crypto() });
  assert.equal(s3.status, CUSTODY_UNREAD);

  for (const s of [s1, s2, s3]) assert.equal(canReveal(s), false);
});
