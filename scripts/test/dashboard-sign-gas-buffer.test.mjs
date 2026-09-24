// @ts-check
/**
 * The Sign page must send every transaction with gas = the node's estimate x 1.25. On a fork, an
 * exact estimate underran a real activate() and it ran out of gas (#402, gasUsed == gasLimit). With
 * no gas field MetaMask's own estimate decides, and a revert still burns the owner's gas (Security,
 * #402). This runs the REAL send block out of scripts/dashboard.mjs's page script against a stub
 * wallet, so a later edit to that block is what gets tested, not a copy of it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard.mjs'), 'utf8');

function sendBlock() {
  const start = SOURCE.indexOf('    var data = item.resolvedData || item.data;');
  const endMarker = "var hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [txParams] });";
  const end = SOURCE.indexOf(endMarker, start);
  assert.ok(start !== -1 && end !== -1, 'could not find the Sign send block in scripts/dashboard.mjs — fix this locator, do not delete the test');
  return SOURCE.slice(start, end + endMarker.length);
}

async function runSend(item, estimateHex) {
  const calls = [];
  const window = {
    ethereum: {
      request: async ({ method, params }) => {
        calls.push({ method, params: JSON.parse(JSON.stringify(params)) });
        if (method === 'eth_estimateGas') return estimateHex;
        if (method === 'eth_sendTransaction') return `0x${'ab'.repeat(32)}`;
        throw new Error(`unexpected ${method}`);
      },
    },
  };
  const fn = vm.runInNewContext(`(async function (window, item) {\n${sendBlock()}\nreturn hash;\n})`);
  await fn(window, item);
  return calls;
}

const ITEM = { from: '0xF000000000000000000000000000000000000f', to: '0xA000000000000000000000000000000000000a', value: '0', data: '0xabcdef', resolvedData: null };

test('the Sign send carries gas = eth_estimateGas x 1.25, and leaves from/to/value/data untouched', async () => {
  const calls = await runSend(ITEM, '0x186a0'); // 100,000
  const send = calls.find((c) => c.method === 'eth_sendTransaction');
  assert.ok(send, 'eth_sendTransaction was not called');
  const tx = send.params[0];
  assert.equal(BigInt(tx.gas), 125_000n);
  assert.equal(tx.from, ITEM.from);
  assert.equal(tx.to, ITEM.to);
  assert.equal(tx.data, ITEM.data);
  assert.equal(tx.value, '0x0');
  const est = calls.find((c) => c.method === 'eth_estimateGas');
  assert.ok(est && est.params[0].gas === undefined, 'estimate the unbuffered tx, not one already carrying a gas cap');
});

test('a contract creation (to: null) is estimated and sent with no `to` key, still buffered', async () => {
  const calls = await runSend({ ...ITEM, to: null }, '0x7a120'); // 500,000
  const tx = calls.find((c) => c.method === 'eth_sendTransaction').params[0];
  assert.equal('to' in tx, false);
  assert.equal(BigInt(tx.gas), 625_000n);
});
