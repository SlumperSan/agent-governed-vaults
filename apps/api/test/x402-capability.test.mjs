// @ts-check
/**
 * x402 as a per-chain capability: the config side and the served side.
 *
 * Two things are pinned here, and they are deliberately not the same thing.
 *
 *  1. **The 4663 config disables it.** Read from `contracts/config/robinhood-mainnet.json` through
 *     the resolver, not from a chain id hard-coded in this file — the point of the change is that
 *     there is ONE source of truth and it is the config.
 *  2. **Base Sepolia's BEHAVIOUR is unchanged.** Not "the JSON still says true" — that would be a
 *     test of the fixture, not of the server. The assertion is that the API resolved for 84532
 *     still answers an unpaid metered read with 402 and a PAYMENT-REQUIRED challenge, still
 *     settles the paid retry, and still leaves the metered routes out of the rate limiter, exactly
 *     as `api.test.mjs` and `ratelimit.test.mjs` describe today.
 *
 * The default matters as much as either: `createApi` with no `x402` at all must meter. Every
 * existing caller passes nothing, and a capability lookup that cannot answer must never be the
 * reason a payment gate comes off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, FREE_ROUTES, METERED_ROUTES } from '../src/server.mjs';
import { resolveApiConfig } from '../src/serve.mjs';
import { HEADERS } from '../src/x402.mjs';
import { createStubFacilitator } from '../src/facilitator.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { x402Capability, DEFAULT_CONFIG_DIR } from '../../../packages/chain-config/src/x402.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const VAULT = '0x' + '1'.repeat(40);
const PRICE = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' };

const ROBINHOOD = 4663;
const BASE_SEPOLIA = 84532;

const envelope = (nonce) =>
  Buffer.from(JSON.stringify({
    x402Version: 2,
    network: 'base',
    signature: '0xsig',
    authorization: { asset: USDC, to: PAYTO, value: '10000', nonce, validBefore: 0 },
  })).toString('base64');

function seededApi(overrides = {}) {
  const state = applyAll([
    { name: 'VaultCreated', vault: VAULT, blockNumber: 1, logIndex: 0, args: { vault: VAULT, creator: '0x' + 'a'.repeat(40), usdc: USDC, capacityCapUsdc: 1000n } },
    { name: 'OperatorRegistered', vault: VAULT, blockNumber: 1, logIndex: 1, args: { opId: 1, operator: '0x' + 'a'.repeat(40) } },
    { name: 'VaultAttested', vault: VAULT, blockNumber: 1, logIndex: 2, args: { vault: VAULT, opId: 1 } },
  ]);
  return createApi({ state, facilitator: createStubFacilitator(), price: PRICE, now: () => 1000, ...overrides });
}

// ── the capability, resolved from contracts/config ───────────────────────────

test('chain 4663 disables x402, and the answer comes from its own config file', () => {
  const cap = x402Capability(ROBINHOOD);
  assert.equal(cap.enabled, false, 'Robinhood Chain does not meter reads over x402');
  assert.equal(cap.chainId, ROBINHOOD);
  assert.equal(cap.chainName, 'robinhood-mainnet');
  assert.match(cap.source, /robinhood-mainnet\.json/, 'resolved from the config, not from a literal in code');

  // And the file itself, read directly: the capability is declared, not inferred.
  const raw = JSON.parse(readFileSync(path.join(DEFAULT_CONFIG_DIR, 'robinhood-mainnet.json'), 'utf8'));
  assert.equal(raw.chainId, ROBINHOOD);
  assert.equal(raw.x402.enabled, false);
  assert.equal(typeof raw.x402.note, 'string');
  assert.ok(raw.x402.note.length > 0, 'a switched-off capability has to say why');
});

test('Base Sepolia keeps the capability, and base-mainnet is untouched by declaring nothing', () => {
  const sepolia = x402Capability(BASE_SEPOLIA);
  assert.equal(sepolia.enabled, true);
  assert.equal(sepolia.chainName, 'base-sepolia');

  const mainnet = x402Capability(8453);
  assert.equal(mainnet.enabled, true, 'a config with no x402 block means enabled');
  assert.match(mainnet.source, /declares no x402 block/);
});

test('an unknown chain, no chain id, or an unreadable config dir all resolve to ENABLED', () => {
  assert.equal(x402Capability(1).enabled, true, 'unknown chain id');
  assert.equal(x402Capability(null).enabled, true, 'no chain id configured');
  assert.equal(x402Capability(undefined).enabled, true);
  assert.equal(x402Capability(ROBINHOOD, { dir: path.join(REPO, 'no-such-config-dir') }).enabled, true,
    'a lookup that cannot read its source must not be the reason a payment gate comes off');
});

test('CHAIN_ID is carried by the API config, and a non-integer is refused at startup', () => {
  const base = { PRICE_ASSET: USDC, PRICE_PAYTO: PAYTO };
  assert.equal(resolveApiConfig(base).chainId, null, 'unset CHAIN_ID means no chain — metering stays on');
  assert.equal(resolveApiConfig({ ...base, CHAIN_ID: '4663' }).chainId, ROBINHOOD);
  assert.throws(() => resolveApiConfig({ ...base, CHAIN_ID: 'robinhood' }), /CHAIN_ID must be an integer/);
});

// ── Base Sepolia behaviour: unchanged ────────────────────────────────────────

test('with the Base Sepolia capability the metered routes still gate on payment', async () => {
  const api = seededApi({ x402: x402Capability(BASE_SEPOLIA) });

  const unpaid = await api.handle('GET', '/vaults', {});
  assert.equal(unpaid.status, 402);
  const challenge = JSON.parse(unpaid.headers[HEADERS.REQUIRED]);
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.asset, USDC);
  assert.equal(challenge.amount, '10000');

  const paid = await api.handle('GET', '/vaults', { [HEADERS.SIGNATURE]: envelope('0xsep1') });
  assert.equal(paid.status, 200);
  assert.equal(JSON.parse(paid.body).vaults.length, 1);
  assert.ok(paid.headers[HEADERS.RESPONSE], 'a paid read still echoes PAYMENT-RESPONSE');
});

test('with no capability supplied at all the API meters, exactly as every existing caller expects', async () => {
  const unpaid = await seededApi().handle('GET', '/operators/leaderboard', {});
  assert.equal(unpaid.status, 402);
});

test('Base Sepolia discovery still advertises the price and the metered route list', async () => {
  const doc = JSON.parse((await seededApi({ x402: x402Capability(BASE_SEPOLIA) }).handle('GET', '/.well-known/x402', {})).body);
  assert.equal(doc.x402Version, 2);
  assert.equal(doc.enabled, true);
  assert.equal(doc.price.asset, USDC);
  assert.equal(doc.price.amount, '10000');
  assert.deepEqual(doc.routes.metered, METERED_ROUTES);
  assert.deepEqual(doc.routes.free, FREE_ROUTES);
});

test('Base Sepolia still leaves the metered routes out of the rate limiter', async () => {
  const api = seededApi({
    x402: x402Capability(BASE_SEPOLIA),
    rateLimit: createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 }),
  });
  for (let i = 0; i < 5; i += 1)
    assert.equal((await api.handle('GET', '/vaults', {}, { ip: 'x' })).status, 402, 'x402 is their limiter');
});

// ── chain 4663: the same reads, no payment gate ──────────────────────────────

test('on 4663 the formerly-metered routes serve 200 with no payment headers and no wallet', async () => {
  const api = seededApi({ x402: x402Capability(ROBINHOOD) });

  for (const route of ['/vaults', `/vaults/${VAULT}`, '/operators/leaderboard']) {
    const res = await api.handle('GET', route, {});
    assert.equal(res.status, 200, `${route} is served without payment`);
    assert.equal(res.headers[HEADERS.REQUIRED], undefined, `${route} issues no challenge`);
    assert.equal(res.headers[HEADERS.RESPONSE], undefined, `${route} echoes no receipt`);
  }

  // Same bodies as the paid path serves on a metering chain — this is a gate change, not a data one.
  const gated = seededApi({ x402: x402Capability(BASE_SEPOLIA) });
  const free = await api.handle('GET', '/vaults', {});
  const paid = await gated.handle('GET', '/vaults', { [HEADERS.SIGNATURE]: envelope('0xsame1') });
  assert.equal(free.body, paid.body, 'the reads are the same reads');
});

test('on 4663 a payment-signature header is simply irrelevant — never settled, never counted', async () => {
  let settled = 0;
  const api = seededApi({
    x402: x402Capability(ROBINHOOD),
    facilitator: { async verifyAndSettle() { settled += 1; return { ok: true, receiptId: 'rcpt' }; } },
  });
  const res = await api.handle('GET', '/vaults', { [HEADERS.SIGNATURE]: envelope('0xrh1') });
  assert.equal(res.status, 200);
  assert.equal(settled, 0, 'no facilitator call, so nothing can move funds');
  const metrics = (await api.handle('GET', '/metrics', {})).body;
  assert.match(metrics, /^vault_api_settlements_total 0$/m);
  assert.match(metrics, /^vault_api_payment_required_total 0$/m);
});

test('on 4663 discovery reports the capability off, prices nothing, and calls every route free', async () => {
  const doc = JSON.parse((await seededApi({ x402: x402Capability(ROBINHOOD) }).handle('GET', '/.well-known/x402', {})).body);
  assert.equal(doc.enabled, false);
  assert.equal(doc.price, null, 'no price an agent could try to pay');
  assert.deepEqual(doc.routes.metered, []);
  for (const route of [...FREE_ROUTES, ...METERED_ROUTES])
    assert.ok(doc.routes.free.includes(route), `${route} is advertised as free`);
});

test('on 4663 the rate limiter covers the formerly-metered routes, because payment no longer does', async () => {
  const api = seededApi({
    x402: x402Capability(ROBINHOOD),
    rateLimit: createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 }),
  });
  assert.equal((await api.handle('GET', '/vaults', {}, { ip: 'scraper' })).status, 200);
  const limited = await api.handle('GET', '/vaults', {}, { ip: 'scraper' });
  assert.equal(limited.status, 429, 'an ungated read route must not also be an unbounded one');
  assert.ok(Number(limited.headers['retry-after']) >= 1);
});

test('on 4663 an unknown route still 404s, and a non-GET is still refused', async () => {
  const api = seededApi({ x402: x402Capability(ROBINHOOD) });
  assert.equal((await api.handle('GET', '/nope', {})).status, 404);
  assert.equal((await api.handle('POST', '/vaults', {})).status, 405);
});
