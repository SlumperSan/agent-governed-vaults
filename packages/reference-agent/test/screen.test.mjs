// @ts-check
/**
 * OFAC screen on the agent's own accounts (screen.mjs): the wrappers themselves, with a fixed
 * clock, and their wiring in createAgent, so every send and every x402 signature passes them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { screenPayer, screenWalletClient } from '../src/screen.mjs';
import { createAgent } from '../src/agent.mjs';
import { createStubChainReader } from '../src/chain.mjs';
import { loadConfig, EXECUTE_ENV_VAR } from '../src/config.mjs';
import { createLogger } from '../src/log.mjs';
import { SDN_ADDRESS_DATA } from '../../../apps/vaults-ui/src/lib/sdn-addresses.ts';
import { SDN_LIST_MAX_AGE_DAYS } from '../../../apps/vaults-ui/src/lib/sanctions.ts';

const LISTED = SDN_ADDRESS_DATA.addresses[0];
const CLEAN = '0x' + '1'.repeat(40);
const FRESH = () => Date.parse(SDN_ADDRESS_DATA.fetchedAt) + 86_400_000;
const STALE = () => Date.parse(SDN_ADDRESS_DATA.fetchedAt) + (SDN_LIST_MAX_AGE_DAYS + 1) * 86_400_000;

function recorder() {
  /** @type {any[]} */
  const sent = [];
  return { sent, writeContract: async (/** @type {any} */ req) => (sent.push(req), '0x' + 'ee'.repeat(32)) };
}
const req = (/** @type {string} */ from, /** @type {string} */ functionName) => ({ address: CLEAN, functionName, args: [], account: { address: from }, chain: null });

test('screenWalletClient: a listed account is refused on deposit and on requestExit, and nothing reaches the client', async () => {
  const w = recorder();
  const s = screenWalletClient(w, FRESH);
  assert.throws(() => s.writeContract(req(LISTED, 'deposit')), { name: 'SanctionsRefusalError' });
  assert.throws(() => s.writeContract(req(LISTED.toUpperCase().replace('0X', '0x'), 'requestExit')), { name: 'SanctionsRefusalError' });
  assert.equal(w.sent.length, 0);
});

test('screenWalletClient: a clean account passes on a fresh list', async () => {
  const w = recorder();
  assert.equal(await screenWalletClient(w, FRESH).writeContract(req(CLEAN, 'deposit')), '0x' + 'ee'.repeat(32));
  assert.equal(w.sent.length, 1);
});

test('screenWalletClient: a stale list refuses deposit and approve but lets a clean exit through', async () => {
  const w = recorder();
  const s = screenWalletClient(w, STALE);
  assert.throws(() => s.writeContract(req(CLEAN, 'deposit')), { name: 'SanctionsListStaleError' });
  assert.throws(() => s.writeContract(req(CLEAN, 'approve')), { name: 'SanctionsListStaleError' });
  await s.writeContract(req(CLEAN, 'requestExit'));
  await s.writeContract(req(CLEAN, 'claimEscrowed'));
  assert.deepEqual(w.sent.map((r) => r.functionName), ['requestExit', 'claimEscrowed']);
  assert.throws(() => s.writeContract(req(LISTED, 'requestExit')), { name: 'SanctionsRefusalError' });
});

test('screenWalletClient: on a stale list the agent may settle its own queued exit, not anyone else\'s, and never when listed', async () => {
  const w = recorder();
  const s = screenWalletClient(w, STALE);
  const settle = (/** @type {string} */ from, /** @type {string} */ member) => ({ ...req(from, 'settleQueuedExit'), args: [member] });
  await s.writeContract(settle(CLEAN, CLEAN.toUpperCase().replace('0X', '0x')));
  assert.equal(w.sent.length, 1);
  const OTHER = '0x' + '2'.repeat(40);
  assert.throws(() => s.writeContract(settle(CLEAN, OTHER)), { name: 'SanctionsListStaleError' });
  assert.throws(() => s.writeContract(settle(LISTED, LISTED)), { name: 'SanctionsRefusalError' });
  assert.throws(() => screenWalletClient(w, FRESH).writeContract(settle(LISTED, LISTED)), { name: 'SanctionsRefusalError' });
  assert.equal(w.sent.length, 1);
});

test('screenWalletClient: a request with no account address fails closed', () => {
  const w = recorder();
  assert.throws(() => screenWalletClient(w, FRESH).writeContract({ functionName: 'deposit' }), /no account address/);
  assert.equal(w.sent.length, 0);
});

test('screenPayer: listed payer refused, clean payer signs, stale list refuses every payment', async () => {
  let signed = 0;
  const payer = (/** @type {string} */ address) => ({ address, signTypedData: async () => (signed++, '0xsig'), sign: async () => (signed++, '0xsig') });
  assert.throws(() => screenPayer(payer(LISTED), FRESH).signTypedData({}), { name: 'SanctionsRefusalError' });
  assert.throws(() => screenPayer(payer(LISTED), FRESH).sign({}), { name: 'SanctionsRefusalError' });
  assert.equal(signed, 0);
  assert.equal(await screenPayer(payer(CLEAN), FRESH).signTypedData({}), '0xsig');
  assert.equal(signed, 1);
  assert.throws(() => screenPayer(payer(CLEAN), STALE).signTypedData({}), { name: 'SanctionsListStaleError' });
  assert.throws(() => screenPayer({ address: '', sign: async () => '0x' }, FRESH).sign({}), /no address/);
  assert.equal(signed, 1);
});

// ── wiring: createAgent routes every send and every payment through the screen ──
// These use the real clock, as production does, so they go red with the vaults-ui freshness test
// once the vendored list passes its ceiling; the remedy is refreshing the list, never this test.

const V_JOIN = '0x' + '4'.repeat(40);
const ASSET = '0x' + 'c'.repeat(40);
const USDC = 10n ** 6n;
const WAD = 10n ** 18n;
const NOW = 1_700_000_000;

function mockApi() {
  const res = (/** @type {number} */ status, /** @type {any} */ body, /** @type {Record<string,string>} */ headers = {}) => {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, ok: status >= 200 && status < 300, headers: { get: (/** @type {string} */ k) => h.get(k.toLowerCase()) ?? null }, json: async () => body };
  };
  const challenge = { asset: ASSET, amount: '10000', payTo: '0x' + 'b'.repeat(40), network: 'base-sepolia', nonce: '0x' + '1'.repeat(64) };
  const BODIES = {
    '/.well-known/x402': { x402Version: 2, price: { asset: ASSET, amount: '10000', payTo: challenge.payTo, network: 'base-sepolia' } },
    '/health': { ok: true, lastBlock: 1010 },
    '/vaults': { vaults: [{ vault: V_JOIN, operatorId: 1, memberCount: 5, depth: 0, parent: null, capacityCapUsdc: (500_000n * USDC).toString(), attested: true }] },
    '/operators/leaderboard': {
      leaderboard: [{ operatorId: 1, operator: '0x' + 'a1'.repeat(20), netRealizedUsdc: (36_000n * USDC).toString(), lifetimeGainUsdc: (42_000n * USDC).toString(), lifetimeLossUsdc: (6_000n * USDC).toString(), lifetimeFeesUsdc: '0', vaultCount: 1 }],
    },
  };
  const fetchImpl = async (/** @type {any} */ url, /** @type {any} */ opts) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    const free = path === '/health' || path === '/.well-known/x402';
    if (!free && !opts?.headers?.['payment-signature']) return res(402, { error: 'payment required' }, { 'payment-required': JSON.stringify(challenge) });
    const body = /** @type {any} */ (BODIES)[path] ?? { vault: path.split('/')[2], operatorId: 1 };
    return res(200, body, { 'payment-response': JSON.stringify({ receiptId: 'r' }) });
  };
  return /** @type {typeof fetch} */ (/** @type {unknown} */ (fetchImpl));
}

function agentWith({ accountAddress, payerAddress, walletClient }) {
  const acct = privateKeyToAccount(generatePrivateKey());
  let rawSigns = 0;
  const payer = {
    address: payerAddress ?? acct.address,
    signTypedData: (/** @type {any} */ td) => (rawSigns++, acct.signTypedData({ domain: td.domain, types: { TransferWithAuthorization: td.types.TransferWithAuthorization }, primaryType: 'TransferWithAuthorization', message: td.message })),
  };
  const config = loadConfig({
    mode: 'execute',
    api: { baseUrl: 'http://api.test', payments: { maxSessionSpendUsdc: '0.25', maxSingleReadUsdc: '0.05' } },
    chain: { chainId: 84532, governance: '0x' + '9'.repeat(40), usdc: ASSET },
  });
  const chain = {
    [V_JOIN]: {
      operatorId: 1, navPerShareWad: WAD, totalAssetsUsdc: 100_000n * USDC, totalPendingUsdc: 0n, idleUsdc: 1_000n * USDC,
      capacityCapUsdc: 500_000n * USDC, isCapped: true, minDepositUsdc: 10n * USDC, stackedPerfFeeBps: 1000, stackedExitFeeCapBps: 100, depth: 0, self: {},
    },
  };
  const agent = createAgent({
    config,
    account: { address: accountAddress ?? acct.address, signMessage: (/** @type {any} */ a) => acct.signMessage(a) },
    payer,
    chainReader: createStubChainReader(chain, {}),
    log: createLogger({ write: () => {}, nowSec: () => NOW }),
    env: { [EXECUTE_ENV_VAR]: 'yes' },
    fetchImpl: mockApi(),
    walletClient,
    nowSec: () => NOW,
  });
  return { agent, rawSigns: () => rawSigns };
}

test('createAgent: a clean agent account deposits through the screened wallet client', async () => {
  const w = recorder();
  const r = await agentWith({ walletClient: w }).agent.tick();
  assert.ok(r.intents.some((i) => i.kind === 'deposit'), 'the fixture must produce a deposit, or the refusal test below proves nothing');
  assert.deepEqual(w.sent.map((t) => t.functionName), ['approve', 'deposit']);
});

test('createAgent: a listed agent account sends nothing, and the refusal lands in the result record', async () => {
  const w = recorder();
  const r = await agentWith({ accountAddress: LISTED, walletClient: w }).agent.tick();
  assert.ok(r.intents.some((i) => i.kind === 'deposit'));
  assert.equal(w.sent.length, 0);
  assert.ok(r.results.length > 0 && r.results.every((x) => x.sent === false && /sanctions list/.test(x.error)));
});

test('createAgent: a listed x402 payer never reaches the raw signer', async () => {
  const w = recorder();
  const a = agentWith({ payerAddress: LISTED, walletClient: w });
  const r = await a.agent.tick();
  assert.equal(a.rawSigns(), 0, 'no payment signature may be produced for a listed payer');
  // The budget charges at signature time before the signer runs, so paidReads counts the refused
  // attempts; the refusal itself surfaces as a perception gap and nothing is sent.
  assert.match(r.world.gaps.join('; '), /sanctions list/);
  assert.equal(w.sent.length, 0);
});
