// @ts-check
/**
 * Signal (h) — OPERATOR POWER. Closes G1 (OPS-5, "operator dilution below `proposalThresholdBps`.
 * Undetected: indefinitely") from Business/Operations/Monitoring Gap Analysis.md §2 — see §3 item 2
 * for the spec this file implements.
 *
 * WHAT THIS EXISTS FOR. Nothing on-chain computes `operatorShares / totalShares` against the stake
 * threshold that gates the operator's own governance rights. As ordinary member deposits dilute the
 * vault, the operator's proportional stake falls — passively, with no action on anyone's part — and
 * the failure only surfaces the moment the operator's next `propose()` reverts `BelowProposalThreshold`,
 * potentially weeks or months after the crossing. If the vault has meanwhile filled to within one
 * minimum deposit of `capacityCapUsdc`, that is also the point past which the operator can no longer
 * deposit to shore up their own position, because the vault cannot accept the deposit either. This
 * signal exists to surface the approach, not just the crossing.
 *
 * THIS IS DILUTION BY DESIGN, NOT A BUG. `Governance._validateConfig` enforces no floor on
 * `proposalThresholdBps` (M-6) — a floor was implemented and then deliberately reverted; see
 * `contracts/test/audit/AuditProposalThresholdFloor.t.sol` and docs/NOW.md "Traps that are not
 * visible in the code". The operator's stake is real capital at risk (Business/Finance/Operator
 * Capital Requirement.md): staying above the gate requires the operator to deposit alongside members,
 * exactly like anyone else. This signal never claims otherwise, and never claims the vault, the
 * operator, or a member is owed any particular outcome — it reports a share of voting stake against a
 * configured threshold, nothing else.
 *
 * TWO INDEPENDENT GATES, MEASURED AGAINST TWO DIFFERENT SHARE QUANTITIES. "500 bps at launch" names
 * two DIFFERENT numbers that happen to start equal, and — the part the first cut of this file got
 * wrong (Review115 F1) — they are not even fractions of the same denominator:
 *   1. Governance's `configOf(vault).proposalThresholdBps` — gates the operator's own next
 *      `propose()` call (`Governance.sol:287-291`, `BelowProposalThreshold`). It compares
 *      `pastVotingEligibleShares` against `pastTotalVotingEligibleShares`, i.e. VOTING-ELIGIBLE
 *      stake: `sharesOf - queuedExitShares`, with a registered parent vault counted as 0
 *      (`VaultCore.sol:968-977`). A queued Mode-F exit removes weight the instant it is queued
 *      (`VaultCore.sol:515-517` — "locked shares leave eligible stake immediately"), so an operator
 *      with an open exit request can be unable to propose RIGHT NOW while the raw book still shows
 *      them comfortably above the bar. Configurable per vault, and can even be 0 (M-6 again).
 *   2. VaultCore's `CREATOR_MIN_STAKE_BPS` — a protocol CONSTANT (500 bps everywhere) that gates the
 *      operator's own voluntary EXIT while non-creator members remain (`_checkCreatorGate`,
 *      `CreatorStakeGate`). That one genuinely uses the RAW book — `_checkCreatorGate` reads
 *      `sharesOf` and `totalShares` (`VaultCore.sol:555-560`) — so it is measured raw here. Only
 *      live once `nonCreatorMemberCount > 0`.
 * Each leg carries its own `measuredBps` and says which book it was measured against; the signal
 * never collapses the two into one number.
 *
 * TWO BARS, TWO TRANSITION KEYS. WARN at operator power <= 1.5x the threshold, ALERT at <= 1.1x.
 * Both map to `alert()` — this package's vocabulary has no fourth status. They are emitted as TWO
 * results under the fixed keys `early-warning` and `critical`, and that is load-bearing rather than
 * cosmetic: `transitions.mjs` keys tracked state on STATUS ALONE, so a single result deteriorating
 * from WARN to CRITICAL is `alert` -> `alert` and emits NO transition at all. On the ordinary
 * monotone-dilution path (cross 1.5x, then later cross 1.1x) a one-result signal therefore delivers
 * the WARN line and then never delivers the CRITICAL one — the line that says "decision needed now"
 * would reach nobody. Under two keys the critical bar makes its own ok->alert transition and pages
 * (see `CONDITIONAL_PAGE` in sinks.mjs). Both keys are emitted on EVERY sweep, including the
 * skipped/detector-broken paths, so no tracked id ever disappears and goes stale.
 *
 * HEADROOM. `detail.thresholds[].depositHeadroomUsdc` is how much further NON-OPERATOR deposit
 * (native USDC units) would dilute the operator down to exactly that gate's `bps`, solved from
 * `VaultCore._mintShares`'s own formula (`minted = amountUsdc * usdcScalar * totalShares / navWad`).
 * Holding NAV-per-share fixed is not an approximation: `_mintShares` does `navWad += amountWad` and
 * `totalShares += amountWad * totalShares / navWad`, which preserves NAV-per-share exactly, so the
 * number is exact whether the deposit lands as one transfer or a thousand (and the integer floor on
 * `minted` makes it very slightly conservative — the crossing lands at or after the estimate, never
 * before). What it does NOT account for: (a) `totalPendingUsdc` — first-time deposits already
 * escrowed will activate and dilute on their own, so the headroom that remains for NEW money is
 * smaller than this number by that much; (b) trading moving NAV between a pending deposit and its
 * activation, since `_activatePending` prices at activation-time NAV. 0 means the vault is already
 * at or past that gate.
 *
 * TOP-UP PATH. `detail.noTopUpPath` is the operator's own side of the same arithmetic, and it is
 * deliberately WIDER than "the vault is literally full" (Review115 F2). Restoring the fraction to a
 * gate needs a deposit of at least `topUpDeficitUsdc`; `_deposit` will reject anything below
 * `minDepositUsdc` (`VaultCore.sol:369`) and anything that would push `navUsdc + totalPendingUsdc`
 * past `capacityCapUsdc` (`VaultCore.sol:374-375`). So the operator is locked out whenever
 * `max(deficit, minDeposit) > cap - committed`, which is the "the top-up must LEAD the fill, not
 * chase it" point of no return in Business/Finance/Operator Capital Requirement.md, not the much
 * later moment the vault reaches its cap. Worked case from that note: cap 50,000, operator 2,000,
 * others 47,600 — restoring 5% needs 505.27 and only 400 of headroom is left, so the operator is
 * already locked out while `committed (49,600) < cap (50,000)`.
 */

import { VAULT_VIEWS, GOVERNANCE_VIEWS } from '../abis.mjs';
import { ok, alert, skipped, detectorBroken, shortAddr, bpsToPct } from '../signal.mjs';

export const SIGNAL = 'operator-power';

const BPS = 10000n;
const isZero = (a) => typeof a !== 'string' || /^0x0{40}$/i.test(a);

/** WARN at <= 1.5x threshold, ALERT at <= 1.1x — exact rational multipliers, integer math only. */
const WARN_NUM = 15n;
const WARN_DEN = 10n;
const ALERT_NUM = 11n;
const ALERT_DEN = 10n;

/**
 * The two transition keys this signal always emits under. `early-warning` tracks the 1.5x bar,
 * `critical` the 1.1x bar. See the "TWO BARS" note above for why this is not one result.
 */
export const EARLY_WARNING_KEY = 'early-warning';
export const CRITICAL_KEY = 'critical';

/** @type {Record<'ok'|'warn'|'alert', number>} */
const RANK = { ok: 0, warn: 1, alert: 2 };

/** Ceiling division for positive integers — never understate a required deposit. */
const ceilDiv = (a, b) => (a + b - 1n) / b;

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {string} ctx.operator   the vault's `creator()` — the operator-of-record whose stake both
 *                                 gates below are keyed to (read once by the runner, shared with
 *                                 exit-liveness; see canary-runner.mjs)
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkOperatorPower({ reader, vault, operator }) {
  const V = (fn, args = []) => reader.tryRead(vault, VAULT_VIEWS, fn, args);

  // REQUIRED: the two share-fraction computations themselves. Plain accounting state, unrelated to
  // the oracle, so a tripped price breaker must never blind this signal the way it (correctly)
  // DEGRADES nav-backing and exit-liveness — dilution is exactly as visible during a freeze as
  // any other time, and is arguably MORE important to see then.
  //
  // The voting-eligible pair is REQUIRED, not best-effort, on purpose: falling back to the raw book
  // when it is unreadable would silently reinstate exactly the wrong-quantity comparison this
  // signal was rejected for. Both views are Sprint-1 vintage (`02285391`) and exist on every
  // VaultCore ever deployed from this repo, so a failure here means the RPC is unwell, not that the
  // contract lacks them.
  const names = [
    'totalShares', 'sharesOf', 'nonCreatorMemberCount', 'CREATOR_MIN_STAKE_BPS',
    'votingEligibleShares', 'totalVotingEligibleShares',
  ];
  const [totalSharesR, opSharesR, nonCreatorR, constR, eligOwnR, eligTotalR, govAddrR] = await Promise.all([
    V('totalShares'), V('sharesOf', [operator]), V('nonCreatorMemberCount'),
    V('CREATOR_MIN_STAKE_BPS'), V('votingEligibleShares', [operator]), V('totalVotingEligibleShares'),
    V('governance'),
  ]);
  const required = [totalSharesR, opSharesR, nonCreatorR, constR, eligOwnR, eligTotalR];
  if (required.some((r) => !r.ok)) {
    const failed = names.filter((_, i) => !required[i].ok);
    return bothKeys((key) => detectorBroken({
      signal: SIGNAL, vault, key,
      message: `OPERATOR POWER DETECTOR BLIND on vault ${shortAddr(vault)}: ${failed.join(', ')} unreadable — operator dilution (G1) is UNMONITORED for this vault, not healthy`,
      detail: { vault, operator, unreadable: failed, bar: key },
    }));
  }

  const totalShares = BigInt(totalSharesR.value);
  if (totalShares === 0n) {
    return bothKeys((key) => skipped({
      signal: SIGNAL, vault, key,
      message: `operator power cannot be measured on vault ${shortAddr(vault)}: totalShares is 0 (no deposits have activated yet)`,
      detail: { vault, operator, totalShares: '0', bar: key },
    }));
  }

  const opShares = BigInt(opSharesR.value);
  const operatorBps = (opShares * BPS) / totalShares;
  const nonCreatorMemberCount = BigInt(nonCreatorR.value);
  const creatorMinStakeBps = BigInt(constR.value);

  // Voting-eligible book — the quantity `Governance.propose` actually gates on. `totalEligible` can
  // legitimately be 0 while `totalShares` is not (every holder queued a Mode-F exit); the operator
  // then has zero weight, `propose()` reverts `NoWeight()` before it ever reaches the threshold
  // comparison, and 0 bps correctly reads as ALERT against any non-zero gate.
  const eligibleOwn = BigInt(eligOwnR.value);
  const eligibleTotal = BigInt(eligTotalR.value);
  const eligibleBps = eligibleTotal === 0n ? 0n : (eligibleOwn * BPS) / eligibleTotal;

  // BEST-EFFORT: only feeds the informational headroom/capacity context, priced through navWad —
  // which reverts StaleOracle for the exact same reason nav-backing DEGRADES. A tripped breaker
  // must not blind the WARN/ALERT verdict above; it only means the USDC headroom estimate and the
  // top-up-path determination cannot be computed this sweep, which is said plainly rather than
  // guessed at. `detail.capacityAssessed` is how a reader tells "there IS a top-up path" from
  // "we could not tell" — the two used to be indistinguishable (Review115 F2c).
  const [capR, minDepR, navR, scalarR, pendingR] = await Promise.all([
    V('capacityCapUsdc'), V('minDepositUsdc'), V('navWad'), V('usdcScalar'), V('totalPendingUsdc'),
  ]);
  const navAvailable = capR.ok && minDepR.ok && navR.ok && scalarR.ok && pendingR.ok;
  const capacityCapUsdc = navAvailable ? BigInt(capR.value) : 0n;
  const minDepositUsdc = navAvailable ? BigInt(minDepR.value) : 0n;
  const navWad = navAvailable ? BigInt(navR.value) : 0n;
  const usdcScalar = navAvailable ? BigInt(scalarR.value) : 0n;
  const totalPendingUsdc = navAvailable ? BigInt(pendingR.value) : 0n;

  const navUsdc = navAvailable && usdcScalar > 0n ? navWad / usdcScalar : 0n;
  const committedUsdc = navUsdc + totalPendingUsdc;
  const capped = navAvailable && capacityCapUsdc !== 0n;
  // Factual, and kept because it is the plainest thing to read in `detail`: the vault is literally
  // full. It is NOT the lockout condition — see `noTopUpPath` on each leg.
  const atCapacity = capped && committedUsdc >= capacityCapUsdc;
  const capacityHeadroomUsdc = capped
    ? (capacityCapUsdc > committedUsdc ? capacityCapUsdc - committedUsdc : 0n)
    : null;

  const { thresholds: govThresholds, note: govLegNote } = await governanceLeg({ reader, govAddrR, vault });

  /** @type {Array<{name:string, label:string, bps:bigint, measuredBps:bigint, book:string}>} */
  const thresholds = govThresholds.map((t) => ({ ...t, measuredBps: eligibleBps, book: 'voting-eligible' }));
  if (nonCreatorMemberCount > 0n && creatorMinStakeBps > 0n) {
    thresholds.push({
      name: 'creatorMinStakeBps', label: "VaultCore's CREATOR_MIN_STAKE_BPS exit gate",
      bps: creatorMinStakeBps, measuredBps: operatorBps, book: 'raw',
    });
  }

  if (thresholds.length === 0) {
    return bothKeys((key) => skipped({
      signal: SIGNAL, vault, key,
      message: `operator power measured but no binding threshold is active on vault ${shortAddr(vault)}: operator holds ${bpsToPct(operatorBps)} of shares, but ${govLegNote ?? 'proposalThresholdBps is 0'} and no non-creator member has joined yet (the exit gate is not live)`,
      detail: { vault, operator, operatorBps: operatorBps.toString(), eligibleBps: eligibleBps.toString(), govLegNote, bar: key },
    }));
  }

  const legs = thresholds.map((t) => evaluateLeg({
    t, opShares, totalShares, eligibleOwn, eligibleTotal,
    navWad, usdcScalar, capped, capacityHeadroomUsdc, minDepositUsdc, navAvailable,
  }));
  const worst = legs.reduce((w, l) => (RANK[l.level] > RANK[w] ? l.level : w), 'ok');
  const worstLeg = pickWorstLeg(legs, worst);
  const thresholdsDiffer = thresholds.length === 2 && thresholds[0].bps !== thresholds[1].bps;
  const detail = {
    vault, operator, level: worst,
    operatorBps: operatorBps.toString(), operatorShares: opShares.toString(), totalShares: totalShares.toString(),
    eligibleBps: eligibleBps.toString(), eligibleShares: eligibleOwn.toString(), totalEligibleShares: eligibleTotal.toString(),
    navAvailable, capacityAssessed: navAvailable, navUsdc: navUsdc.toString(),
    capacityCapUsdc: capacityCapUsdc.toString(), minDepositUsdc: minDepositUsdc.toString(),
    capacityHeadroomUsdc: capacityHeadroomUsdc === null ? null : capacityHeadroomUsdc.toString(),
    atCapacity, noTopUpPath: worstLeg.noTopUpPath,
    thresholds: legs, thresholdsDiffer, govLegNote,
  };

  return [
    barResult({ bar: EARLY_WARNING_KEY, breached: RANK[worst] >= RANK.warn, worst, worstLeg, legs, vault, operator, detail, navAvailable }),
    barResult({ bar: CRITICAL_KEY, breached: worst === 'alert', worst, worstLeg, legs, vault, operator, detail, navAvailable }),
  ];
}

/** Same non-measurable observation under both transition keys, so neither id ever goes missing. */
function bothKeys(make) {
  return [make(EARLY_WARNING_KEY), make(CRITICAL_KEY)];
}

/**
 * One bar's result. `breached` decides `alert()` vs `ok()`; `detail.level` stays the vault's OVERALL
 * worst level on both, so a reader of either line sees the same picture.
 */
function barResult({ bar, breached, worst, worstLeg, legs, vault, operator, detail, navAvailable }) {
  const base = { signal: SIGNAL, vault, key: bar, detail: { ...detail, bar } };
  const measured = bpsToPct(BigInt(worstLeg.measuredBps));
  if (!breached) {
    const suffix = worst === 'ok'
      ? `against ${legs.map((l) => `${l.label} (${bpsToPct(BigInt(l.bps))})`).join(' and ')}`
      : `— the ${bpsToPct(BigInt(worstLeg.bps))} ${worstLeg.label} is still clear of the 1.1x critical bar, but the 1.5x early-warning bar IS breached (see the ${EARLY_WARNING_KEY} line)`;
    return ok({
      ...base,
      message: `operator power healthy on vault ${shortAddr(vault)} at the ${bar} bar: ${shortAddr(operator)} holds ${measured} of the ${worstLeg.book} share book ${suffix}`,
      measured, threshold: legs.map((l) => bpsToPct(BigInt(l.bps))).join(' / '),
    });
  }

  const headroomClause = !navAvailable
    ? 'NAV is currently unreadable (see oracle-freshness) — neither the deposit headroom estimate nor the top-up-path determination could be computed this sweep, so no claim is made either way about whether a top-up is still possible'
    : worstLeg.depositHeadroomUsdc !== '0'
      ? `further non-operator deposits up to an estimated ${worstLeg.depositHeadroomUsdc} USDC (6dp; NAV-per-share is preserved exactly by _mintShares, so this is exact for new money — escrowed totalPendingUsdc will dilute on activation on top of it) would cross the ${worstLeg.label} threshold`
      : `the vault is already at or past the ${worstLeg.label} threshold — no deposit headroom remains`;
  const diffClause = detail.thresholdsDiffer
    ? ` Governance's proposalThresholdBps and VaultCore's CREATOR_MIN_STAKE_BPS differ on this vault — both gates are monitored (detail.thresholds)`
    : '';
  const capClause = worstLeg.noTopUpPath
    ? ` The vault cannot accept the deposit that would rebuild the margin — no top-up path — decision needed now: restoring the ${worstLeg.label} needs ${worstLeg.topUpDeficitUsdc} USDC (and any deposit at all needs ${detail.minDepositUsdc}, VaultCore's minDepositUsdc), against ${detail.capacityHeadroomUsdc} USDC of capacityCapUsdc headroom${detail.atCapacity ? ' — the vault is at its cap' : ' — the cap is not reached yet, but the top-up must LEAD the fill, not chase it'}`
    : '';

  return alert({
    ...base,
    message: `${worst === 'alert' ? 'OPERATOR POWER CRITICAL' : 'OPERATOR POWER WARNING'} on vault ${shortAddr(vault)}: ${shortAddr(operator)} holds ${measured} of the ${worstLeg.book} share book, within ${worst === 'alert' ? '1.1x' : '1.5x'} of the ${worstLeg.label} threshold ${bpsToPct(BigInt(worstLeg.bps))} (margin ${bpsToPct(BigInt(worstLeg.marginBps))}). This is passive dilution by design — VaultCore ships no floor on proposalThresholdBps (M-6) — and the operator's stake is real capital at risk, not a free privilege: ${headroomClause}.${diffClause}${capClause}`,
    measured, threshold: bpsToPct(BigInt(worstLeg.bps)),
  });
}

/**
 * The leg that decides the reported line. `level` alone is too coarse: with two legs at the SAME
 * level, taking the first in array order reports whichever gate happens to be listed first, which
 * can be the one with 466,666 USDC of headroom while the other is already frozen solid (Review115
 * F12). Tightest margin wins; the higher bar breaks a tie, and array order only breaks a tie in
 * both, so the choice is total and deterministic.
 */
function pickWorstLeg(legs, worst) {
  const atWorst = legs.filter((l) => l.level === worst);
  const pool = atWorst.length > 0 ? atWorst : legs;
  return pool.reduce((best, l) => {
    const dm = BigInt(l.marginBps) - BigInt(best.marginBps);
    if (dm !== 0n) return dm < 0n ? l : best;
    return BigInt(l.bps) > BigInt(best.bps) ? l : best;
  });
}

/**
 * The Governance leg is optional and gracefully degrades: an unregistered vault, a zero/unreadable
 * `governance()`, or a `proposalThresholdBps` of 0 (M-6: no floor) all mean "no propose-gate to
 * monitor here" rather than a detector fault — the VaultCore exit-gate leg still applies on its own.
 * A genuine read failure against a REGISTERED, non-zero governance is reported in `note` but does not
 * blind the whole signal, matching the graceful-per-leg style of feed-identity.mjs.
 */
async function governanceLeg({ reader, govAddrR, vault }) {
  if (!govAddrR.ok || isZero(govAddrR.value)) {
    return { thresholds: [], note: 'vault.governance() is unreadable or zero' };
  }
  const governanceAddr = govAddrR.value;
  const [registeredR, cfgR] = await Promise.all([
    reader.tryRead(governanceAddr, GOVERNANCE_VIEWS, 'vaultRegistered', [vault]),
    reader.tryRead(governanceAddr, GOVERNANCE_VIEWS, 'configOf', [vault]),
  ]);
  if (!registeredR.ok || !cfgR.ok) {
    return { thresholds: [], note: `Governance at ${shortAddr(governanceAddr)} unreadable: ${registeredR.error ?? cfgR.error}` };
  }
  if (!registeredR.value) {
    return { thresholds: [], note: 'vault is not registered with Governance — propose() reverts NotRegistered() regardless of stake' };
  }
  const proposalThresholdBps = BigInt(normalizeGovConfig(cfgR.value).proposalThresholdBps);
  if (proposalThresholdBps === 0n) {
    return { thresholds: [], note: 'Governance proposalThresholdBps is 0 — no stake gate configured on this vault (M-6: no floor, by design)' };
  }
  return {
    thresholds: [{ name: 'proposalThresholdBps', label: "Governance's proposalThresholdBps propose() gate", bps: proposalThresholdBps }],
    note: null,
  };
}

/** `configOf` is a mapping-to-struct getter, flattened to GovConfig's eight fields in order. */
function normalizeGovConfig(v) {
  const [
    commitDuration, revealDuration, timelockDuration, executionWindow,
    quorumBps, proposalThresholdBps, concentrationCapBps, proposalCooldown,
  ] = Array.isArray(v)
    ? v
    : [
      v?.commitDuration, v?.revealDuration, v?.timelockDuration, v?.executionWindow,
      v?.quorumBps, v?.proposalThresholdBps, v?.concentrationCapBps, v?.proposalCooldown,
    ];
  return {
    commitDuration, revealDuration, timelockDuration, executionWindow,
    quorumBps, proposalThresholdBps: proposalThresholdBps ?? 0, concentrationCapBps, proposalCooldown,
  };
}

/**
 * One gate, evaluated against the share book THAT gate actually reads — `measuredBps` is the
 * voting-eligible fraction for the Governance leg and the raw fraction for the VaultCore exit gate.
 * Every field is a JSON-safe primitive (bigints stringified) because this object rides straight into
 * `detail.thresholds`, which the webhook sink `JSON.stringify`s — a raw BigInt there throws rather
 * than serializing.
 */
function evaluateLeg({
  t, opShares, totalShares, eligibleOwn, eligibleTotal,
  navWad, usdcScalar, capped, capacityHeadroomUsdc, minDepositUsdc, navAvailable,
}) {
  const eligible = t.book === 'voting-eligible';
  const own = eligible ? eligibleOwn : opShares;
  const denom = eligible ? eligibleTotal : totalShares;
  const warnAt = (t.bps * WARN_NUM) / WARN_DEN;
  const alertAt = (t.bps * ALERT_NUM) / ALERT_DEN;
  const level = t.measuredBps <= alertAt ? 'alert' : t.measuredBps <= warnAt ? 'warn' : 'ok';
  // Share->USDC always converts through the RAW book: `_mintShares` mints
  // `amountUsdc * usdcScalar * totalShares / navWad` regardless of how much of that supply happens
  // to be Mode-F-locked. Only the FRACTION being solved for is measured in the gate's own book.
  const mint = { navWad, usdcScalar, rawTotalShares: totalShares };
  const headroomUsdc = dilutionHeadroomUsdc({ own, denom, thresholdBps: t.bps, ...mint });
  const deficitUsdc = topUpDeficitUsdc({ own, denom, thresholdBps: t.bps, ...mint });
  // `_deposit` rejects below `minDepositUsdc` BEFORE the cap check, so the smallest deposit that can
  // both land and help is `max(deficit, minDeposit)`. Uncapped vaults always have a path.
  const unreachable = deficitUsdc < 0n;
  const requiredUsdc = unreachable ? -1n : (deficitUsdc > minDepositUsdc ? deficitUsdc : minDepositUsdc);
  // An unreachable gate (>= 100%) has no top-up path at ANY capacity, capped or not.
  const noTopUpPath = navAvailable && (unreachable
    || (capped && capacityHeadroomUsdc !== null && requiredUsdc > capacityHeadroomUsdc));
  return {
    name: t.name, label: t.label, bps: t.bps.toString(), book: t.book,
    measuredBps: t.measuredBps.toString(),
    warnAtBps: warnAt.toString(), alertAtBps: alertAt.toString(), level,
    marginBps: (t.measuredBps - t.bps).toString(),
    depositHeadroomUsdc: headroomUsdc.toString(),
    topUpDeficitUsdc: deficitUsdc.toString(),
    requiredTopUpUsdc: requiredUsdc.toString(),
    noTopUpPath,
  };
}

/**
 * How much further NON-OPERATOR deposit (native USDC units) would dilute `own/denom` down to
 * exactly `thresholdBps`, solved from VaultCore._mintShares's own formula:
 *   minted = amountUsdc * usdcScalar * rawTotalShares / navWad
 *   own * BPS / (denom + minted) = thresholdBps
 *   => minted = own * BPS / thresholdBps - denom
 *   => amountUsdc = minted * navWad / (usdcScalar * rawTotalShares)
 * Returns 0n when the vault is already at or through the threshold — there is no headroom to
 * report, only a crossing already behind it.
 * @returns {bigint}
 */
function dilutionHeadroomUsdc({ own, denom, thresholdBps, navWad, usdcScalar, rawTotalShares }) {
  if (thresholdBps <= 0n || denom === 0n || rawTotalShares === 0n || usdcScalar === 0n || navWad === 0n) return 0n;
  const sharesAtThreshold = (own * BPS) / thresholdBps;
  if (sharesAtThreshold <= denom) return 0n;
  const neededMinted = sharesAtThreshold - denom;
  return (neededMinted * navWad) / (usdcScalar * rawTotalShares);
}

/**
 * The mirror image: how much the OPERATOR must deposit to bring `own/denom` back UP to exactly
 * `thresholdBps`. Their own deposit mints to themselves, so both sides move:
 *   (own + m) * BPS >= thresholdBps * (denom + m)
 *   => m * (BPS - thresholdBps) >= thresholdBps * denom - own * BPS
 *   => m >= ceil((thresholdBps * denom - own * BPS) / (BPS - thresholdBps))
 * then converted to USDC through `_mintShares` and rounded UP, because a deposit one unit short
 * does not clear the gate and a rounded-down figure would manufacture a top-up path that is not
 * there. 0 when the operator is already at or above the gate. A threshold at or above 100% cannot
 * be reached by depositing at all (the fraction only ever approaches 1 from below unless the
 * operator already holds everything), so it reports the sentinel `-1` rather than a finite number
 * a reader could act on.
 * @returns {bigint}
 */
function topUpDeficitUsdc({ own, denom, thresholdBps, navWad, usdcScalar, rawTotalShares }) {
  if (thresholdBps <= 0n || rawTotalShares === 0n || usdcScalar === 0n || navWad === 0n) return 0n;
  if (own * BPS >= thresholdBps * denom) return 0n;
  if (thresholdBps >= BPS) return -1n;
  const neededMinted = ceilDiv(thresholdBps * denom - own * BPS, BPS - thresholdBps);
  return ceilDiv(neededMinted * navWad, usdcScalar * rawTotalShares);
}
