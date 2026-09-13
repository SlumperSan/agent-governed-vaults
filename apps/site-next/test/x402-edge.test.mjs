// @ts-check
/**
 * The edge route that takes money — now reading the chain instead of a pinned file.
 *
 * WHAT THESE TESTS ARE FOR. Two prior guards in this repository passed something they existed to
 * block: an `assert(!rewired)` satisfied by any transport failure, and a dropped `workflowName` that
 * turned a self-exclusion into a no-op. Both were green. The equivalent failure here has TWO shapes
 * now instead of one: a route that serves the paid body without a settled payment (unchanged from
 * the pinned-snapshot version), and a route that reports an oracle freeze for a field that merely
 * failed to answer — issues #266 and PR #185 are this repository's own history of exactly that
 * confusion. So the tests below assert on the BODY, not the status code alone, and the live-read
 * tests assert on which KEY is present, not just which value — `'navWad' in vault === false` catches
 * a fabricated 0 that `vault.navWad === undefined` would miss if navWad were ever accidentally
 * assigned `undefined` rather than omitted.
 *
 * NO TEST BELOW TOUCHES THE NETWORK. Every test that reaches the chain-read step injects a fake
 * `reader` via `handle`'s second argument (`{reader, facilitator, nowMs}`) — a seam that exists
 * only for tests; `onRequestGet` (what Cloudflare actually calls) always uses the real chain and a
 * real HTTP facilitator. The tests that stop BEFORE the chain-read step (unpaid, locally-invalid
 * envelope, misconfiguration) call `handle` with a reader/facilitator that throws if either is ever
 * called at all, which is itself the assertion that those paths never reach the network.
 *
 * The routes are Cloudflare Pages Functions: plain ES modules exporting `onRequestGet(context)`.
 * They need no Workers runtime to test, only a `context` with `request` and `env`, so these run in
 * `node --test` alongside everything else rather than in a separate harness nothing runs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAddress } from 'viem';

import { handle } from '../functions/api/vaults.js';
import { onRequestGet as discovery } from '../functions/.well-known/x402.js';
import { BASE_MAINNET_USDC } from '../functions/api/_price.js';
import { VAULTS, DATA_CHAIN_ID } from '../functions/api/_chain.js';

const PAYTO = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';

/** A fully-configured deployment: $0.10 of Circle-native USDC on Base mainnet. */
const ENV = {
  PRICE_ASSET: BASE_MAINNET_USDC,
  PRICE_PAYTO: PAYTO,
  PRICE_AMOUNT: '100000',
  PRICE_NETWORK: 'base',
  FACILITATOR_URL: 'https://facilitator.example',
  // CAIP-2, and deliberately NOT the same value as PRICE_NETWORK above: that one is the label
  // the challenge shows a paying client, this one is what the facilitator's /verify expects.
  FACILITATOR_NETWORK: 'eip155:8453',
};

const ctx = (env = ENV, headers = {}) => ({
  request: new Request('https://rwally.com/api/vaults', { headers }),
  env,
});

const bodyOf = async (res) => JSON.parse(await res.text());

/** A well-formed envelope for the configured price — the one every live-read test pays with. */
function paidEnvelope({ value = '100000', to = PAYTO, asset = BASE_MAINNET_USDC, network = 'base', nonce = '0xnonce1' } = {}) {
  const env = {
    x402Version: 2,
    network,
    signature: '0x' + '11'.repeat(65),
    authorization: { asset, to, value, nonce, validAfter: '0', validBefore: String(Math.floor(Date.now() / 1000) + 600) },
  };
  return Buffer.from(JSON.stringify(env)).toString('base64');
}
const paidHeaders = (overrides) => ({ 'payment-signature': paidEnvelope(overrides) });

/**
 * A reader that fails the test outright if the route ever calls it — proves steps 1/2 make no RPC
 * call. `assertBoundToDeclaredChain` is in here for the same reason as the other two and not as a
 * formality: the binding is itself an `eth_chainId` round trip, so "no RPC before the envelope
 * clears locally" is only true if the BINDING is also after that point.
 */
const noRpcReader = {
  async headBlock() { throw new Error('MUST NOT BE CALLED: no payment was settled yet'); },
  async tryRead() { throw new Error('MUST NOT BE CALLED: no payment was settled yet'); },
  async assertBoundToDeclaredChain() { throw new Error('MUST NOT BE CALLED: no payment was settled yet'); },
};

/** A facilitator that fails the test outright if it is ever called — proves a 503 charges nobody. */
const noFacilitator = {
  async verifyAndSettle() { throw new Error('MUST NOT BE CALLED: the chain read failed, so nothing was sold'); },
};

const okFacilitator = (receiptId = 'rcpt_live_1') => ({
  async verifyAndSettle() { return { ok: true, receiptId }; },
});

/**
 * A fake `packages/canary`-shaped reader. `values[`${address}:${fn}`]` is the value `tryRead`
 * resolves with; `errors[`${address}:${fn}`]` (or `errors.headBlock`) makes that call fail the
 * way `reader.mjs`'s real `tryRead`/`headBlock` fail — `{kind, revertData}` for a read, a thrown
 * Error for `headBlock`. Every `tryRead` call is recorded in `.calls` so a test can assert every
 * field was pinned to the same block.
 *
 * `errors.binding` makes `assertBoundToDeclaredChain` reject with that error, standing in for the
 * real reader refusing a wrong or unreadable chain id. `.order` records the sequence of `bind` /
 * `headBlock` / `read` so a test can assert the binding happened FIRST rather than merely happening
 * — a binding that runs after the addresses have been read has proven nothing.
 */
function fakeReader({ block = 1, values = {}, errors = {} } = {}) {
  const calls = [];
  const order = [];
  return {
    calls,
    order,
    async assertBoundToDeclaredChain() {
      order.push('bind');
      if (errors.binding) throw errors.binding;
      return { ok: true, message: 'fake reader: bound by fixture' };
    },
    async headBlock() {
      order.push('headBlock');
      if (errors.headBlock) throw errors.headBlock;
      return block;
    },
    async tryRead(address, _abi, functionName, _args, opts) {
      order.push('read');
      calls.push({ address, functionName, blockNumber: opts?.blockNumber });
      const key = `${address}:${functionName}`;
      if (errors[key]) {
        const e = errors[key];
        return { ok: false, error: e.message, kind: e.kind, revertData: e.revertData ?? null };
      }
      if (key in values) return { ok: true, value: values[key] };
      if (functionName === 'locked') return { ok: true, value: false };
      if (functionName === 'creator') return { ok: true, value: '0x0f80606a2283fd9c67ce2eec79b90e95907f9f35' };
      return { ok: true, value: 0n };
    },
  };
}

const SMOKE = VAULTS[0].address;
const SECOND = VAULTS[1].address;

/** The exact measured values from the smoke vault, 2026-09-13 (brief's own numbers). */
const SMOKE_VALUES = {
  [`${SMOKE}:totalShares`]: 20000000000000000000n,
  [`${SMOKE}:idleUsdc`]: 20000000n,
  [`${SMOKE}:navWad`]: 20000000000000000000n,
  [`${SMOKE}:navPerShareWad`]: 1000000000000000000n,
  [`${SMOKE}:totalPendingUsdc`]: 0n,
  [`${SMOKE}:capacityCapUsdc`]: 50000000000n,
  [`${SMOKE}:minDepositUsdc`]: 10000n,
  [`${SMOKE}:basketLength`]: 2n,
  [`${SMOKE}:childVaultCount`]: 0n,
  [`${SMOKE}:usdcScalar`]: 1000000000000n,
  [`${SMOKE}:locked`]: false,
  [`${SMOKE}:creator`]: '0x0f80606a2283fd9c67ce2eec79b90e95907f9f35',
};

// ── the money path: unpaid / invalid, and NO RPC CALL ──────────────────────────────────────────

test('an unpaid request gets 402, NOT the paid body, and never reads the chain', async () => {
  const res = await handle(ctx(), { reader: noRpcReader, facilitator: noFacilitator });
  assert.equal(res.status, 402);

  const body = await bodyOf(res);
  assert.equal(body.error, 'payment required');
  assert.ok(body.challenge, 'a 402 must carry the challenge the caller has to sign');
  assert.equal(body.vaults, undefined, 'THE defect this route could have: the paid payload served without payment');
});

test('the 402 challenge demands exactly the configured price, asset, payee and network', async () => {
  const res = await handle(ctx(), { reader: noRpcReader });
  const { challenge } = await bodyOf(res);
  assert.equal(challenge.amount, '100000', '$0.10 at 6dp');
  assert.equal(challenge.asset, BASE_MAINNET_USDC);
  assert.equal(challenge.payTo, PAYTO);
  assert.equal(challenge.network, 'base');
  assert.equal(challenge.scheme, 'exact', 'EVM EIP-3009, not the Solana scheme');
  assert.equal(challenge.x402Version, 2);
});

test('the challenge is echoed in the PAYMENT-REQUIRED header, which is where a client reads it', async () => {
  const res = await handle(ctx(), { reader: noRpcReader });
  const header = res.headers.get('payment-required');
  assert.ok(header, 'no PAYMENT-REQUIRED header');
  const body = await bodyOf(res);
  assert.deepEqual(JSON.parse(header), body.challenge);
});

test('a garbage payment header is refused, and never reads the chain', async () => {
  const res = await handle(ctx(ENV, { 'payment-signature': 'not-base64-json' }), { reader: noRpcReader, facilitator: noFacilitator });
  assert.equal(res.status, 402);
  const body = await bodyOf(res);
  assert.equal(body.vaults, undefined);
});

test('a well-formed envelope for the WRONG amount is refused before any RPC call or facilitator call', async () => {
  const res = await handle(ctx(ENV, paidHeaders({ value: '1' })), { reader: noRpcReader, facilitator: noFacilitator });
  assert.equal(res.status, 402);
  const body = await bodyOf(res);
  assert.match(body.error, /payment invalid/);
  assert.equal(body.vaults, undefined);
});

// ── fail closed on misconfiguration (unchanged behaviour, still no RPC) ─────────────────────────

for (const missing of ['PRICE_ASSET', 'PRICE_PAYTO', 'PRICE_AMOUNT', 'PRICE_NETWORK', 'FACILITATOR_URL', 'FACILITATOR_NETWORK']) {
  test(`a deployment missing ${missing} refuses rather than serving the body free`, async () => {
    const env = { ...ENV };
    delete env[missing];
    const res = await handle(ctx(env), { reader: noRpcReader, facilitator: noFacilitator });
    assert.equal(res.status, 500);
    const body = await bodyOf(res);
    assert.equal(body.error, 'route misconfigured');
    assert.match(body.detail, new RegExp(missing));
    assert.equal(body.vaults, undefined, 'a misconfigured route must never serve the paid payload');
  });
}

test('an unparseable FACILITATOR_URL is refused WITHOUT echoing it back', async () => {
  // Unlike the other five settings, this one is operator configuration published nowhere, and a
  // facilitator endpoint may carry a key in its path or query. Omitting the scheme is the commonest
  // URL typo, so this branch is exactly where a credential would reach an unauthenticated GET.
  const res = await handle(ctx({ ...ENV, FACILITATOR_URL: 'facilitator.example/x?apiKey=SUPER_SECRET_KEY' }), { reader: noRpcReader });
  assert.equal(res.status, 500);
  const body = await bodyOf(res);
  assert.ok(!body.detail.includes('SUPER_SECRET_KEY'), 'the credential must not reach the response');
  assert.ok(!body.detail.includes('facilitator.example'), 'the value must not be echoed at all');
  assert.match(body.detail, /FACILITATOR_URL/, 'but it must still name the setting at fault');
  assert.equal(body.vaults, undefined);
});

test('a scheme-omitted FACILITATOR_URL is refused WITHOUT echoing the host', async () => {
  // `host:443/path` PARSES -- WHATWG reads the host as the scheme -- so it reaches the non-https
  // branch rather than the unparseable one. That branch used to print `parsed.protocol`, i.e. the
  // hostname. Asserting on ABSENCE, so a reworded message cannot quietly reintroduce the leak.
  const res = await handle(ctx({ ...ENV, FACILITATOR_URL: 'facilitator.example.com:443/settle?apiKey=SUPER_SECRET_KEY' }), { reader: noRpcReader });
  assert.equal(res.status, 500);
  const body = await bodyOf(res);
  assert.ok(!body.detail.includes('SUPER_SECRET_KEY'), 'the credential must not reach the response');
  assert.ok(!body.detail.includes('facilitator.example.com'), 'the host must not reach the response');
  assert.match(body.detail, /FACILITATOR_URL/, 'but it must still name the setting at fault');
  assert.equal(body.vaults, undefined);
});

test('a non-https FACILITATOR_URL is refused — a signed envelope must not cross plain http', async () => {
  const res = await handle(ctx({ ...ENV, FACILITATOR_URL: 'http://facilitator.example/settle' }), { reader: noRpcReader });
  assert.equal(res.status, 500);
  const body = await bodyOf(res);
  // Assert the SETTING is named and the VALUE is absent, not the exact wording -- an earlier
  // version pinned /must be https/ and broke when the message was reworded to withhold the value.
  assert.match(body.detail, /FACILITATOR_URL/);
  assert.match(body.detail, /https/);
  assert.ok(!body.detail.includes('facilitator.example'), 'the value must not be echoed');
});

test('PRICE_AMOUNT must be positive base units, so a free or malformed price cannot deploy', async () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    const res = await handle(ctx({ ...ENV, PRICE_AMOUNT: bad }), { reader: noRpcReader });
    assert.equal(res.status, 500, `PRICE_AMOUNT=${JSON.stringify(bad)} should refuse`);
  }
});

test('FACILITATOR_NETWORK must be CAIP-2 — a wrong chain id rejects every payment forever', async () => {
  // Not defaulted on purpose. The facilitator verifies against whatever chain this names, so a
  // plausible-but-wrong value (the client-facing label, a bare chain number) would make every
  // payment fail verification with nothing in the response explaining why.
  for (const bad of ['base', '8453', 'eip155', ':8453', 'eip155:', '']) {
    const res = await handle(ctx({ ...ENV, FACILITATOR_NETWORK: bad }), { reader: noRpcReader });
    assert.equal(res.status, 500, `FACILITATOR_NETWORK=${JSON.stringify(bad)} should refuse`);
    const body = await bodyOf(res);
    assert.equal(body.vaults, undefined);
  }
});

test('the facilitator network and the advertised network are allowed to differ', async () => {
  // One chain, two spellings, different audiences: the challenge advertises `base` (what PayAI's
  // /supported lists for its x402Version 1 Base-mainnet entry) while the facilitator is addressed
  // as eip155:8453 (its v2 entry for the same chain). Merging them would break one side.
  const res = await handle(ctx(), { reader: noRpcReader });
  const { challenge } = await bodyOf(res);
  assert.equal(challenge.network, 'base', 'the client sees the advertised label');
  assert.notEqual(ENV.FACILITATOR_NETWORK, challenge.network, 'and the facilitator gets CAIP-2');
});

test('a PRICE_PAYTO that is not an address is refused — it decides who receives the money', async () => {
  const res = await handle(ctx({ ...ENV, PRICE_PAYTO: 'vitalik.eth' }), { reader: noRpcReader });
  assert.equal(res.status, 500);
  const body = await bodyOf(res);
  assert.match(body.detail, /PRICE_PAYTO is not an address/);
});

// ── discovery ─────────────────────────────────────────────────────────────────────────────────

test('discovery is free and quotes the SAME price the gate enforces', async () => {
  const res = await discovery({ request: new Request('https://rwally.com/.well-known/x402'), env: ENV });
  assert.equal(res.status, 200);
  const doc = await bodyOf(res);

  const paid = await handle(ctx(), { reader: noRpcReader });
  const { challenge } = await bodyOf(paid);

  assert.equal(doc.routes[0].price.amount, challenge.amount, 'discovery must not quote a price the gate will not charge');
  assert.equal(doc.asset, challenge.asset);
  assert.equal(doc.payTo, challenge.payTo);
  assert.equal(doc.network, challenge.network);
});

test('discovery states the read is LIVE, and quotes no fixed age for it', async () => {
  const res = await discovery({ request: new Request('https://rwally.com/.well-known/x402'), env: ENV });
  const doc = await bodyOf(res);
  assert.equal(doc.routes[0].data.live, true, 'the payload is a chain read at request time and must say so');
  assert.equal(doc.routes[0].data.vaultCount, VAULTS.length);
  assert.equal(doc.routes[0].data.asOf, undefined, 'there is no pinned age left to quote');
});

test('discovery names the route at the origin it was requested from', async () => {
  const res = await discovery({ request: new Request('https://rwally.com/.well-known/x402'), env: ENV });
  const doc = await bodyOf(res);
  assert.equal(doc.routes[0].url, 'https://rwally.com/api/vaults');
});

// ── the vault address list is the same list the deployment record names ────────────────────────

test('VAULTS matches the deployment record exactly — no drift between the edge copy and the source', async () => {
  const { default: rec } = await import(
    '../../../contracts/config/deployments/robinhood-mainnet.json',
    { with: { type: 'json' } }
  );
  assert.equal(VAULTS.length, 2);
  assert.equal(VAULTS[0].address, rec.smokeVault.address);
  assert.equal(VAULTS[1].address, rec.secondVault.address);
});

// ── the live read: success ──────────────────────────────────────────────────────────────────────

test('a settled payment serves a live read: block number, chain identity, and the settled receipt', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator('rcpt_42') });
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.live, true);
  assert.equal(body.chainId, 4663);
  assert.equal(body.blockNumber, 1);
  assert.equal(body.receiptId, 'rcpt_42');
  assert.equal(res.headers.get('payment-response'), JSON.stringify({ receiptId: 'rcpt_42', nonce: '0xnonce1' }));
  assert.equal(res.headers.get('cache-control'), 'no-store', '`live: true` must not be cached and re-served stale');
});

test('a malformed creator value is a DECODE failure, not a "chain read failed" 503 — an encoding bug is not a chain fact', async () => {
  const values = { ...SMOKE_VALUES, [`${SMOKE}:creator`]: '0xnot-an-address' };
  const reader = fakeReader({ block: 1, values });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  assert.equal(res.status, 200, 'the read otherwise succeeded; one malformed field must not fail the whole request');
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  assert.equal('creator' in smoke, false);
  assert.equal(smoke.unreadable.creator.kind, 'decode');
});

test('a headBlock() that resolves to a non-integer is treated as a failed read, not a null block number', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  reader.headBlock = async () => NaN;
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: noFacilitator });
  assert.equal(res.status, 503);
  const body = await bodyOf(res);
  assert.equal(body.vaults, undefined);
});

test('every field read succeeds is pinned to the SAME block — no field straddles a boundary another was read at', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  assert.equal(res.status, 200);
  assert.ok(reader.calls.length > 0);
  for (const call of reader.calls) assert.equal(call.blockNumber, 1);
});

test('amounts are decimal STRINGS, not numbers — this repo does not treat token amounts as floats', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  for (const field of ['totalShares', 'idleUsdc', 'navWad', 'navPerShareWad', 'totalPendingUsdc', 'capacityCapUsdc', 'minDepositUsdc', 'usdcScalar', 'basketLength', 'childVaultCount']) {
    assert.equal(typeof smoke[field], 'string', `${field} must be a decimal string`);
  }
  assert.equal(smoke.totalShares, '20000000000000000000');
  assert.equal(smoke.navPerShareWad, '1000000000000000000');
});

test('locked is served as a boolean, and creator as a CHECKSUMMED address, not the raw ABI decode', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  assert.equal(typeof smoke.locked, 'boolean');
  assert.equal(smoke.locked, false);
  assert.equal(smoke.creator, getAddress('0x0f80606a2283fd9c67ce2eec79b90e95907f9f35'));
  assert.notEqual(smoke.creator, '0x0f80606a2283fd9c67ce2eec79b90e95907f9f35', 'must not be the lowercase ABI decode');
});

test('capacity headroom is capacityCapUsdc minus (navWad/usdcScalar + totalPendingUsdc) — the deposit gate\'s own arithmetic', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  // navUsdc = 20000000000000000000 / 1000000000000 = 20000000; committed = 20000000 + 0
  // headroom = 50000000000 - 20000000 = 49980000000
  assert.equal(smoke.capacityHeadroomUsdc, '49980000000');
});

test('capacity headroom is OMITTED (not zero) when the vault is uncapped', async () => {
  const values = { ...SMOKE_VALUES, [`${SMOKE}:capacityCapUsdc`]: 0n };
  const reader = fakeReader({ block: 1, values });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  assert.equal('capacityHeadroomUsdc' in smoke, false);
});

test('a vault that could not be fully read has NO capacity headroom rather than a partial figure', async () => {
  const values = { ...SMOKE_VALUES };
  delete values[`${SMOKE}:totalPendingUsdc`];
  const errors = { [`${SMOKE}:totalPendingUsdc`]: { message: 'HTTP request failed.', kind: 'transport' } };
  const reader = fakeReader({ block: 1, values, errors });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  assert.equal('capacityHeadroomUsdc' in smoke, false);
  assert.equal('totalPendingUsdc' in smoke, false);
  assert.ok(smoke.unreadable.totalPendingUsdc);
});

// ── the property this whole file exists to defend: revert vs transport never collapse ──────────

test('a genuine oracle freeze (StaleOracle revert) is reported as pricingFrozen, and NAV fields are ABSENT — never 0', async () => {
  const errors = {
    [`${SMOKE}:navWad`]: { message: 'execution reverted', kind: 'revert', revertData: '0xa2671f4b' },
    [`${SMOKE}:navPerShareWad`]: { message: 'execution reverted', kind: 'revert', revertData: '0xa2671f4b' },
  };
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES, errors });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  assert.equal(res.status, 200, 'a frozen oracle on one vault does not fail the whole read');
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  assert.equal(smoke.pricingFrozen, true);
  assert.equal(smoke.pricingFrozenReason, 'StaleOracle');
  assert.equal(smoke.pricingFrozenSelector, '0xa2671f4b');
  assert.equal('navWad' in smoke, false, 'a frozen NAV must be ABSENT, never a fabricated 0');
  assert.equal('navPerShareWad' in smoke, false);
  assert.equal(smoke.unreadable, undefined, 'a recognised freeze is a signal, not missing evidence');
});

test('a TRANSPORT failure on the pricing read is NEVER reported as pricingFrozen — the bug this repo shipped twice', async () => {
  const errors = {
    [`${SMOKE}:navWad`]: { message: 'HTTP request failed.', kind: 'transport' },
    [`${SMOKE}:navPerShareWad`]: { message: 'HTTP request failed.', kind: 'transport' },
  };
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES, errors });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  assert.notEqual(smoke.pricingFrozen, true);
  assert.equal(smoke.pricingFrozen, undefined);
  assert.equal('navWad' in smoke, false);
  assert.equal(smoke.unreadable.navWad.kind, 'transport');
});

test('an UNRECOGNISED revert on the pricing read is filed unreadable, not guessed at as StaleOracle', async () => {
  const errors = {
    [`${SMOKE}:navWad`]: { message: 'execution reverted', kind: 'revert', revertData: '0xdeadbeef' },
  };
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES, errors });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  assert.equal(smoke.pricingFrozen, undefined, 'an unrecognised revert must not be presented as the known freeze');
  assert.equal('navWad' in smoke, false);
  assert.equal(smoke.unreadable.navWad.kind, 'revert');
});

const ALL_VAULT_FIELDS = ['totalShares', 'idleUsdc', 'navWad', 'navPerShareWad', 'totalPendingUsdc', 'capacityCapUsdc', 'minDepositUsdc', 'usdcScalar', 'basketLength', 'childVaultCount', 'locked', 'creator'];

test('a bad RPC (every field transport-fails on EVERY vault) settles nothing — a block number and two addresses is not a read', async () => {
  // This is the exact case a review found billing $0.10 for: headBlock() answers, and every
  // subsequent tryRead() fails. No vault contributed a single field, so there is nothing here
  // that was actually read, and the route must not settle for it.
  const errors = {};
  for (const v of VAULTS) {
    for (const fn of ALL_VAULT_FIELDS) {
      errors[`${v.address}:${fn}`] = { message: 'getaddrinfo ENOTFOUND rpc.mainnet.chain.robinhood.com', kind: 'transport' };
    }
  }
  const reader = fakeReader({ block: 1, errors });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: noFacilitator });
  assert.equal(res.status, 503, 'a block number alone, with zero readable fields on every vault, is not a sellable read');
  const body = await bodyOf(res);
  assert.equal(body.vaults, undefined);
  assert.equal(res.headers.get('payment-response'), null, 'no payment was settled — no receipt to echo');
});

test('a bad RPC on only ONE vault still settles and serves the vault that DID read — and still reports no pricingFrozen for the failed one', async () => {
  const errors = {};
  for (const fn of ALL_VAULT_FIELDS) {
    errors[`${SMOKE}:${fn}`] = { message: 'getaddrinfo ENOTFOUND rpc.mainnet.chain.robinhood.com', kind: 'transport' };
  }
  const values = {
    [`${SECOND}:navWad`]: 4899602373219565415n,
    [`${SECOND}:navPerShareWad`]: 979920474643913083n,
  };
  const reader = fakeReader({ block: 1, values, errors });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  assert.equal(res.status, 200, 'the second vault DID yield data, so this is a real (partial) read and can be sold');
  const body = await bodyOf(res);
  const smoke = body.vaults.find((v) => v.address === SMOKE);
  const second = body.vaults.find((v) => v.address === SECOND);
  assert.notEqual(smoke.pricingFrozen, true);
  assert.equal('navWad' in smoke, false);
  assert.equal(smoke.unreadable.navWad.kind, 'transport');
  assert.equal(second.navPerShareWad, '979920474643913083');
});

test('when the chain cannot even report a block number, the route answers 503 and NEVER calls the facilitator', async () => {
  const reader = fakeReader({ errors: { headBlock: new Error('getaddrinfo ENOTFOUND rpc.mainnet.chain.robinhood.com') } });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: noFacilitator });
  assert.equal(res.status, 503);
  const body = await bodyOf(res);
  assert.equal(body.vaults, undefined);
  assert.match(body.detail, /ENOTFOUND/);
  assert.equal(res.headers.get('payment-response'), null, 'no payment was settled — no receipt to echo');
});

test('a 503 (chain unreadable) reports no vault as pricingFrozen either, vacuously and by construction', async () => {
  const reader = fakeReader({ errors: { headBlock: new Error('getaddrinfo ENOTFOUND rpc.mainnet.chain.robinhood.com') } });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: noFacilitator });
  const text = await res.text();
  assert.ok(!text.includes('"pricingFrozen":true'));
});

// ── chain binding: the RPC must BE the chain this route says it is ──────────────────────────────

/**
 * Produce a real `ChainBindingError` by driving the real `assertChainBinding` against a client that
 * reports `reportedId`, rather than hand-typing a message. A literal `/WRONG CHAIN/` would keep
 * passing if `chain-binding.mjs` changed its wording, which is the failure mode where a test agrees
 * with itself instead of with the module.
 */
async function realBindingError(reportedId, declaredChainId = DATA_CHAIN_ID) {
  const { assertChainBinding } = await import('../../../packages/chain-config/src/chain-binding.mjs');
  const client = {
    async getChainId() {
      if (reportedId === null) throw new Error('method eth_chainId not supported');
      return reportedId;
    },
  };
  try {
    await assertChainBinding({
      client, declaredChainId, rpc: 'https://rpc.example.invalid', declaredBy: "the route's DATA_CHAIN_ID",
    });
  } catch (err) {
    return err;
  }
  throw new Error('expected assertChainBinding to refuse, but it did not');
}

test('the binding runs BEFORE any address is read — a check after the reads proves nothing', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  assert.equal(res.status, 200);
  assert.equal(reader.order[0], 'bind', `first chain interaction was ${reader.order[0]}, not the binding`);
  assert.equal(reader.order.filter((o) => o === 'bind').length, 1, 'bound exactly once per request');
  assert.ok(reader.order.includes('read'), 'the fixture did record reads, so "bind first" is not vacuous');
});

test('a WRONG CHAIN rpc is a 503 and the facilitator is NEVER called — nobody pays for another chain', async () => {
  // 4664 stands in for the trap that makes "the reads would just fail" false: the same deployer
  // running the same script on another Robinhood chain yields IDENTICAL CREATE addresses holding
  // different state, so an unbound route would have served a paid 200 of the wrong chain's numbers.
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES, errors: { binding: await realBindingError(4664) } });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: noFacilitator });
  assert.equal(res.status, 503);
  const body = await bodyOf(res);
  assert.equal(body.vaults, undefined, 'no vault data may leave this route on an unproven chain');
  assert.match(body.detail, /4664/, 'the refusal names the chain the RPC actually reported');
  assert.match(body.detail, new RegExp(String(DATA_CHAIN_ID)), 'and the chain this route declares');
  assert.equal(res.headers.get('payment-response'), null, 'no settlement, so no receipt to echo');
  assert.equal(reader.order.includes('read'), false, 'refused before reading a single address');
  assert.equal(reader.order.includes('headBlock'), false, 'refused before asking for a block height');
});

test('an UNREADABLE chain id refuses exactly like a mismatch — "I could not tell" is not "they match"', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES, errors: { binding: await realBindingError(null) } });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: noFacilitator });
  assert.equal(res.status, 503);
  const body = await bodyOf(res);
  assert.equal(body.vaults, undefined);
  assert.match(body.detail, /UNPROVEN/);
  assert.equal(reader.order.includes('read'), false);
});

test('a matching chain binds and the route still sells — the refusal is not indiscriminate', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator('rcpt_bound') });
  assert.equal(res.status, 200);
  const body = await bodyOf(res);
  assert.equal(body.chainId, DATA_CHAIN_ID);
  assert.equal(body.receiptId, 'rcpt_bound');
});

// ── settlement still gates the body ─────────────────────────────────────────────────────────────

test('a chain read that succeeds but a facilitator that rejects still serves NO vault data', async () => {
  const reader = fakeReader({ block: 1, values: SMOKE_VALUES });
  const rejecting = { async verifyAndSettle() { return { ok: false, reason: 'signature-invalid' }; } };
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: rejecting });
  assert.equal(res.status, 402);
  const body = await bodyOf(res);
  assert.match(body.error, /settlement failed/);
  assert.equal(body.vaults, undefined);
});

test('both configured vaults are served, in order', async () => {
  const values = {
    ...SMOKE_VALUES,
    [`${SECOND}:navWad`]: 4899602373219565415n,
    [`${SECOND}:navPerShareWad`]: 979920474643913083n,
    [`${SECOND}:totalShares`]: 5000000000000000000n,
    [`${SECOND}:basketLength`]: 1n,
  };
  const reader = fakeReader({ block: 1, values });
  const res = await handle(ctx(ENV, paidHeaders()), { reader, facilitator: okFacilitator() });
  const body = await bodyOf(res);
  assert.equal(body.vaults.length, 2);
  assert.equal(body.vaults[0].address, SMOKE);
  assert.equal(body.vaults[1].address, SECOND);
  assert.equal(body.vaults[1].navPerShareWad, '979920474643913083');
});
