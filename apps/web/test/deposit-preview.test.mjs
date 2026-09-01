// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacity, entryPath, indicativeShares, previewDeposit } from '../src/deposit-preview.mjs';

const WAD = 10n ** 18n;
const DAY = 86_400n;
const usdc = (n) => BigInt(n) * 1_000_000n;

const codes = (r, key = 'blockers') => r[key].map((b) => b.code);

test('capacity counts escrowed pending deposits, as the contract does', () => {
  // _deposit: navUsdc + totalPendingUsdc + amount <= capacityCapUsdc
  const c = capacity({ navUsdc: usdc(800_000), totalPendingUsdc: usdc(150_000), capacityCapUsdc: usdc(1_000_000) });
  assert.equal(c.used, usdc(950_000));
  assert.equal(c.headroom, usdc(50_000));
  assert.equal(c.usedBps, 9500);
  // NAV alone would have read 80% used and promised $200k of room that does not exist.
});

test('capacityCapUsdc === 0 is uncapped, not full', () => {
  const c = capacity({ navUsdc: usdc(9_000_000), totalPendingUsdc: 0n, capacityCapUsdc: 0n });
  assert.equal(c.capped, false);
  assert.equal(c.headroom, null);
  assert.equal(c.usedBps, null);
});

test('entryPath mirrors windowCleared[member] || sharesOf[member] > 0', () => {
  assert.equal(entryPath({}), 'window');
  assert.equal(entryPath({ windowCleared: true }), 'immediate');
  assert.equal(entryPath({ sharesHeld: WAD }), 'immediate');
  assert.equal(entryPath({ sharesHeld: 0n }), 'window');
});

test('indicativeShares mirrors _mintShares and rounds down against the depositor', () => {
  assert.equal(indicativeShares({ amountUsdc: usdc(100), totalShares: 0n, navWad: 0n }), 100n * WAD);
  // amountWad * ts / navWad, floored: 100e18 * 3 / 700e18 → 0.428…e18
  assert.equal(
    indicativeShares({ amountUsdc: usdc(100), totalShares: 3n * WAD, navWad: 700n * WAD }),
    (100n * WAD * 3n * WAD) / (700n * WAD),
  );
  // Unknowable inputs return null, never a fabricated share count.
  assert.equal(indicativeShares({ amountUsdc: usdc(100), totalShares: 3n * WAD, navWad: undefined }), null);
  assert.equal(indicativeShares({ amountUsdc: usdc(100), totalShares: 3n * WAD, navWad: 0n }), null);
});

const openVault = {
  amountUsdc: usdc(1_000),
  minDepositUsdc: usdc(10),
  navUsdc: usdc(500_000),
  navWad: 500_000n * WAD,
  totalPendingUsdc: 0n,
  capacityCapUsdc: usdc(1_000_000),
  totalShares: 500_000n * WAD,
};

test('a clean first deposit takes the window path and says so twice', () => {
  const r = previewDeposit(openVault);
  assert.equal(r.ok, true);
  assert.equal(r.path, 'window');
  assert.equal(r.sharesAreIndicative, true, 'shares mint at ACTIVATION NAV, four hours later');
  const c = codes(r, 'consequences');
  assert.ok(c.includes('ObservationWindow'));
  assert.ok(c.includes('ForwardPricedEntry'));
});

test('capacity blocker fires on the pending-inclusive figure', () => {
  const r = previewDeposit({ ...openVault, amountUsdc: usdc(60_000), totalPendingUsdc: usdc(450_000) });
  // 500k nav + 450k pending + 60k = 1.01M > 1M cap
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('CapacityExceeded'));
  assert.equal(r.blockers.find((b) => b.code === 'CapacityExceeded').headroom, usdc(50_000));
});

test('frozen blocks the deposit and names why — the capacity check reads NAV', () => {
  const r = previewDeposit({ ...openVault, frozen: true });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('StaleOracle'));
});

test('contract revert names are carried so the on-chain failure reads the same', () => {
  assert.ok(codes(previewDeposit({ ...openVault, amountUsdc: usdc(1) })).includes('BelowMinDeposit'));
  assert.ok(codes(previewDeposit({ ...openVault, amountUsdc: 0n })).includes('ZeroAmount'));
  assert.ok(codes(previewDeposit({ ...openVault, walletUsdc: usdc(10) })).includes('InsufficientBalance'));
  assert.ok(codes(previewDeposit({ ...openVault, hasPendingDeposit: true })).includes('PendingExists'));
});

test('a second pending deposit is only blocked on the window path', () => {
  // An existing member deposits immediately, so PendingExists cannot apply to them.
  const member = previewDeposit({ ...openVault, hasPendingDeposit: true, sharesHeld: WAD });
  assert.equal(member.path, 'immediate');
  assert.ok(!codes(member).includes('PendingExists'));
});

test('TENURE RESET is surfaced, quantified, for a member whose fee had decayed', () => {
  // 60 days into a 90-day decay on a 1% max ⇒ currently 0.33%; a top-up puts it back to 1.00%.
  const r = previewDeposit({
    ...openVault,
    sharesHeld: WAD,
    tenure: { exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90n * DAY, tenureSec: 60n * DAY },
  });
  const t = r.consequences.find((c) => c.code === 'TenureReset');
  assert.ok(t, 'a top-up that restores the full exit fee must be disclosed before signing');
  assert.equal(t.fromBps, 33n);
  assert.equal(t.toBps, 100n);
  assert.equal(t.severity, 'warn');
});

test('no tenure-reset notice when there is nothing to lose', () => {
  // Brand-new member: fee is already at max, so the reset costs them nothing.
  const fresh = previewDeposit({
    ...openVault,
    tenure: { exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90n * DAY, tenureSec: 0n },
  });
  assert.equal(fresh.consequences.find((c) => c.code === 'TenureReset'), undefined);
  // Vault with no exit fee at all.
  const free = previewDeposit({
    ...openVault,
    sharesHeld: WAD,
    tenure: { exitFeeMaxBps: 0, exitFeeDecayPeriodSec: 90n * DAY, tenureSec: 60n * DAY },
  });
  assert.equal(free.consequences.find((c) => c.code === 'TenureReset'), undefined);
});

test('EVERY mint is forward-priced — shares are indicative on the immediate path too', () => {
  // The immediate path does not mint at the NAV on screen either: it mints at the NAV of a FUTURE
  // block, against a basket that moves. The window path is the same mechanic priced four hours
  // further out. Rendering "Shares you receive: 923.159805" as a fact on either path is the
  // promise §3.1 forbids.
  const member = previewDeposit({ ...openVault, sharesHeld: WAD, windowCleared: true });
  assert.equal(member.path, 'immediate');
  assert.equal(member.sharesAreIndicative, true);
  assert.ok(member.shares > 0n);
  assert.ok(member.consequences.some((c) => c.code === 'ForwardPricedEntry'));

  const windowPath = previewDeposit(openVault);
  assert.equal(windowPath.sharesAreIndicative, true);
});

test('capacity is unknown, not 0% used, when NAV and pending are unreadable', () => {
  // The metered API carries neither, and `used = 0 + 0` would draw a full-headroom meter as fact.
  const c = capacity({ navUsdc: null, totalPendingUsdc: null, capacityCapUsdc: usdc(1_000_000) });
  assert.equal(c.determinable, false);
  assert.equal(c.used, null);
  assert.equal(c.usedBps, null);
  assert.equal(c.headroom, null);
  assert.equal(c.capped, true, 'the cap itself IS event-derived and known');

  const r = previewDeposit({ ...openVault, navUsdc: null, navWad: null, totalPendingUsdc: null });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('CapacityUnknown'));
  assert.equal(r.shares, null, 'no NAV ⇒ no share estimate, not a fabricated one');
});

test('the entry path is an inference when windowCleared cannot be read', () => {
  // `windowCleared[member]` is a mapping, not an event: a zero-share member who already burned
  // their skip opt-in reads as `window` here and mints immediately on-chain.
  assert.equal(previewDeposit(openVault).pathIsCertain, false);
  assert.equal(previewDeposit({ ...openVault, windowCleared: false }).pathIsCertain, true);
  assert.equal(previewDeposit({ ...openVault, sharesHeld: WAD }).pathIsCertain, true);
  const uncertain = previewDeposit(openVault).consequences.find((c) => c.code === 'ObservationWindow');
  assert.match(uncertain.detail, /skip opt-in/i);
});
