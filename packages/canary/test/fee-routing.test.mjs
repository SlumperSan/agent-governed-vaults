// @ts-check
/**
 * Signal (f) — fee routing (EE-9 / MO-4).
 *
 * The tests that matter most are the two that keep this signal from crying wolf:
 *   - an operator who is ALSO a member exiting their own position is legitimate (EE-9), and
 *   - a USDC transfer to the FeeEngine is the claim flow working, not a leak.
 * A signal that pages on either of those gets muted, and a muted signal catches nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkFeeRouting } from '../src/signals/fee-routing.mjs';
import { mockReader, healthyVault, log, VAULT, USDC, REGISTRY, OPERATOR, MEMBER, FEE_ENGINE } from './helpers.mjs';

const W = { fromBlock: 100, toBlock: 200 };
const transfer = (to, value, block = 150) => log(USDC, 'Transfer', block, { from: VAULT, to, value });

const run = (logs, contracts = healthyVault()) => checkFeeRouting({
  reader: mockReader({ contracts, logs }),
  vault: VAULT, usdc: USDC, operatorRegistry: REGISTRY, ...W,
});

test('OK when no USDC leaves the vault at all', async () => {
  const [r] = await run([]);
  assert.equal(r.status, 'ok');
});

test('OK when USDC goes to the FeeEngine — that IS the claim flow', async () => {
  const [r] = await run([transfer(FEE_ENGINE, 1_000_000n)]);
  assert.equal(r.status, 'ok');
  assert.match(r.message, /none to an operator address/);
});

test('OK when USDC goes to an ordinary member (an exit payout)', async () => {
  const [r] = await run([transfer(MEMBER, 5_000_000n)]);
  assert.equal(r.status, 'ok');
});

test('ALERTS on a direct USDC transfer to the registered operator address', async () => {
  const [r] = await run([transfer(OPERATOR, 250_000n)]);
  assert.equal(r.status, 'alert');
  assert.match(r.message, /FEE ROUTING VIOLATION/);
  assert.match(r.message, /FeeEngine\.claimFees/);
  assert.equal(r.measured, '1 transfer(s), 250000 USDC base units');
  assert.equal(r.detail.transfers[0].to, OPERATOR);
  assert.equal(r.detail.transfers[0].blockNumber, 150);
  assert.deepEqual(r.detail.threatModelRows, ['EE-9', 'MO-4']);
});

test('OK when the operator is also a MEMBER exiting their own position (EE-9)', async () => {
  const [r] = await run([
    transfer(OPERATOR, 250_000n, 150),
    log(VAULT, 'ExitSettled', 150, { member: OPERATOR, sharesBurned: 1n, usdcPaid: 250_000n, exitFeeBps: 0n, perfFeeUsdc: 0n }),
  ]);
  assert.equal(r.status, 'ok', 'operator-as-member is explicitly legitimate — the prohibition is on ROUTING');
  assert.equal(r.detail.excusedAsMemberSettlement, 1);
});

test('OK when the operator cancels their own pending deposit (a refund, not a fee)', async () => {
  const [r] = await run([
    transfer(OPERATOR, 250_000n, 150),
    log(VAULT, 'PendingCancelled', 150, { member: OPERATOR, amountUsdc: 250_000n }),
  ]);
  assert.equal(r.status, 'ok');
});

test('still ALERTS when a settlement in a DIFFERENT block is used as cover', async () => {
  const [r] = await run([
    transfer(OPERATOR, 250_000n, 150),
    log(VAULT, 'ExitSettled', 151, { member: OPERATOR, sharesBurned: 1n, usdcPaid: 1n, exitFeeBps: 0n, perfFeeUsdc: 0n }),
  ]);
  assert.equal(r.status, 'alert', 'the discriminator is same-block, so an unrelated exit cannot excuse a leak');
});

test('excuses the settled transfer and still alerts on the unsettled one in the same window', async () => {
  const [r] = await run([
    transfer(OPERATOR, 100n, 150),
    log(VAULT, 'ExitSettled', 150, { member: OPERATOR, sharesBurned: 1n, usdcPaid: 100n, exitFeeBps: 0n, perfFeeUsdc: 0n }),
    transfer(OPERATOR, 900n, 160),
  ]);
  assert.equal(r.status, 'alert');
  assert.equal(r.detail.excusedAsMemberSettlement, 1);
  assert.equal(r.detail.transfers.length, 1);
  assert.equal(r.detail.transfers[0].value, '900');
});

test('honours EXTRA_OPERATOR_ADDRESSES for operators the registry does not name', async () => {
  const ROGUE = '0x' + 'f'.repeat(40);
  const [r] = await checkFeeRouting({
    reader: mockReader({ contracts: healthyVault(), logs: [transfer(ROGUE, 1n)] }),
    vault: VAULT, usdc: USDC, operatorRegistry: REGISTRY, extraOperators: [ROGUE], ...W,
  });
  assert.equal(r.status, 'alert');
});

test('OK on an unattested vault — operatorId 0 means there is no operator to leak to', async () => {
  const [r] = await run([transfer(OPERATOR, 1n)], healthyVault({ [REGISTRY]: { operatorOf: () => 0n } }));
  assert.equal(r.status, 'ok');
  assert.match(r.message, /unattested vault/);
});

test('DEGRADED, not OK, when the registry is unreadable', async () => {
  const [r] = await run([transfer(OPERATOR, 1n)], healthyVault({ [REGISTRY]: { operatorOf: () => ({ revert: '0xdeadbeef' }) } }));
  assert.equal(r.status, 'skipped');
  assert.notEqual(r.status, 'ok');
});

test('matches the operator address case-insensitively', async () => {
  const [r] = await run([transfer(OPERATOR.toUpperCase().replace('0X', '0x'), 1n)]);
  assert.equal(r.status, 'alert', 'viem checksums decoded address args — a case-sensitive compare would miss the leak');
});
