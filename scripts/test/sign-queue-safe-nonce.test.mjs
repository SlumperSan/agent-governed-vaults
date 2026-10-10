// @ts-check
/**
 * The Safe-nonce gate on the Safe-routed Sign-queue items (Security V-381-r2).
 *
 * The first-vault items execute through the creator Safe with a PRE-VALIDATED owner signature,
 * which authorises by `msg.sender == owner` and does not bind the Safe nonce. So nothing on chain
 * stops the same `execTransaction(createVault)` from running twice, and a second run creates an
 * orphan duplicate vault. Each item is built for one Safe nonce. Once the live nonce has moved past
 * it, the item must never be signable again. These tests drive `safeRoutedRefusal` against a stub
 * RPC in which every other precondition passes, so the nonce is the only thing that varies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { safeRoutedRefusal } from '../lib/sign-queue-preconditions.mjs';

const SAFE = '0x99e805294F1f1465C96f68e36264E99991Ef9E82';
const OWNER = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';
const FACTORY = '0x692385262C05df7515560886f167c4eDD0814025';
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const addrWord = (a) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');

/** Stub Arc RPC: the Safe has code, the chain is 5042, threshold 1, owners [OWNER], nonce `safeNonce`. */
function arcStub(safeNonce) {
  return async (_url, opts) => {
    const { method, params, id } = JSON.parse(opts.body);
    let result;
    if (method === 'eth_getCode') result = '0x6080604052';
    else if (method === 'eth_chainId') result = '0x13b2';
    else if (method === 'eth_call') {
      const sel = params[0].data.slice(0, 10);
      if (sel === '0xe75235b8') result = `0x${word(1)}`;
      else if (sel === '0xa0e67e2b') result = `0x${word(32)}${word(1)}${addrWord(OWNER)}`;
      else if (sel === '0xaffed0e0') result = `0x${word(safeNonce)}`;
      else throw new Error(`unstubbed eth_call ${sel}`);
    } else throw new Error(`unstubbed ${method}`);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id, result }) };
  };
}

const plan = {
  to: FACTORY, action: 'createVault', expectedTo: FACTORY, data: `0x49af0336${'0'.repeat(64)}`,
  operation: 0, value: 0, safeTxGas: 0, baseGas: 0, gasPrice: 0,
};

test('Safe nonce equal to the item\'s safeNonce: signable (the positive control, so the refusals below are not vacuous)', async () => {
  assert.equal(await safeRoutedRefusal(arcStub(0), { safe: SAFE, owner: OWNER, plan, expectedSafeNonce: 0 }), null);
});

test('Safe nonce already past the item\'s safeNonce refuses: the duplicate-vault case', async () => {
  const r = await safeRoutedRefusal(arcStub(1), { safe: SAFE, owner: OWNER, plan, expectedSafeNonce: 0 });
  assert.match(String(r), /nonce is 1, this item was built for Safe nonce 0/);
});

test('a Safe-routed item with no expected nonce refuses rather than skipping the gate', async () => {
  const r = await safeRoutedRefusal(arcStub(0), { safe: SAFE, owner: OWNER, plan, expectedSafeNonce: undefined });
  assert.match(String(r), /carries no expected Safe nonce/);
});
