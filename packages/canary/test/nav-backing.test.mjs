// @ts-check
/**
 * Signal (b) — NAV backing, both legs.
 *
 * The composition leg reproduces VaultCore.navWad() including the SV-7 look-through, so the
 * headline test here is the S6 Finding-1 shape: a parent whose reported navWad omits grandchild
 * value must diverge from the recompute. If that case passes, the look-through is real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkNavBacking } from '../src/signals/nav-backing.mjs';
import { mockReader, healthyVault, VAULT, CHILD, ORACLE, USDC, ASSET } from './helpers.mjs';

const WAD = 1_000000000000000000n;
const composition = (rs) => rs.find((r) => r.key === 'composition');
const custody = (rs) => rs.find((r) => r.key === 'custody');

test('OK on a healthy vault: navWad matches the recompute exactly (divergence 0)', async () => {
  const reader = mockReader({ contracts: healthyVault() });
  const rs = await checkNavBacking({ reader, vault: VAULT, atBlock: 900 });
  const c = composition(rs);
  assert.equal(c.status, 'ok');
  assert.equal(c.detail.divergenceBps, 0);
  assert.equal(c.detail.navWad, (7n * WAD).toString());
  assert.equal(c.detail.recomputedWad, (7n * WAD).toString());
});

test('every read is pinned to the requested block, so the two sides cannot race', async () => {
  const reader = mockReader({ contracts: healthyVault() });
  await checkNavBacking({ reader, vault: VAULT, atBlock: 900 });
  const reads = reader.calls.filter((c) => c.kind === 'read');
  assert.ok(reads.length > 5);
  assert.ok(reads.every((c) => c.blockNumber === 900), 'an unpinned read would make divergence racy');
});

test('ALERTS when navWad overstates the components by more than 0.5%', async () => {
  // Reported NAV inflated by 1%: 7.07e18 vs a recompute of 7e18.
  const reader = mockReader({ contracts: healthyVault({ [VAULT]: { navWad: 7_070000000000000000n } }) });
  const c = composition(await checkNavBacking({ reader, vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'alert');
  assert.match(c.message, /NAV backing divergence/);
  assert.equal(c.measured, '0.99%');
  assert.equal(c.threshold, '0.50%');
});

test('stays OK for a divergence under the threshold', async () => {
  // 0.14% — real but below the runbook's 0.5% bar; reported, not paged.
  const reader = mockReader({ contracts: healthyVault({ [VAULT]: { navWad: 7_010000000000000000n } }) });
  const c = composition(await checkNavBacking({ reader, vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'ok');
  assert.equal(c.detail.divergenceBps, 14);
});

test('look-through: a parent that omits grandchild value diverges (the S6 Finding-1 shape)', async () => {
  const GRANDCHILD = '0x' + 'ab'.repeat(20);
  // Parent holds 100% of CHILD; CHILD holds 100% of GRANDCHILD, which carries 4e18 of idle USDC.
  // Reported navWad = 7e18 (parent's own holdings only) — the grandchild leg is missing.
  const contracts = healthyVault({
    [VAULT]: { childVaultCount: 1n, childVaults: () => CHILD },
    [CHILD]: {
      idleUsdc: 0n, basketLength: 0n, basketAssets: () => { throw new Error('none'); },
      assetBalance: () => 0n, childVaultCount: 1n, childVaults: () => GRANDCHILD,
      totalShares: 10n, sharesOf: () => 10n,
    },
    [GRANDCHILD]: {
      idleUsdc: 4_000_000n, basketLength: 0n, basketAssets: () => { throw new Error('none'); },
      assetBalance: () => 0n, childVaultCount: 0n, childVaults: () => { throw new Error('none'); },
      totalShares: 10n, sharesOf: () => 10n,
    },
  });
  const rs = await checkNavBacking({ reader: mockReader({ contracts }), vault: VAULT, atBlock: 900 });
  const c = composition(rs);
  assert.equal(c.status, 'alert');
  // Recompute = 7e18 (parent) + 4e18 (grandchild, priced through the PARENT's usdcScalar) = 11e18.
  assert.equal(c.detail.recomputedWad, (11n * WAD).toString());
  assert.equal(c.detail.navWad, (7n * WAD).toString());
});

test('look-through values a partial child position pro-rata, matching _childValueWad truncation', async () => {
  // Parent holds 3 of the child's 10 shares; child NAV = 10e18 => the parent leg is 3e18.
  const contracts = healthyVault({
    [VAULT]: { navWad: 10_000000000000000000n, childVaultCount: 1n, childVaults: () => CHILD },
    [CHILD]: {
      idleUsdc: 10_000_000n, basketLength: 0n, basketAssets: () => { throw new Error('none'); },
      assetBalance: () => 0n, childVaultCount: 0n, childVaults: () => { throw new Error('none'); },
      totalShares: 10n, sharesOf: () => 3n,
    },
  });
  const c = composition(await checkNavBacking({ reader: mockReader({ contracts }), vault: VAULT, atBlock: 900 }));
  assert.equal(c.detail.recomputedWad, (10n * WAD).toString()); // 7e18 own + 3e18 child leg
  assert.equal(c.status, 'ok');
});

test('DEGRADED, attributed to the oracle, when navWad reverts StaleOracle — not a NAV alert', async () => {
  const reader = mockReader({ contracts: healthyVault({ [VAULT]: { navWad: { revert: '0xa2671f4b' } } }) });
  const rs = await checkNavBacking({ reader, vault: VAULT, atBlock: 900 });
  assert.equal(rs.length, 1);
  assert.equal(rs[0].status, 'skipped');
  assert.notEqual(rs[0].status, 'alert', 'a tripped breaker must not double-page as a NAV divergence');
  assert.equal(rs[0].detail.attributedTo, 'oracle-freshness');
});

test('DEGRADED when a basket asset price reverts mid-recompute', async () => {
  const reader = mockReader({ contracts: healthyVault({ [ORACLE]: { priceWad: () => ({ revert: '0xa2671f4b' }) } }) });
  const c = composition(await checkNavBacking({ reader, vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'skipped');
  assert.equal(c.detail.attributedTo, 'oracle-freshness');
});

// ── custody leg ──────────────────────────────────────────────────────────────

test('custody OK when token balances cover internal accounting', async () => {
  const c = custody(await checkNavBacking({ reader: mockReader({ contracts: healthyVault() }), vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'ok');
});

test('custody OK on a SURPLUS — EE-1 pending capital and EE-6 escrow are not faults', async () => {
  const contracts = healthyVault({
    [VAULT]: { totalPendingUsdc: 500_000n },
    // The vault holds pending capital plus a donation on top of what it accounts for.
    [USDC]: { balanceOf: () => 9_999_999n },
    [ASSET]: { balanceOf: () => 50_000000000000000000n },
  });
  const c = custody(await checkNavBacking({ reader: mockReader({ contracts }), vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'ok', 'a surplus is normal — donations, escrow, and pending deposits all live here');
});

test('custody ALERTS on a USDC shortfall — the vault claims more than it holds', async () => {
  const contracts = healthyVault({
    [VAULT]: { totalPendingUsdc: 500_000n }, // accounts for 1_500_000 total
    [USDC]: { balanceOf: () => 1_000_000n },
  });
  const c = custody(await checkNavBacking({ reader: mockReader({ contracts }), vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'alert');
  assert.match(c.message, /BACKING SHORTFALL/);
  assert.equal(c.detail.shortfalls[0].owed, '1500000');
  assert.equal(c.detail.shortfalls[0].held, '1000000');
});

test('custody ALERTS on a basket-asset shortfall and names the token', async () => {
  const contracts = healthyVault({ [ASSET]: { balanceOf: () => 1_000000000000000000n } });
  const c = custody(await checkNavBacking({ reader: mockReader({ contracts }), vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'alert');
  assert.equal(c.detail.shortfalls[0].token, ASSET);
  assert.ok(c.message.includes(ASSET.slice(0, 6)), 'alert line must name the token');
});

test('a 429 on priceWad mid-recompute is worded as an unread call, not as a revert', async () => {
  // memoPrice's Error text is not swallowed: nav-backing.mjs:92 puts it verbatim into the
  // operator's "NAV recompute failed …" line, so an unconditional "reverted" there reported a
  // network failure as a claim about priceWad. Non-paging either way — the result is `skipped`,
  // and `isFrozen(null)` is false because the reader nulls returndata on a transport failure.
  const contracts = healthyVault({ [ORACLE]: { priceWad: () => ({ transport: 'HTTP request failed.' }) } });
  const c = composition(await checkNavBacking({ reader: mockReader({ contracts }), vault: VAULT, atBlock: 900 }));
  assert.equal(c.status, 'skipped');
  assert.equal(c.detail.attributedTo, null);
  assert.match(c.message, /priceWad\(0x\w+\) could not be read: HTTP request failed\./);
  assert.doesNotMatch(c.message, /revert/);
});
