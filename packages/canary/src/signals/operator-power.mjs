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
 * potentially weeks or months after the crossing. If the vault has meanwhile hit `capacityCapUsdc`,
 * that is also the point past which the operator can no longer deposit to shore up their own
 * position, because the vault cannot accept the deposit either. This signal exists to surface the
 * approach, not just the crossing.
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
 * TWO INDEPENDENT GATES, BOTH WATCHED. "500 bps at launch" names two DIFFERENT numbers that happen to
 * start equal:
 *   1. Governance's `configOf(vault).proposalThresholdBps` — gates the operator's own next
 *      `propose()` call (Governance.sol `BelowProposalThreshold`). Configurable per vault, and can
 *      even be 0 (no gate at all — M-6 again).
 *   2. VaultCore's `CREATOR_MIN_STAKE_BPS` — a protocol CONSTANT (500 bps everywhere) that gates the
 *      operator's own voluntary EXIT while non-creator members remain (`_checkCreatorGate`,
 *      `CreatorStakeGate`). Only live once `nonCreatorMemberCount > 0`.
 * A vault whose creator registered a different `proposalThresholdBps` than 500 has two gates that
 * bind at different margins. Both are read, both are evaluated, and `detail.thresholds` names both
 * plus whether they differ — this signal never assumes they agree.
 *
 * BARS. WARN at operator power <= 1.5x the (binding) threshold, ALERT at <= 1.1x. Both statuses map
 * to `alert()` — this package's vocabulary has no fourth status — and are distinguished by
 * `detail.level` and the message text, the same way `oracle-health.mjs`'s early-warning bar is a
 * WARN-worded `alert()` alongside the freeze ALERT under the same signal id. The worse of the two
 * gates decides the vault's status; both are still reported in `detail.thresholds`.
 *
 * HEADROOM. `detail.thresholds[].depositHeadroomUsdc` is an ESTIMATE of how much further
 * non-operator deposit (native USDC units) would dilute the operator down to exactly that gate's
 * `bps`, holding the operator's own shares and the current NAV-per-share fixed — solved from
 * `VaultCore._mintShares`'s own formula (`minted = amountUsdc * usdcScalar * totalShares / navWad`).
 * It is informational, not a quote: real deposits move NAVps as they land, so a large single deposit
 * crosses sooner than a naive read of this number suggests. 0 means the vault is already at or past
 * that gate.
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

/** @type {Record<'ok'|'warn'|'alert', number>} */
const RANK = { ok: 0, warn: 1, alert: 2 };

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
  const base = { signal: SIGNAL, vault };
  const V = (fn, args = []) => reader.tryRead(vault, VAULT_VIEWS, fn, args);

  // REQUIRED: the share-fraction computation itself. Plain accounting state, unrelated to the
  // oracle, so a tripped price breaker must never blind this signal the way it (correctly)
  // DEGRADES nav-backing and exit-liveness — dilution is exactly as visible during a freeze as
  // any other time, and is arguably MORE important to see then.
  const [totalSharesR, opSharesR, nonCreatorR, constR, govAddrR] = await Promise.all([
    V('totalShares'), V('sharesOf', [operator]), V('nonCreatorMemberCount'),
    V('CREATOR_MIN_STAKE_BPS'), V('governance'),
  ]);
  const required = [totalSharesR, opSharesR, nonCreatorR, constR];
  if (required.some((r) => !r.ok)) {
    const failed = ['totalShares', 'sharesOf', 'nonCreatorMemberCount', 'CREATOR_MIN_STAKE_BPS']
      .filter((_, i) => !required[i].ok);
    return [detectorBroken({
      ...base,
      message: `OPERATOR POWER DETECTOR BLIND on vault ${shortAddr(vault)}: ${failed.join(', ')} unreadable — operator dilution (G1) is UNMONITORED for this vault, not healthy`,
      detail: { vault, operator, unreadable: failed },
    })];
  }

  const totalShares = BigInt(totalSharesR.value);
  if (totalShares === 0n) {
    return [skipped({
      ...base,
      message: `operator power cannot be measured on vault ${shortAddr(vault)}: totalShares is 0 (no deposits have activated yet)`,
      detail: { vault, operator, totalShares: '0' },
    })];
  }

  const opShares = BigInt(opSharesR.value);
  const operatorBps = (opShares * BPS) / totalShares;
  const nonCreatorMemberCount = BigInt(nonCreatorR.value);
  const creatorMinStakeBps = BigInt(constR.value);

  // BEST-EFFORT: only feeds the informational headroom/capacity context, priced through navWad —
  // which reverts StaleOracle for the exact same reason nav-backing DEGRADES. A tripped breaker
  // must not blind the WARN/ALERT verdict above; it only means the USDC headroom estimate and the
  // capacityCapUsdc check cannot be computed this sweep, which is said plainly rather than guessed.
  const [capR, navR, scalarR, pendingR] = await Promise.all([
    V('capacityCapUsdc'), V('navWad'), V('usdcScalar'), V('totalPendingUsdc'),
  ]);
  const navAvailable = capR.ok && navR.ok && scalarR.ok && pendingR.ok;
  const capacityCapUsdc = navAvailable ? BigInt(capR.value) : 0n;
  const navWad = navAvailable ? BigInt(navR.value) : 0n;
  const usdcScalar = navAvailable ? BigInt(scalarR.value) : 0n;
  const totalPendingUsdc = navAvailable ? BigInt(pendingR.value) : 0n;

  const navUsdc = navAvailable && usdcScalar > 0n ? navWad / usdcScalar : 0n;
  const committedUsdc = navUsdc + totalPendingUsdc;
  const atCapacity = navAvailable && capacityCapUsdc !== 0n && committedUsdc >= capacityCapUsdc;

  const { thresholds: govThresholds, note: govLegNote } = await governanceLeg({ reader, govAddrR, vault });

  /** @type {Array<{name:string, label:string, bps:bigint}>} */
  const thresholds = [...govThresholds];
  if (nonCreatorMemberCount > 0n && creatorMinStakeBps > 0n) {
    thresholds.push({
      name: 'creatorMinStakeBps', label: "VaultCore's CREATOR_MIN_STAKE_BPS exit gate", bps: creatorMinStakeBps,
    });
  }

  if (thresholds.length === 0) {
    return [skipped({
      ...base,
      message: `operator power measured but no binding threshold is active on vault ${shortAddr(vault)}: operator holds ${bpsToPct(operatorBps)} of shares, but ${govLegNote ?? 'proposalThresholdBps is 0'} and no non-creator member has joined yet (the exit gate is not live)`,
      detail: { vault, operator, operatorBps: operatorBps.toString(), govLegNote },
    })];
  }

  const legs = thresholds.map((t) => evaluateLeg({ t, operatorBps, opShares, totalShares, navWad, usdcScalar }));
  const worst = legs.reduce((w, l) => (RANK[l.level] > RANK[w] ? l.level : w), 'ok');
  const thresholdsDiffer = thresholds.length === 2 && thresholds[0].bps !== thresholds[1].bps;
  const detail = {
    vault, operator,
    operatorBps: operatorBps.toString(), operatorShares: opShares.toString(), totalShares: totalShares.toString(),
    navAvailable, navUsdc: navUsdc.toString(), capacityCapUsdc: capacityCapUsdc.toString(), atCapacity,
    thresholds: legs, thresholdsDiffer, govLegNote,
  };

  if (worst === 'ok') {
    return [ok({
      ...base,
      message: `operator power healthy on vault ${shortAddr(vault)}: ${shortAddr(operator)} holds ${bpsToPct(operatorBps)} of shares against ${legs.map((l) => `${l.label} (${bpsToPct(BigInt(l.bps))})`).join(' and ')}`,
      measured: bpsToPct(operatorBps), threshold: legs.map((l) => bpsToPct(BigInt(l.bps))).join(' / '),
      detail: { ...detail, level: 'ok' },
    })];
  }

  const worstLeg = legs.find((l) => l.level === worst) ?? legs[0];
  const noTopUp = worst === 'alert' && atCapacity;
  const headroomClause = !navAvailable
    ? 'NAV is currently unreadable (see oracle-freshness) — the deposit headroom estimate cannot be computed this sweep'
    : worstLeg.depositHeadroomUsdc !== '0'
      ? `further non-operator deposits up to an estimated ${worstLeg.depositHeadroomUsdc} USDC (6dp; NAV-per-share held fixed) would cross the ${worstLeg.label} threshold`
      : `the vault is already at or past the ${worstLeg.label} threshold — no deposit headroom remains`;
  const diffClause = thresholdsDiffer
    ? ` Governance's proposalThresholdBps and VaultCore's CREATOR_MIN_STAKE_BPS differ on this vault — both gates are monitored (detail.thresholds)`
    : '';
  const capClause = noTopUp
    ? ` The vault is at capacityCapUsdc: no top-up path — decision needed now, the operator cannot deposit further to rebuild the margin because the vault cannot accept the deposit either`
    : '';

  return [alert({
    ...base,
    message: `${worst === 'alert' ? 'OPERATOR POWER CRITICAL' : 'OPERATOR POWER WARNING'} on vault ${shortAddr(vault)}: ${shortAddr(operator)} holds ${bpsToPct(operatorBps)} of shares, within ${worst === 'alert' ? '1.1x' : '1.5x'} of the ${worstLeg.label} threshold ${bpsToPct(BigInt(worstLeg.bps))} (margin ${bpsToPct(BigInt(worstLeg.marginBps))}). This is passive dilution by design — VaultCore ships no floor on proposalThresholdBps (M-6) — and the operator's stake is real capital at risk, not a free privilege: ${headroomClause}.${diffClause}${capClause}`,
    measured: bpsToPct(operatorBps), threshold: bpsToPct(BigInt(worstLeg.bps)),
    detail: { ...detail, level: worst },
  })];
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
 * One gate, evaluated against the operator's current bps. Every field is a JSON-safe primitive
 * (bigints stringified) because this object rides straight into `detail.thresholds`, which the
 * webhook sink `JSON.stringify`s — a raw BigInt there throws rather than serializing.
 */
function evaluateLeg({ t, operatorBps, opShares, totalShares, navWad, usdcScalar }) {
  const warnAt = (t.bps * WARN_NUM) / WARN_DEN;
  const alertAt = (t.bps * ALERT_NUM) / ALERT_DEN;
  const level = operatorBps <= alertAt ? 'alert' : operatorBps <= warnAt ? 'warn' : 'ok';
  const headroomUsdc = computeHeadroomUsdc({ opShares, totalShares, thresholdBps: t.bps, navWad, usdcScalar });
  return {
    name: t.name, label: t.label, bps: t.bps.toString(),
    warnAtBps: warnAt.toString(), alertAtBps: alertAt.toString(), level,
    marginBps: (operatorBps - t.bps).toString(), depositHeadroomUsdc: headroomUsdc.toString(),
  };
}

/**
 * How much further NON-OPERATOR deposit (native USDC units) would dilute `operatorBps` down to
 * exactly `thresholdBps`, holding the operator's own shares and current NAV-per-share fixed —
 * solved from VaultCore._mintShares's own formula:
 *   minted = amountUsdc * usdcScalar * totalShares / navWad
 *   opShares * BPS / (totalShares + minted) = thresholdBps
 *   => minted = opShares * BPS / thresholdBps - totalShares
 *   => amountUsdc = minted * navWad / (usdcScalar * totalShares)
 * Returns 0n when the vault is already at or through the threshold — there is no headroom to
 * report, only a crossing already behind it.
 * @returns {bigint}
 */
function computeHeadroomUsdc({ opShares, totalShares, thresholdBps, navWad, usdcScalar }) {
  if (thresholdBps <= 0n || totalShares === 0n || usdcScalar === 0n || navWad === 0n) return 0n;
  const sharesAtThreshold = (opShares * BPS) / thresholdBps;
  if (sharesAtThreshold <= totalShares) return 0n;
  const neededMinted = sharesAtThreshold - totalShares;
  return (neededMinted * navWad) / (usdcScalar * totalShares);
}
