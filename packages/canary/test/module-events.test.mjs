// @ts-check
/**
 * Signal (e) — ModuleCallFailed + SliceEscrowed watch (MO-1 / MO-2 / EE-6).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkModuleEvents } from '../src/signals/module-events.mjs';
import { decodeModuleLabel } from '../src/abis.mjs';
import { mockReader, log, VAULT, MEMBER, ASSET, FEE_ENGINE } from './helpers.mjs';

/** bytes32("feeEngine.onRealize") — a right-zero-padded literal, not a hash. */
const MODULE_ON_REALIZE = `0x${Buffer.from('feeEngine.onRealize', 'ascii').toString('hex').padEnd(64, '0')}`;

test('decodes a bytes32 string literal back to a readable module label', () => {
  assert.equal(decodeModuleLabel(MODULE_ON_REALIZE), 'feeEngine.onRealize');
  assert.equal(decodeModuleLabel(`0x${'00'.repeat(32)}`), `0x${'00'.repeat(32)}`);
});

test('OK and silent when the window contains neither event', async () => {
  const reader = mockReader({ contracts: {}, logs: [] });
  const [r] = await checkModuleEvents({ reader, vault: VAULT, fromBlock: 100, toBlock: 200 });
  assert.equal(r.status, 'ok');
  assert.equal(r.measured, '0 events');
});

test('ALERTS on ModuleCallFailed, naming the module and the member', async () => {
  const reader = mockReader({
    contracts: {},
    logs: [log(VAULT, 'ModuleCallFailed', 150, { module: MODULE_ON_REALIZE, member: MEMBER })],
  });
  const [r] = await checkModuleEvents({ reader, vault: VAULT, fromBlock: 100, toBlock: 200 });
  assert.equal(r.status, 'alert');
  assert.match(r.message, /1x ModuleCallFailed \(feeEngine\.onRealize/);
  assert.equal(r.detail.moduleCallFailed[0].module, 'feeEngine.onRealize');
  assert.equal(r.detail.moduleCallFailed[0].blockNumber, 150);
  assert.deepEqual(r.detail.threatModelRows, ['MO-1', 'MO-2', 'EE-6']);
});

test('ALERTS on SliceEscrowed, naming the asset (the EE-6 in-kind escrow path)', async () => {
  const reader = mockReader({
    contracts: {},
    logs: [log(VAULT, 'SliceEscrowed', 180, { member: FEE_ENGINE, asset: ASSET, amount: 42n })],
  });
  const [r] = await checkModuleEvents({ reader, vault: VAULT, fromBlock: 100, toBlock: 200 });
  assert.equal(r.status, 'alert');
  assert.match(r.message, /1x SliceEscrowed/);
  assert.equal(r.detail.sliceEscrowed[0].amount, '42');
});

test('reports both kinds in one line and counts them', async () => {
  const reader = mockReader({
    contracts: {},
    logs: [
      log(VAULT, 'ModuleCallFailed', 150, { module: MODULE_ON_REALIZE, member: MEMBER }),
      log(VAULT, 'ModuleCallFailed', 151, { module: MODULE_ON_REALIZE, member: MEMBER }),
      log(VAULT, 'SliceEscrowed', 152, { member: MEMBER, asset: ASSET, amount: 1n }),
    ],
  });
  const [r] = await checkModuleEvents({ reader, vault: VAULT, fromBlock: 100, toBlock: 200 });
  assert.equal(r.measured, '3 events');
  assert.match(r.message, /2x ModuleCallFailed/);
  assert.match(r.message, /1x SliceEscrowed/);
});

test('ignores events outside the poll window and events from other vaults', async () => {
  const OTHER = '0x' + '7'.repeat(40);
  const reader = mockReader({
    contracts: {},
    logs: [
      log(VAULT, 'ModuleCallFailed', 99, { module: MODULE_ON_REALIZE, member: MEMBER }),
      log(VAULT, 'ModuleCallFailed', 201, { module: MODULE_ON_REALIZE, member: MEMBER }),
      log(OTHER, 'ModuleCallFailed', 150, { module: MODULE_ON_REALIZE, member: MEMBER }),
    ],
  });
  const [r] = await checkModuleEvents({ reader, vault: VAULT, fromBlock: 100, toBlock: 200 });
  assert.equal(r.status, 'ok');
});
