// @ts-check
/**
 * The client half of x402 `exact` on Solana.
 *
 * The tests that matter here are the ones about what the client CANNOT know without being told:
 * the facilitator's fee payer and the mint's decimals. Both arrive in the challenge, and a client
 * given an EVM-shaped challenge has to fail loudly rather than build a transaction that will be
 * refused for a reason it cannot act on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { buildSvmEnvelope, createSvmPayer } from '../src/svm-exact.mjs';
import { createProtocolClient } from '../src/index.mjs';

const payer = Keypair.generate();
const facilitator = Keypair.generate();
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOURCE = Keypair.generate().publicKey.toBase58();
const DEST = Keypair.generate().publicKey.toBase58();

/** A connection that answers the one call this module makes, and records that it was asked. */
const stubConnection = () => ({
  asked: 0,
  async getLatestBlockhash() { this.asked += 1; return { blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 1 }; },
});

const CHALLENGE = {
  scheme: 'exact-svm',
  x402Version: 2,
  asset: MINT,
  amount: '10000',
  payTo: DEST,
  network: 'solana-devnet',
  feePayer: facilitator.publicKey.toBase58(),
  decimals: 6,
};

const build = (over = {}) => buildSvmEnvelope({
  challenge: { ...CHALLENGE, ...over },
  keypair: payer,
  sourceTokenAccount: SOURCE,
  connection: stubConnection(),
});

test('the envelope carries a partially signed transaction, and the fee payer is theirs', async () => {
  const envelope = await build();
  assert.equal(envelope.x402Version, 2);
  assert.equal(envelope.scheme, 'exact-svm');
  assert.equal(envelope.network, 'solana-devnet');

  const tx = VersionedTransaction.deserialize(Buffer.from(envelope.transaction, 'base64'));
  // Account 0 is the fee payer on Solana, always. It must be the FACILITATOR's key, not ours —
  // the facilitator refuses anything else, and it is the one thing the client cannot derive.
  assert.equal(tx.message.staticAccountKeys[0].toBase58(), facilitator.publicKey.toBase58());
  assert.equal(tx.message.compiledInstructions.length, 1, 'one instruction, and it is the transfer');
  const programId = tx.message.staticAccountKeys[tx.message.compiledInstructions[0].programIdIndex];
  assert.equal(programId.toBase58(), TOKEN_PROGRAM_ID.toBase58());
  assert.equal(tx.message.compiledInstructions[0].data[0], 12, 'TransferChecked');
});

test('the payer signs and the fee-payer slot is left empty for the facilitator', async () => {
  const envelope = await build();
  const tx = VersionedTransaction.deserialize(Buffer.from(envelope.transaction, 'base64'));
  const empty = (sig) => sig.every((b) => b === 0);
  // Signature order follows account order, so slot 0 is the fee payer's and it must be unfilled.
  assert.ok(empty(tx.signatures[0]), 'the facilitator has not signed yet — that is its job');
  assert.ok(tx.signatures.some((sig) => !empty(sig)), 'and the payer HAS signed, or nothing authorises the transfer');
});

test('a challenge missing what only the server knows fails LOUDLY, not silently', async () => {
  // An EVM-shaped challenge has no feePayer and no decimals. Building anyway would produce a
  // transaction the facilitator refuses as `wrong-fee-payer`, which tells the client nothing it can
  // act on — the fault is the server's, and the message says so.
  for (const field of ['feePayer', 'decimals', 'asset', 'amount', 'payTo']) {
    await assert.rejects(
      () => build({ [field]: undefined }),
      new RegExp(`the challenge has no ${field}`),
      `a challenge without ${field} must be refused by the client`,
    );
  }
});

test('a nonpositive amount is refused before a transaction is built', async () => {
  await assert.rejects(() => build({ amount: '0' }), /nonpositive amount/);
  await assert.rejects(() => build({ amount: '-1' }), /nonpositive amount/);
});

test('the blockhash is fetched, because it is the expiry this scheme has instead of a nonce', async () => {
  // There is no nonce check on the SVM path and that is not an oversight: a Solana transaction is
  // valid only for about two minutes after the blockhash it names, and the network refuses a
  // duplicate signature inside that window. The blockhash IS the replay bound, so it has to be
  // fresh per envelope rather than cached.
  const connection = stubConnection();
  await buildSvmEnvelope({ challenge: CHALLENGE, keypair: payer, sourceTokenAccount: SOURCE, connection });
  await buildSvmEnvelope({ challenge: CHALLENGE, keypair: payer, sourceTokenAccount: SOURCE, connection });
  assert.equal(connection.asked, 2, 'each envelope gets its own blockhash');
});

test('it sets no compute-unit price, because the facilitator would refuse one', async () => {
  // The facilitator pays the fee and rejects `SetComputeUnitPrice` outright. A client that added one
  // would build an envelope guaranteed to be refused, so this pins the absence.
  const envelope = await build();
  const tx = VersionedTransaction.deserialize(Buffer.from(envelope.transaction, 'base64'));
  const programs = tx.message.compiledInstructions.map((ix) => tx.message.staticAccountKeys[ix.programIdIndex].toBase58());
  assert.ok(!programs.includes('ComputeBudget111111111111111111111111111111'), 'no compute-budget instruction at all');
});

test('createSvmPayer is the injection point, and it declares its scheme', async () => {
  const p = createSvmPayer({ keypair: payer, sourceTokenAccount: SOURCE, connection: stubConnection() });
  assert.equal(p.scheme, 'exact-svm');
  const envelope = await p.buildEnvelope({ challenge: CHALLENGE });
  assert.equal(envelope.scheme, 'exact-svm');
  assert.ok(envelope.transaction.length > 0);
});

test('a Token-2022 mint can be paid, by naming the program', async () => {
  const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
  const envelope = await buildSvmEnvelope({
    challenge: CHALLENGE, keypair: payer, sourceTokenAccount: SOURCE,
    connection: stubConnection(), tokenProgramId: TOKEN_2022,
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(envelope.transaction, 'base64'));
  const programId = tx.message.staticAccountKeys[tx.message.compiledInstructions[0].programIdIndex];
  assert.equal(programId.toBase58(), TOKEN_2022);
});

test('the destination is the challenge\'s payTo, never a derived address', async () => {
  // The facilitator compares the destination against its own configuration, so a client that
  // derived one would be refused. Taking it from the challenge is what makes the two agree.
  const envelope = await build();
  const tx = VersionedTransaction.deserialize(Buffer.from(envelope.transaction, 'base64'));
  const keys = tx.message.compiledInstructions[0].accountKeyIndexes.map((i) => tx.message.staticAccountKeys[i].toBase58());
  assert.ok(keys.includes(DEST), 'the payTo from the challenge is in the instruction accounts');
  assert.ok(keys.includes(new PublicKey(MINT).toBase58()), 'and so is the mint');
});


// ── the injection point that did not exist ──────────────────────────────────────────────────────

test('createProtocolClient takes a payer, and a payer-scheme 402 goes through it', async () => {
  // `svm-exact.mjs` documented `createProtocolClient({ payer })` as the injection point. There was
  // no `payer` parameter, and this module was not exported from the package index either — so a
  // caller outside the package could not reach `createSvmPayer` at all, and one inside it had
  // nowhere to pass the result. A documented path with no way to walk it.
  const challenge = { scheme: 'exact-svm', x402Version: 2, network: 'solana-devnet', amount: '10000' };
  let asked = null;
  const payer = {
    scheme: 'exact-svm',
    async buildEnvelope({ challenge: c }) { asked = c; return { x402Version: 2, scheme: 'exact-svm', network: c.network, transaction: 'AQAB' }; },
  };

  let sentHeader = null;
  const fetchImpl = async (_url, init) => {
    if (!init?.headers) {
      return { status: 402, headers: { get: (k) => (k === 'payment-required' ? JSON.stringify(challenge) : null) }, json: async () => ({}) };
    }
    sentHeader = init.headers['payment-signature'];
    return { status: 200, ok: true, headers: { get: () => null }, json: async () => ({ vaults: [] }) };
  };

  const client = createProtocolClient({ baseUrl: 'http://x', wallet: { address: '0x' + '1'.repeat(40), sign: async () => { throw new Error('the EVM signer must not be reached'); } }, domain: {}, fetchImpl, payer });
  const r = await client.listVaults();
  assert.deepEqual(r.data, { vaults: [] });
  assert.equal(asked?.scheme, 'exact-svm', 'the payer must receive the challenge');
  const sent = JSON.parse(Buffer.from(sentHeader, 'base64').toString('utf8'));
  assert.equal(sent.transaction, 'AQAB');
  assert.equal(sent.scheme, 'exact-svm');
});

test('a scheme the client has no payer for is an error, not a silent EVM signature', async () => {
  // Without this the client signs an EIP-3009 authorization for a Solana challenge, the server
  // rejects it, and the client retries the 402 forever with no statement of what is wrong.
  const challenge = { scheme: 'exact-svm', x402Version: 2, network: 'solana-devnet' };
  const fetchImpl = async () => ({ status: 402, headers: { get: (k) => (k === 'payment-required' ? JSON.stringify(challenge) : null) }, json: async () => ({}) });
  const client = createProtocolClient({ baseUrl: 'http://x', wallet: { address: '0x' + '1'.repeat(40), sign: async () => '0x00' }, domain: {}, fetchImpl });
  await assert.rejects(() => client.listVaults(), /has no payer for it/);
});
