// @ts-check
/**
 * Tests for the chain reader.
 *
 * WHAT THESE GUARD, and what they deliberately do not. There is no network here and no viem: the
 * module under test plans reads and interprets answers, so the tests hand it answers. What they are
 * really pinning is the arithmetic and the three places a wrong answer is indistinguishable from a
 * right one on screen — a frozen vault vs a zero NAV, a known-absent proposal vs an unread one, and
 * weights measured against NAV vs against the basket total.
 *
 * Every numeric assertion here is computed from `VaultCore`'s own formulas, read from the contract:
 *   navWad          = idleUsdc * usdcScalar + Σ _assetValueWad(a, balance)   (VaultCore.navWad)
 *   _assetValueWad  = balance * priceWad / assetUnit                          (assetUnit = 10**dec)
 * so a test that passes here is evidence about the contract's arithmetic, not about a fixture that
 * happens to agree with the reader.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROPOSAL_STATUS_BY_ORDINAL,
  PROPOSAL_TYPE_BY_ORDINAL,
  assembleLeg,
  assembleProposal,
  assembleVault,
  legValueWad,
  navPerShareWad,
  planBasketAssets,
  planCore,
  planFeeds,
  planLegs,
  planPosition,
  planProposal,
  planProposalId,
  weightsBps,
} from '../src/chain-reader.mjs';
import { MISSING_IN_LIVE } from '../src/live-adapter.mjs';
import { VAULT_VIEWS, GOVERNANCE_VIEWS, CHAINLINK_ORACLE_VIEWS, AGGREGATOR_V3_VIEWS } from '../../../packages/canary/src/abis.mjs';

const WAD = 10n ** 18n;
const wad = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const VAULT = '0x1111000000000000000000000000000000001111';
const ORACLE = '0x0racle00000000000000000000000000000000ab'.padEnd(42, '0').slice(0, 42);
const GOV = '0x90000000000000000000000000000000000000ab';
const WETH = '0x4200000000000000000000000000000000000006';
const NOW = 1_800_000_000;

/** Every fragment table the planner names, so a typo in an `abi` tag fails here not at runtime. */
const TABLES = {
  VAULT_VIEWS,
  GOVERNANCE_VIEWS,
  CHAINLINK_ORACLE_VIEWS,
  AGGREGATOR_V3_VIEWS,
};

// ── The planner names only functions that exist ────────────────────────────────────────────────

test('every planned call names a real fragment in the table it claims', () => {
  const planned = [
    ...planCore(VAULT),
    ...planBasketAssets(VAULT, 2),
    ...planProposalId(GOV, VAULT),
    ...planLegs(VAULT, ORACLE, [WETH]),
    ...planProposal(GOV, 41),
    ...planFeeds(['0xfeed000000000000000000000000000000000001']),
    ...planPosition(VAULT, '0xmember00000000000000000000000000000001'.padEnd(42, '0').slice(0, 42)),
  ];
  assert.ok(planned.length > 0);

  for (const c of planned) {
    const table = TABLES[c.abi];
    assert.ok(table, `planned call names unknown fragment table ${c.abi}`);
    const frag = table.find((f) => f.name === c.fn);
    assert.ok(frag, `${c.abi} has no ${c.fn} — the caller would encode a selector that reverts`);
    assert.equal(
      frag.inputs.length,
      c.args.length,
      `${c.fn} planned with ${c.args.length} args but its fragment takes ${frag.inputs.length}`,
    );
  }
});

test('planBasketAssets indexes every slot exactly once', () => {
  const calls = planBasketAssets(VAULT, 3);
  assert.deepEqual(calls.map((c) => c.args[0]), [0, 1, 2]);
  assert.equal(planBasketAssets(VAULT, 0).length, 0);
});

// ── Arithmetic, against VaultCore's own formulas ────────────────────────────────────────────────

test('legValueWad matches VaultCore._assetValueWad for 18- and 8-decimal tokens', () => {
  // 578.4 WETH at $3,500 = $2,024,400.
  assert.equal(
    legValueWad({ balance: 578_400_000_000_000_000_000n, priceWad: wad(3500), assetUnit: 10n ** 18n }),
    wad(2_024_400),
  );
  // 23.18597557 cbBTC at $99,800 = $2,313,960.36... — 8 decimals, the ordering that breaks naive code.
  assert.equal(
    legValueWad({ balance: 2_318_597_557n, priceWad: wad(99_800), assetUnit: 10n ** 8n }),
    (2_318_597_557n * wad(99_800)) / 10n ** 8n,
  );
});

test('legValueWad multiplies before dividing', () => {
  // A balance smaller than one whole unit. Dividing first gives 0; the contract's order does not.
  const leg = { balance: 1n, priceWad: wad(99_800), assetUnit: 10n ** 8n };
  assert.equal(legValueWad(leg), wad(99_800) / 10n ** 8n);
  assert.ok(legValueWad(leg) > 0n, 'a dust balance of a valuable token is not worth zero');
});

test('legValueWad is 0 for an asset with no unit rather than dividing by zero', () => {
  assert.equal(legValueWad({ balance: 5n, priceWad: wad(1), assetUnit: 0n }), 0n);
});

test('navPerShareWad divides NAV by shares, and is 0 for an empty vault', () => {
  assert.equal(navPerShareWad(wad(4_820_400.512), wad(4_450_000)), (wad(4_820_400.512) * WAD) / wad(4_450_000));
  assert.equal(navPerShareWad(0n, 0n), 0n, 'an empty vault has no price per share');
  assert.equal(navPerShareWad(wad(100), 0n), 0n, 'no shares means no per-share price, not a throw');
});

// ── Weights: against NAV, not against the basket total ──────────────────────────────────────────

test('weights are a share of NAV, so idle cash is not allocated away', () => {
  // A vault that is 90% idle USDC and 10% WETH. Measured against the basket total, WETH would
  // read 10000 bps — "fully allocated" — which is the opposite of true.
  const navWad = wad(1_000_000);
  const legs = [{ valueWad: wad(100_000) }];
  assert.deepEqual(weightsBps(legs, navWad), [1000]);
});

test('weights are 0 rather than NaN when NAV is zero', () => {
  assert.deepEqual(weightsBps([{ valueWad: wad(5) }], 0n), [0]);
});

// ── Frozen vs zero NAV: the distinction the whole module exists to keep ─────────────────────────

test('a reverted navWad reads as frozen, not as a vault worth nothing', () => {
  const v = assembleVault({
    address: VAULT,
    core: { navWad: null, totalShares: wad(4_450_000), idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
  });
  assert.equal(v.frozen, true);
  assert.equal(v.navWad, 0n);
  assert.equal(v.navPerShareWad, 0n);
  assert.equal(v.totalShares, wad(4_450_000), 'the shares still exist; only the price is unreadable');
});

test('a vault that genuinely holds nothing is not reported as frozen', () => {
  const v = assembleVault({
    address: VAULT,
    core: { navWad: 0n, totalShares: 0n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
  });
  assert.equal(v.frozen, false, 'empty and frozen are different states and render differently');
  assert.equal(v.navWad, 0n);
});

// ── Proposal: absent vs unread ──────────────────────────────────────────────────────────────────

test('proposal id 0 is a known absence', () => {
  assert.equal(assembleProposal(0, { status: 1n }), null);
  assert.equal(assembleProposal(0n, null), null);
});

test('Status.None is an absence even when a record comes back', () => {
  assert.equal(assembleProposal(41, { status: 0n }), null);
});

test('assembleVault leaves proposal null only when told, never by defaulting a read it did not get', () => {
  // The caller passes `'unknown'` through for a vault whose governance was not read. If this
  // module coerced that to null, `resolveExitMode` would assert instant settlement on a vault
  // that may be mid-reveal, telling a holder their exit is instant when it would queue.
  const v = assembleVault({
    address: VAULT,
    core: { navWad: wad(1), totalShares: wad(1), idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
    proposal: 'unknown',
  });
  assert.equal(v.proposal, 'unknown');
});

test('a live proposal decodes every deadline, and 0 deadlines become null not 1970', () => {
  const p = assembleProposal(41, {
    ptype: 0n,
    proposer: GOV,
    createdAt: BigInt(NOW - 5 * 3600),
    commitDeadline: BigInt(NOW - 3600),
    revealDeadline: BigInt(NOW + 2 * 3600),
    executableAt: 0n,
    expiresAt: 0n,
    status: 1n,
    actionHash: '0xab',
    snapshotTotal: wad(4_450_000),
    memberCount: 23n,
    forWeight: wad(1_691_000),
    againstWeight: wad(267_000),
    revealedWeight: wad(1_958_000),
    revealedVoterCount: 11n,
  });
  assert.equal(p.pid, 41);
  assert.equal(p.ptype, 'Rebalance');
  assert.equal(p.status, 'Active');
  assert.equal(p.commitDeadline, NOW - 3600);
  assert.equal(p.revealDeadline, NOW + 2 * 3600);
  assert.equal(p.executableAt, null, 'an unset deadline is unknown, not the epoch');
  assert.equal(p.expiresAt, null);
  assert.equal(p.memberCount, 23);
  assert.equal(p.forWeight, wad(1_691_000));
});

test('enum ordinals match the contract declaration order', () => {
  assert.deepEqual([...PROPOSAL_TYPE_BY_ORDINAL], ['Rebalance', 'RuleChange', 'ChildAllocation']);
  assert.deepEqual([...PROPOSAL_STATUS_BY_ORDINAL], ['None', 'Active', 'Passed', 'Defeated', 'Executed', 'Expired']);
});

// ── Oracle freshness comes from the feed's own heartbeat ────────────────────────────────────────

test('a leg takes its staleness bound from the feed heartbeat, not a constant', () => {
  const leg = assembleLeg({
    address: WETH,
    symbol: 'WETH',
    decimals: 18,
    assetUnit: 10n ** 18n,
    balance: 578_400_000_000_000_000_000n,
    priceWad: wad(3500),
    feed: { feed: '0xfeed000000000000000000000000000000000001', heartbeat: 1200n },
    oracleUpdatedAt: NOW - 40,
  });
  assert.equal(leg.maxStalenessSec, 1200);
  assert.equal(leg.oracleUpdatedAt, NOW - 40);
  assert.equal(leg.valueWad, wad(2_024_400));
});

// ── The whole vault, priced to its parts ────────────────────────────────────────────────────────

test('assembled NAV equals idle plus every leg, the way VaultCore.navWad sums it', () => {
  const usdcScalar = 10n ** 12n;
  const idleUsdc = 482_040_150_000n; // 482,040.15 USDC, 6 decimals
  const legs = [
    assembleLeg({ address: WETH, symbol: 'WETH', decimals: 18, assetUnit: 10n ** 18n, balance: 578_400_000_000_000_000_000n, priceWad: wad(3500), feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW - 40 }),
    assembleLeg({ address: '0xcb', symbol: 'cbBTC', decimals: 8, assetUnit: 10n ** 8n, balance: 2_318_597_557n, priceWad: wad(99_800), feed: { feed: '0xf2', heartbeat: 1200n }, oracleUpdatedAt: NOW - 95 }),
  ];
  const navWad = idleUsdc * usdcScalar + legs[0].valueWad + legs[1].valueWad;

  const v = assembleVault({
    address: VAULT,
    core: { navWad, totalShares: wad(4_450_000), idleUsdc, usdcScalar, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT, childVaultCount: 0n },
    legs,
    blockNumber: 1234n,
  });

  const summed = v.idleUsdc * v.usdcScalar + v.basket.reduce((a, l) => a + l.valueWad, 0n);
  assert.equal(v.navWad, summed, 'NAV must equal its parts or two panels show different numbers');
  assert.equal(v.basket.reduce((a, l) => a + l.weightBps, 0) < 10_000, true, 'idle cash holds the remainder');
  assert.equal(v.blockNumber, 1234n, 'freshness travels with the data');
  assert.equal(v.chainRead, true);
});

// ── The two lists stay complements of each other ────────────────────────────────────────────────

test('everything the indexer cannot carry is either filled here or still listed as missing', () => {
  // MISSING_IN_LIVE is the projection's own admission of what it lacks. If a row is added there
  // and nothing here fills it, this test says so rather than leaving a field silently empty.
  const missing = MISSING_IN_LIVE.map(([field]) => field);
  const unfilled = ['Exit-fee ceiling and decay period'];
  for (const field of missing) {
    const filled = [
      'NAV, NAV/share, basket composition',
      'Oracle freshness / frozen state',
      'Proposal deadlines — so exit Mode I vs F',
      'Your position, pending deposit and queued exit',
    ].includes(field);
    assert.ok(
      filled || unfilled.includes(field),
      `${field} is missing from the projection and neither filled by a chain read nor listed as a known gap`,
    );
  }
});
