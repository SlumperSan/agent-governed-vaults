// @ts-check
// The OFAC SDN payer screen in `gate()`: a listed EVM payer, or any payer while the vendored list is
// past its freshness ceiling, is refused before the replay key is reserved and before the
// facilitator is called. This screens what this server accepts, nothing wider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { gate, HEADERS } from '../src/x402.mjs';
import { isSanctionedAddress, SDN_LIST_MAX_AGE_DAYS } from '../../vaults-ui/src/lib/sanctions.ts';
import { SDN_ADDRESS_DATA } from '../../vaults-ui/src/lib/sdn-addresses.ts';

const DAY = 86_400_000;
const FETCHED = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
const FRESH = FETCHED + DAY;
const STALE = FETCHED + (SDN_LIST_MAX_AGE_DAYS + 1) * DAY; // 31 days old

const LISTED = SDN_ADDRESS_DATA.addresses[0];
const CLEAN = '0x' + 'ab'.repeat(20);
assert.ok(isSanctionedAddress(LISTED), 'fixture: LISTED is on the vendored list');
assert.ok(!isSanctionedAddress(CLEAN), 'fixture: CLEAN is not on the vendored list');

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' };
const REFUSED = 'payment refused: payer screening';

const b64 = (/** @type {any} */ o) => Buffer.from(JSON.stringify(o)).toString('base64');
const evmHeader = (/** @type {string} */ from, nonce = '0x' + '1'.repeat(64)) => ({
  [HEADERS.SIGNATURE]: b64({
    x402Version: 2,
    network: 'base',
    signature: '0xsig',
    authorization: { from, asset: USDC, to: PAYTO, value: '10000', nonce, validBefore: 0 },
  }),
});

function countingFacilitator() {
  const f = {
    calls: 0,
    async verifyAndSettle() {
      f.calls += 1;
      return { ok: true, receiptId: 'rcpt_1' };
    },
  };
  return f;
}

test('a listed payer is refused and the facilitator is never called', async () => {
  for (const from of [LISTED, LISTED.toUpperCase().replace(/^0X/, '0x')]) {
    const fac = countingFacilitator();
    const v = await gate({ headers: evmHeader(from), price, facilitator: fac, nowMs: FRESH });
    assert.equal(v.status, 402);
    assert.equal(/** @type {any} */ (v).body.error, REFUSED);
    assert.equal(fac.calls, 0);
  }
});

test('a clean payer passes to the facilitator and is served', async () => {
  const fac = countingFacilitator();
  const v = await gate({ headers: evmHeader(CLEAN), price, facilitator: fac, nowMs: FRESH });
  assert.equal(v.status, 200);
  assert.equal(fac.calls, 1);
});

test('a list past its freshness ceiling refuses every payment, clean payers included', async () => {
  for (const from of [CLEAN, LISTED]) {
    const fac = countingFacilitator();
    const v = await gate({ headers: evmHeader(from), price, facilitator: fac, nowMs: STALE });
    assert.equal(v.status, 402);
    assert.equal(/** @type {any} */ (v).body.error, REFUSED);
    assert.equal(fac.calls, 0);
  }
});

test('a refused payer leaves no replay reservation behind', async () => {
  const seen = new Set();
  const nonce = '0x' + '2'.repeat(64);
  const refused = await gate({ headers: evmHeader(LISTED, nonce), price, facilitator: countingFacilitator(), nowMs: FRESH, seenNonces: seen });
  assert.equal(refused.status, 402);
  assert.equal(seen.size, 0, 'no key reserved for a refused payer');
  const staleRefused = await gate({ headers: evmHeader(CLEAN, nonce), price, facilitator: countingFacilitator(), nowMs: STALE, seenNonces: seen });
  assert.equal(staleRefused.status, 402);
  assert.equal(seen.size, 0, 'no key reserved on a stale-list refusal');
  // The same nonce, now presented validly, is not blocked as a replay.
  const fac = countingFacilitator();
  const ok = await gate({ headers: evmHeader(CLEAN, nonce), price, facilitator: fac, nowMs: FRESH, seenNonces: seen });
  assert.equal(ok.status, 200);
  assert.equal(fac.calls, 1);
});

test('a non-string or non-address `from` is a 402 and leaves no replay reservation', async () => {
  const seen = new Set();
  for (const from of [12345, { toLowerCase: 1 }, [LISTED], 'not-an-address', '0x1234', '', 0, false, true]) {
    const fac = countingFacilitator();
    const v = await gate({ headers: evmHeader(/** @type {any} */ (from)), price, facilitator: fac, nowMs: FRESH, seenNonces: seen });
    assert.equal(v.status, 402, JSON.stringify(from));
    assert.equal(/** @type {any} */ (v).body.error, 'payment invalid: bad-payer');
    assert.equal(fac.calls, 0);
    assert.equal(seen.size, 0);
  }
});

test('an SVM price is not screened here, even on a stale list or a listed client-written `from`', async () => {
  const svmPrice = {
    asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    amount: '10000',
    payTo: 'GsbwXfJraMomNxBcjK4kZ1DXG9RrbCXjVBQdRSCTgLcz',
    network: 'solana-devnet',
    svm: { feePayer: '3MAZqvKUxvuPmqmkYX6FGgpJHNPzBn9BvKKEmDVEvk4j', decimals: 6 },
  };
  const payer = Keypair.generate();
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 }));
  tx.feePayer = Keypair.generate().publicKey;
  tx.recentBlockhash = '11111111111111111111111111111111';
  tx.partialSign(payer);
  const transaction = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  const fac = countingFacilitator();
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: b64({ x402Version: 2, scheme: 'exact-svm', network: 'solana-devnet', transaction, authorization: { from: LISTED } }) },
    price: svmPrice,
    facilitator: fac,
    nowMs: STALE,
  });
  assert.equal(v.status, 200);
  assert.equal(fac.calls, 1);
});
