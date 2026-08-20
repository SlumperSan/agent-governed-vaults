// @ts-check
/**
 * x402 spend-cap tests. The cap has to hold at BOTH layers — the pre-call gate that skips a read
 * cleanly, and the signer backstop that refuses to produce a signature. Under EIP-3009 a signature
 * IS the spend, so the second layer is the one that actually protects the wallet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetExceededError, createBudget } from '../src/budget.mjs';

const CENT = 10_000n; // $0.01 in USDC base units
const mk = (over = {}) => createBudget({ maxSessionSpendUsdc: '0.05', maxSingleReadUsdc: '0.02', ...over });

test('spending accumulates and the cap is reported honestly', () => {
  const b = mk();
  assert.equal(b.cap, 50_000n);
  assert.equal(b.remaining, 50_000n);
  b.charge(CENT, 'listVaults');
  b.charge(CENT, 'leaderboard');
  assert.equal(b.spent, 20_000n);
  assert.equal(b.remaining, 30_000n);
  assert.deepEqual(b.summary(), { enabled: true, spentUsdc: '0.02', capUsdc: '0.05', remainingUsdc: '0.03', paidReads: 2 });
});

test('the session cap refuses the read that would breach it', () => {
  const b = mk();
  for (let i = 0; i < 5; i++) b.charge(CENT);
  assert.equal(b.remaining, 0n);
  assert.equal(b.canAfford(CENT).ok, false);
  assert.match(b.canAfford(CENT).reason, /session spend cap reached/);
  assert.throws(() => b.charge(CENT), BudgetExceededError);
});

test('the cap is exact: the read that lands exactly on it is allowed, the next is not', () => {
  const b = mk();
  b.charge(20_000n); // at the per-read cap exactly — allowed
  b.charge(10_000n);
  assert.equal(b.remaining, 20_000n);
  assert.equal(b.canAfford(20_000n).ok, true, 'a read that lands exactly on the session cap is affordable');
  b.charge(20_000n);
  assert.equal(b.remaining, 0n);
  assert.equal(b.canAfford(1n).ok, false, 'one base unit past the cap is not');
});

test('the per-read cap refuses one oversized read without touching the session budget', () => {
  const b = mk();
  const v = b.canAfford(30_000n); // > $0.02 per-read cap
  assert.equal(v.ok, false);
  assert.match(v.reason, /per-read cap/);
  assert.equal(b.spent, 0n, 'a refused read must not be billed');
});

test('the GUARDED SIGNER refuses before producing a signature', () => {
  // The layer that matters: the SDK signs inside request(), so a post-hoc check is too late.
  const b = mk();
  let signed = 0;
  const sign = b.guardSigner(async () => {
    signed++;
    return '0xsig';
  });
  return (async () => {
    await sign({ message: { value: '10000' } });
    assert.equal(signed, 1);
    await sign({ message: { value: '10000' } });
    await sign({ message: { value: '10000' } });
    await sign({ message: { value: '10000' } });
    await sign({ message: { value: '10000' } });
    assert.equal(signed, 5);
    await assert.rejects(() => sign({ message: { value: '10000' } }), BudgetExceededError);
    assert.equal(signed, 5, 'no signature may be produced once the cap is reached');
  })();
});

test('the signer reads the value from the TYPED DATA, so an inflated challenge cannot sneak past', async () => {
  // The pre-call gate saw $0.01; the challenge actually asks for $10. The backstop catches it.
  const b = mk();
  let signed = false;
  const sign = b.guardSigner(async () => {
    signed = true;
    return '0xsig';
  });
  await assert.rejects(() => sign({ message: { value: '10000000' } }), BudgetExceededError);
  assert.equal(signed, false);
  assert.equal(b.spent, 0n);
});

test('typed data with no value is refused rather than signed blind', async () => {
  const b = mk();
  const sign = b.guardSigner(async () => '0xsig');
  await assert.rejects(() => sign({ message: {} }), /no value to check/);
  await assert.rejects(() => sign({}), /no value to check/);
});

test('a disabled budget authorizes nothing at all', async () => {
  const b = mk({ enabled: false });
  assert.equal(b.canAfford(1n).ok, false);
  assert.match(b.canAfford(1n).reason, /disabled by config/);
  const sign = b.guardSigner(async () => '0xsig');
  await assert.rejects(() => sign({ message: { value: '1' } }), BudgetExceededError);
});

test('the ledger records what was paid for, for the session narrative', () => {
  const b = mk();
  b.charge(CENT, 'listVaults');
  b.charge(CENT, 'getVault 0xabc');
  assert.deepEqual(b.ledger(), [
    { amountUsdc: '0.01', label: 'listVaults' },
    { amountUsdc: '0.01', label: 'getVault 0xabc' },
  ]);
});
