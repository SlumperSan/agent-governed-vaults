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
  LEG_SAFETY_UNREAD,
  PROPOSAL_STATUS_BY_ORDINAL,
  PROPOSAL_TYPE_BY_ORDINAL,
  assembleLeg,
  assembleLegSafety,
  assembleProposal,
  assembleVault,
  legValueWad,
  navPerShareWad,
  planBasketAssets,
  planCore,
  planFeeds,
  planLegSafety,
  planLegs,
  planPosition,
  planProposal,
  planProposalId,
  weightsBps,
} from '../src/chain-reader.mjs';
import { MISSING_IN_LIVE } from '../src/live-adapter.mjs';
import {
  VAULT_VIEWS, GOVERNANCE_VIEWS, CHAINLINK_ORACLE_VIEWS, AGGREGATOR_V3_VIEWS, TOKEN_SAFETY_VIEWS,
} from '../../../packages/canary/src/abis.mjs';

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
  TOKEN_SAFETY_VIEWS,
};

// ── The planner names only functions that exist ────────────────────────────────────────────────

test('every planned call names a real fragment in the table it claims', () => {
  const planned = [
    ...planCore(VAULT),
    ...planBasketAssets(VAULT, 2),
    ...planProposalId(GOV, VAULT),
    ...planLegs(VAULT, ORACLE, [WETH]),
    ...planLegSafety(VAULT, [WETH]),
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

test('planLegSafety plans paused() and isBlacklisted(vault) for every leg, in order', () => {
  const CBBTC = '0xcb00000000000000000000000000000000cb00';
  const calls = planLegSafety(VAULT, [WETH, CBBTC]);
  assert.equal(calls.length, 4);
  assert.deepEqual(
    calls.map((c) => [c.address, c.fn, c.args]),
    [
      [WETH, 'paused', []],
      [WETH, 'isBlacklisted', [VAULT]],
      [CBBTC, 'paused', []],
      [CBBTC, 'isBlacklisted', [VAULT]],
    ],
  );
  assert.equal(planLegSafety(VAULT, []).length, 0);
});

// ── Card #32: paused()/isBlacklisted() per leg — FAILURE DIRECTION FIRST ───────────────────────
//
// The whole point of this card: a failed read must render as 'unknown', NEVER as the safe-looking
// boolean. Every shape a failure can take — a throw the caller catches into `null`, a timeout the
// caller also catches into `null`, a revert (same), and a call that "succeeds" but the caller could
// not decode into a strict boolean — is asserted here, BEFORE the happy path, and each assertion
// names explicitly that the result is not the healthy value.

test('a thrown call (caller passes null) renders paused as unknown, never active', () => {
  const leg = assembleLegSafety({
    address: WETH, pausedValue: null, pausedReadAt: NOW, blacklistedValue: false, blacklistedReadAt: NOW,
  });
  assert.equal(leg.paused, 'unknown');
  assert.notEqual(leg.paused, 'active', 'a failed read must never look like "not paused"');
});

test('a timed-out call (caller passes null) renders isBlacklisted as unknown, never clear', () => {
  const leg = assembleLegSafety({
    address: WETH, pausedValue: false, pausedReadAt: NOW, blacklistedValue: null, blacklistedReadAt: NOW,
  });
  assert.equal(leg.blacklisted, 'unknown');
  assert.notEqual(leg.blacklisted, 'clear');
});

test('a reverting call renders unknown for both reads, not a mix of unknown and healthy', () => {
  const leg = assembleLegSafety({
    address: WETH, pausedValue: null, pausedReadAt: NOW, blacklistedValue: null, blacklistedReadAt: NOW,
  });
  assert.equal(leg.paused, 'unknown');
  assert.equal(leg.blacklisted, 'unknown');
});

test('a call returning data that is not a strict boolean renders unknown, not a coerced boolean', () => {
  // A truthy non-boolean (an object, a numeric 1, a string) must not be treated as `true`, and a
  // falsy non-boolean (0, '', undefined) must not be treated as `false` either — only the EXACT
  // booleans the contract can actually return may resolve to a definite state.
  for (const bogus of [1, 0, '', 'false', 'true', undefined, {}, [], NaN]) {
    const leg = assembleLegSafety({
      address: WETH, pausedValue: bogus, pausedReadAt: NOW, blacklistedValue: bogus, blacklistedReadAt: NOW,
    });
    assert.equal(leg.paused, 'unknown', `pausedValue ${JSON.stringify(bogus)} must render unknown`);
    assert.equal(leg.blacklisted, 'unknown', `blacklistedValue ${JSON.stringify(bogus)} must render unknown`);
  }
});

test('no assembled leg-safety state is ever "not paused" or "clear" from a failed read, across every failure shape', () => {
  const failureShapes = [null, undefined, 0, 1, '', 'paused', NaN, {}, []];
  for (const bogus of failureShapes) {
    const leg = assembleLegSafety({
      address: WETH, pausedValue: bogus, pausedReadAt: NOW, blacklistedValue: bogus, blacklistedReadAt: NOW,
    });
    assert.notEqual(leg.paused, 'active');
    assert.notEqual(leg.blacklisted, 'clear');
  }
});

// ── Now the happy path ──────────────────────────────────────────────────────────────────────────

test('a clean read renders the real boolean, not unknown', () => {
  const healthy = assembleLegSafety({
    address: WETH, pausedValue: false, pausedReadAt: NOW, blacklistedValue: false, blacklistedReadAt: NOW,
  });
  assert.equal(healthy.paused, 'active');
  assert.equal(healthy.blacklisted, 'clear');

  const alarming = assembleLegSafety({
    address: WETH, pausedValue: true, pausedReadAt: NOW, blacklistedValue: true, blacklistedReadAt: NOW,
  });
  assert.equal(alarming.paused, 'paused');
  assert.equal(alarming.blacklisted, 'blacklisted');
});

// ── Each leg, and each call on a leg, carries its OWN read timestamp ───────────────────────────

test('pausedReadAt and blacklistedReadAt are carried through unchanged, not stamped with a shared now', () => {
  const leg = assembleLegSafety({
    address: WETH, pausedValue: false, pausedReadAt: NOW, blacklistedValue: true, blacklistedReadAt: NOW + 4,
  });
  assert.equal(leg.pausedReadAt, NOW);
  assert.equal(leg.blacklistedReadAt, NOW + 4);
  assert.notEqual(leg.pausedReadAt, leg.blacklistedReadAt, 'two calls read seconds apart are two facts, not one');
});


test('BLOCKER: a REORDERED safety array cannot hand one leg another leg\'s safety state', () => {
  // THE FAILURE THIS CLOSES, in the shape it was demonstrated. The merge was `r.legSafety[i]`, so a
  // caller that assembled the array in a different order than the basket rendered a PAUSED and
  // BLACKLISTED asset as `active` / `clear` with a fresh timestamp. A confident wrong answer, which is
  // strictly worse than the `unknown` the tri-state exists to preserve — and the ordered-array test
  // beside this one could never see it, because index and identity agree there.
  const legA = assembleLeg({ address: WETH, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const legB = assembleLeg({ address: '0xcb', assetUnit: 10n ** 8n, balance: 1n, priceWad: 1n, feed: { feed: '0xf2', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  // Leg B is the dangerous one: paused AND blacklisted.
  const safetyA = assembleLegSafety({ address: WETH, pausedValue: false, pausedReadAt: NOW - 10, blacklistedValue: false, blacklistedReadAt: NOW - 9 });
  const safetyB = assembleLegSafety({ address: '0xcb', pausedValue: true, pausedReadAt: NOW - 4, blacklistedValue: true, blacklistedReadAt: NOW - 3 });

  const v = assembleVault({
    address: VAULT,
    core: { navWad: 2n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
    legs: [legA, legB],
    legSafety: [safetyB, safetyA], // REVERSED
  });

  assert.equal(v.basket[1].paused, 'paused', 'the paused leg must still read paused when the array order differs');
  assert.equal(v.basket[1].blacklisted, 'blacklisted');
  assert.equal(v.basket[1].pausedReadAt, NOW - 4, 'and it must keep its OWN timestamp, not the other leg\'s');
  assert.equal(v.basket[0].paused, 'active');
  assert.equal(v.basket[0].blacklisted, 'clear');
  assert.equal(v.basket[0].pausedReadAt, NOW - 10);
});

test('a safety record for an address that is not in the basket reaches no leg at all', () => {
  const leg = assembleLeg({ address: WETH, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const stranger = assembleLegSafety({ address: '0xdeadbeef', pausedValue: false, pausedReadAt: NOW, blacklistedValue: false, blacklistedReadAt: NOW });

  const v = assembleVault({
    address: VAULT,
    core: { navWad: 1n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
    legs: [leg],
    legSafety: [stranger],
  });
  assert.equal(v.basket[0].paused, 'unknown', 'a record naming another asset must not clear this leg');
  assert.equal(v.basket[0].blacklisted, 'unknown');
  assert.equal(v.basket[0].pausedReadAt, null);
});

test('TWO records naming one address make it ambiguous, and ambiguity reads unknown', () => {
  // Fails closed rather than picking one. "Two answers" about whether an asset is paused is not an
  // answer, and the one thing that must never come out of this function is a clean bill of health
  // nobody established.
  const leg = assembleLeg({ address: WETH, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const first = assembleLegSafety({ address: WETH, pausedValue: false, pausedReadAt: NOW, blacklistedValue: false, blacklistedReadAt: NOW });
  const second = assembleLegSafety({ address: WETH, pausedValue: true, pausedReadAt: NOW + 1, blacklistedValue: true, blacklistedReadAt: NOW + 1 });

  const v = assembleVault({
    address: VAULT,
    core: { navWad: 1n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
    legs: [leg],
    legSafety: [first, second],
  });
  assert.equal(v.basket[0].paused, 'unknown');
  assert.equal(v.basket[0].blacklisted, 'unknown');
});

test('THREE OR MORE records naming one address stay ambiguous - two is the arity that proves nothing', () => {
  // At exactly two records `safetyByAddress.has(key)` carries the whole check and the `ambiguous`
  // SET never matters: deleting it leaves two-record ambiguity working. The set exists for the third
  // record, which finds `has(key)` FALSE - the second one deleted the entry - and would re-insert,
  // handing the leg a clean bill of health assembled from three contradictory reads. Every arity from
  // 2 to 5 is checked, because "an odd number of duplicates re-inserts" is the shape of the bug.
  const leg = assembleLeg({ address: WETH, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  for (const n of [2, 3, 4, 5]) {
    const records = [];
    for (let i = 0; i < n; ++i) {
      records.push(assembleLegSafety({
        address: i % 2 === 0 ? WETH : WETH.toUpperCase(), // and the duplicate may be checksummed
        pausedValue: i % 2 === 0,
        pausedReadAt: NOW + i,
        blacklistedValue: i % 2 === 0,
        blacklistedReadAt: NOW + i,
      }));
    }
    const v = assembleVault({
      address: VAULT,
      core: { navWad: 1n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
      legs: [leg],
      legSafety: records,
    });
    assert.equal(v.basket[0].paused, 'unknown', `${n} records for one address must stay ambiguous`);
    assert.equal(v.basket[0].blacklisted, 'unknown', `${n} records for one address must stay ambiguous`);
    assert.equal(v.basket[0].pausedReadAt, null, `${n} records: an ambiguous leg must carry no timestamp either`);
  }
});

test('a record with NO address is dropped, and an address-less leg does not collect it', () => {
  // `if (!key) continue` in the merge. Without it the record is stored under the '' key, and
  // `lcAddr` returns '' for any leg whose address is missing or not a string - so that leg LOOKS UP
  // the address-less record and inherits its state. That is blocker 1 of this PR returning by a
  // different door, and it needs a leg with no address to show, which no other test builds.
  const namedLeg = assembleLeg({ address: WETH, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const anonLeg = assembleLeg({ address: undefined, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf2', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  for (const missing of [undefined, null, '', '   ', 42, {}]) {
    const orphan = assembleLegSafety({ address: missing, pausedValue: false, pausedReadAt: NOW, blacklistedValue: false, blacklistedReadAt: NOW });
    const v = assembleVault({
      address: VAULT,
      core: { navWad: 1n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
      legs: [namedLeg, anonLeg],
      legSafety: [orphan],
    });
    const why = `address ${JSON.stringify(missing)}`;
    // 'active'/'clear' is the DANGEROUS answer here: a clean bill of health nobody established.
    assert.equal(v.basket[0].paused, 'unknown', `${why}: a named leg must not collect an unaddressed record`);
    assert.equal(v.basket[1].paused, 'unknown', `${why}: an address-less leg must not collect it either`);
    assert.equal(v.basket[1].blacklisted, 'unknown', `${why}: nor its blacklist state`);
  }
});

test('address matching is case-insensitive, because a checksummed address is the same asset', () => {
  const leg = assembleLeg({ address: WETH.toLowerCase(), assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const safety = assembleLegSafety({ address: WETH.toUpperCase(), pausedValue: true, pausedReadAt: NOW, blacklistedValue: false, blacklistedReadAt: NOW });
  const v = assembleVault({
    address: VAULT,
    core: { navWad: 1n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
    legs: [leg],
    legSafety: [safety],
  });
  assert.equal(v.basket[0].paused, 'paused', 'a checksum difference must not silently lose a paused state');
});

test('assembleVault merges per-leg safety by ADDRESS, each leg keeping its own timestamps', () => {
  const legA = assembleLeg({ address: WETH, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const legB = assembleLeg({ address: '0xcb', assetUnit: 10n ** 8n, balance: 1n, priceWad: 1n, feed: { feed: '0xf2', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const safetyA = assembleLegSafety({ address: WETH, pausedValue: false, pausedReadAt: NOW - 10, blacklistedValue: false, blacklistedReadAt: NOW - 9 });
  const safetyB = assembleLegSafety({ address: '0xcb', pausedValue: null, pausedReadAt: NOW - 4, blacklistedValue: true, blacklistedReadAt: NOW - 3 });

  const v = assembleVault({
    address: VAULT,
    core: { navWad: 2n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
    legs: [legA, legB],
    // REVERSED on purpose. With `[safetyA, safetyB]` the array is already in basket order, so the
    // index merge this PR replaced produces the identical result and the test named "by ADDRESS"
    // passes with the defect restored. The order has to disagree with the legs for the assertion to
    // be about identity rather than about position.
    legSafety: [safetyB, safetyA],
  });

  assert.equal(v.basket[0].paused, 'active');
  assert.equal(v.basket[0].pausedReadAt, NOW - 10);
  assert.equal(v.basket[1].paused, 'unknown', 'leg B\'s failed paused() read must not borrow leg A\'s healthy state');
  assert.equal(v.basket[1].blacklisted, 'blacklisted');
  assert.notEqual(
    v.basket[0].pausedReadAt, v.basket[1].pausedReadAt,
    'two legs read at different times are two distinct facts, not one shared timestamp',
  );
});

test('a leg with no safety reads supplied at all defaults to LEG_SAFETY_UNREAD — unknown, never healthy', () => {
  const leg = assembleLeg({ address: WETH, assetUnit: 10n ** 18n, balance: 1n, priceWad: 1n, feed: { feed: '0xf1', heartbeat: 1200n }, oracleUpdatedAt: NOW });
  const v = assembleVault({
    address: VAULT,
    core: { navWad: 1n, totalShares: 1n, idleUsdc: 0n, usdcScalar: 10n ** 12n, totalPendingUsdc: 0n, oracle: ORACLE, governance: GOV, creator: VAULT },
    legs: [leg],
    // legSafety deliberately omitted
  });
  assert.equal(v.basket[0].paused, LEG_SAFETY_UNREAD.paused);
  assert.equal(v.basket[0].paused, 'unknown');
  assert.equal(v.basket[0].blacklisted, 'unknown');
  assert.equal(v.basket[0].pausedReadAt, null);
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
