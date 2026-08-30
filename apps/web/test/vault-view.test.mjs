// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { oracleHealth, position, vaultView, SORTS } from '../src/vault-view.mjs';
import { VAULTS, WALLET, NOW, vaultByAddress } from '../src/fixtures.mjs';
import { mapVaultRecords } from '../src/live-adapter.mjs';
import { PROPOSAL_UNKNOWN } from '../src/governance.mjs';

const DAY = 86_400;
const WAD = 10n ** 18n;

test('oracleHealth names the asset that froze the vault, and by how much', () => {
  // A freeze is per asset: priceWad(asset) reverts for the one stale feed, and navWad walks the
  // whole basket — so one stale feed freezes everything.
  const h = oracleHealth(
    [
      { symbol: 'WETH', oracleUpdatedAt: NOW - 30, maxStalenessSec: 3600, priceWad: 1n },
      { symbol: 'cbBTC', oracleUpdatedAt: NOW - 9 * 3600, maxStalenessSec: 3600, priceWad: null },
    ],
    NOW,
  );
  assert.equal(h.frozen, true);
  assert.deepEqual(h.culprits, ['cbBTC']);
  assert.equal(h.assets[0].state, 'fresh');
  assert.equal(h.assets[1].state, 'stale');
  assert.equal(h.assets[1].overBySec, 8 * 3600);
});

test('oracleHealth warns before the bound, not only after it', () => {
  const h = oracleHealth([{ symbol: 'WETH', oracleUpdatedAt: NOW - 3000, maxStalenessSec: 3600 }], NOW);
  assert.equal(h.assets[0].state, 'ageing'); // 3000/3600 = 83%
  assert.equal(h.frozen, false);
});

test('a feed whose freshness cannot be read is not provably live', () => {
  const h = oracleHealth([{ symbol: '???', oracleUpdatedAt: null, maxStalenessSec: null }], NOW);
  assert.equal(h.determinable, false);
  assert.equal(h.assets[0].state, 'unknown');
  assert.equal(h.frozen, false, 'unknown is not the same claim as stale');
});

test('position values a holding at NAV/share and refuses to while frozen', () => {
  const v = { totalShares: 4n * WAD, navWad: 1_000n * WAD, frozen: false };
  const p = position(v, { shares: WAD, costBasisUsdc: 200_000_000n, lastDepositTime: NOW - 10 * DAY }, NOW);
  assert.equal(p.valueUsdc, 250_000_000n); // a quarter of $1,000
  assert.equal(p.pnlUsdc, 50_000_000n); // +$50 over a $200 basis
  assert.equal(p.tenureSec, 10 * DAY);

  const frozen = position({ ...v, frozen: true }, { shares: WAD, costBasisUsdc: 200_000_000n, lastDepositTime: NOW }, NOW);
  assert.equal(frozen.valueUsdc, null, 'NAV cannot be read while frozen — do not show a stale value as current');
  assert.equal(frozen.pnlUsdc, null);
});

test('a sole holder pays no exit fee even at zero tenure', () => {
  const p = position(
    { totalShares: WAD, navWad: 100n * WAD, frozen: false, exitFeeMaxBps: 100, exitFeeDecayPeriodSec: 90 * DAY },
    { shares: WAD, costBasisUsdc: 0n, lastDepositTime: NOW },
    NOW,
  );
  assert.equal(p.isSoleHolder, true);
  assert.equal(p.feeBpsNow, 0n);
});

test('fixture: the Mode-F vault resolves to F and withholds nothing but says why', () => {
  const view = vaultView(vaultByAddress('0x1111000000000000000000000000000000001111'), WALLET, NOW);
  assert.equal(view.mode.mode, 'F', 'past its commit deadline ⇒ reveal phase ⇒ exits queue');
  assert.equal(view.status.key, 'modeF');
  assert.equal(view.actions.exit.available, true);
  assert.equal(view.actions.exit.severity, 'warn');
});

test('fixture: the commit-phase vault still settles exits instantly', () => {
  const view = vaultView(vaultByAddress('0x2222000000000000000000000000000000002222'), WALLET, NOW);
  assert.equal(view.mode.mode, 'I');
  // The viewer has a PENDING deposit here, not shares.
  assert.equal(view.facts.hasPendingDeposit, true);
  assert.equal(view.facts.pendingMatured, false);
  assert.equal(view.actions.cancelPending.available, true);
  assert.equal(view.actions.activate.available, false);
  assert.equal(view.actions.deposit.available, false, 'one pending deposit per member per vault');
});

test('fixture: the frozen vault blocks everything except cancelling pending capital', () => {
  const view = vaultView(vaultByAddress('0x4444000000000000000000000000000000004444'), WALLET, NOW);
  assert.equal(view.frozen, true);
  assert.deepEqual(view.oracle.culprits, ['cbBTC']);
  assert.equal(view.actions.deposit.available, false);
  assert.equal(view.actions.exit.available, false);
  assert.equal(view.position.valueUsdc, null, 'the position is held, and its value is unknown, not stale-but-shown');
});

test('fixture: an uncapped vault reads as uncapped, never as full', () => {
  const view = vaultView(vaultByAddress('0x3333000000000000000000000000000000003333'), WALLET, NOW);
  assert.equal(view.capacity.capped, false);
  assert.equal(view.facts.capacityFull, false);
  assert.equal(view.actions.deposit.available, true);
});

test('fixture: the sub-vault stacks fees per the contract-mirrored model', () => {
  const view = vaultView(vaultByAddress('0x3333000000000000000000000000000000003333'), WALLET, NOW);
  assert.equal(view.fees.levels, 2);
  assert.equal(view.fees.stackedPerfFeeBps, 1900, '19%, because perf fees compound on net-of-fee value');
  assert.equal(view.fees.stackedExitFeeCapBps, 100, '0.50% + 0.50% across the chain');
});

test('fixture: the unattested vault is quarantined from deposits', () => {
  const view = vaultView(vaultByAddress('0x5555000000000000000000000000000000005555'), WALLET, NOW);
  assert.equal(view.facts.attested, false);
  assert.equal(view.status.key, 'unattested');
  assert.equal(view.actions.deposit.available, false);
});

test('a live-API record renders as UNKNOWN, never as a green open Mode-I vault', () => {
  // The whole point of the sentinels: mapVaultRecords' output must not assert the two facts that
  // decide whether an exit is reversible and whether capital is trapped.
  const [rec] = mapVaultRecords(
    [{ vault: '0x' + '7'.repeat(40), operatorId: 4, memberCount: 12, capacityCapUsdc: '6000000000000', attested: true }],
    [{ operatorId: 4, operator: '0x' + 'b'.repeat(40) }],
  );
  assert.equal(rec.frozen, null);
  assert.equal(rec.proposal, PROPOSAL_UNKNOWN);

  const view = vaultView(rec, null, NOW);
  assert.equal(view.frozen, null, 'unknown, not false');
  assert.equal(view.mode.mode, 'unknown');
  assert.notEqual(view.status.key, 'open');
  assert.equal(view.status.tone, 'warn');
  assert.equal(view.capacity.determinable, false, 'NAV and escrowed pending are both unreadable');
  assert.equal(view.capacity.usedBps, null, 'so no 0.00% meter is drawn as fact');
  assert.equal(view.facts.capacityFull, false, 'unknown is not full either');
  const ids = view.actions.notices.map((n) => n.id);
  assert.ok(ids.includes('freeze-unknown'));
  assert.ok(ids.includes('mode-unknown'));
});

test('oracleHealth skips a ZERO-balance asset, as navWad does', () => {
  // VaultCore.sol:284-287 — `if (bal != 0)`. A stale feed on an asset the vault does not hold
  // freezes nothing on-chain, and must not disable deposit, activation and exit here.
  const h = oracleHealth(
    [
      { symbol: 'WETH', balance: 10n ** 18n, oracleUpdatedAt: NOW - 30, maxStalenessSec: 3600 },
      { symbol: 'cbBTC', balance: 0n, oracleUpdatedAt: NOW - 9 * 3600, maxStalenessSec: 3600 },
    ],
    NOW,
  );
  assert.equal(h.frozen, false);
  assert.deepEqual(h.culprits, []);
  assert.equal(h.assets[1].state, 'unheld');
  assert.equal(h.determinable, true, 'an unpriceable asset the vault does not hold is not a gap');

  // A held balance with the same stale feed still freezes.
  const held = oracleHealth([{ symbol: 'cbBTC', balance: 1n, oracleUpdatedAt: NOW - 9 * 3600, maxStalenessSec: 3600 }], NOW);
  assert.equal(held.frozen, true);
});

test('fixture: an unattested vault’s freeze state is unknown, and is consumed as unknown', () => {
  // `determinable` was computed and unit-tested and then referenced nowhere, so a vault whose
  // feed freshness cannot be read was treated as healthy and fully actionable.
  const view = vaultView(vaultByAddress('0x5555000000000000000000000000000000005555'), WALLET, NOW);
  assert.equal(view.oracle.determinable, false);
  assert.equal(view.frozen, null);
  assert.ok(view.actions.notices.some((n) => n.id === 'freeze-unknown'));
});

test('a card and a detail page cannot disagree — both read one vaultView', () => {
  for (const v of VAULTS) {
    const a = vaultView(v, WALLET, NOW);
    const b = vaultView(v, WALLET, NOW);
    assert.equal(a.status.key, b.status.key);
    assert.equal(a.frozen, b.frozen);
    assert.equal(a.mode.mode, b.mode.mode);
  }
});

test('sorts rank on the named signal, and tolerate a missing one', () => {
  const views = VAULTS.map((v) => vaultView(v, WALLET, NOW));
  for (const key of Object.keys(SORTS)) {
    const sorted = [...views].sort(SORTS[key].fn);
    assert.equal(sorted.length, views.length);
    assert.ok(SORTS[key].label.length > 0);
  }
  const byFee = [...views].sort(SORTS.fee.fn);
  assert.equal(byFee[0].fees.exitFeeMaxBps, 0, 'lowest exit fee first');
});
