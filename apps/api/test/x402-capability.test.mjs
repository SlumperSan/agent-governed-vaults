// @ts-check
/**
 * x402 as a per-chain capability: the config side and the served side.
 *
 * Three things are pinned here, and they are deliberately not the same thing.
 *
 *  1. **The 4663 config disables it.** Read from `contracts/config/robinhood-mainnet.json` through
 *     the resolver, not from a chain id hard-coded in this file — the point of the change is that
 *     there is ONE source of truth and it is the config.
 *  2. **Base's BEHAVIOUR is unchanged, on both Base configs.** Not "the JSON still says true" —
 *     that would be a test of the fixture, not of the server. The assertion is that the API
 *     resolved for 84532 (Base Sepolia) and for 8453 (Base mainnet, re-enabled explicitly per the
 *     owner's 2026-09-09 decision) still answers an unpaid metered read with 402 and a
 *     PAYMENT-REQUIRED challenge, still settles the paid retry through the facilitator, and still
 *     leaves the metered routes out of the rate limiter, exactly as `api.test.mjs` and
 *     `ratelimit.test.mjs` describe today.
 *  3. **Base declaring itself explicitly changes nothing about the default.** `base-mainnet.json`
 *     used to declare no `x402` block at all and rely on absent-means-enabled; it now says
 *     `enabled: true` out loud, matching `base-sepolia.json` and `robinhood-mainnet.json` field for
 *     field. The resolver's default for a chain with no block, or no config, or an unreadable
 *     config directory, is untouched — still enabled.
 *
 * The default matters as much as any of the above: `createApi` with no `x402` at all must meter.
 * Every existing caller passes nothing, and a capability lookup that cannot answer must never be
 * the reason a payment gate comes off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, FREE_ROUTES, METERED_ROUTES } from '../src/server.mjs';
import { resolveApiConfig } from '../src/serve.mjs';
import { HEADERS } from '../src/x402.mjs';
import { createStubFacilitator } from '../src/facilitator.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { x402Capability, DEFAULT_CONFIG_DIR, DEFAULT_NETWORK_DIR, loadNetworkCapabilities, loadChainCapabilities } from '../../../packages/chain-config/src/x402.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const VAULT = '0x' + '1'.repeat(40);
const PRICE = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' };

const ROBINHOOD = 4663;
const BASE_SEPOLIA = 84532;
const BASE_MAINNET = 8453;

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

test('Base Sepolia and Base mainnet both declare the capability explicitly, per the 2026-09-09 re-enable', () => {
  const sepolia = x402Capability(BASE_SEPOLIA);
  assert.equal(sepolia.enabled, true);
  assert.equal(sepolia.chainName, 'base-sepolia');
  assert.match(sepolia.source, /base-sepolia\.json sets x402\.enabled = true/);

  const mainnet = x402Capability(BASE_MAINNET);
  assert.equal(mainnet.enabled, true);
  assert.equal(mainnet.chainName, 'base-mainnet');
  assert.match(mainnet.source, /base-mainnet\.json sets x402\.enabled = true/, 'explicit now, not the absent-block default');

  // Both files, read directly: the capability is declared, not inferred, and each says why.
  for (const [file, chainId] of [['base-sepolia.json', BASE_SEPOLIA], ['base-mainnet.json', BASE_MAINNET]]) {
    const raw = JSON.parse(readFileSync(path.join(DEFAULT_CONFIG_DIR, file), 'utf8'));
    assert.equal(raw.chainId, chainId);
    assert.equal(raw.x402.enabled, true);
    assert.equal(typeof raw.x402.note, 'string');
    assert.ok(raw.x402.note.length > 0, 'an enabled capability on Base still says why, matching Robinhood field for field');
  }
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

test('with the Base mainnet capability the metered routes gate on payment and settle through the facilitator', async () => {
  let settled = 0;
  const api = seededApi({
    x402: x402Capability(BASE_MAINNET),
    facilitator: { async verifyAndSettle() { settled += 1; return { ok: true, receiptId: 'rcpt-mainnet' }; } },
  });

  const unpaid = await api.handle('GET', '/vaults', {});
  assert.equal(unpaid.status, 402);
  const challenge = JSON.parse(unpaid.headers[HEADERS.REQUIRED]);
  assert.equal(challenge.x402Version, 2);
  assert.equal(challenge.asset, USDC);
  assert.equal(challenge.amount, '10000');

  const paid = await api.handle('GET', '/vaults', { [HEADERS.SIGNATURE]: envelope('0xmain1') });
  assert.equal(paid.status, 200);
  assert.equal(JSON.parse(paid.body).vaults.length, 1);
  assert.ok(paid.headers[HEADERS.RESPONSE], 'a paid read still echoes PAYMENT-RESPONSE');
  assert.equal(settled, 1, 'the paid retry actually exercised the facilitator, not just a 200');
});

test('a config that declares no x402 block still resolves to enabled, read from a real directory', () => {
  // Every shipped config now declares a block, so this branch of the resolver
  // (x402.mjs, the `!entry.x402` case) is reachable by no fixture in the repository.
  // It is the branch the fail-closed argument rests on, so it gets a config directory
  // of its own rather than an assertion about what would happen.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-absent-'));
  try {
    writeFileSync(
      path.join(dir, 'no-block.json'),
      JSON.stringify({ chainId: 999001, chainName: 'chain that declares no x402 block' }),
    );
    const cap = x402Capability(999001, { dir });
    assert.equal(cap.enabled, true, 'an absent block must mean enabled, or a payment gate comes off by omission');
    assert.match(cap.source, /declares no x402 block/);
    assert.equal(cap.chainName, 'chain that declares no x402 block', 'the entry was read, not defaulted past');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a config that declares the block false is the only way metering comes off', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-false-'));
  try {
    writeFileSync(
      path.join(dir, 'off.json'),
      JSON.stringify({ chainId: 999002, chainName: 'off', x402: { enabled: false } }),
    );
    assert.equal(x402Capability(999002, { dir }).enabled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Base mainnet also leaves the metered routes out of the rate limiter, same as Base Sepolia', async () => {
  const api = seededApi({
    x402: x402Capability(BASE_MAINNET),
    rateLimit: createRateLimiter({ capacity: 1, refillPerSec: 1, now: () => 0 }),
  });
  for (let i = 0; i < 5; i += 1)
    assert.equal((await api.handle('GET', '/vaults', {}, { ip: 'x' })).status, 402, 'x402 is their limiter');
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

/*
 * ── NETWORKS WITH NO EVM CHAIN ID ───────────────────────────────────────────────────────────────
 *
 * ADDED 2026-09-09, when the owner asked for x402 on Solana. The resolver took a chain id and did
 * `Number(key)`, rejecting anything non-finite, which was right while every target was EVM.
 *
 * THE BUG THAT PRODUCED IS THE FIRST THING PINNED BELOW, because it is the kind that reads as
 * working: `x402Capability('solana-mainnet')` gave `NaN`, fell into the "no chain id configured"
 * branch, and returned `enabled: true` having consulted no config at all. Fail-CLOSED, so no
 * payment gate came off by accident — but Solana metering was UNCONFIGURABLE, and no file anywhere
 * could have turned it off. That is not a capability, it is a constant wearing one's clothes.
 */

test('a Solana network resolves by NAME, out of its own directory', () => {
  const cap = x402Capability('solana-mainnet');
  assert.equal(cap.enabled, true);
  assert.equal(cap.network, 'solana-mainnet', 'the network name is echoed, so a boot log says which network answered');
  assert.equal(cap.chainId, null, 'Solana has no EVM chain id and must not be given a fake one');
  assert.equal(cap.scheme, 'exact-svm', 'the scheme is carried so a caller picks a facilitator without a second lookup');
  assert.match(cap.source, /solana-mainnet\.json sets x402\.enabled = true/);
});

test('the network name is matched case-insensitively', () => {
  // `NETWORK=Solana-Mainnet` in a .env is the same network. A lookup that disagreed would take a
  // payment gate off by capitalisation, which is the least debuggable way to lose one.
  for (const spelling of ['solana-mainnet', 'Solana-Mainnet', 'SOLANA-MAINNET', '  solana-mainnet  ']) {
    const cap = x402Capability(spelling);
    assert.equal(cap.network, 'solana-mainnet', `${JSON.stringify(spelling)} must resolve to the same network`);
    assert.equal(cap.enabled, true);
  }
});

test('a network name that no file declares still means ENABLED, and says so', () => {
  const cap = x402Capability('a-network-nobody-configured');
  assert.equal(cap.enabled, true, 'an unknown network must not switch a payment gate off');
  assert.equal(cap.network, 'a-network-nobody-configured');
  assert.match(cap.source, /no network config for a-network-nobody-configured/);
});

test('a network config CAN turn metering off — which is the whole point of the change', () => {
  // Before this existed there was no file that could produce this result for a non-EVM network.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-net-off-'));
  try {
    writeFileSync(path.join(dir, 'off.json'), JSON.stringify({
      network: 'somewhere-metering-is-off', chainName: 'test', scheme: 'exact-svm', x402: { enabled: false, note: 'because a test says so' },
    }));
    const cap = x402Capability('somewhere-metering-is-off', { networkDir: dir });
    assert.equal(cap.enabled, false);
    assert.equal(cap.note, 'because a test says so');
    assert.match(cap.source, /off\.json sets x402\.enabled = false/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a network file with no x402 block resolves to enabled, read from a real directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-net-absent-'));
  try {
    writeFileSync(path.join(dir, 'bare.json'), JSON.stringify({ network: 'bare-network', chainName: 'bare' }));
    const cap = x402Capability('bare-network', { networkDir: dir });
    assert.equal(cap.enabled, true, 'an absent block must mean enabled here for the same reason it does on the chain-id path');
    assert.equal(cap.chainName, 'bare', 'the entry was read, not defaulted past');
    assert.match(cap.source, /declares no x402 block/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a missing network directory degrades to enabled rather than throwing on a boot path', () => {
  const cap = x402Capability('solana-mainnet', { networkDir: path.join(tmpdir(), 'no-such-dir-' + process.pid) });
  assert.equal(cap.enabled, true);
  assert.match(cap.source, /no network config for solana-mainnet/);
});

test('a malformed network file is skipped, and does not take the lookup down with it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-net-bad-'));
  try {
    writeFileSync(path.join(dir, 'broken.json'), '{ this is not json');
    writeFileSync(path.join(dir, 'fine.json'), JSON.stringify({ network: 'fine', x402: { enabled: false } }));
    const { networks, unreadable } = loadNetworkCapabilities({ dir });
    assert.ok(networks.has('fine'), 'the good file still loads');
    assert.equal(x402Capability('fine', { networkDir: dir }).enabled, false);
    assert.equal(networks.size, 1, 'the unreadable file is not an entry at all');
    assert.deepEqual(unreadable, ['broken.json']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a file with no `network` key is not indexed, so a stray json cannot claim a name', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-net-noname-'));
  try {
    writeFileSync(path.join(dir, 'stray.json'), JSON.stringify({ chainId: 8453, chainName: 'base', x402: { enabled: false } }));
    const { networks, unreadable } = loadNetworkCapabilities({ dir });
    assert.equal(networks.size, 0);
    assert.deepEqual(unreadable, [], 'a file that PARSES but declares no network is skipped, not reported as unreadable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the EVM path is untouched: numeric keys still resolve out of contracts/config', () => {
  // The regression that matters. Every chain-id caller predates this change and none of them may
  // move, including the `source` strings other tests in this file match on.
  const rh = x402Capability(ROBINHOOD);
  assert.equal(rh.enabled, false, '4663 stays off');
  assert.equal(rh.chainId, 4663);
  assert.equal(rh.network, null, 'an EVM chain answers with a chain id, not a network name');
  assert.equal(x402Capability(BASE_SEPOLIA).enabled, true);
  assert.equal(x402Capability('4663').enabled, false, 'a numeric STRING is still a chain id, not a network name');
  assert.equal(x402Capability(null).enabled, true);
  assert.equal(x402Capability('').enabled, true);
});

test('every shipped network file declares the block out loud, and names a scheme', () => {
  // The same non-vacuity discipline the chain configs are held to: a directory that has gone empty
  // would make every assertion above pass by walking nothing.
  const shipped = loadNetworkCapabilities({ dir: DEFAULT_NETWORK_DIR }).networks;
  assert.ok(shipped.size >= 2, `expected at least two shipped network configs, found ${shipped.size}`);
  for (const [name, entry] of shipped) {
    assert.ok(entry.x402, `${entry.file}: declares no x402 block — say it out loud rather than relying on the default`);
    assert.ok(entry.scheme, `${entry.file}: declares no scheme, so a caller cannot pick a facilitator`);
    assert.equal(name, name.toLowerCase(), 'the index key is lower-cased');
  }
});

/*
 * ── THE NETWORK NAME, END TO END ────────────────────────────────────────────────────────────────
 *
 * The capability landed before anything could reach it: `resolveApiConfig` threw on a non-integer
 * CHAIN_ID, so the only caller that could get to the network path was a direct call. A review
 * pointed that out, along with the packaging half — `config/networks` was not in the image — and
 * both are closed here. These cases pin the wiring rather than the resolver.
 */

test('NETWORK resolves the capability by name, and CHAIN_ID stays the numeric door', () => {
  const base = { PRICE_ASSET: USDC, PRICE_PAYTO: PAYTO };
  assert.equal(resolveApiConfig({ ...base, NETWORK: 'solana-mainnet' }).network, 'solana-mainnet');
  assert.equal(resolveApiConfig({ ...base, NETWORK: 'solana-mainnet' }).chainId, null);
  assert.equal(resolveApiConfig({ ...base, CHAIN_ID: '4663' }).chainId, 4663);
  assert.equal(resolveApiConfig({ ...base, CHAIN_ID: '4663' }).network, null);
  assert.equal(resolveApiConfig(base).network, null, 'neither set is still the old behaviour');
  assert.equal(resolveApiConfig({ ...base, NETWORK: '   ' }).network, null, 'whitespace is not a network');
  assert.equal(resolveApiConfig({ ...base, NETWORK: '  solana-devnet  ' }).network, 'solana-devnet', 'trimmed');
});

test('setting BOTH is refused at boot rather than resolved by precedence', () => {
  // Whichever way a precedence rule fell, half the readers of serve.mjs would assume the other, and
  // the thing being decided is whether a payment gate is on. Failing with both names printed is the
  // cheapest possible version of that argument.
  assert.throws(
    () => resolveApiConfig({ PRICE_ASSET: USDC, PRICE_PAYTO: PAYTO, NETWORK: 'solana-mainnet', CHAIN_ID: '4663' }),
    /set NETWORK or CHAIN_ID, not both/,
  );
});

test('a numeric NETWORK is refused, so it cannot silently mean CHAIN_ID', () => {
  for (const bad of ['4663', '8453', '0', '1e3'])
    assert.throws(
      () => resolveApiConfig({ PRICE_ASSET: USDC, PRICE_PAYTO: PAYTO, NETWORK: bad }),
      /NETWORK must be a network NAME/,
      `NETWORK='${bad}' must be refused`,
    );
});

test('two files declaring one network: the first wins and the collision is named', () => {
  // This was the loader's one fail-OPEN direction. Last-wins meant an explicit `enabled: false`
  // could be undone by adding a file that sorted later, silently.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-dup-'));
  try {
    writeFileSync(path.join(dir, 'a-off.json'), JSON.stringify({ network: 'dup', x402: { enabled: false } }));
    writeFileSync(path.join(dir, 'z-on.json'), JSON.stringify({ network: 'dup', x402: { enabled: true } }));
    const cap = x402Capability('dup', { networkDir: dir });
    assert.equal(cap.enabled, false, 'the explicit disable must survive a duplicate that re-enables');
    assert.match(cap.source, /a-off\.json/);
    assert.match(cap.source, /CONFIGURATION ERROR/);
    assert.match(cap.source, /z-on\.json.*ignored/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a duplicate that differs only by case collides visibly, not invisibly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-dupcase-'));
  try {
    writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ network: 'dup', x402: { enabled: false } }));
    writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ network: 'DUP', x402: { enabled: true } }));
    const cap = x402Capability('dup', { networkDir: dir });
    assert.equal(cap.enabled, false);
    assert.match(cap.source, /CONFIGURATION ERROR/, 'the case-only collision must be reported, not swallowed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('no shipped network is shadowed, so the message above is not routine', () => {
  const shippedLoad = loadNetworkCapabilities({ dir: DEFAULT_NETWORK_DIR });
  assert.deepEqual(shippedLoad.unreadable, [], 'a shipped config that does not parse is a release blocker, not a note');
  for (const [, entry] of shippedLoad.networks)
    assert.equal(entry.shadowed, undefined, `${entry.file}: a shipped config is shadowed by another`);
});

/*
 * ── THE FIVE THINGS THE REVIEW OF #236 FOUND ───────────────────────────────────────────────────
 */

test('the CHAIN-ID loader is keep-first too, so the fail-open is not asymmetric', () => {
  // #236 closed last-wins on the network path and left it open on the chain path — which is the
  // path chain 4663 uses, and 4663's `enabled: false` is a live owner decision. A review
  // demonstrated it with two configs for one chain id.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-chaindup-'));
  try {
    writeFileSync(path.join(dir, 'a-off.json'), JSON.stringify({ chainId: 99991, chainName: 'off', x402: { enabled: false } }));
    writeFileSync(path.join(dir, 'z-on.json'), JSON.stringify({ chainId: 99991, chainName: 'on', x402: { enabled: true } }));
    const cap = x402Capability(99991, { dir });
    assert.equal(cap.enabled, false, 'adding a later file must not be able to turn a gate back on');
    assert.match(cap.source, /a-off\.json/);
    assert.equal(loadChainCapabilities({ dir }).get(99991).shadowed.join(','), 'z-on.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable file is reported on a miss, not silently skipped', () => {
  // "The collision is named" had a hole: a malformed file that declares an already-declared network
  // shadowed nothing and reported nothing, so the operator who wrote it got no signal at all.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-unreadable-'));
  try {
    writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    const cap = x402Capability('solana-mainnet', { networkDir: dir });
    assert.equal(cap.enabled, true, 'still the safe default');
    assert.match(cap.source, /broken\.json could not be parsed/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unreadable files are a PROPERTY, not an entry — they cannot be looked up or counted', () => {
  // The first draft filed them under a reserved key inside the Map. A review took that apart: the
  // guard meant to stop the key being looked up was dead code (lookups are trimmed, the key was
  // not, so the comparison could never be true), and the entry counted toward the shipped-configs
  // non-vacuity floor — so that floor could be met by one real config and one broken one.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-unreadable-shape-'));
  try {
    writeFileSync(path.join(dir, 'broken.json'), '{ not json');
    writeFileSync(path.join(dir, 'real.json'), JSON.stringify({ network: 'real', scheme: 'exact-svm', x402: { enabled: true } }));
    const { networks, unreadable } = loadNetworkCapabilities({ dir });
    assert.equal(networks.size, 1, 'one real config, and the broken one is not an entry');
    assert.deepEqual([...networks.keys()], ['real']);
    assert.deepEqual(unreadable, ['broken.json']);
    // The shape a review asked for: two named fields, so nothing can be dropped by a Map copy and
    // nothing has to be cast to be described.
    assert.deepEqual(Object.keys(loadNetworkCapabilities({ dir })).sort(), ['networks', 'unreadable']);
    // And nothing about it is reachable as a network name, by construction rather than by a guard.
    for (const spelling of ['broken.json', 'unreadable', 'unreadable/files', ' unreadable/files '])
      assert.match(x402Capability(spelling, { networkDir: dir }).source, /no network config for/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a chain-id collision is NAMED in source, not merely recorded', () => {
  // The commit message claimed both loaders name their collisions. Only the network branch did:
  // `shadowed` was set on the chain entry and nothing read it, so a configuration error on the very
  // path chain 4663 uses was invisible in the boot log.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-chaincollide-'));
  try {
    writeFileSync(path.join(dir, 'a-off.json'), JSON.stringify({ chainId: 99992, chainName: 'off', x402: { enabled: false } }));
    writeFileSync(path.join(dir, 'z-on.json'), JSON.stringify({ chainId: 99992, chainName: 'on', x402: { enabled: true } }));
    const cap = x402Capability(99992, { dir });
    assert.equal(cap.enabled, false);
    assert.match(cap.source, /CONFIGURATION ERROR/);
    assert.match(cap.source, /z-on\.json/);
    assert.match(cap.source, /declare the same chain id/, 'and it says chain id, not network');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('keep-first means the FIRST file wins — not that a disable wins', () => {
  // The first draft of this rule claimed "an explicit false cannot be overwritten". It can be
  // discarded, by an earlier file's silence or by an earlier true. What keep-first actually buys is
  // that ADDING a file can no longer take a gate off. Both directions are pinned here so the
  // comment and the code cannot drift apart again.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-keepfirst-'));
  try {
    writeFileSync(path.join(dir, 'a-on.json'), JSON.stringify({ network: 'd', x402: { enabled: true } }));
    writeFileSync(path.join(dir, 'z-off.json'), JSON.stringify({ network: 'd', x402: { enabled: false } }));
    const cap = x402Capability('d', { networkDir: dir });
    assert.equal(cap.enabled, true, 'a later `false` is discarded exactly as a later `true` would be');
    assert.match(cap.source, /the FIRST file wins, whatever it says/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a network config with no chainName still counts as a config that matched', () => {
  // `chainName` is optional, and the boot log used `chainName == null` as its "nothing matched"
  // sentinel — so this config fired a warning that no config had matched, on the same log line
  // whose `why` quoted the file that did.
  const dir = mkdtempSync(path.join(tmpdir(), 'x402-noname-'));
  try {
    writeFileSync(path.join(dir, 'anon.json'), JSON.stringify({ network: 'anon', x402: { enabled: true } }));
    const cap = x402Capability('anon', { networkDir: dir });
    assert.equal(cap.chainName, null, 'the display name really is absent');
    assert.match(cap.source, /sets x402\.enabled = true/, 'and `source` is what says a file was read');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
