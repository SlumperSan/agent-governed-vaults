// @ts-check
/**
 * Tests for the live runner's pure surface: the startup gate, the spend caps, and the guard that
 * stands between the transcript and the repo.
 *
 * The runner's chain path is exercised for real against an Anvil fork of Base Sepolia (see
 * docs/X402-LIVE-REPORT.md §"Rehearsal"); what is unit-tested here is everything that must fail
 * BEFORE a transaction is ever built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunConfig, assertNoSecrets, bindChain } from '../live-x402-run.mjs';
import { CONSENT_ENV_VAR } from '../../apps/api/src/facilitator-server.mjs';

const ENV = {
  [CONSENT_ENV_VAR]: 'yes',
  SETTLER_KEYSTORE: '/keys/deployer',
  SETTLER_KEYSTORE_PASSWORD: 'pw',
};

test('resolveRunConfig accepts a complete environment and applies sane defaults', () => {
  const cfg = resolveRunConfig({ env: ENV, args: {} });
  assert.equal(cfg.price, 10_000n, 'default price is $0.01 in USDC base units');
  assert.equal(cfg.fund, 50_000n);
  assert.equal(cfg.network, 'base-sepolia');
  assert.equal(cfg.usdcAddress, '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  assert.equal(cfg.usdcAddressExplicit, false, 'the default address was not requested by the operator');
  assert.match(cfg.rpcUrl, /^https:\/\//);
});

test('resolveRunConfig records USDC_ADDRESS as explicit when the operator sets it', () => {
  const cfg = resolveRunConfig({ env: { ...ENV, USDC_ADDRESS: '0x' + '9'.repeat(40) }, args: {} });
  assert.equal(cfg.usdcAddressExplicit, true);
});

test('resolveRunConfig refuses to start without consent or a keystore, listing every problem', () => {
  try {
    resolveRunConfig({ env: {}, args: {} });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message, new RegExp(CONSENT_ENV_VAR));
    assert.match(err.message, /SETTLER_KEYSTORE .*is not set/);
    assert.match(err.message, /SETTLER_KEYSTORE_PASSWORD is not set/);
  }
  assert.throws(() => resolveRunConfig({ env: { ...ENV, [CONSENT_ENV_VAR]: undefined }, args: {} }), /not set to "yes"/);
});

test('resolveRunConfig refuses a raw private key in the environment outright', () => {
  // The whole point of the keystore path: a key in env is one leaked shell history from a drain.
  assert.throws(
    () => resolveRunConfig({ env: { ...ENV, SETTLER_PRIVATE_KEY: '0x' + 'f'.repeat(64) }, args: {} }),
    /refusing to run with a raw private key/,
  );
  assert.throws(
    () => resolveRunConfig({ env: { ...ENV, PAYER_PRIVATE_KEY: '0x' + 'f'.repeat(64) }, args: {} }),
    /refusing to run with a raw private key/,
  );
});

test('spend caps bound the run to pocket change', () => {
  assert.throws(() => resolveRunConfig({ env: ENV, args: { price: '5' } }), /exceeds the 0.1 USDC cap/);
  assert.throws(() => resolveRunConfig({ env: ENV, args: { fund: '10' } }), /exceeds the 1 USDC cap/);
  assert.throws(() => resolveRunConfig({ env: ENV, args: { price: '0' } }), /--price must be positive/);
  assert.throws(() => resolveRunConfig({ env: ENV, args: { fund: '0.005', price: '0.01' } }), /less than --price/);
  assert.equal(resolveRunConfig({ env: ENV, args: { price: '0.1', fund: '1' } }).price, 100_000n, 'the cap itself is allowed');
});

test('USDC amounts are parsed exactly — no floats, no more than 6 decimals', () => {
  assert.equal(resolveRunConfig({ env: ENV, args: { price: '0.000001' } }).price, 1n);
  assert.throws(() => resolveRunConfig({ env: ENV, args: { price: '0.0000001' } }), /at most 6 decimals/);
  assert.throws(() => resolveRunConfig({ env: ENV, args: { price: '1e-2' } }), /at most 6 decimals/);
  assert.throws(() => resolveRunConfig({ env: ENV, args: { price: '-0.01' } }), /at most 6 decimals/);
});

// ── the transcript guard ──

test('assertNoSecrets passes a transcript of plain evidence', () => {
  assertNoSecrets({
    accounts: { settler: '0x' + '1'.repeat(40), payer: '0x' + '2'.repeat(40) },
    paidRead: { receiptId: '0x' + 'a'.repeat(64), envelope: { signature: '0x' + 'b'.repeat(130) } },
    balances: [{ label: 'before', payerUsdc: '50000' }],
  });
});

test('assertNoSecrets refuses an account object anywhere in the tree', () => {
  const account = { address: '0x' + '1'.repeat(40), signTypedData: () => {} };
  assert.throws(() => assertNoSecrets({ deep: { nested: [account] } }), /looks like an account object/);
});

test('assertNoSecrets refuses secret-shaped field names', () => {
  assert.throws(() => assertNoSecrets({ cfg: { password: 'hunter2' } }), /secret-shaped field name/);
  assert.throws(() => assertNoSecrets({ privateKey: null }), /secret-shaped field name/);
  assert.throws(() => assertNoSecrets({ wallet: { mnemonic: 'a b c' } }), /secret-shaped field name/);
});

test('assertNoSecrets keeps tx hashes and nonces — redact() would have eaten them', () => {
  // Deliberate contrast with keystore.redact(): a 32-byte hex string is key-shaped, so a blanket
  // redact would strip exactly the settlement tx hash and authorization nonce this run exists to
  // produce. The guard checks capability, not shape.
  const t = { txHash: '0x' + 'c'.repeat(64), nonce: '0x' + 'd'.repeat(64) };
  assertNoSecrets(t);
  assert.equal(JSON.parse(JSON.stringify(t)).txHash, '0x' + 'c'.repeat(64));
});

// ── the chain-binding gate (issue #204) ──
//
// `USDC_ADDRESS` defaults to Base Sepolia's USDC and `RPC_URL` defaults to a Base Sepolia RPC, but
// the two resolve independently — point RPC_URL at a different testnet chain id and leave
// USDC_ADDRESS unset, and this runner would read Base Sepolia's USDC contract on a chain it does
// not exist on. `bindChain` closes that: it takes a `publicClient` object that only needs
// `getChainId()`, so this is testable with a fake in-memory client — no real RPC, no `viem`
// transport, no network.

const fakeClient = (chainIdOrThrow) => ({
  getChainId: async () => {
    if (chainIdOrThrow instanceof Error) throw chainIdOrThrow;
    return chainIdOrThrow;
  },
});

test('bindChain: the real chain (84532) with the default USDC address proceeds', async () => {
  const cfg = resolveRunConfig({ env: ENV, args: {} });
  const chainId = await bindChain({ publicClient: fakeClient(84532), cfg });
  assert.equal(chainId, 84532);
});

test('bindChain: a different TESTNET chain with the default USDC address REFUSES', async () => {
  // 31337 is in TESTNET_CHAIN_IDS (a plain local anvil), so the testnet allowlist alone would let
  // this through — which is exactly the gap #204 is about: the allowlist checks the chain is SOME
  // testnet, not that it is the one the default USDC_ADDRESS was written for.
  const cfg = resolveRunConfig({ env: ENV, args: {} });
  assert.equal(cfg.usdcAddressExplicit, false, 'precondition: the default address, not an override');
  await assert.rejects(
    bindChain({ publicClient: fakeClient(31337), cfg }),
    /WRONG CHAIN.*84532|84532.*WRONG CHAIN|WRONG CHAIN/,
  );
});

test('bindChain: a different chain is fine once USDC_ADDRESS is set explicitly', async () => {
  const cfg = resolveRunConfig({ env: { ...ENV, USDC_ADDRESS: '0x' + '9'.repeat(40) }, args: {} });
  const chainId = await bindChain({ publicClient: fakeClient(31337), cfg });
  assert.equal(chainId, 31337, 'an explicit USDC_ADDRESS means there is no default-chain assumption to bind');
});

test('bindChain: a non-testnet chain refuses regardless of USDC_ADDRESS', async () => {
  const cfg = resolveRunConfig({ env: { ...ENV, USDC_ADDRESS: '0x' + '9'.repeat(40) }, args: {} });
  await assert.rejects(bindChain({ publicClient: fakeClient(8453), cfg }), /testnet only/);
});

test('bindChain: an unreadable chain id REFUSES as UNPROVEN, not as a pass', async () => {
  const cfg = resolveRunConfig({ env: ENV, args: {} });
  await assert.rejects(
    bindChain({ publicClient: fakeClient(new Error('fetch failed')), cfg }),
    /UNPROVEN/,
  );
});
