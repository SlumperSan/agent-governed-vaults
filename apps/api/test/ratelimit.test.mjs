// @ts-check
/**
 * The free-route token bucket. The paid routes are deliberately NOT limited — x402 is their rate
 * limiter — and one of the tests below pins that so nobody "fixes" it later.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRateLimiter, clientIp } from '../src/ratelimit.mjs';
import { createApi, FREE_ROUTES } from '../src/server.mjs';
import { createStubFacilitator } from '../src/facilitator.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + '9'.repeat(40);
const PRICE = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' };

test('a burst up to capacity is allowed, and the next request is not', () => {
  const rl = createRateLimiter({ capacity: 3, refillPerSec: 1, now: () => 0 });
  assert.deepEqual([1, 2, 3].map(() => rl.take('a').allowed), [true, true, true]);
  const over = rl.take('a');
  assert.equal(over.allowed, false);
  assert.equal(over.remaining, 0);
  assert.equal(over.limit, 3);
  assert.ok(over.retryAfterSec >= 1, 'a 429 always tells the caller a usable wait');
});

test('tokens refill at the configured rate, capped at capacity', () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 5, refillPerSec: 2, now: () => t });
  for (let i = 0; i < 5; i += 1) rl.take('a');
  assert.equal(rl.take('a').allowed, false);
  t = 1000;                                   // +1s at 2/s = 2 tokens
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, true);
  assert.equal(rl.take('a').allowed, false);
  t = 60_000;                                 // a long idle must not bank 120 tokens
  for (let i = 0; i < 5; i += 1) assert.equal(rl.take('a').allowed, true, `refill ${i}`);
  assert.equal(rl.take('a').allowed, false, 'capped at capacity');
});

test('buckets are per key: one noisy IP cannot throttle another', () => {
  const rl = createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 });
  assert.equal(rl.take('1.1.1.1').allowed, true);
  assert.equal(rl.take('1.1.1.1').allowed, false);
  assert.equal(rl.take('2.2.2.2').allowed, true);
});

test('memory is bounded: an unbounded per-IP map would itself be the denial-of-service', () => {
  let t = 0;
  const rl = createRateLimiter({ capacity: 2, refillPerSec: 1, maxKeys: 10, now: () => t });
  for (let i = 0; i < 5000; i += 1) rl.take(`ip-${i}`);
  assert.ok(rl.size <= 11, `bounded, got ${rl.size}`);
  t = 60_000;
  rl.take('fresh');
  assert.ok(rl.size <= 11);
});

test('eviction drops fully-refilled buckets first: a throttled key survives the churn', () => {
  // A refilled bucket is indistinguishable from an IP never seen, so dropping it changes no
  // decision. A depleted one still carries a verdict, and must outlive the harmless entries.
  let t = 0;
  const rl = createRateLimiter({ capacity: 10, refillPerSec: 1, maxKeys: 6, now: () => t });
  for (let i = 0; i < 10; i += 1) rl.take('victim');        // fully depleted
  for (const k of ['a', 'b', 'c', 'd', 'e']) rl.take(k);    // one token each

  t = 2000;                                                 // a–e are full again; victim has 2
  for (let i = 0; i < 3; i += 1) rl.take(`flood-${i}`);     // push over maxKeys → prune
  assert.ok(rl.size <= 6, `bounded, got ${rl.size}`);

  // victim kept its deficit: 2 tokens at t=2000, +1 by t=3000 → 3 allowed, then throttled.
  t = 3000;
  assert.deepEqual([1, 2, 3].map(() => rl.take('victim').allowed), [true, true, true]);
  assert.equal(rl.take('victim').allowed, false, 'not silently reset to a full burst');
});

test('under sustained table pressure eviction falls back to LRU — a known, bounded trade', () => {
  // When EVERY tracked IP is actively throttled there is no harmless entry to drop, so the
  // least-recently-used goes and that IP gets a fresh burst. Remembering an attacker perfectly is
  // not worth letting them choose our heap size. Pinned here so the trade stays deliberate.
  const rl = createRateLimiter({ capacity: 1, refillPerSec: 0.001, maxKeys: 5, now: () => 0 });
  rl.take('attacker');
  assert.equal(rl.take('attacker').allowed, false);
  for (let i = 0; i < 100; i += 1) rl.take(`noise-${i}`);
  assert.equal(rl.take('attacker').allowed, true, 'evicted and reset — the documented trade-off');
  assert.ok(rl.evictions > 0, 'and it is counted, not silent');
});

test('a bad configuration is refused loudly rather than silently allowing everything', () => {
  assert.throws(() => createRateLimiter({ capacity: 0 }), /capacity must be/);
  assert.throws(() => createRateLimiter({ refillPerSec: 0 }), /refillPerSec must be/);
});

test('clientIp ignores x-forwarded-for unless TRUST_PROXY says a proxy sets it', () => {
  const req = { socket: { remoteAddress: '10.0.0.1' }, headers: { 'x-forwarded-for': '9.9.9.9, 10.0.0.2' } };
  assert.equal(clientIp(req), '10.0.0.1', 'spoofable header ignored by default');
  assert.equal(clientIp(req, { trustProxy: true }), '9.9.9.9', 'left-most entry is the client');
  assert.equal(clientIp({ socket: {}, headers: {} }), 'unknown');
  assert.equal(clientIp({ socket: { remoteAddress: '10.0.0.1' }, headers: {} }, { trustProxy: true }), '10.0.0.1', 'trusted but absent → socket');
});

// ── wiring: which routes the limiter actually guards ──

function api({ rateLimit }) {
  return createApi({ state: applyAll([]), facilitator: createStubFacilitator(), price: PRICE, rateLimit });
}

test('free routes are limited, and the 429 carries retry-after', async () => {
  const a = api({ rateLimit: createRateLimiter({ capacity: 2, refillPerSec: 1, now: () => 0 }) });
  assert.equal((await a.handle('GET', '/health', {}, { ip: 'x' })).status, 200);
  assert.equal((await a.handle('GET', '/health', {}, { ip: 'x' })).status, 200);
  const res = await a.handle('GET', '/health', {}, { ip: 'x' });
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers['retry-after']) >= 1);
  assert.equal(res.headers['x-ratelimit-remaining'], '0');
  assert.equal(JSON.parse(res.body).error, 'rate limit exceeded');
});

test('every advertised free route is covered by the limiter', async () => {
  for (const route of FREE_ROUTES) {
    const a = api({ rateLimit: createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 }) });
    assert.notEqual((await a.handle('GET', route, {}, { ip: 'x' })).status, 429);
    assert.equal((await a.handle('GET', route, {}, { ip: 'x' })).status, 429, `${route} is limited`);
  }
});

test('PAID routes are NOT rate limited — x402 is their limiter, and that is deliberate', async () => {
  const a = api({ rateLimit: createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 }) });
  for (let i = 0; i < 25; i += 1) {
    const res = await a.handle('GET', '/vaults', {}, { ip: 'x' });
    assert.equal(res.status, 402, 'unpaid metered reads keep answering 402, never 429');
  }
});

test('the limiter is off by default, so existing in-process callers are unchanged', async () => {
  const a = api({ rateLimit: null });
  for (let i = 0; i < 50; i += 1) assert.equal((await a.handle('GET', '/health', {})).status, 200);
});

test('limiting keys on the real socket address end to end', async () => {
  const a = api({ rateLimit: createRateLimiter({ capacity: 2, refillPerSec: 1, now: () => 0 }) });
  a.server.listen(0);
  await once(a.server, 'listening');
  const port = a.server.address().port;
  try {
    const codes = [];
    for (let i = 0; i < 4; i += 1) codes.push((await fetch(`http://127.0.0.1:${port}/health`)).status);
    assert.deepEqual(codes, [200, 200, 429, 429]);
  } finally {
    a.server.close();
    await once(a.server, 'close');
  }
});
