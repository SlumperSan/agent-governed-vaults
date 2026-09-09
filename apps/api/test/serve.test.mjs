// @ts-check
/**
 * Tests the API server entrypoint: config resolution, facilitator selection, fault-tolerant
 * in-place snapshot reload, and the CORS/preflight path over the REAL http server (the piece the
 * browser live mode depends on).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { rm, writeFile, mkdtemp } from 'node:fs/promises';
import { resolveApiConfig, facilitatorFromConfig, buildApiServer } from '../src/serve.mjs';
import { createApi } from '../src/server.mjs';
import { createStubFacilitator } from '../src/facilitator.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';
import { saveSnapshot } from '../../../packages/indexer/src/store.mjs';
import { readHeartbeatFile } from '../../../packages/oplog/src/heartbeat.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + '9'.repeat(40);
const BASE_ENV = { PRICE_ASSET: USDC, PRICE_PAYTO: PAYTO };
// A real devnet mint address, used only for its SHAPE — 32 bytes of base58, which is what the
// SVM checks accept and the EVM checks reject.
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SVM_PRICE = { PRICE_ASSET: MINT, PRICE_PAYTO: MINT };

test('resolveApiConfig defaults + price assembly', () => {
  const cfg = resolveApiConfig(BASE_ENV);
  assert.equal(cfg.port, 8402);
  assert.equal(cfg.reloadMs, 5000);
  assert.equal(cfg.facilitatorKind, 'stub');
  assert.deepEqual(cfg.price, { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' });
});

test('resolveApiConfig requires PRICE_ASSET + PRICE_PAYTO and validates them', () => {
  assert.throws(() => resolveApiConfig({}), /PRICE_ASSET.*PRICE_PAYTO/);
  assert.throws(() => resolveApiConfig({ ...BASE_ENV, PRICE_ASSET: '0xzz' }), /PRICE_ASSET is not an 0x address/);
});

test('resolveApiConfig: FACILITATOR=http demands a URL', () => {
  assert.throws(() => resolveApiConfig({ ...BASE_ENV, FACILITATOR: 'http' }), /requires FACILITATOR_URL/);
  const ok = resolveApiConfig({ ...BASE_ENV, FACILITATOR: 'http', FACILITATOR_URL: 'https://f.example' });
  assert.equal(ok.facilitatorKind, 'http');
  assert.throws(() => resolveApiConfig({ ...BASE_ENV, FACILITATOR: 'nope' }), /must be 'stub', 'http' or 'svm'/);
});

test("resolveApiConfig: FACILITATOR=svm demands all three of its settings", () => {
  // Each is required rather than defaulted. A Solana facilitator with a missing destination would
  // verify every payment against `undefined` and refuse all of them, which looks like a client
  // problem for as long as it takes somebody to read serve.mjs.
  const svm = { ...SVM_PRICE, FACILITATOR: 'svm', SVM_RPC_URL: 'https://api.devnet.solana.com', SVM_KEYPAIR: '[1]', SVM_DESTINATION_TOKEN_ACCOUNT: MINT, SVM_DECIMALS: '6' };
  for (const missing of ['SVM_RPC_URL', 'SVM_KEYPAIR', 'SVM_DESTINATION_TOKEN_ACCOUNT', 'SVM_DECIMALS']) {
    const env = { ...BASE_ENV, ...svm };
    delete env[missing];
    assert.throws(() => resolveApiConfig(env), new RegExp(`requires ${missing}`), `${missing} must be required`);
  }
  const cfg = resolveApiConfig({ ...BASE_ENV, ...svm });
  assert.equal(cfg.facilitatorKind, 'svm');
  assert.equal(cfg.svm.destinationTokenAccount, MINT);
  assert.equal(cfg.price.svm.decimals, 6, 'the decimals reach the price, and from there the challenge');
  assert.equal(resolveApiConfig(BASE_ENV).svm, null, 'the svm block is absent unless asked for');
});

test('FACILITATOR=svm takes Solana-shaped addresses, and EVM mode still refuses them', () => {
  // THIS TEST USED TO ASSERT A BOOT REFUSAL. The mode could not settle: PRICE_ASSET was checked
  // against the EVM shape unconditionally, so the price could never name a Solana mint and every
  // payment died as `wrong-mint`. Rather than keep a guard that said "this does not work", the shape
  // now follows the facilitator, and what is pinned is that each mode takes its own kind of address
  // and refuses the other's.
  const svm = { FACILITATOR: 'svm', SVM_RPC_URL: 'https://api.devnet.solana.com', SVM_KEYPAIR: '[1]', SVM_DESTINATION_TOKEN_ACCOUNT: MINT, SVM_DECIMALS: '6' };
  const cfg = resolveApiConfig({ ...SVM_PRICE, ...svm });
  assert.equal(cfg.facilitatorKind, 'svm');
  assert.equal(cfg.price.asset, MINT);
  assert.equal(cfg.price.svm.feePayer, null, 'the config is pure; buildApiServer fills this from the facilitator');

  // An 0x address is not a Solana address, and a base58 mint is not an EVM one. Both directions.
  assert.throws(() => resolveApiConfig({ ...BASE_ENV, ...svm }), /PRICE_ASSET is not a base58 Solana address/);
  assert.throws(() => resolveApiConfig({ ...SVM_PRICE }), /PRICE_ASSET is not an 0x address/);
});

test('facilitatorFromConfig refuses an unreadable SVM keypair, and names the variable not the value', () => {
  const env = { ...SVM_PRICE, FACILITATOR: 'svm', SVM_RPC_URL: 'https://api.devnet.solana.com', SVM_KEYPAIR: '[1,2,3]', SVM_DESTINATION_TOKEN_ACCOUNT: MINT, SVM_DECIMALS: '6' };
  assert.throws(() => facilitatorFromConfig(resolveApiConfig(env)), (err) => {
    assert.match(err.message, /SVM_KEYPAIR could not be read/);
    assert.ok(!err.message.includes('1,2,3'), 'the key material must never reach an error message');
    return true;
  });
});

test('facilitatorFromConfig builds stub vs http', () => {
  assert.equal(typeof facilitatorFromConfig(resolveApiConfig(BASE_ENV)).verifyAndSettle, 'function');
  const http = facilitatorFromConfig(resolveApiConfig({ ...BASE_ENV, FACILITATOR: 'http', FACILITATOR_URL: 'https://f.example' }));
  assert.equal(typeof http.verifyAndSettle, 'function');
});

test('buildApiServer reload picks up a new snapshot IN PLACE, and keeps stale state on a bad one', async () => {
  const path = join(tmpdir(), `serve-${process.pid}-${Date.now()}.json`);
  try {
    const V = '0x' + '1'.repeat(40);
    await saveSnapshot(path, applyAll([{ name: 'VaultCreated', vault: V, blockNumber: 5, logIndex: 0, args: { vault: V, creator: V, usdc: USDC, capacityCapUsdc: 1n } }]));

    const cfg = resolveApiConfig({ ...BASE_ENV, STATE_PATH: path });
    const { state, reload } = await buildApiServer(cfg, { log: () => {} });
    assert.equal(state.lastBlock, 5);
    assert.equal(state.vaults.size, 1);

    // Newer snapshot → reload reflects it on the same state object.
    await saveSnapshot(path, applyAll([
      { name: 'VaultCreated', vault: V, blockNumber: 9, logIndex: 0, args: { vault: V, creator: V, usdc: USDC, capacityCapUsdc: 1n } },
    ]));
    assert.equal(await reload(), true);
    assert.equal(state.lastBlock, 9);

    // Corrupt snapshot → reload returns false and keeps the last good state.
    await writeFile(path, '{ not json', 'utf8');
    assert.equal(await reload(), false);
    assert.equal(state.lastBlock, 9, 'stale-but-valid state kept serving');
  } finally {
    await rm(path, { force: true });
  }
});

test('CORS: preflight OPTIONS is answered and payment headers are exposed', async () => {
  const state = applyAll([]);
  const { server } = createApi({ state, facilitator: createStubFacilitator(), price: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' }, cors: true });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  try {
    // Preflight for the paid retry's custom header.
    const pre = await fetch(`http://127.0.0.1:${port}/vaults`, { method: 'OPTIONS', headers: { 'access-control-request-headers': 'payment-signature' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
    assert.match(pre.headers.get('access-control-allow-headers') ?? '', /payment-signature/i);

    // A real 402 exposes the challenge header cross-origin.
    const res = await fetch(`http://127.0.0.1:${port}/vaults`);
    assert.equal(res.status, 402);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.match(res.headers.get('access-control-expose-headers') ?? '', /payment-required/i);
    assert.ok(res.headers.get('payment-required'), 'challenge header present');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('no CORS headers by default (existing behavior preserved)', async () => {
  const state = applyAll([]);
  const { server } = createApi({ state, facilitator: createStubFacilitator(), price: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' } });
  server.listen(0);
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

// ── hardening config (Sprint 13) ──

test('rate-limit config: defaults, and RATE_LIMIT_PER_SEC=0 turns the limiter off', () => {
  assert.deepEqual(resolveApiConfig(BASE_ENV).rateLimit, { enabled: true, capacity: 60, refillPerSec: 5, maxKeys: 10_000 });
  assert.equal(resolveApiConfig({ ...BASE_ENV, RATE_LIMIT_PER_SEC: '0' }).rateLimit.enabled, false);
  const tuned = resolveApiConfig({ ...BASE_ENV, RATE_LIMIT_PER_SEC: '1', RATE_LIMIT_BURST: '10', RATE_LIMIT_MAX_IPS: '50' }).rateLimit;
  assert.deepEqual(tuned, { enabled: true, capacity: 10, refillPerSec: 1, maxKeys: 50 });
});

test('rate-limit config rejects nonsense instead of silently disabling the limiter', () => {
  assert.throws(() => resolveApiConfig({ ...BASE_ENV, RATE_LIMIT_PER_SEC: '-1' }), /RATE_LIMIT_PER_SEC must be >= 0/);
  assert.throws(() => resolveApiConfig({ ...BASE_ENV, RATE_LIMIT_BURST: '0' }), /RATE_LIMIT_BURST must be > 0/);
  assert.throws(() => resolveApiConfig({ ...BASE_ENV, RATE_LIMIT_BURST: 'lots' }), /RATE_LIMIT_BURST must be > 0/);
});

test('TRUST_PROXY is OFF unless explicitly set — x-forwarded-for is client-spoofable', () => {
  assert.equal(resolveApiConfig(BASE_ENV).trustProxy, false);
  assert.equal(resolveApiConfig({ ...BASE_ENV, TRUST_PROXY: '1' }).trustProxy, true);
  assert.equal(resolveApiConfig({ ...BASE_ENV, TRUST_PROXY: 'true' }).trustProxy, true);
  assert.equal(resolveApiConfig({ ...BASE_ENV, TRUST_PROXY: 'yes-please' }).trustProxy, false);
});

test('request caps default sensibly and are overridable', () => {
  assert.deepEqual(resolveApiConfig(BASE_ENV).limits, { maxUrlLength: 2048, maxBodyBytes: 8192, maxHeaderBytes: 16384 });
  const l = resolveApiConfig({ ...BASE_ENV, MAX_URL_BYTES: '512', MAX_BODY_BYTES: '1024', MAX_HEADER_BYTES: '4096' }).limits;
  assert.deepEqual(l, { maxUrlLength: 512, maxBodyBytes: 1024, maxHeaderBytes: 4096 });
});

test('heartbeatDir defaults alongside the snapshot, and HEARTBEAT_DIR overrides it', () => {
  assert.equal(resolveApiConfig({ ...BASE_ENV, STATE_PATH: '/data/indexer-state.json' }).heartbeatDir, dirname('/data/indexer-state.json'));
  assert.equal(resolveApiConfig({ ...BASE_ENV, HEARTBEAT_DIR: '/hb' }).heartbeatDir, '/hb');
});

test('buildApiServer beats the API heartbeat only on a SUCCESSFUL reload', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'serve-hb-'));
  const path = join(dir, 'indexer-state.json');
  try {
    const V = '0x' + '1'.repeat(40);
    await saveSnapshot(path, applyAll([{ name: 'VaultCreated', vault: V, blockNumber: 5, logIndex: 0, args: { vault: V, creator: V, usdc: USDC, capacityCapUsdc: 1n } }]));
    const cfg = resolveApiConfig({ ...BASE_ENV, STATE_PATH: path, HEARTBEAT_DIR: dir });
    const { reload, heartbeat } = await buildApiServer(cfg, { log: {} });

    assert.equal(await reload(), true);
    const first = await readHeartbeatFile(heartbeat.path);
    assert.equal(first.service, 'api');
    assert.equal(first.detail.lastBlock, 5);

    // A process that is up but has lost its snapshot must NOT keep looking healthy to ops-check.
    await writeFile(path, '{ torn', 'utf8');
    assert.equal(await reload(), false);
    const second = await readHeartbeatFile(heartbeat.path);
    assert.equal(second.ts, first.ts, 'heartbeat not refreshed by a failed reload');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
