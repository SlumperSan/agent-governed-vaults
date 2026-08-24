// @ts-check
/**
 * `/metrics` and the request caps. The counters exist to answer "is it up, is it being paid, and
 * how far behind is the indexer" from a terminal during an incident, so the tests check the wire
 * format an operator actually reads, not just the internal numbers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';
import { createMetrics } from '../src/metrics.mjs';
import { createApi, DEFAULT_LIMITS } from '../src/server.mjs';
import { createStubFacilitator } from '../src/facilitator.mjs';
import { resolveApiConfig, buildApiServer } from '../src/serve.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';
import { saveSnapshot } from '../../../packages/indexer/src/store.mjs';
import { buildChallenge } from '../src/x402.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + '9'.repeat(40);
const V = '0x' + '1'.repeat(40);
const PRICE = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' };
const BASE_ENV = { PRICE_ASSET: USDC, PRICE_PAYTO: PAYTO };

const api = (extra = {}) => createApi({ state: applyAll([]), facilitator: createStubFacilitator(), price: PRICE, ...extra });

/** Speak HTTP down a bare socket — `fetch` will not send the malformed shapes we need to refuse. */
function rawRequest(port, text) {
  return new Promise((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write(text));
    let buf = '';
    sock.setTimeout(3000, () => { sock.destroy(); resolve(buf); });
    sock.on('data', (d) => { buf += d.toString('utf8'); });
    sock.on('close', () => resolve(buf));
    sock.on('error', () => resolve(buf));
    sock.on('timeout', () => reject(new Error('timeout')));
  });
}

/** A signature header the stub facilitator accepts. */
function paidHeader(nonce = '0x' + '7'.repeat(64)) {
  const c = buildChallenge(PRICE, { nowMs: Date.now() });
  const env = {
    x402Version: 2, network: PRICE.network, signature: '0xdead',
    authorization: { asset: c.asset, to: c.payTo, value: c.amount, nonce, validBefore: Math.floor(Date.now() / 1000) + 600 },
  };
  return { 'payment-signature': Buffer.from(JSON.stringify(env), 'utf8').toString('base64') };
}

// ── the counter store ──

test('counters start at zero rather than absent — a missing series and a zero series look alike', () => {
  const text = createMetrics().render();
  assert.match(text, /^vault_api_requests_total 0$/m);
  assert.match(text, /^vault_api_settlements_total 0$/m);
});

test('render emits HELP and TYPE for known metrics, in the prometheus text format', () => {
  const m = createMetrics();
  m.inc('vault_api_requests_total', 3);
  const text = m.render();
  assert.match(text, /# HELP vault_api_requests_total HTTP requests received/);
  assert.match(text, /# TYPE vault_api_requests_total counter/);
  assert.match(text, /^vault_api_requests_total 3$/m);
  assert.ok(text.endsWith('\n'), 'the exposition format requires a trailing newline');
});

test('gauges are pulled at scrape time, not pushed by a timer that could itself have died', () => {
  const m = createMetrics();
  let v = 1;
  m.gauge('vault_indexer_last_block', () => v);
  assert.equal(m.get('vault_indexer_last_block'), 1);
  v = 99;
  assert.match(m.render(), /^vault_indexer_last_block 99$/m);
});

test('a gauge that throws degrades to 0 instead of taking the whole scrape down', () => {
  const m = createMetrics();
  m.gauge('vault_indexer_last_block', () => { throw new Error('state gone'); });
  m.gauge('weird_nan', () => NaN);
  assert.match(m.render(), /^vault_indexer_last_block 0$/m);
  assert.match(m.render(), /^weird_nan 0$/m);
});

// ── the route ──

test('/metrics is free, plain text, and reflects the requests it has served', async () => {
  const a = api();
  await a.handle('GET', '/health', {});
  await a.handle('GET', '/vaults', {});            // unpaid → 402
  const res = await a.handle('GET', '/metrics', {});
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /^text\/plain/);
  assert.match(res.body, /^vault_api_requests_total 3$/m);
  assert.match(res.body, /^vault_api_payment_required_total 1$/m);
  assert.match(res.body, /^vault_api_settlements_total 0$/m);
});

test('a settled payment increments settlements, not payment-required', async () => {
  const a = api();
  const res = await a.handle('GET', '/vaults', paidHeader());
  assert.equal(res.status, 200);
  assert.match((await a.handle('GET', '/metrics', {})).body, /^vault_api_settlements_total 1$/m);
  assert.match((await a.handle('GET', '/metrics', {})).body, /^vault_api_payment_required_total 0$/m);
});

test('/metrics is advertised as free in the discovery document', async () => {
  const doc = JSON.parse((await api().handle('GET', '/.well-known/x402', {})).body);
  assert.ok(doc.routes.free.includes('/metrics'), 'the discovery doc must not lie to agents');
  assert.ok(doc.routes.free.includes('/health'));
});

test('the snapshot block being served is exposed as a gauge', async () => {
  const state = applyAll([{ name: 'VaultCreated', vault: V, blockNumber: 77, logIndex: 0, args: { vault: V, creator: V, usdc: USDC, capacityCapUsdc: 1n } }]);
  const a = createApi({ state, facilitator: createStubFacilitator(), price: PRICE });
  assert.match((await a.handle('GET', '/metrics', {})).body, /^vault_indexer_last_block 77$/m);
});

// ── request caps ──

test('an over-long URL is refused before any handler work', async () => {
  const a = api();
  const long = `/vaults/${'a'.repeat(DEFAULT_LIMITS.maxUrlLength)}`;
  const res = await a.handle('GET', long, {});
  assert.equal(res.status, 414);
  assert.equal(JSON.parse(res.body).limit, DEFAULT_LIMITS.maxUrlLength);
  assert.match((await a.handle('GET', '/metrics', {})).body, /^vault_api_rejected_total 1$/m);
});

test('the URL cap is configurable and a normal URL is unaffected', async () => {
  const a = api({ limits: { maxUrlLength: 20 } });
  assert.equal((await a.handle('GET', '/health', {})).status, 200);
  assert.equal((await a.handle('GET', `/vaults/${'b'.repeat(40)}`, {})).status, 414);
});

test('a non-GET request is refused and counted as a rejection', async () => {
  const a = api();
  assert.equal((await a.handle('POST', '/health', {})).status, 405);
  assert.match((await a.handle('GET', '/metrics', {})).body, /^vault_api_rejected_total 1$/m);
});

test('a declared over-size body is refused with 413 before the method is even considered', async () => {
  const a = api({ limits: { maxBodyBytes: 64 } });
  a.server.listen(0);
  await once(a.server, 'listening');
  const port = a.server.address().port;
  try {
    // POST, so `fetch` will actually carry a body. The cap fires in the connection handler, ahead
    // of the 405 the method check would otherwise produce — the payload never reaches the handler.
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST', body: 'x'.repeat(500) });
    assert.equal(res.status, 413);
    assert.equal((await res.json()).limit, 64);

    // And on a GET, which fetch refuses to give a body — raw socket, declared content-length.
    const raw = await rawRequest(port, `GET /health HTTP/1.1\r\nHost: t\r\nContent-Length: 5000\r\nConnection: close\r\n\r\n${'y'.repeat(5000)}`);
    assert.match(raw, /^HTTP\/1\.1 413/);
  } finally {
    a.server.close();
    await once(a.server, 'close');
  }
});

test('an UNDECLARED (chunked) over-size body is cut off at the same ceiling', async () => {
  const a = api({ limits: { maxBodyBytes: 64 } });
  a.server.listen(0);
  await once(a.server, 'listening');
  const port = a.server.address().port;
  try {
    const chunk = 'z'.repeat(1000);
    const raw = await rawRequest(port, `POST /health HTTP/1.1\r\nHost: t\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${(3e8).toString(16)}\r\n${chunk}`);
    // Either a refusal or a dropped connection is acceptable; silently buffering 300MB is not.
    assert.ok(raw === '' || /^HTTP\/1\.1 4\d\d/.test(raw), `unexpected response: ${raw.slice(0, 40)}`);
    assert.ok(a.metrics.get('vault_api_rejected_total') >= 1, 'the refusal is counted');
  } finally {
    a.server.close();
    await once(a.server, 'close');
  }
});

test('the server still answers normal traffic with the caps in place', async () => {
  const a = api({ limits: { maxBodyBytes: 64, maxUrlLength: 100 } });
  a.server.listen(0);
  await once(a.server, 'listening');
  const port = a.server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    const met = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.match(met.headers.get('content-type') ?? '', /text\/plain/);
    assert.match(await met.text(), /vault_api_requests_total/);
  } finally {
    a.server.close();
    await once(a.server, 'close');
  }
});

// ── indexer lag, end to end ──

test('snapshot age is the lag signal, and it is named for what it measures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
  const path = join(dir, 'indexer-state.json');
  try {
    await saveSnapshot(path, applyAll([{ name: 'VaultCreated', vault: V, blockNumber: 5, logIndex: 0, args: { vault: V, creator: V, usdc: USDC, capacityCapUsdc: 1n } }]));
    let clock = Date.now();
    const cfg = resolveApiConfig({ ...BASE_ENV, STATE_PATH: path, HEARTBEAT_DIR: dir });
    const { api: built, metrics } = await buildApiServer(cfg, { log: {}, now: () => clock });

    assert.ok(metrics.get('vault_indexer_snapshot_age_seconds') < 5, 'a just-written snapshot is fresh');
    clock += 600_000;                       // ten minutes later, with no new snapshot
    assert.ok(metrics.get('vault_indexer_snapshot_age_seconds') >= 600, 'age grows when the indexer stops');
    assert.equal(metrics.get('vault_api_uptime_seconds'), 600);

    const text = (await built.handle('GET', '/metrics', {})).body;
    assert.match(text, /^vault_indexer_snapshot_age_seconds 60\d$/m);
    assert.match(text, /^vault_indexer_last_block 5$/m);
    // The API has no RPC client by design, so it must never claim a blocks-behind figure.
    assert.doesNotMatch(text, /lag_blocks|blocks_behind/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed snapshot reload is counted, and the stale block keeps being reported honestly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'metrics-'));
  const path = join(dir, 'indexer-state.json');
  try {
    await saveSnapshot(path, applyAll([{ name: 'VaultCreated', vault: V, blockNumber: 5, logIndex: 0, args: { vault: V, creator: V, usdc: USDC, capacityCapUsdc: 1n } }]));
    const cfg = resolveApiConfig({ ...BASE_ENV, STATE_PATH: path, HEARTBEAT_DIR: dir });
    const { reload, metrics } = await buildApiServer(cfg, { log: {} });
    assert.equal(await reload(), true);
    assert.equal(metrics.get('vault_api_snapshot_reload_failures_total'), 0);

    await rm(path, { force: true });
    await saveSnapshot(path, applyAll([]));
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '{ torn', 'utf8');
    assert.equal(await reload(), false);
    assert.equal(metrics.get('vault_api_snapshot_reload_failures_total'), 1);
    assert.equal(metrics.get('vault_indexer_last_block'), 5, 'still serving the last good block');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
