// @ts-check
/**
 * The S-4 tests. If any of these fail, a committed vote can be forfeited — which is the single
 * highest-severity failure the product has (CONSUMER-UX-SPEC §3.2).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  assertDeterministicSigner,
  buildVote,
  commitmentFor,
  deriveSalt,
  recoverVote,
  saltMessage,
} from '../src/salt.mjs';

const VAULT = '0x3333333333333333333333333333333333333333';
const CHAIN_ID = 84532;

/**
 * PINNED VECTOR — produced by Foundry, not by this codebase:
 *   cast keccak $(cast abi-encode "f(uint256,address,bool,bytes32)" 7 0x1111…1111 true 0x2222…2222)
 * A test that only compared our implementation to itself would pass just as happily with
 * `encodePacked` or the wrong field order, and the agent would commit votes it could never reveal.
 */
test('commitmentFor matches the Solidity encoding exactly (cast-derived vector)', async () => {
  const got = await commitmentFor({
    pid: 7,
    voter: '0x1111111111111111111111111111111111111111',
    support: true,
    salt: '0x' + '22'.repeat(32),
  });
  assert.equal(got, '0x5aab197fb111f4360d00844270879be5f50e5c29da252537813f5c11a0145b4a');
});

test('commitment binds support: flipping the vote changes the hash', async () => {
  const base = { pid: 7, voter: '0x1111111111111111111111111111111111111111', salt: '0x' + '22'.repeat(32) };
  const yes = await commitmentFor({ ...base, support: true });
  const no = await commitmentFor({ ...base, support: false });
  assert.notEqual(yes, no);
});

test('commitment binds the voter: another address cannot reuse our commitment', async () => {
  const base = { pid: 7, support: true, salt: '0x' + '22'.repeat(32) };
  const a = await commitmentFor({ ...base, voter: '0x1111111111111111111111111111111111111111' });
  const b = await commitmentFor({ ...base, voter: '0x2222222222222222222222222222222222222222' });
  assert.notEqual(a, b);
});

test('salt message is domain-separated and address-case-insensitive', () => {
  const lower = saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42 });
  const upper = saltMessage({ chainId: CHAIN_ID, vault: VAULT.toUpperCase().replace('0X', '0x'), pid: 42 });
  assert.equal(lower, upper, 'a checksummed vs lowercase address must not derive two different salts');
  assert.match(lower, /^x402-vaults:reveal-salt:v1:84532:0x3{40}:42$/);
  // Different vault, different proposal, different chain ⇒ different message.
  assert.notEqual(lower, saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 43 }));
  assert.notEqual(lower, saltMessage({ chainId: 8453, vault: VAULT, pid: 42 }));
});

test('salt derivation is deterministic across independent derivations', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const a = await deriveSalt({ account, chainId: CHAIN_ID, vault: VAULT, pid: 42 });
  const b = await deriveSalt({ account, chainId: CHAIN_ID, vault: VAULT, pid: 42 });
  assert.equal(a, b);
  assert.match(a, /^0x[0-9a-f]{64}$/);
  // …and distinct per proposal, so one leaked salt cannot unmask another vote.
  assert.notEqual(a, await deriveSalt({ account, chainId: CHAIN_ID, vault: VAULT, pid: 43 }));
});

test('REVEAL AFTER RESTART: a fresh process with no stored state recovers the salt and support', async () => {
  const key = generatePrivateKey();

  // ── session 1: commit, then die. Nothing is persisted. ──
  const before = privateKeyToAccount(key);
  const vote = await buildVote({ account: before, chainId: CHAIN_ID, vault: VAULT, pid: 42, support: true });
  const onChainCommitment = vote.commitment; // the ONLY thing that survives — it is on-chain

  // ── session 2: a brand-new account object, no memory of session 1 ──
  const after = privateKeyToAccount(key);
  assert.notEqual(before, after, 'sanity: a genuinely distinct object, as after a restart');

  const recovered = await recoverVote({ account: after, chainId: CHAIN_ID, vault: VAULT, pid: 42, onChainCommitment });
  assert.ok(recovered, 'the restarted agent must be able to recover its vote');
  assert.equal(recovered.support, true, 'support is recovered from the commitment, not from storage');
  assert.equal(recovered.salt, vote.salt);

  // And the recovered pair genuinely reproduces what the contract will check.
  const rebuilt = await commitmentFor({ pid: 42, voter: after.address, support: recovered.support, salt: recovered.salt });
  assert.equal(rebuilt, onChainCommitment);
});

test('recovery of an AGAINST vote works the same way', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const vote = await buildVote({ account, chainId: CHAIN_ID, vault: VAULT, pid: 9, support: false });
  const recovered = await recoverVote({ account, chainId: CHAIN_ID, vault: VAULT, pid: 9, onChainCommitment: vote.commitment });
  assert.equal(recovered?.support, false);
});

test('recovery returns null for a commitment made by someone else', async () => {
  const mine = privateKeyToAccount(generatePrivateKey());
  const theirs = privateKeyToAccount(generatePrivateKey());
  const theirVote = await buildVote({ account: theirs, chainId: CHAIN_ID, vault: VAULT, pid: 42, support: true });
  const recovered = await recoverVote({ account: mine, chainId: CHAIN_ID, vault: VAULT, pid: 42, onChainCommitment: theirVote.commitment });
  assert.equal(recovered, null, 'we must not claim a commitment we cannot actually reveal');
});

test('a NON-DETERMINISTIC signer is rejected before it can commit an unrevealable vote', async () => {
  let n = 0;
  const flaky = { address: '0x' + '1'.repeat(40), signMessage: async () => '0x' + String(n++).padStart(130, 'a') };
  await assert.rejects(
    () => assertDeterministicSigner({ account: flaky, chainId: CHAIN_ID, vault: VAULT, pid: 42 }),
    /NOT deterministic/,
  );
});

test('a deterministic signer passes the check', async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const { deterministic } = await assertDeterministicSigner({ account, chainId: CHAIN_ID, vault: VAULT, pid: 42 });
  assert.equal(deterministic, true);
});

// v2: voter-bound. One salt key serving several agent accounts (smart accounts whose address is
// not the signer's) must not hand them identical salts, or the first reveal unmasks the rest.
const VOTER_A = getAddress('0x' + 'ab'.repeat(20)); // checksummed, so mixed case
const VOTER_B = getAddress('0x' + 'cd'.repeat(20));

test('v2 salt message appends the lowercased voter and refuses a missing one', () => {
  const m = saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42, voter: VOTER_A, version: 'v2' });
  assert.equal(m, `x402-vaults:reveal-salt:v2:84532:0x${'3'.repeat(40)}:42:${VOTER_A.toLowerCase()}`);
  assert.throws(() => saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42, version: 'v2' }), /voter/);
  assert.throws(() => saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42, voter: VOTER_A, version: 'v3' }), /unknown version/);
  // v1 ignores the voter entirely: byte-identical for every commit already on chain.
  assert.equal(
    saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42, voter: VOTER_A }),
    saltMessage({ chainId: CHAIN_ID, vault: VAULT, pid: 42 }),
  );
});

test('v2: one salt key, two voters, two different salts (v1 gave them the same one)', async () => {
  const key = privateKeyToAccount(generatePrivateKey());
  const as = (address, saltVersion) => ({ address, saltVersion, signMessage: key.signMessage });
  const p = { chainId: CHAIN_ID, vault: VAULT, pid: 42 };
  assert.equal(await deriveSalt({ account: as(VOTER_A, 'v1'), ...p }), await deriveSalt({ account: as(VOTER_B, 'v1'), ...p }));
  assert.notEqual(await deriveSalt({ account: as(VOTER_A, 'v2'), ...p }), await deriveSalt({ account: as(VOTER_B, 'v2'), ...p }));
  // Still a pure function of (salt key, voter, vote): a restarted process derives the same v2 salt.
  assert.equal(await deriveSalt({ account: as(VOTER_A, 'v2'), ...p }), await deriveSalt({ account: as(VOTER_A, 'v2'), ...p }));
});

test('v2 REVEAL AFTER RESTART: a smart-account voter with a separate salt key recovers its vote', async () => {
  const saltKey = generatePrivateKey();
  const before = { address: VOTER_A, saltVersion: 'v2', signMessage: privateKeyToAccount(saltKey).signMessage };
  const vote = await buildVote({ account: before, chainId: CHAIN_ID, vault: VAULT, pid: 42, support: false });
  const after = { address: VOTER_A, saltVersion: 'v2', signMessage: privateKeyToAccount(saltKey).signMessage };
  const recovered = await recoverVote({ account: after, chainId: CHAIN_ID, vault: VAULT, pid: 42, onChainCommitment: vote.commitment });
  assert.deepEqual(recovered, { support: false, salt: vote.salt, version: 'v2' });
});

test('a v1 commit still reveals after the account switches to v2', async () => {
  const key = privateKeyToAccount(generatePrivateKey());
  const v1 = await buildVote({ account: key, chainId: CHAIN_ID, vault: VAULT, pid: 7, support: true });
  const switched = { address: key.address, saltVersion: 'v2', signMessage: key.signMessage };
  const recovered = await recoverVote({ account: switched, chainId: CHAIN_ID, vault: VAULT, pid: 7, onChainCommitment: v1.commitment });
  assert.deepEqual(recovered, { support: true, salt: v1.salt, version: 'v1' });
});

test('a v2 commit still reveals after saltVersion is dropped', async () => {
  const key = privateKeyToAccount(generatePrivateKey());
  const v2Account = { address: key.address, saltVersion: 'v2', signMessage: key.signMessage };
  const v2 = await buildVote({ account: v2Account, chainId: CHAIN_ID, vault: VAULT, pid: 9, support: false });
  const restarted = { address: key.address, signMessage: key.signMessage };
  const recovered = await recoverVote({ account: restarted, chainId: CHAIN_ID, vault: VAULT, pid: 9, onChainCommitment: v2.commitment });
  assert.deepEqual(recovered, { support: false, salt: v2.salt, version: 'v2' });
});

test('an unknown saltVersion is refused, not guessed', async () => {
  const key = privateKeyToAccount(generatePrivateKey());
  const account = { address: key.address, saltVersion: 'V2', signMessage: key.signMessage };
  await assert.rejects(() => deriveSalt({ account, chainId: CHAIN_ID, vault: VAULT, pid: 1 }), /unknown saltVersion/);
  await assert.rejects(() => recoverVote({ account, chainId: CHAIN_ID, vault: VAULT, pid: 1, onChainCommitment: '0x' + '00'.repeat(32) }), /unknown saltVersion/);
});

test('commitmentFor rejects malformed input rather than producing a wrong hash', async () => {
  const voter = '0x1111111111111111111111111111111111111111';
  await assert.rejects(() => commitmentFor({ pid: 1, voter, support: 'true', salt: '0x' + '22'.repeat(32) }), /boolean/);
  await assert.rejects(() => commitmentFor({ pid: 1, voter, support: true, salt: '0xdeadbeef' }), /32-byte hex/);
});
