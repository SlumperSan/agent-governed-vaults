// @ts-check
/**
 * The FACILITATOR=http x402 loop (this repo's own bespoke wire contract), in one process, over
 * real sockets, with no stub anywhere on the money path.
 *
 * SCOPE, STATED PRECISELY BECAUSE A REVIEW CAUGHT THE TITLE OVER-REACHING. This drives the repo's
 * own client (`createHttpFacilitator`) against the repo's own server (`createSettleHandler` /
 * `checkChallengePrice`) — the two halves of ONE wire contract that only this repo speaks, and
 * they agree with each other BY CONSTRUCTION. It does not exercise `FACILITATOR=standard`
 * (`createStandardHttpFacilitator`, `apps/api/src/facilitator.mjs`) or `serve.mjs`'s mode
 * selection at all — `bootApi` below constructs `createHttpFacilitator` directly. A defect where a
 * route is wired to a facilitator CLIENT that the actual remote facilitator cannot parse (the
 * `FACILITATOR=http` vs `FACILITATOR=standard` choice itself being wrong) is invisible to this
 * file for exactly that reason, and is not claimed to be covered.
 *
 * WHY THIS FILE EXISTS ANYWAY. `apps/api/test/integration.test.mjs`'s "agent SDK drives the live
 * HTTP server through the x402 loop end to end" test is real for the client<->API leg, but its
 * `facilitator` is `{ async verifyAndSettle() { return { ok: true, receiptId: 'wire_rcpt' } } }`
 * — an always-ok spy standing in for the ENTIRE API<->facilitator leg. `apps/api/test/
 * facilitator-server.test.mjs`'s "createHttpFacilitator and the handler agree on the wire, end to
 * end through gate()" drives the real `createHttpFacilitator` against the real `createSettleHandler`
 * — but in-process, with a `fetchImpl` that calls the handler function directly (no socket), a
 * canned `okFacilitator` (no real settlement logic), and a fixed garbage signature that is never
 * cryptographically checked. Neither puts both halves of the BESPOKE contract on real sockets with
 * a signature that has to actually recover. This file does that composition, within the scope
 * stated above.
 *
 * WHAT IS FAKED, and why each fake is the correct place to stop: the settling facilitator's
 * `publicClient`/`walletClient` (viem's *chain* clients — object literals with `readContract`/
 * `simulateContract`/`writeContract`, no RPC involved) stand in for an actual RPC node and a
 * broadcaster, because reaching a real chain needs a funded key and a real network, both banned
 * for this suite. Everything above that boundary — `createApi`, `createHttpFacilitator`,
 * `createSettleHandler`, `checkChallengePrice`, `createSettlingFacilitator`, `recoverPayer`
 * (real EIP-712 recovery via viem, no network call), the agent SDK's `createProtocolClient` and
 * `authorizeFromChallenge` — is the actual production module, imported and exercised for real.
 *
 * NO NETWORK, NO KEYS. The buyer's private key is generated fresh in-process
 * (`generatePrivateKey()`) and never printed or asserted on; it signs only a local EIP-712
 * struct, and the only "chain" involved is the two fake client objects above. See
 * `docs/X402-END-TO-END-SEAMS.md` for the no-network preload this suite was run under and the
 * seam findings this file's later tests pin down.
 *
 * RE-DERIVED AGAINST `feat/x402-v2-conformance` (#269), MERGED into `protocol/main` at `dded7cf7`
 * partway through this PR's review. Every claim below was re-checked by reading the merged source,
 * not carried over from a pre-merge draft — see `docs/X402-END-TO-END-SEAMS.md` for what changed
 * and why three tests that used to pin an absent fix now pin the fix itself.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { domainSeparator } from 'viem';

import { createApi } from '../../apps/api/src/server.mjs';
import { createHttpFacilitator, createSettlingFacilitator } from '../../apps/api/src/facilitator.mjs';
import {
  createSettleHandler, checkChallengePrice, startFacilitatorServer, CONSENT_ENV_VAR,
} from '../../apps/api/src/facilitator-server.mjs';
import { gate, decodeSignatureHeader, checkEnvelopeAgainstPrice, toCaip2 } from '../../apps/api/src/x402.mjs';
import { createProtocolClient, buildTypedData } from '../../packages/agent-sdk/src/index.mjs';
import { applyAll } from '../../packages/indexer/src/projections.mjs';

// ── shared fixtures ──

const CHAIN_ID = 84532; // Base Sepolia
const USDC_NAME = 'USDC'; // Base Sepolia's real name() — apps/api/src/facilitator.mjs's readUsdcDomain doc
const USDC_VERSION = '2';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const OP = '0x' + 'a'.repeat(40);
const VAULT = '0x' + '1'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const PRICE = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia' };
const DOMAIN = { name: USDC_NAME, version: USDC_VERSION, chainId: CHAIN_ID, verifyingContract: USDC };
const ON_CHAIN_SEPARATOR = domainSeparator({ domain: DOMAIN });

function seededState() {
  return applyAll([
    { name: 'VaultCreated', vault: VAULT, blockNumber: 1, logIndex: 0, args: { vault: VAULT, creator: OP, usdc: USDC, capacityCapUsdc: 1000n } },
    { name: 'OperatorRegistered', vault: VAULT, blockNumber: 1, logIndex: 1, args: { opId: 1, operator: OP } },
    { name: 'VaultAttested', vault: VAULT, blockNumber: 1, logIndex: 2, args: { vault: VAULT, opId: 1 } },
    { name: 'DepositActivated', vault: VAULT, blockNumber: 2, logIndex: 0, args: { member: OP, sharesMinted: 1000n } },
  ]);
}

/**
 * A viem wallet-client-shaped signer for `wallet.sign` (agent-sdk) — real EIP-712 signing, no
 * network. `payer.signTypedData` is viem's local account signer; it touches no RPC.
 */
const signerFor = (payer) => (typedData) =>
  payer.signTypedData({
    domain: typedData.domain,
    types: { TransferWithAuthorization: typedData.types.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization',
    message: typedData.message,
  });

/**
 * A fake chain: `publicClient`/`walletClient` shaped exactly like viem's, backing the REAL
 * `createSettlingFacilitator` (apps/api/src/facilitator.mjs). `usedNonces` is a real in-memory
 * model of EIP-3009's on-chain nonce-burn (`authorizationState`) — it starts empty and is marked
 * on a successful `writeContract`, so a genuine replay of the same authorization is refused by
 * `createSettlingFacilitator`'s own pre-flight read, independent of the API's local nonce guard.
 */
function fakeChain({ usedNonces = new Set(), failWrite = null } = {}) {
  const publicClient = {
    async readContract({ functionName, args }) {
      if (functionName === 'name') return USDC_NAME;
      if (functionName === 'version') return USDC_VERSION;
      if (functionName === 'DOMAIN_SEPARATOR') return ON_CHAIN_SEPARATOR;
      if (functionName === 'authorizationState') return usedNonces.has(args[1]);
      throw new Error(`fakeChain: unexpected readContract ${functionName}`);
    },
    async simulateContract(req) { return { request: req }; },
  };
  const account = { address: '0x' + '9'.repeat(40) };
  const walletClient = {
    account,
    async writeContract(req) {
      if (failWrite) throw failWrite;
      usedNonces.add(req.args[5]); // nonce is the 6th transferWithAuthorization arg
      return '0x' + '7'.repeat(64);
    },
  };
  return { publicClient, walletClient, account, usedNonces };
}

/** Boots the real facilitator HTTP server on an ephemeral loopback port. Real code, fake chain. */
async function bootFacilitator(chain) {
  const srv = await startFacilitatorServer({
    account: chain.account, publicClient: chain.publicClient, walletClient: chain.walletClient,
    usdcAddress: USDC, chainId: CHAIN_ID, port: 0, host: '127.0.0.1',
    env: { [CONSENT_ENV_VAR]: 'yes' }, log: () => {},
  });
  return srv;
}

/** Boots the real API on an ephemeral loopback port, wired to a real `createHttpFacilitator`. */
async function bootApi(facilitatorUrl, { state = seededState(), price = PRICE, now = () => Date.now() } = {}) {
  const facilitator = createHttpFacilitator({ url: facilitatorUrl });
  const { server } = createApi({ state, facilitator, price, now });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

// ── the real loop: unpaid -> signed -> paid -> replayed ──

test('the real loop over real sockets: unpaid -> 402, signed -> 200 + receipt, replayed -> refused at BOTH layers', async () => {
  const chain = fakeChain();
  const facSrv = await bootFacilitator(chain);
  const facPort = facSrv.server.address().port;
  const apiSrv = await bootApi(`http://127.0.0.1:${facPort}/settle`);
  const apiPort = apiSrv.address().port;

  try {
    // 1. Unpaid: a plain fetch with no PAYMENT-SIGNATURE header gets a 402 + challenge, straight
    //    from the real API (no facilitator call — verified below by the seenNonces/payments count).
    const unpaid = await fetch(`http://127.0.0.1:${apiPort}/vaults`);
    assert.equal(unpaid.status, 402);
    const challenge = JSON.parse(unpaid.headers.get('payment-required'));
    assert.equal(challenge.asset, USDC);
    assert.equal(challenge.network, 'base-sepolia');
    const unpaidBody = await unpaid.json();
    assert.equal(unpaidBody.error, 'payment required');

    // 2. Signed: a REAL buyer (fresh throwaway key, generated here, never logged) drives the real
    //    agent SDK, which signs a genuine EIP-712 authorization and retries. The signature is
    //    checked for real by `recoverPayer` (facilitator.mjs, via viem) inside the real
    //    `createSettlingFacilitator`, running inside the real facilitator HTTP process.
    const payerKey = generatePrivateKey();
    const payer = privateKeyToAccount(payerKey);
    const payments = [];
    const client = createProtocolClient({
      baseUrl: `http://127.0.0.1:${apiPort}`,
      wallet: { address: payer.address, sign: signerFor(payer) },
      domain: DOMAIN,
      onPayment: (p) => payments.push(p),
    });

    const disc = await client.discovery();
    assert.equal(disc.enabled, true, 'discovery must advertise metering is on');

    const list = await client.listVaults();
    assert.equal(list.data.vaults.length, 1);
    assert.equal(list.data.vaults[0].vault, VAULT);
    assert.match(list.receipt.receiptId, /^0x7{64}$/, 'the receipt is the fake chain\'s real writeContract return value');
    assert.equal(payments.length, 1);
    const paidNonce = payments[0].envelope.authorization.nonce;
    assert.ok(chain.usedNonces.has(paidNonce), 'the fake chain\'s own nonce-burn model must have recorded the settlement');

    // 3. Replayed through the API: the SAME signed envelope, POSTed again to the same API
    //    instance. Caught by x402.mjs's in-process `seenNonces` guard BEFORE the facilitator is
    //    ever called again — this is what an agent's naive retry actually hits.
    const b64 = Buffer.from(JSON.stringify(payments[0].envelope), 'utf8').toString('base64');
    const replay1 = await fetch(`http://127.0.0.1:${apiPort}/vaults`, { headers: { 'payment-signature': b64 } });
    assert.equal(replay1.status, 402);
    const replay1Body = await replay1.json();
    assert.match(replay1Body.error, /replayed-nonce/);

    // 4. Replayed directly at the facilitator, bypassing the API's local guard entirely — proves
    //    the facilitator's OWN defense-in-depth (the on-chain-style `authorizationState` pre-flight
    //    inside `createSettlingFacilitator`) independently refuses it too, matching
    //    facilitator-server.mjs's own stated purpose ("the facilitator is the last place that can
    //    still say no").
    const direct = await fetch(`http://127.0.0.1:${facPort}/settle`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: 2, challenge: { price: PRICE }, envelope: payments[0].envelope }),
    });
    assert.equal(direct.status, 200);
    const directBody = await direct.json();
    assert.deepEqual(directBody, { ok: false, reason: 'authorization-used' });
  } finally {
    apiSrv.close();
    await once(apiSrv, 'close');
    await facSrv.close();
  }
});

test('MAJOR-1 regression, exercised on the real wire: a CAIP-2-spelled envelope settles against a price configured in this repo\'s short-name spelling', async () => {
  // The loop test above cannot see this seam: `PRICE.network` is `'base-sepolia'` throughout, and
  // the agent SDK's `buildEnvelope` (packages/agent-sdk/src/eip3009.mjs) echoes `challenge.network`
  // verbatim, so both sides always agree by construction. To make the comparison mismatch, this
  // test rewrites the ALREADY-SIGNED envelope's `network` field to the CAIP-2 spelling for the
  // SAME chain (`eip155:84532`, via `toCaip2` — the exact function both `checkEnvelopeAgainstPrice`
  // and `checkChallengePrice` now share) before it goes on the wire. `network` is not part of the
  // signed EIP-712 struct (see `buildTypedData`: the message has no network field), so this does
  // not invalidate the signature — it only changes what the two server-side checks compare.
  //
  // This exercises the MAJOR-1 fix (`apps/api/src/facilitator-server.mjs:149`) through the actual
  // request path: `checkEnvelopeAgainstPrice` (x402.mjs) sees the mismatch first, then
  // `checkChallengePrice` sees it again over the real HTTP hop to the facilitator. Both must now
  // agree it is the same chain, or this test is red.
  const chain = fakeChain();
  const facSrv = await bootFacilitator(chain);
  const facPort = facSrv.server.address().port;
  const apiSrv = await bootApi(`http://127.0.0.1:${facPort}/settle`);
  const apiPort = apiSrv.address().port;

  try {
    const payer = privateKeyToAccount(generatePrivateKey());
    const rewriteNetworkToCaip2 = async (url, init) => {
      if (init?.headers?.['payment-signature']) {
        const env = JSON.parse(Buffer.from(init.headers['payment-signature'], 'base64').toString('utf8'));
        assert.equal(env.network, 'base-sepolia', 'precondition: the SDK signed against the repo\'s own short name');
        env.network = toCaip2(env.network);
        assert.equal(env.network, 'eip155:84532', 'precondition: toCaip2 actually changed the spelling');
        init = { ...init, headers: { ...init.headers, 'payment-signature': Buffer.from(JSON.stringify(env), 'utf8').toString('base64') } };
      }
      return fetch(url, init);
    };
    const client = createProtocolClient({
      baseUrl: `http://127.0.0.1:${apiPort}`,
      wallet: { address: payer.address, sign: signerFor(payer) },
      domain: DOMAIN,
      fetchImpl: rewriteNetworkToCaip2,
    });

    const list = await client.listVaults();
    assert.equal(list.data.vaults.length, 1);
    assert.match(list.receipt.receiptId, /^0x7{64}$/,
      'settled even though the envelope on the wire named eip155:84532 while PRICE.network is base-sepolia');
  } finally {
    apiSrv.close();
    await once(apiSrv, 'close');
    await facSrv.close();
  }
});

test('a genuine x402 v2 spec-nested payment payload (payload:{signature,authorization} under accepted/resource) settles through the real HTTP loop', async () => {
  // packages/agent-sdk's client only ever emits the legacy flat envelope (eip3009.mjs's
  // `buildEnvelope`) — nothing in this repo produces the spec-nested shape, so it is built by hand
  // here to stand in for a real x402 v2 client. `decodeSignatureHeader` (apps/api/src/x402.mjs)
  // now hoists `payload.signature`/`payload.authorization` to the top level before anything
  // downstream sees the envelope (§5.2.1/§5.2.2, merged in #269) — this proves that hoist actually
  // reaches all the way through a real settlement, not just through `decodeSignatureHeader` in
  // isolation.
  const chain = fakeChain();
  const facSrv = await bootFacilitator(chain);
  const facPort = facSrv.server.address().port;
  const apiSrv = await bootApi(`http://127.0.0.1:${facPort}/settle`);
  const apiPort = apiSrv.address().port;

  try {
    const unpaid = await fetch(`http://127.0.0.1:${apiPort}/vaults`);
    const challenge = JSON.parse(unpaid.headers.get('payment-required'));

    const payer = privateKeyToAccount(generatePrivateKey());
    const authorization = {
      from: payer.address, to: challenge.payTo, value: challenge.amount,
      validAfter: String(Math.floor(Date.now() / 1000) - 60),
      validBefore: String(Math.floor(Date.now() / 1000) + 300),
      nonce: challenge.nonce, asset: challenge.asset,
    };
    const typedData = buildTypedData({ authorization, domain: DOMAIN });
    const signature = await signerFor(payer)(typedData);

    const nestedEnvelope = {
      x402Version: 2,
      accepted: { scheme: 'exact', network: challenge.network, asset: challenge.asset, amount: challenge.amount, payTo: challenge.payTo },
      resource: { url: '/vaults' },
      payload: { signature, authorization },
    };
    const b64 = Buffer.from(JSON.stringify(nestedEnvelope), 'utf8').toString('base64');
    const paid = await fetch(`http://127.0.0.1:${apiPort}/vaults`, { headers: { 'payment-signature': b64 } });
    const body = await paid.json();
    assert.equal(paid.status, 200, `expected settlement, got ${JSON.stringify(body)}`);
    const receipt = JSON.parse(paid.headers.get('payment-response'));
    assert.match(receipt.receiptId, /^0x7{64}$/);
  } finally {
    apiSrv.close();
    await once(apiSrv, 'close');
    await facSrv.close();
  }
});

test('a facilitator that verifies the signature fine but fails to broadcast surfaces as a 402, never a crash or a false 200', async () => {
  const chain = fakeChain({ failWrite: new Error('replacement transaction underpriced') });
  const facSrv = await bootFacilitator(chain);
  const facPort = facSrv.server.address().port;
  const apiSrv = await bootApi(`http://127.0.0.1:${facPort}/settle`);
  const apiPort = apiSrv.address().port;

  try {
    const payer = privateKeyToAccount(generatePrivateKey());
    const client = createProtocolClient({
      baseUrl: `http://127.0.0.1:${apiPort}`,
      wallet: { address: payer.address, sign: signerFor(payer) },
      domain: DOMAIN,
    });
    await assert.rejects(() => client.leaderboard(), (e) => {
      assert.equal(e.status, 402);
      assert.match(e.message, /settlement failed/);
      assert.match(e.message, /settle-failed/, 'the broadcast failure reason must survive both hops (facilitator -> API -> client)');
      return true;
    });
  } finally {
    apiSrv.close();
    await once(apiSrv, 'close');
    await facSrv.close();
  }
});

test('a facilitator returning a malformed 200 (not JSON) degrades to a declined payment, not a crash', async () => {
  // A raw node:http server standing in for a badly-behaved remote facilitator — deliberately NOT
  // `createSettleHandler`, because the point is what happens when the remote does not speak the
  // wire contract at all.
  const badFacilitator = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json');
  });
  badFacilitator.listen(0, '127.0.0.1');
  await once(badFacilitator, 'listening');
  const { port: badPort } = badFacilitator.address();

  try {
    const facilitator = createHttpFacilitator({ url: `http://127.0.0.1:${badPort}/settle` });
    const verdict = await gate({
      headers: {}, price: PRICE, facilitator, nowMs: 1_000_000,
    });
    // No signature was posted, so this is just the free 402 path — confirms wiring, not the bug.
    assert.equal(verdict.status, 402);

    // Post directly at the facilitator client to see the malformed-response path for real.
    const direct = await facilitator.verifyAndSettle({ price: PRICE }, { authorization: { nonce: '0x' + 'b'.repeat(64) } });
    assert.equal(direct.ok, false);
    assert.equal(direct.reason, undefined,
      'createHttpFacilitator (facilitator.mjs) has no branch for "200 but unparseable": ' +
      '`res.json().catch(() => ({}))` silently becomes `{}`, so `!!body.ok` is false and `reason` ' +
      'is `undefined` — a malformed facilitator response is indistinguishable, to the API and to ' +
      'the payer, from a facilitator that understood the request and declined it with no reason.');
  } finally {
    badFacilitator.close();
    await once(badFacilitator, 'close');
  }
});

// ── regression: the MAJOR-1 fix (networksEqual), both sides, both directions ──
//
// These three tests used to be characterization tests pinned to a pre-#269 world: they asserted
// the DEFECT'S ABSENCE OF A FIX, so a reviewer who reverted `facilitator-server.mjs`'s
// `networksEqual` call back to a bare string compare — reintroducing the exact defect this PR
// exists to catch — got a GREENER suite, not a redder one. That is now inverted: every test below
// pins the FIX, with both a positive case (genuinely-equivalent spellings must be accepted) and a
// negative case (genuinely-different chains must still be refused), so reverting the fix in either
// direction turns one of these red.

test('decodeSignatureHeader (apps/api/src/x402.mjs) now hoists a spec-nested payload to the flat shape everything downstream reads', () => {
  const nested = {
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:84532', asset: USDC, amount: '10000', payTo: PAYTO },
    payload: {
      signature: '0x' + 'b'.repeat(130),
      authorization: { from: '0x' + '1'.repeat(40), to: PAYTO, value: '10000', validAfter: '0', validBefore: '999999999999', nonce: '0x' + 'a'.repeat(64) },
    },
  };
  const header = Buffer.from(JSON.stringify(nested), 'utf8').toString('base64');
  const decoded = decodeSignatureHeader(header);
  assert.notEqual(decoded, null, 'a spec-nested envelope must decode, not silently degrade to "unpaid"');
  assert.equal(decoded.signature, nested.payload.signature);
  assert.equal(decoded.authorization.from, nested.payload.authorization.from);
  assert.equal(decoded.authorization.asset, USDC, 'asset is backfilled from accepted.asset (the spec Authorization object has no asset field)');
  assert.equal(decoded.network, 'eip155:84532', 'network is hoisted from accepted.network when the envelope has none of its own');
});

test('checkChallengePrice (facilitator-server.mjs:149, the MAJOR-1 fix): accepts a CAIP-2/short-name pair naming the SAME chain, still refuses a genuinely different one', () => {
  // eip155:84532 (spec CAIP-2, docs/RESEARCH-SPRINT1.md:37-38) and base-sepolia (this repo's own
  // PRICE_NETWORK spelling) name the SAME chain — accepted, in both argument orders.
  const same1 = checkChallengePrice(
    { price: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia' } },
    { authorization: { to: PAYTO, asset: USDC, value: '10000' }, network: 'eip155:84532' },
  );
  assert.deepEqual(same1, { ok: true });
  const same2 = checkChallengePrice(
    { price: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'eip155:84532' } },
    { authorization: { to: PAYTO, asset: USDC, value: '10000' }, network: 'base-sepolia' },
  );
  assert.deepEqual(same2, { ok: true });

  // eip155:8453 is Base MAINNET — a genuinely different chain than base-sepolia. The fix is an
  // equivalence check, not a bypass: this must still be refused.
  const different = checkChallengePrice(
    { price: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia' } },
    { authorization: { to: PAYTO, asset: USDC, value: '10000' }, network: 'eip155:8453' },
  );
  assert.deepEqual(different, { ok: false, reason: 'network-mismatch' });
});

test('checkEnvelopeAgainstPrice (x402.mjs) and checkChallengePrice (facilitator-server.mjs) now AGREE on every case, using the same networksEqual', () => {
  // The two checks import and call the identical function (apps/api/src/x402.mjs's toCaip2/
  // networksEqual, imported by facilitator-server.mjs:56) rather than each hand-rolling its own —
  // that is what #269's own review comment on `toCaip2` says this must hold, and it is what stops
  // this specific defect from recurring by a future edit to only one side.
  const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia' };
  const envSameChain = {
    x402Version: 2, scheme: 'exact', network: 'eip155:84532', signature: '0x' + 'b'.repeat(130),
    authorization: { from: '0x' + '1'.repeat(40), to: PAYTO, asset: USDC, value: '10000', validBefore: '999999999999' },
  };
  assert.deepEqual(checkEnvelopeAgainstPrice(price, envSameChain, 1_000_000), { ok: true });
  assert.deepEqual(
    checkChallengePrice({ price }, envSameChain),
    { ok: true },
    'the facilitator-side re-check must reach the same verdict as the API-side gate for the same pair',
  );

  const envDifferentChain = { ...envSameChain, network: 'eip155:8453' };
  const local = checkEnvelopeAgainstPrice(price, envDifferentChain, 1_000_000);
  const remote = checkChallengePrice({ price }, envDifferentChain);
  assert.deepEqual(local, { ok: false, reason: 'network-mismatch' });
  assert.deepEqual(remote, { ok: false, reason: 'network-mismatch' });
});
