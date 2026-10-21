// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi } from 'viem';
import { createUserOpWalletClient, stripUrls } from '../src/index.mjs';

const SMART = '0x' + '5'.repeat(40);
const TARGET = '0x' + '7'.repeat(40);
const ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const ARGS = ['0x' + '9'.repeat(40), 1_000_000n];
const TX = '0x' + 'a'.repeat(64);
const OP_HASH = '0x' + 'b'.repeat(64);
const CEILING = 100n * 10n ** 9n;

/** A bundler stub recording every call; nothing touches a network. */
function stubs({ maxFeePerGas = CEILING, success = true, sendError = null } = {}) {
  const calls = { prepare: [], send: [], wait: [], sign: [] };
  const bundlerClient = {
    async prepareUserOperation(p) { calls.prepare.push(p); return { account: p.account, sender: SMART, callData: '0xc0de', maxFeePerGas, maxPriorityFeePerGas: 1n }; },
    async sendUserOperation(p) { calls.send.push(p); if (sendError) throw sendError; return OP_HASH; },
    async waitForUserOperationReceipt(p) { calls.wait.push(p); return { success, receipt: { transactionHash: TX } }; },
  };
  const smartAccount = {
    address: SMART,
    entryPoint: { address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', version: '0.7' },
    async signUserOperation(op) { calls.sign.push(op); return '0x5199'; },
  };
  return { calls, bundlerClient, smartAccount };
}

const req = (account = { address: SMART }) => ({ address: TARGET, abi: ABI, functionName: 'approve', args: ARGS, account, chain: null });

test('sends one UserOp with the encoded call, signed as checked, and returns the mined tx hash', async () => {
  const { calls, bundlerClient, smartAccount } = stubs();
  const w = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: CEILING });
  assert.equal(await w.writeContract(req()), TX);
  assert.deepEqual(calls.prepare[0].calls, [{ to: TARGET, data: encodeFunctionData({ abi: ABI, functionName: 'approve', args: ARGS }) }]);
  assert.equal(calls.prepare[0].account, smartAccount);
  assert.equal(calls.send[0].signature, '0x5199');
  assert.equal(calls.send[0].entryPointAddress, smartAccount.entryPoint.address);
  assert.equal(calls.send[0].maxFeePerGas, CEILING);
  assert.equal('account' in calls.send[0], false, 'sent with a signature and no account, so viem does not re-prepare it');
  assert.deepEqual(calls.wait, [{ hash: OP_HASH }]);
});

test('the account check is case-insensitive and accepts a bare address', async () => {
  const { bundlerClient, smartAccount } = stubs();
  smartAccount.address = '0x' + 'aB'.repeat(20);
  const w = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: CEILING });
  assert.equal(await w.writeContract(req(smartAccount.address.toLowerCase())), TX);
});

test('refuses a write for any other account, before anything is prepared', async () => {
  const { calls, bundlerClient, smartAccount } = stubs();
  const w = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: CEILING });
  await assert.rejects(w.writeContract(req({ address: '0x' + '6'.repeat(40) })), /refused: the write is for/);
  await assert.rejects(w.writeContract(req(/** @type {any} */ (null))), /no account/);
  assert.equal(calls.prepare.length, 0);
});

test('refuses a UserOp priced above the ceiling, unsigned and unsent', async () => {
  const { calls, bundlerClient, smartAccount } = stubs({ maxFeePerGas: CEILING + 1n });
  const w = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: CEILING });
  await assert.rejects(w.writeContract(req()), /above the ceiling/);
  assert.equal(calls.sign.length, 0);
  assert.equal(calls.send.length, 0);
});

test('a reverted UserOp throws instead of returning a hash', async () => {
  const { bundlerClient, smartAccount } = stubs({ success: false });
  const w = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: CEILING });
  await assert.rejects(w.writeContract(req()), /reverted/);
});

test('bundler errors come back without the URL path that carries the API key', async () => {
  const err = Object.assign(new Error('HTTP request failed.\nURL: https://base-mainnet.g.alchemy.com/v2/SECRETKEY123?x=1\nStatus: 500'), {
    shortMessage: 'HTTP request failed at https://base-mainnet.g.alchemy.com/v2/SECRETKEY123',
    cause: new Error('https://base-mainnet.g.alchemy.com/v2/SECRETKEY123'),
  });
  const { bundlerClient, smartAccount } = stubs({ sendError: err });
  const w = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: CEILING });
  const thrown = await w.writeContract(req()).then(() => null, (e) => e);
  assert.ok(thrown);
  assert.doesNotMatch(JSON.stringify({ m: thrown.message, s: thrown.shortMessage, c: String(thrown.cause ?? '') }), /SECRETKEY123/);
  assert.match(thrown.message, /https:\/\/base-mainnet\.g\.alchemy\.com/);
});

test('stripUrls keeps scheme and host only (trailing punctuation goes with the path)', () => {
  assert.equal(stripUrls('at https://x.g.alchemy.com/v2/K?q=1#f, then http://h:8545/p.'), 'at https://x.g.alchemy.com then http://h:8545');
  assert.equal(stripUrls('URL: https://rpc.example/K\nStatus: 500'), 'URL: https://rpc.example\nStatus: 500');
});

test('exposes writeContract only: no signing method, so no ERC-1271 signature for USDC', () => {
  const { bundlerClient, smartAccount } = stubs();
  const w = createUserOpWalletClient({ bundlerClient, smartAccount, maxFeePerGasCeiling: CEILING });
  assert.deepEqual(Object.keys(w), ['writeContract']);
});

test('construction refuses a missing ceiling, a missing entry point and a bad account', () => {
  const { bundlerClient, smartAccount } = stubs();
  assert.throws(() => createUserOpWalletClient(/** @type {any} */ ({ bundlerClient, smartAccount })), /maxFeePerGasCeiling/);
  assert.throws(() => createUserOpWalletClient(/** @type {any} */ ({ bundlerClient, smartAccount, maxFeePerGasCeiling: 1 })), /maxFeePerGasCeiling/);
  assert.throws(() => createUserOpWalletClient(/** @type {any} */ ({ bundlerClient, smartAccount: { ...smartAccount, entryPoint: undefined }, maxFeePerGasCeiling: CEILING })), /entry point/);
  assert.throws(() => createUserOpWalletClient(/** @type {any} */ ({ bundlerClient, smartAccount: { ...smartAccount, address: '0x12' }, maxFeePerGasCeiling: CEILING })), /address/);
});
