// @ts-check
/**
 * ERC-1271 (deployed smart account) and ERC-6492 (counterfactual) payer signatures in the x402
 * facilitator. The RPC is a stub transport: no network. viem's own verifyTypedData runs on top of
 * it, so what is under test is this module's acceptance decision, not a reimplementation of viem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicClient, custom, serializeErc6492Signature } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildTypedData } from '../../../packages/agent-sdk/src/eip3009.mjs';
import { recoverPayer, verifyEnvelopeShape, createSettlingFacilitator } from '../src/facilitator.mjs';

const USDC = '0x' + 'c'.repeat(40);
const SMART = '0x' + '5'.repeat(40); // the smart account (payer)
const FACTORY = '0x' + '7'.repeat(40);
const TO = '0x' + '2'.repeat(40);
const NONCE = '0x' + 'a'.repeat(64);
const CHAIN = 8453;
const SMART_SIG = '0x' + 'ab'.repeat(97); // 97 bytes: not ECDSA-shaped, account-defined
const cfg = (publicClient) => ({ chainId: CHAIN, usdcAddress: USDC, publicClient });

const auth = (from = SMART) => ({ from, to: TO, value: '10000', validAfter: '100', validBefore: '999999999999', nonce: NONCE, asset: USDC });
const env = (signature, from) => ({ x402Version: 2, scheme: 'exact', network: 'base', signature, authorization: auth(from) });

/** A public client over a stub transport. `ethCall` answers every eth_call and records its params. */
function stubClient(ethCall) {
  const calls = [];
  const client = createPublicClient({
    transport: custom({
      async request({ method, params }) {
        calls.push({ method, params });
        if (method === 'eth_call') return ethCall(params[0]);
        if (method === 'eth_chainId') return '0x2105';
        throw new Error(`unexpected rpc ${method}`);
      },
    }),
  });
  return { client, calls };
}
const TRUE = '0x' + '0'.repeat(63) + '1';
const FALSE = '0x' + '0'.repeat(64);

// ── shape ──

test('shape accepts 65-byte and longer even-length hex, refuses short, odd or non-hex signatures', () => {
  assert.deepEqual(verifyEnvelopeShape(env('0x' + 'b'.repeat(130)), 1000), { ok: true });
  assert.deepEqual(verifyEnvelopeShape(env(SMART_SIG), 1000), { ok: true });
  for (const bad of ['0x1234', '0x' + 'b'.repeat(131), '0x' + 'zz'.repeat(70), '0x' + 'ab'.repeat(8193)])
    assert.equal(verifyEnvelopeShape(env(bad), 1000).reason, 'bad-signature-format', bad.slice(0, 12));
});

// ── ERC-1271 ──

test('1271: a signature the account validates is accepted, and the account is the one asked', async () => {
  const { client, calls } = stubClient(() => TRUE);
  const r = await recoverPayer(env(SMART_SIG), cfg(client));
  assert.deepEqual(r, { ok: true, payer: SMART, smart: true });
  const call = calls.find((c) => c.method === 'eth_call');
  assert.ok(call, 'verification must go to the chain');
  assert.ok(JSON.stringify(call.params).toLowerCase().includes(SMART.slice(2)), 'eth_call must name the payer account');
});

test('1271: a signature the account rejects is refused', async () => {
  const { client } = stubClient(() => FALSE);
  const r = await recoverPayer(env(SMART_SIG), cfg(client));
  assert.deepEqual(r, { ok: false, reason: 'smart-account-signature-invalid' });
});

test('1271: the account reverting is a refusal, not an acceptance', async () => {
  const { client } = stubClient(() => { throw Object.assign(new Error('execution reverted'), { code: 3 }); });
  const r = await recoverPayer(env(SMART_SIG), cfg(client));
  assert.equal(r.ok, false);
});

test('1271: no RPC configured refuses a non-ECDSA signature, naming why', async () => {
  assert.deepEqual(await recoverPayer(env(SMART_SIG), cfg(undefined)), { ok: false, reason: 'smart-account-needs-rpc' });
});

test('1271: an RPC outage is a refusal, never an acceptance', async () => {
  const client = createPublicClient({ transport: custom({ async request() { throw new Error('socket hang up'); } }) });
  const r = await recoverPayer(env(SMART_SIG), cfg(client));
  assert.equal(r.ok, false); // viem reads a failed eth_call as an invalid signature
});

// ── ERC-6492 ──

const wrapped6492 = () => serializeErc6492Signature({ address: FACTORY, data: '0xdeadbeef', signature: SMART_SIG });

test('6492: a counterfactual signature is validated through the universal validator and accepted', async () => {
  const { client, calls } = stubClient(() => TRUE);
  const sig = wrapped6492();
  const r = await recoverPayer(env(sig), cfg(client));
  assert.deepEqual(r, { ok: true, payer: SMART, smart: true });
  const data = calls.find((c) => c.method === 'eth_call').params[0].data.toLowerCase();
  assert.ok(data.includes(sig.slice(2).toLowerCase()), 'the wrapped signature must reach the validator');
});

test('6492: a counterfactual signature the validator rejects is refused', async () => {
  const { client } = stubClient(() => FALSE);
  assert.deepEqual(await recoverPayer(env(wrapped6492()), cfg(client)), { ok: false, reason: 'smart-account-signature-invalid' });
});

// ── ECDSA is unchanged ──

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'; // well-known test key
async function ecdsaEnvelope(value = '10000') {
  const account = privateKeyToAccount(KEY);
  const a = { ...auth(account.address), value };
  const td = buildTypedData({ authorization: a, domain: { name: 'USD Coin', version: '2', chainId: CHAIN, verifyingContract: USDC } });
  const signature = await account.signTypedData({
    domain: td.domain, types: { TransferWithAuthorization: td.types.TransferWithAuthorization },
    primaryType: 'TransferWithAuthorization', message: td.message,
  });
  return { account, envelope: { x402Version: 2, authorization: auth(account.address), signature } };
}

test('ECDSA: a valid 65-byte signature is accepted with no RPC call at all', async () => {
  const { envelope } = await ecdsaEnvelope();
  const { client, calls } = stubClient(() => TRUE);
  const r = await recoverPayer(envelope, cfg(client));
  assert.equal(r.ok, true);
  assert.equal(r.smart, undefined);
  assert.equal(calls.length, 0);
});

test('ECDSA: a 65-byte signature by a stranger is refused when the chain says no, keeping signer-mismatch', async () => {
  const { envelope } = await ecdsaEnvelope();
  const tampered = { ...envelope, authorization: { ...envelope.authorization, value: '99999' } };
  const { client } = stubClient(() => FALSE);
  const r = await recoverPayer(tampered, cfg(client));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'signer-mismatch');
  // and with no publicClient the answer is exactly what it was before this change
  assert.equal((await recoverPayer(tampered, cfg(undefined))).reason, 'signer-mismatch');
});

test('a 65-byte signature from a smart account (recovers to a stranger) is accepted when the chain validates it', async () => {
  const { envelope } = await ecdsaEnvelope();
  const asSmart = { ...envelope, authorization: { ...envelope.authorization, from: SMART } };
  const { client } = stubClient(() => TRUE);
  assert.deepEqual(await recoverPayer(asSmart, cfg(client)), { ok: true, payer: SMART, smart: true });
});

test('a 65-byte signature that is not ECDSA-recoverable (r=0, s=0, v=0x1b) is checked on chain and accepted when validated', async () => {
  const probe = '0x' + '00'.repeat(64) + '1b';
  const { client, calls } = stubClient(() => TRUE);
  assert.deepEqual(await recoverPayer(env(probe), cfg(client)), { ok: true, payer: SMART, smart: true });
  assert.ok(calls.some((c) => c.method === 'eth_call'), 'must fall through to the chain');
  assert.equal((await recoverPayer(env(probe), cfg(undefined))).reason, 'smart-account-needs-rpc');
});

test('a publicClient whose verifyTypedData throws is a refusal, never an acceptance', async () => {
  const publicClient = { verifyTypedData: async () => { throw new Error('boom'); } };
  const r = await recoverPayer(env(SMART_SIG), cfg(publicClient));
  assert.deepEqual(r, { ok: false, reason: 'smart-account-verify-failed: boom' });
});

// ── settlement ──

function settler({ valid = true, code = '0x6000' } = {}) {
  const seen = { simulate: [], verify: 0 };
  const publicClient = {
    verifyTypedData: async () => { seen.verify++; return valid; },
    getCode: async () => code,
    readContract: async () => false,
    simulateContract: async (req) => { seen.simulate.push(req); return { request: req }; },
  };
  const walletClient = { account: { address: '0x' + '9'.repeat(40) }, writeContract: async () => '0xhash' };
  return { seen, facilitator: createSettlingFacilitator({ publicClient, walletClient, usdcAddress: USDC, chainId: CHAIN }) };
}

test('settle: a 1271 payer goes through the bytes-signature overload with the signature intact', async () => {
  const { seen, facilitator } = settler();
  const r = await facilitator.verifyAndSettle({}, env(SMART_SIG));
  assert.deepEqual(r, { ok: true, receiptId: '0xhash' });
  const args = seen.simulate[0].args;
  assert.equal(args.length, 7);
  assert.equal(args[6], SMART_SIG);
  assert.ok(seen.simulate[0].abi[0].inputs.some((i) => i.name === 'signature' && i.type === 'bytes'));
});

test('settle: a 6492 payer that is already deployed settles with the unwrapped inner signature', async () => {
  const { seen, facilitator } = settler();
  const r = await facilitator.verifyAndSettle({}, env(wrapped6492()));
  assert.equal(r.ok, true);
  assert.equal(seen.simulate[0].args[6].toLowerCase(), SMART_SIG);
});

test('settle: a 6492 payer that is not deployed is refused, not settled', async () => {
  const { seen, facilitator } = settler({ code: null });
  const r = await facilitator.verifyAndSettle({}, env(wrapped6492()));
  assert.deepEqual(r, { ok: false, reason: 'counterfactual-account-not-deployed' });
  assert.equal(seen.simulate.length, 0);
});

test('settle: an invalid smart-account signature never reaches simulate or send', async () => {
  const { seen, facilitator } = settler({ valid: false });
  const r = await facilitator.verifyAndSettle({}, env(SMART_SIG));
  assert.equal(r.ok, false);
  assert.equal(seen.simulate.length, 0);
});

test('settle: ECDSA still uses the (v,r,s) overload and never asks the chain to verify', async () => {
  const { envelope } = await ecdsaEnvelope();
  const { seen, facilitator } = settler();
  const r = await facilitator.verifyAndSettle({}, envelope);
  assert.equal(r.ok, true);
  assert.equal(seen.verify, 0);
  assert.equal(seen.simulate[0].args.length, 9);
});
