// @ts-check
// `?kind=` filter on GET /vaults (spec section 5). Fixture holds one regular and one agent vault.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEADERS } from '../src/x402.mjs';
import { createApi } from '../src/server.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';

const USDC = '0x' + 'c'.repeat(40);
const PAYTO = '0x' + 'd'.repeat(40);
const VAULT = '0x' + '1'.repeat(40);
const AGENT_VAULT = '0x' + '2'.repeat(40);
const OP = '0x' + 'a'.repeat(40);
const price = { asset: USDC, amount: '10000', payTo: PAYTO, network: 'base' };

// Same envelope shape as api.test.mjs; only the nonce varies.
function envelope(nonce) {
  const env = {
    x402Version: 2,
    network: 'base',
    signature: '0xsig',
    authorization: { asset: USDC, to: PAYTO, value: '10000', nonce, validBefore: 0 },
  };
  return Buffer.from(JSON.stringify(env)).toString('base64');
}

function makeApi(facilitator) {
  const state = applyAll([
    { name: 'VaultCreated', vault: VAULT, blockNumber: 1, logIndex: 0, args: { vault: VAULT, creator: OP, usdc: USDC, capacityCapUsdc: 1000n } },
    { name: 'AgentVaultCreated', vault: AGENT_VAULT, blockNumber: 1, logIndex: 1, args: { vault: AGENT_VAULT, creator: OP, usdc: USDC, capacityCapUsdc: 1000n, identityRegistry: '0x' + 'e'.repeat(40), kind: 1 } },
  ]);
  return createApi({ state, facilitator, price, now: () => 1000 });
}

const okFacilitator = { async verifyAndSettle() { return { ok: true, receiptId: 'rcpt' }; } };

test('/vaults?kind= returns the right subset; no kind returns both', async () => {
  const api = makeApi(okFacilitator);
  const list = async (qs, nonce) => {
    const r = await api.handle('GET', `/vaults${qs}`, { [HEADERS.SIGNATURE]: envelope(nonce) });
    assert.equal(r.status, 200);
    return JSON.parse(r.body).vaults;
  };
  assert.deepEqual((await list('', '0xk0')).map((v) => [v.vault, v.kind]), [[VAULT, 'regular'], [AGENT_VAULT, 'agent']]);
  assert.deepEqual((await list('?kind=agent', '0xk1')).map((v) => v.vault), [AGENT_VAULT]);
  assert.deepEqual((await list('?kind=regular', '0xk2')).map((v) => v.vault), [VAULT]);
});

test('/vaults?kind=<unknown> is refused with 400 before the payment gate, so nothing is settled', async () => {
  let settled = 0;
  const api = makeApi({ async verifyAndSettle() { settled += 1; return { ok: true, receiptId: 'r' }; } });
  const r = await api.handle('GET', '/vaults?kind=bogus', { [HEADERS.SIGNATURE]: envelope('0xk3') });
  assert.equal(r.status, 400);
  assert.equal(settled, 0);
  assert.equal((await api.handle('GET', '/vaults?kind=', {})).status, 400);
});
