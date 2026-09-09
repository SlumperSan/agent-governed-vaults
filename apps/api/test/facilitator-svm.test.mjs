// @ts-check
/**
 * The SVM facilitator, attacked rather than demonstrated.
 *
 * WHY THE SHAPE OF THIS FILE IS "ONE HAPPY CASE AND TWENTY REJECTIONS". On the EVM path the client
 * signs an intent and this server builds the transaction, so a malformed envelope simply fails to
 * recover. On Solana THE CLIENT BUILDS THE WHOLE TRANSACTION and the server is asked to co-sign and
 * broadcast it. Anything the verifier does not check, it endorses. So the useful test is not "does
 * a correct payment pass" -- it is "does every incorrect one fail, and fail for the stated reason".
 *
 * Every transaction below is a real one, built with the same SDK a client would use and serialised
 * to the same bytes. No network and no key: the connection is a stub and the keypairs are generated
 * in-process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, Transaction, TransactionInstruction, SystemProgram, VersionedTransaction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import { createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  verifySvmPayment, decodeTransaction, instructionsOf, createSvmFacilitator, keypairFromEnv, base58Decode,
} from '../src/facilitator-svm.mjs';

const payer = Keypair.generate();          // the client
const feePayerKp = Keypair.generate();     // the facilitator
const MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC mainnet mint
const SOURCE = Keypair.generate().publicKey;
const DEST = Keypair.generate().publicKey;
const DECIMALS = 6;
const AMOUNT = 10_000n; // $0.01 at 6dp, the same price the EVM path uses

const CFG = { destinationTokenAccount: DEST.toBase58(), feePayer: feePayerKp.publicKey.toBase58() };
const CHALLENGE = { price: { asset: MINT.toBase58(), amount: AMOUNT.toString(), payTo: DEST.toBase58(), network: 'solana-devnet' } };

/** A legacy transaction carrying exactly one TransferChecked, unsigned by the fee payer. */
function buildTx({ amount = AMOUNT, mint = MINT, dest = DEST, source = SOURCE, authority = payer.publicKey, extra = [], feePayer = feePayerKp.publicKey } = {}) {
  const tx = new Transaction();
  tx.add(createTransferCheckedInstruction(source, mint, dest, authority, amount, DECIMALS, [], TOKEN_PROGRAM_ID));
  for (const ix of extra) tx.add(ix);
  tx.feePayer = feePayer;
  tx.recentBlockhash = '11111111111111111111111111111111';
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

const verify = (b64, challenge = CHALLENGE, cfg = CFG) => verifySvmPayment(challenge, { x402Version: 2, transaction: b64 }, cfg);

// ── the one that must pass ──────────────────────────────────────────────────────────────────────

test('a transaction carrying exactly the expected transfer verifies', () => {
  const v = verify(buildTx());
  assert.equal(v.ok, true, `expected ok, got ${v.ok === false ? v.reason : ''}`);
  assert.equal(v.amount, AMOUNT);
  assert.equal(v.source, SOURCE.toBase58());
  assert.equal(v.authority, payer.publicKey.toBase58());
});

test('a versioned transaction verifies too, because refusing one would refuse a wallet', () => {
  const message = new TransactionMessage({
    payerKey: feePayerKp.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [createTransferCheckedInstruction(SOURCE, MINT, DEST, payer.publicKey, AMOUNT, DECIMALS, [], TOKEN_PROGRAM_ID)],
  }).compileToV0Message();
  const b64 = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  const v = verify(b64);
  assert.equal(v.ok, true, `expected ok, got ${v.ok === false ? v.reason : ''}`);
  assert.equal(v.amount, AMOUNT);
});

// ── the ones that must not ──────────────────────────────────────────────────────────────────────

test('an EXTRA instruction from an unknown program is refused, not ignored', () => {
  // This is the attack the allow-list exists for: the expected payment, plus one instruction that
  // moves the fee payer's SOL. A verifier that searches for its transfer and stops would sign it.
  const drain = SystemProgram.transfer({ fromPubkey: feePayerKp.publicKey, toPubkey: payer.publicKey, lamports: 1_000_000_000 });
  const v = verify(buildTx({ extra: [drain] }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /^unexpected-program:/);
  assert.ok(v.reason.includes(SystemProgram.programId.toBase58()), 'the reason names the program that was refused');
});

test('a SECOND transfer is refused even when the first one is correct', () => {
  const second = createTransferCheckedInstruction(SOURCE, MINT, DEST, payer.publicKey, 1n, DECIMALS, [], TOKEN_PROGRAM_ID);
  const v = verify(buildTx({ extra: [second] }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'more-than-one-transfer');
});

test('a token instruction that is not TransferChecked is refused before it is decoded', () => {
  // Discriminator 3 is the unchecked `Transfer`, which carries no mint and no decimals -- so it
  // cannot be checked against the price at all, and accepting it would be accepting an unknown.
  const ix = new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [SOURCE, DEST, payer.publicKey].map((pubkey, i) => ({ pubkey, isSigner: i === 2, isWritable: i !== 2 })),
    data: Buffer.from([3, ...new Array(8).fill(0)]),
  });
  const tx = new Transaction().add(ix);
  tx.feePayer = feePayerKp.publicKey;
  tx.recentBlockhash = '11111111111111111111111111111111';
  const v = verify(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'token-instruction-is-not-transferchecked');
});

test('the wrong mint is refused — paying the right amount of the wrong token is not paying', () => {
  const v = verify(buildTx({ mint: Keypair.generate().publicKey }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'wrong-mint');
});

test('the wrong destination is refused, and the destination comes from config not from the request', () => {
  const v = verify(buildTx({ dest: Keypair.generate().publicKey }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'wrong-destination');
});

test('a short payment is refused, and so is an over-payment', () => {
  assert.equal(verify(buildTx({ amount: AMOUNT - 1n })).reason, 'wrong-amount');
  assert.equal(verify(buildTx({ amount: AMOUNT + 1n })).reason, 'wrong-amount',
    'over-paying is still not the agreed price, and accepting it invites a rounding attack on the ledger');
});

test('a transfer whose authority is the fee payer is refused', () => {
  // Otherwise this server can be induced to pay itself and call it settled.
  const v = verify(buildTx({ authority: feePayerKp.publicKey }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'authority-is-fee-payer');
});

test('a transaction naming somebody else as fee payer is refused at VERIFY time', () => {
  // IT USED TO VERIFY. The mismatch surfaced later, inside `sign()`, as
  // `settlement-error:Cannot sign with non signer key …` — and `settlement-error` means "we could
  // not tell whether you paid" in this repository, which was false: we could tell, the envelope was
  // malformed. Nothing was ever submitted, so this is a diagnosis fix rather than a hole; but three
  // earlier PRs here exist because a failed call got reported as a verdict, and this was the fourth.
  const v = verify(buildTx({ feePayer: Keypair.generate().publicKey }));
  assert.equal(v.ok, false);
  assert.match(v.reason, /^wrong-fee-payer:/);
});

test('settlement never reaches the chain for a foreign fee payer, and says why', async () => {
  const connection = stubConnection();
  const fac = createSvmFacilitator({ connection, keypair: feePayerKp, destinationTokenAccount: DEST.toBase58() });
  const r = await fac.verifyAndSettle(CHALLENGE, { x402Version: 2, transaction: buildTx({ feePayer: Keypair.generate().publicKey }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^wrong-fee-payer:/, 'a verification reason, not a settlement-error');
  assert.equal(connection.sent.length, 0);
});

test('a transfer from the destination to itself is refused', () => {
  const v = verify(buildTx({ source: DEST }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'source-is-destination');
});

test('an empty or undecodable transaction is refused with a reason that says which', () => {
  assert.equal(verify('').reason, 'no-transaction');
  assert.equal(verify('!!!not base64!!!').reason, 'transaction-undecodable');
  assert.equal(verify(Buffer.from('nonsense').toString('base64')).reason, 'transaction-undecodable');
});

test('a transaction with no instructions at all is refused', () => {
  const tx = new Transaction();
  tx.feePayer = feePayerKp.publicKey;
  tx.recentBlockhash = '11111111111111111111111111111111';
  const v = verify(tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'));
  assert.equal(v.ok, false);
  assert.ok(['no-instructions', 'no-transfer'].includes(v.reason), `got ${v.reason}`);
});

test('the envelope version and the price are checked before anything is decoded', () => {
  assert.equal(verifySvmPayment(CHALLENGE, null, CFG).reason, 'no-envelope');
  assert.equal(verifySvmPayment(CHALLENGE, { x402Version: 1, transaction: 'x' }, CFG).reason, 'bad-version');
  assert.equal(verifySvmPayment({}, { x402Version: 2, transaction: 'x' }, CFG).reason, 'no-price');
  assert.equal(verifySvmPayment({ price: { amount: 'not a number' } }, { x402Version: 2, transaction: 'x' }, CFG).reason, 'bad-price-amount');
  assert.equal(verifySvmPayment({ price: { amount: '0' } }, { x402Version: 2, transaction: 'x' }, CFG).reason, 'nonpositive-price');
  assert.equal(verifySvmPayment({ price: { amount: '-1' } }, { x402Version: 2, transaction: 'x' }, CFG).reason, 'nonpositive-price');
});

test('a compute-unit LIMIT is allowed alongside the transfer, because it costs the fee payer nothing', () => {
  const v = verify(buildTx({ extra: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 })] }));
  assert.equal(v.ok, true, `a unit-limit instruction must not be a rejection, got ${v.ok === false ? v.reason : ''}`);
});

test('a compute-unit PRICE is REFUSED, because the fee payer paying it is this server', () => {
  // THE FIRST DRAFT ALLOWED THIS. ComputeBudget was on a per-PROGRAM benign list under the comment
  // "it moves nothing and cannot" — true of the limit, false of the price. The priority fee is
  // limit × price, and on this path the fee payer is the facilitator's own keypair, so an otherwise
  // perfect $0.01 payment could have carried a five-million-microlamport price and billed the
  // operator for the privilege. That is precisely the shape the allow-list exists to stop, and it
  // would have been waved through BY an allow-list entry.
  const v = verify(buildTx({ extra: [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000_000 })] }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'compute-unit-price-is-paid-by-the-facilitator');
});

test('an unrecognised ComputeBudget instruction is refused, not assumed harmless', () => {
  // The program is allowed to appear; that is not the same as every byte it accepts being safe.
  const ix = new TransactionInstruction({
    programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
    keys: [],
    data: Buffer.from([9, 1, 2, 3]),
  });
  const v = verify(buildTx({ extra: [ix] }));
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'unexpected-compute-budget-instruction:9');
});

// ── settlement ──────────────────────────────────────────────────────────────────────────────────

const stubConnection = (over = {}) => ({
  sent: [],
  async sendRawTransaction(raw) { this.sent.push(raw); return over.signature ?? 'sig_' + this.sent.length; },
  async confirmTransaction() { return over.confirmation ?? { value: { err: null } }; },
  ...over,
});

test('settlement signs, submits, and returns the signature as the receipt', async () => {
  const connection = stubConnection();
  const fac = createSvmFacilitator({ connection, keypair: feePayerKp, destinationTokenAccount: DEST.toBase58() });
  const r = await fac.verifyAndSettle(CHALLENGE, { x402Version: 2, transaction: buildTx() });
  assert.equal(r.ok, true, `expected ok, got ${r.reason}`);
  assert.equal(r.receiptId, 'sig_1');
  assert.equal(connection.sent.length, 1, 'exactly one submission');
  assert.equal(fac.scheme, 'exact-svm');
});

test('a rejected payment is NEVER submitted', async () => {
  // The whole point: verification gates the network call, not the other way round.
  const connection = stubConnection();
  const fac = createSvmFacilitator({ connection, keypair: feePayerKp, destinationTokenAccount: DEST.toBase58() });
  const r = await fac.verifyAndSettle(CHALLENGE, { x402Version: 2, transaction: buildTx({ amount: 1n }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong-amount');
  assert.equal(connection.sent.length, 0, 'a refused payment must not reach the chain');
});

test('an on-chain failure is reported as a failure, not as a receipt', async () => {
  const connection = stubConnection({ confirmation: { value: { err: { InstructionError: [0, 'Custom'] } } } });
  const fac = createSvmFacilitator({ connection, keypair: feePayerKp, destinationTokenAccount: DEST.toBase58() });
  const r = await fac.verifyAndSettle(CHALLENGE, { x402Version: 2, transaction: buildTx() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^settlement-failed:/);
});

test('a transport failure says it could not tell, not that the payment was bad', async () => {
  // #173/#179/#183 in this repository are all the same lesson: a failed call is not a verdict.
  const connection = stubConnection({ async sendRawTransaction() { throw new Error('429 rate limited'); } });
  const fac = createSvmFacilitator({ connection, keypair: feePayerKp, destinationTokenAccount: DEST.toBase58() });
  const r = await fac.verifyAndSettle(CHALLENGE, { x402Version: 2, transaction: buildTx() });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^settlement-error:/);
  assert.match(r.reason, /429/, 'the operator reading this at 3am needs the transport error in it');
});

// ── the keypair ─────────────────────────────────────────────────────────────────────────────────

test('the keypair parses from both shapes an operator actually has', () => {
  const kp = Keypair.generate();
  const asArray = keypairFromEnv(JSON.stringify(Array.from(kp.secretKey)));
  assert.equal(asArray.ok, true);
  assert.equal(asArray.keypair.publicKey.toBase58(), kp.publicKey.toBase58());

  const asBase58 = keypairFromEnv(bs58(kp.secretKey));
  assert.equal(asBase58.ok, true, `base58 form failed: ${asBase58.ok === false ? asBase58.reason : ''}`);
  assert.equal(asBase58.keypair.publicKey.toBase58(), kp.publicKey.toBase58());
});

test('a missing or malformed keypair is a reason, not a throw on a boot path', () => {
  assert.equal(keypairFromEnv(undefined).reason, 'no-keypair');
  assert.equal(keypairFromEnv('   ').reason, 'no-keypair');
  assert.match(keypairFromEnv('[1,2,3]').reason, /keypair-wrong-length:3/);
  assert.match(keypairFromEnv('not a key').reason, /keypair-unparseable/);
});

test('base58 decoding keeps leading zero bytes, which are part of the key', () => {
  // Dropping them yields a different, valid-looking key -- the quietest possible way to sign as
  // the wrong account.
  const withLeadingZero = Uint8Array.from([0, 0, 7, 9]);
  assert.deepEqual(Array.from(base58Decode(bs58(withLeadingZero))), [0, 0, 7, 9]);
});

/** base58 encode, for the test's own fixtures only. */
function bs58(bytes) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = A[Number(n % 58n)] + out; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; out = '1' + out; }
  return out;
}

test('one parser reads both wire formats, and reports which it read', () => {
  // THIS TEST FOUND A DEAD BRANCH. The implementation first tried the versioned parser and fell
  // back to the legacy one; this leg asserted the fallback ran for legacy bytes, and it failed --
  // `VersionedTransaction.deserialize` accepts legacy wire format too and reports
  // `message.version === 'legacy'`. The fallback had never run for any well-formed input. It was
  // removed rather than the assertion relaxed, and this leg now pins the real behaviour so nobody
  // reintroduces the branch believing it is needed.
  const legacy = decodeTransaction(buildTx());
  assert.equal(legacy.ok, true);
  assert.equal(legacy.version, 'legacy', 'a legacy transaction is read, and says it is legacy');
  assert.equal(instructionsOf(legacy).length, 1);

  const message = new TransactionMessage({
    payerKey: feePayerKp.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [createTransferCheckedInstruction(SOURCE, MINT, DEST, payer.publicKey, AMOUNT, DECIMALS, [], TOKEN_PROGRAM_ID)],
  }).compileToV0Message();
  const v0 = decodeTransaction(Buffer.from(new VersionedTransaction(message).serialize()).toString('base64'));
  assert.equal(v0.ok, true);
  assert.equal(v0.version, 0, 'a v0 transaction reports version 0');
  assert.equal(instructionsOf(v0).length, 1);
  assert.equal(instructionsOf(v0)[0].programId, TOKEN_PROGRAM_ID.toBase58());
});

test('a malformed keypair leaks NO byte of the key into the reason', () => {
  // THE COMMIT MESSAGE FOR THE FIRST DRAFT CLAIMED A TEST ALREADY PROVED THIS. It did not: the case
  // it pointed at fed `[1,2,3]`, which fails on LENGTH and never reaches the parser. The parser is
  // where the leak was — V8 quotes a window of its input back in a SyntaxError, so
  // `keypair-unparseable:Unexpected token 'x', "[x254,96,74"... is not valid JSON` carries three
  // real secret-key bytes, and `serve.mjs` puts that string in `log.error('startup.failed')`.
  //
  // So the test uses a REAL generated key with a one-character typo, and asserts on the key's own
  // bytes rather than on the shape of the message. A future refactor that reintroduces the parser's
  // text reds this by name.
  const kp = Keypair.generate();
  const json = JSON.stringify(Array.from(kp.secretKey));
  for (const [label, mangled] of [
    ['a typo at the head', '[x' + json.slice(1)],
    ['a typo at the tail', json.slice(0, -1) + ',]'],
    ['truncated', json.slice(0, 40)],
    ['not json and not base58', '{"secret": "nope"}'],
  ]) {
    const r = keypairFromEnv(mangled);
    assert.equal(r.ok, false, `${label}: must not parse`);
    // EQUALITY IS THE REAL ASSERTION. The reason can only be one of two fixed strings, so no
    // input-derived content can be in it at all — that is stronger than any search for key bytes.
    assert.ok(
      r.reason === 'keypair-unparseable:json-array' || r.reason === 'keypair-unparseable:base58',
      `${label}: the reason must be a shape, got "${r.reason}"`,
    );
    // The byte scan stays because it is what makes a REGRESSION legible: if somebody puts the
    // parser's message back, this names the leaked byte rather than just saying the string changed.
    // It runs on the part after the shape token, because 'base58' contains the digits 5 and 8 and a
    // key byte of 58 would otherwise report itself — which it did, on the first run, at random.
    const scanned = r.reason.replace(/^keypair-unparseable:(json-array|base58)$/, '');
    for (const byte of kp.secretKey) {
      const needle = String(byte);
      if (needle.length < 2) continue;
      assert.ok(
        !scanned.includes(needle),
        `${label}: the reason "${r.reason}" contains ${needle}, which is a byte of the secret key`,
      );
    }
  }
});

test('the shape code says which encoding was attempted, so a typo is still fixable', () => {
  assert.equal(keypairFromEnv('[1,2,not-a-number]').reason, 'keypair-unparseable:json-array');
  assert.equal(keypairFromEnv('0OIl-invalid-base58').reason, 'keypair-unparseable:base58');
});
