// @ts-check
/**
 * Full-stack integration: the REAL HTTP server (node:http) + the REAL agent SDK over the wire,
 * through the actual x402 402→authorize→retry loop and the real event projections. Everything
 * else is unit-tested in isolation (SDK mocks fetch; server tests call handle() directly); this
 * proves the pieces compose over a socket. No external chain/facilitator (facilitator stubbed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApi } from '../src/server.mjs';
import { createProtocolClient } from '../../../packages/agent-sdk/src/index.mjs';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';

const USDC = '0x' + 'c'.repeat(40);
const OP = '0x' + 'a'.repeat(40);
const VAULT = '0x' + '1'.repeat(40);
const price = { asset: USDC, amount: '10000', payTo: '0x' + 'd'.repeat(40), network: 'base' };

function seededState() {
  return applyAll([
    { name: 'VaultCreated', vault: VAULT, blockNumber: 1, logIndex: 0, args: { vault: VAULT, creator: OP, usdc: USDC, capacityCapUsdc: 1000n } },
    { name: 'OperatorRegistered', vault: VAULT, blockNumber: 1, logIndex: 1, args: { opId: 1, operator: OP } },
    { name: 'VaultAttested', vault: VAULT, blockNumber: 1, logIndex: 2, args: { vault: VAULT, opId: 1 } },
    { name: 'DepositActivated', vault: VAULT, blockNumber: 2, logIndex: 0, args: { member: OP, sharesMinted: 1000n } },
    { name: 'RealizationRecorded', vault: VAULT, blockNumber: 3, logIndex: 0, args: { opId: 1, gainUsdc: 250n, lossUsdc: 0n } },
  ]);
}

test('agent SDK drives the live HTTP server through the x402 loop end to end', async () => {
  const facilitator = { async verifyAndSettle() { return { ok: true, receiptId: 'wire_rcpt' }; } };
  const { server } = createApi({ state: seededState(), facilitator, price, now: () => 1_000_000 });

  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const client = createProtocolClient({
      baseUrl: `http://127.0.0.1:${port}`,
      wallet: { address: OP, sign: async () => '0x' + 'f'.repeat(130) },
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      nowSec: () => 1000,
    });

    // Free discovery — no payment.
    const disc = await client.discovery();
    assert.equal(disc.x402Version, 2);
    assert.ok(disc.routes.metered.includes('/vaults'));

    // Free health.
    const health = await client.health();
    assert.equal(health.ok, true);

    // Paid: the SDK hits 402, signs an EIP-3009 authorization, retries, and gets data + receipt.
    const list = await client.listVaults();
    assert.equal(list.data.vaults.length, 1);
    assert.equal(list.data.vaults[0].vault, VAULT);
    assert.equal(list.data.vaults[0].attested, true);
    assert.equal(list.receipt.receiptId, 'wire_rcpt', 'x402 settlement receipt round-tripped');

    const vault = await client.getVault(VAULT);
    assert.equal(vault.data.operatorId, 1);
    assert.equal(vault.data.totalShares, '1000');

    const board = await client.leaderboard();
    assert.equal(board.data.leaderboard[0].netRealizedUsdc, '250');

    const pos = await client.memberPosition(VAULT, OP);
    assert.equal(pos.data.shares, '1000');
    assert.equal(pos.data.shareOfVaultBps, 10000);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('a failing facilitator surfaces as a ProtocolError (402) over the wire', async () => {
  const facilitator = { async verifyAndSettle() { return { ok: false, reason: 'sig-bad' }; } };
  const { server } = createApi({ state: seededState(), facilitator, price, now: () => 1_000_000 });
  server.listen(0);
  await once(server, 'listening');
  const { port } = server.address();
  try {
    const client = createProtocolClient({
      baseUrl: `http://127.0.0.1:${port}`,
      wallet: { address: OP, sign: async () => '0x' + 'f'.repeat(130) },
      domain: { name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC },
      nowSec: () => 1000,
    });
    await assert.rejects(() => client.leaderboard(), (e) => e.status === 402);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
