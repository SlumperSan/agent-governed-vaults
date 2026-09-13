// @ts-check
/**
 * The whole x402 loop, in one process, over real sockets, with no stub anywhere on the money path.
 *
 * WHY THIS FILE EXISTS. `apps/api/test/integration.test.mjs`'s "agent SDK drives the live HTTP
 * server through the x402 loop end to end" test is real for the client<->API leg, but its
 * `facilitator` is `{ async verifyAndSettle() { return { ok: true, receiptId: 'wire_rcpt' } } }`
 * — an always-ok spy standing in for the ENTIRE API<->facilitator leg. `apps/api/test/
 * facilitator-server.test.mjs`'s "createHttpFacilitator and the handler agree on the wire, end to
 * end through gate()" drives the real `createHttpFacilitator` against the real `createSettleHandler`
 * — but in-process, with a `fetchImpl` that calls the handler function directly (no socket), a
 * canned `okFacilitator` (no real settlement logic), and a fixed garbage signature that is never
 * cryptographically checked. Nothing in the repository, as of this writing, boots the real API
 * (`server.mjs`'s `createApi`) AND the real bespoke facilitator process (`facilitator-server.mjs`'s
 * `startFacilitatorServer`) as two independent `node:http` servers on two real loopback ports,
 * and drives them with a real buyer (`packages/agent-sdk`) holding a real, freshly generated
 * EIP-712 signing key. This file is that composition.
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
import { gate, decodeSignatureHeader, checkEnvelopeAgainstPrice } from '../../apps/api/src/x402.mjs';
import { createProtocolClient } from '../../packages/agent-sdk/src/index.mjs';
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

// ── seam: the two envelope shapes ──

test('CHARACTERIZATION (protocol/main today): a spec-nested payment payload is not decoded at all — the client just sees another 402', () => {
  // The real x402 v2 spec nests the EIP-3009 payload as `payload:{signature,authorization}` under
  // a top-level `accepted`/`resource` (confirmed by reading the diff of the OPEN #269
  // `feat/x402-v2-conformance` PR against `apps/api/src/x402.mjs`, which teaches
  // `decodeSignatureHeader` to unwrap exactly this shape — it does not exist on `protocol/main`
  // yet). `decodeSignatureHeader` on `protocol/main` recognizes only a top-level
  // `{signature, authorization}` (`evmShape`) or the SVM shape (`svmShape`); a spec-nested envelope
  // satisfies neither.
  const nested = {
    x402Version: 2,
    accepted: { scheme: 'exact', network: 'eip155:84532', asset: USDC, amount: '10000', payTo: PAYTO },
    payload: {
      signature: '0x' + 'b'.repeat(130),
      authorization: { from: '0x' + '1'.repeat(40), to: PAYTO, value: '10000', validAfter: '0', validBefore: '999999999999', nonce: '0x' + 'a'.repeat(64) },
    },
  };
  const header = Buffer.from(JSON.stringify(nested), 'utf8').toString('base64');
  assert.equal(decodeSignatureHeader(header), null,
    'decodeSignatureHeader (apps/api/src/x402.mjs) returns null for a spec-nested envelope today; ' +
    'gate() then treats the request as simply unpaid and issues a fresh 402 with the generic ' +
    '"payment required" body — never a diagnosable reason, and never a crash.');
});

test('SEAM (present-day, present-code): checkChallengePrice does not know a CAIP-2 id and this repo\'s short network name can be the same chain', () => {
  // `eip155:84532` (spec CAIP-2, docs/RESEARCH-SPRINT1.md:37-38) and `base-sepolia` (this repo's
  // own PRICE_NETWORK spelling, apps/api/src/serve.mjs default is `base` / soak default is
  // `base-sepolia`) name the SAME chain. `checkChallengePrice`
  // (`apps/api/src/facilitator-server.mjs:137`) compares `envelope.network` to `price.network` by
  // exact lowercase string equality and has no notion of that equivalence.
  const challenge = { price: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia' } };
  const envelope = { authorization: { to: PAYTO, asset: USDC, value: '10000' }, network: 'eip155:84532' };
  assert.deepEqual(checkChallengePrice(challenge, envelope), { ok: false, reason: 'network-mismatch' });
  // Symmetric in the other spelling direction too.
  const challenge2 = { price: { asset: USDC, amount: '10000', payTo: PAYTO, network: 'eip155:84532' } };
  const envelope2 = { authorization: { to: PAYTO, asset: USDC, value: '10000' }, network: 'base-sepolia' };
  assert.deepEqual(checkChallengePrice(challenge2, envelope2), { ok: false, reason: 'network-mismatch' });
});

test('on protocol/main today, x402.mjs\'s OWN local check rejects the identical CAIP-2/short-name pair the same way — no asymmetry exists YET', () => {
  // This is the other half of the seam above: as of this commit, `checkEnvelopeAgainstPrice`
  // (apps/api/src/x402.mjs) and `checkChallengePrice` (apps/api/src/facilitator-server.mjs) are
  // SYMMETRIC — both do a bare `.toLowerCase()` compare, so a client presenting `eip155:84532`
  // against a `base-sepolia` price is rejected at the FIRST gate, and the facilitator is never
  // reached. See docs/X402-END-TO-END-SEAMS.md for why this stops being true the moment
  // `feat/x402-v2-conformance` (#269) merges without a matching change to facilitator-server.mjs.
  const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base-sepolia' };
  const env = {
    x402Version: 2, scheme: 'exact', network: 'eip155:84532', signature: '0x' + 'b'.repeat(130),
    authorization: { from: '0x' + '1'.repeat(40), to: PAYTO, asset: USDC, value: '10000', validBefore: '999999999999' },
  };
  assert.deepEqual(checkEnvelopeAgainstPrice(price, env, 1_000_000), { ok: false, reason: 'network-mismatch' });
});
