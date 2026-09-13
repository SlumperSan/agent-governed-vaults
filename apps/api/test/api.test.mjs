// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gate, buildChallenge, checkEnvelopeAgainstPrice, decodeSignatureHeader, HEADERS } from '../src/x402.mjs';
import { createApi } from '../src/server.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' }; // $0.01

const okFacilitator = {
  async verifyAndSettle() {
    return { ok: true, receiptId: 'rcpt_1' };
  },
};
const rejectFacilitator = {
  async verifyAndSettle() {
    return { ok: false, reason: 'signature-invalid' };
  },
};

function envelope({ value = '10000', to = PAYTO, asset = USDC, network = 'base', nonce = '0xnonce1', validBefore = 0 } = {}) {
  const env = {
    x402Version: 2,
    network,
    signature: '0xsig',
    authorization: { asset, to, value, nonce, validBefore },
  };
  return Buffer.from(JSON.stringify(env)).toString('base64');
}

test('unpaid request returns a 402 challenge', async () => {
  const v = await gate({ headers: {}, price, facilitator: okFacilitator, nowMs: 1000 });
  assert.equal(v.status, 402);
  const ch = JSON.parse(v.headers[HEADERS.REQUIRED]);
  assert.equal(ch.asset, USDC);
  assert.equal(ch.amount, '10000');
  assert.equal(ch.x402Version, 2);
});

test('valid signature settles and authorizes (200)', async () => {
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: envelope() },
    price,
    facilitator: okFacilitator,
    nowMs: 1000,
  });
  assert.equal(v.status, 200);
  assert.equal(v.receiptId, 'rcpt_1');
  assert.equal(JSON.parse(v.headers[HEADERS.RESPONSE]).receiptId, 'rcpt_1');
});

test('underpayment is rejected before the facilitator is called', async () => {
  let called = false;
  const spy = { async verifyAndSettle() { called = true; return { ok: true }; } };
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: envelope({ value: '9999' }) },
    price,
    facilitator: spy,
    nowMs: 1000,
  });
  assert.equal(v.status, 402);
  assert.match(JSON.parse(v.headers[HEADERS.REQUIRED]) ? v.body.error : '', /underpaid/);
  assert.equal(called, false, 'facilitator must not be billed for a locally-invalid envelope');
});

test('wrong recipient / asset / network rejected locally', () => {
  assert.equal(checkEnvelopeAgainstPrice(price, { authorization: { asset: USDC, to: '0x' + '9'.repeat(40), value: '10000' }, network: 'base' }, 1000).ok, false);
  assert.equal(checkEnvelopeAgainstPrice(price, { authorization: { asset: '0x' + '9'.repeat(40), to: PAYTO, value: '10000' }, network: 'base' }, 1000).ok, false);
  assert.equal(checkEnvelopeAgainstPrice(price, { authorization: { asset: USDC, to: PAYTO, value: '10000' }, network: 'ethereum' }, 1000).ok, false);
});

test('expired authorization rejected', () => {
  const r = checkEnvelopeAgainstPrice(price, { authorization: { asset: USDC, to: PAYTO, value: '10000', validBefore: 1 }, network: 'base' }, 999_999_999_000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'authorization-expired');
});

test('facilitator rejection surfaces as 402', async () => {
  const v = await gate({
    headers: { [HEADERS.SIGNATURE]: envelope() },
    price,
    facilitator: rejectFacilitator,
    nowMs: 1000,
  });
  assert.equal(v.status, 402);
  assert.match(v.body.error, /settlement failed/);
});

test('replayed nonce rejected on second use', async () => {
  const seen = new Set();
  const first = await gate({ headers: { [HEADERS.SIGNATURE]: envelope({ nonce: '0xreplay' }) }, price, facilitator: okFacilitator, nowMs: 1000, seenNonces: seen });
  assert.equal(first.status, 200);
  const second = await gate({ headers: { [HEADERS.SIGNATURE]: envelope({ nonce: '0xreplay' }) }, price, facilitator: okFacilitator, nowMs: 1000, seenNonces: seen });
  assert.equal(second.status, 402);
  assert.match(second.body.error, /replayed-nonce/);
});

test('malformed signature header decodes to null → 402', () => {
  assert.equal(decodeSignatureHeader('not-base64-!!!'), null);
  assert.equal(decodeSignatureHeader(Buffer.from('{"x402Version":1}').toString('base64')), null); // wrong version
});

// ── the scheme is the SERVER's to choose ────────────────────────────────────

const svmPrice = {
  asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  amount: '10000',
  payTo: 'GsbwXfJraMomNxBcjK4kZ1DXG9RrbCXjVBQdRSCTgLcz',
  network: 'solana-devnet',
  svm: { feePayer: '3MAZqvKUxvuPmqmkYX6FGgpJHNPzBn9BvKKEmDVEvk4j', decimals: 6 },
};
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

test('a client CANNOT disable the price checks by claiming a scheme', async () => {
  // THE REGRESSION THIS PINS. `checkEnvelopeAgainstPrice` branched on `env.scheme` — a string the
  // client writes — so against an EVM price an envelope that merely said `scheme:'exact-svm'` and
  // carried any non-empty `transaction` returned ok. Asset, recipient, amount and expiry were all
  // skipped, and so was the replay guard, which reads `env.authorization.nonce` that a spoofed
  // envelope does not have. Wrong asset, wrong recipient, and it settled.
  const spoof = {
    x402Version: 2,
    scheme: 'exact-svm',
    network: 'base',
    transaction: 'AAAA',
    signature: '0x' + '1'.repeat(130),
    authorization: {},
  };
  const local = checkEnvelopeAgainstPrice(price, spoof, 1000);
  assert.equal(local.ok, false, 'an SVM claim must not switch off an EVM price check');
  assert.equal(local.reason, 'scheme-mismatch');

  let billed = false;
  const spy = { async verifyAndSettle() { billed = true; return { ok: true, receiptId: 'r' }; } };
  const v = await gate({ headers: { [HEADERS.SIGNATURE]: b64(spoof) }, price, facilitator: spy, nowMs: 1000 });
  assert.equal(v.status, 402, 'the gate must refuse it');
  assert.equal(billed, false, 'and must not reach the facilitator');
});

test('an EVM envelope cannot be paid against an SVM price either', () => {
  const evm = { x402Version: 2, network: 'solana-devnet', signature: '0x' + '1'.repeat(130), authorization: { asset: 'x', to: 'y', value: '10000' } };
  const r = checkEnvelopeAgainstPrice(svmPrice, evm, 1000);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'scheme-mismatch');
});

test('an SVM envelope reaches the facilitator when the SERVER’s price is SVM', async () => {
  // BLOCKER 1. `decodeSignatureHeader` required `{signature, authorization}` unconditionally, and
  // the shipped `buildSvmEnvelope` produces neither — so `gate()` 402'd every SVM payment forever
  // and the facilitator was never reached through the only production entry point, while the
  // commit that removed the boot refusal said the path was finished. This is that path, end to end.
  const env = { x402Version: 2, scheme: 'exact-svm', network: 'solana-devnet', transaction: 'AQAB' };
  assert.notEqual(decodeSignatureHeader(b64(env)), null, 'the decoder must accept the SVM shape');
  assert.equal(checkEnvelopeAgainstPrice(svmPrice, env, 1000).ok, true);

  let seenEnvelope = null;
  const spy = { async verifyAndSettle(_c, e) { seenEnvelope = e; return { ok: true, receiptId: 'sig' }; } };
  const v = await gate({ headers: { [HEADERS.SIGNATURE]: b64(env) }, price: svmPrice, facilitator: spy, nowMs: 1000 });
  assert.equal(v.status, 200, `expected settlement, got ${v.status} ${v.body?.error ?? ''}`);
  assert.equal(seenEnvelope?.transaction, 'AQAB');
});

test('the SVM replay key is the transaction, because there is no nonce to read', async () => {
  // `env.authorization?.nonce` is undefined on this path, so the guard was present and inert —
  // which is worse than absent, because it looks like protection.
  const env = { x402Version: 2, scheme: 'exact-svm', network: 'solana-devnet', transaction: 'AQAB' };
  const seen = new Set();
  const ok = { async verifyAndSettle() { return { ok: true, receiptId: 'sig' }; } };
  const first = await gate({ headers: { [HEADERS.SIGNATURE]: b64(env) }, price: svmPrice, facilitator: ok, nowMs: 1000, seenNonces: seen });
  assert.equal(first.status, 200);
  const second = await gate({ headers: { [HEADERS.SIGNATURE]: b64(env) }, price: svmPrice, facilitator: ok, nowMs: 1000, seenNonces: seen });
  assert.equal(second.status, 402);
  assert.match(second.body.error, /replayed-nonce/);
});

test('a client cannot pick its own replay key by attaching an invented nonce', async () => {
  // THE ATTACK, AS DEMONSTRATED IN REVIEW. The key was
  // `env.authorization?.nonce ?? (scheme === 'exact-svm' ? env.transaction : undefined)`, and
  // `env.authorization` is client-supplied while the SVM branch of the price check never reads it.
  // So identical transaction bytes with a fresh invented `authorization.nonce` each time presented
  // the same payment over and over: five attempts, five 200s. One line below the comment explaining
  // that a client-supplied field must not select which server check runs.
  const seen = new Set();
  const ok = { async verifyAndSettle() { return { ok: true, receiptId: 'sig' }; } };
  const statuses = [];
  for (let i = 0; i < 5; i += 1) {
    const env = {
      x402Version: 2, scheme: 'exact-svm', network: 'solana-devnet', transaction: 'AQAB',
      authorization: { nonce: `0xinvented${i}` },
    };
    const r = await gate({ headers: { [HEADERS.SIGNATURE]: b64(env) }, price: svmPrice, facilitator: ok, nowMs: 1000, seenNonces: seen });
    statuses.push(r.status);
  }
  assert.deepEqual(statuses, [200, 402, 402, 402, 402],
    `identical transaction bytes must settle once however the envelope is dressed, got ${statuses.join(',')}`);
  assert.equal(seen.size, 1, 'the set must hold ONE key for one payment, not one per invented nonce');
});

test('the EVM replay key is still the authorization nonce, not the price', async () => {
  // The other direction: the fix selects on `price.svm`, so an EVM price must be unaffected — a
  // `transaction` field on an EVM envelope must not become anybody's key.
  const seen = new Set();
  const ok = { async verifyAndSettle() { return { ok: true, receiptId: 'r' }; } };
  const mk = (nonce) => b64({ x402Version: 2, network: 'base', signature: `0x${'1'.repeat(130)}`, transaction: 'AQAB', authorization: { asset: USDC, to: PAYTO, value: '10000', nonce } });
  assert.equal((await gate({ headers: { [HEADERS.SIGNATURE]: mk('0xaaa') }, price, facilitator: ok, nowMs: 1000, seenNonces: seen })).status, 200);
  assert.equal((await gate({ headers: { [HEADERS.SIGNATURE]: mk('0xaaa') }, price, facilitator: ok, nowMs: 1000, seenNonces: seen })).status, 402);
  // Same identical `transaction` string, a different authorization: a DIFFERENT payment on this path.
  assert.equal((await gate({ headers: { [HEADERS.SIGNATURE]: mk('0xbbb') }, price, facilitator: ok, nowMs: 1000, seenNonces: seen })).status, 200);
});

test('an EVM price still produces a byte-identical challenge', () => {
  const c = buildChallenge(price, { nowMs: 1000 });
  assert.equal(c.scheme, 'exact');
  assert.equal(c.feePayer, undefined);
  assert.equal(c.decimals, undefined);
});

// ── end-to-end through the server handler ────────────────────────────────────

const VAULT = '0x' + '1'.repeat(40);

function seededApi(facilitator) {
  const state = applyAll([
    { name: 'VaultCreated', vault: VAULT, blockNumber: 1, logIndex: 0, args: { vault: VAULT, creator: '0x' + 'a'.repeat(40), usdc: USDC, capacityCapUsdc: 1000n } },
    { name: 'OperatorRegistered', vault: VAULT, blockNumber: 1, logIndex: 1, args: { opId: 1, operator: '0x' + 'a'.repeat(40) } },
    { name: 'VaultAttested', vault: VAULT, blockNumber: 1, logIndex: 2, args: { vault: VAULT, opId: 1 } },
    { name: 'RealizationRecorded', vault: VAULT, blockNumber: 2, logIndex: 0, args: { opId: 1, gainUsdc: 100n, lossUsdc: 0n } },
  ]);
  return createApi({ state, facilitator, price, now: () => 1000 });
}

test('health route is free', async () => {
  const api = seededApi(okFacilitator);
  const r = await api.handle('GET', '/health', {});
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('vault route requires payment then serves data', async () => {
  const api = seededApi(okFacilitator);
  const unpaid = await api.handle('GET', `/vaults/${VAULT}`, {});
  assert.equal(unpaid.status, 402);

  const paid = await api.handle('GET', `/vaults/${VAULT}`, { [HEADERS.SIGNATURE]: envelope({ nonce: '0xv1' }) });
  assert.equal(paid.status, 200);
  assert.equal(JSON.parse(paid.body).operatorId, 1);
});

test('leaderboard route serves aggregated operators when paid', async () => {
  const api = seededApi(okFacilitator);
  const paid = await api.handle('GET', '/operators/leaderboard', { [HEADERS.SIGNATURE]: envelope({ nonce: '0xlb1' }) });
  assert.equal(paid.status, 200);
  const body = JSON.parse(paid.body);
  assert.equal(body.leaderboard[0].netRealizedUsdc, '100');
});

test('discovery document is free and lists pricing + routes', async () => {
  const api = seededApi(okFacilitator);
  const r = await api.handle('GET', '/.well-known/x402', {});
  assert.equal(r.status, 200);
  const doc = JSON.parse(r.body);
  assert.equal(doc.x402Version, 2);
  assert.equal(doc.price.asset, USDC);
  assert.ok(doc.routes.metered.includes('/vaults'));
  assert.ok(doc.routes.free.includes('/health'));
});

test('vault list route requires payment then returns discovery data', async () => {
  const api = seededApi(okFacilitator);
  const unpaid = await api.handle('GET', '/vaults', {});
  assert.equal(unpaid.status, 402);
  const paid = await api.handle('GET', '/vaults', { [HEADERS.SIGNATURE]: envelope({ nonce: '0xlist1' }) });
  assert.equal(paid.status, 200);
  const body = JSON.parse(paid.body);
  assert.equal(body.vaults.length, 1);
  assert.equal(body.vaults[0].vault, VAULT);
  assert.equal(body.vaults[0].attested, true);
});

// ── challenge nonce: unpredictable and process-independent (sprint-14 live bug) ──

test('buildChallenge issues a unique, unpredictable nonce — never a restart-resetting counter', () => {
  const p = { asset: '0x' + 'c'.repeat(40), amount: '10000', payTo: '0x' + '2'.repeat(40), network: 'base-sepolia' };
  const nonces = new Set();
  for (let i = 0; i < 512; i++) nonces.add(buildChallenge(p, { nowMs: 0 }).nonce);

  assert.equal(nonces.size, 512, 'every challenge must carry a distinct nonce');
  for (const n of nonces) assert.match(n, /^0x[0-9a-f]{64}$/, 'nonce must be a 32-byte hex string');

  // The regression: a module-level counter made the FIRST nonce of every process `0x…0001`. The
  // agent SDK reuses challenge.nonce as the EIP-3009 authorization nonce, and EIP-3009 burns
  // nonces permanently per (authorizer, nonce) — so a fresh API process would hand out an
  // authorization nonce a previous process had already spent, and the settlement would revert as
  // `authorization-used` forever after.
  const counterish = `0x${'0'.repeat(63)}1`;
  assert.ok(!nonces.has(counterish), 'a low counter-shaped nonce would collide across restarts');
});

test('buildChallenge still honours an injected nonce so tests stay deterministic', () => {
  const p = { asset: '0x' + 'c'.repeat(40), amount: '10000', payTo: '0x' + '2'.repeat(40), network: 'base-sepolia' };
  assert.equal(buildChallenge(p, { nowMs: 0, nonce: '0xfeed' }).nonce, '0xfeed');
});
