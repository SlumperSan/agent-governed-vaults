// @ts-check
/**
 * Pre-flight REFUSALS for the member wallet UI: what it must refuse to let a member attempt, or
 * must warn unmissably about, before it asks for a signature — given on-chain-shaped state. This
 * is NOT a replacement for VaultCore/Governance's own require()s (contracts/src/VaultCore.sol,
 * contracts/src/Governance.sol) — the contract is still the final word — but it must be RIGHT,
 * because its whole job is stopping a member from paying gas for a call that only reverts, or
 * signing something irrevocable without being told so first.
 *
 * Four cases (2026-09-19 scope):
 *  1. `skipWindow` is IRREVOCABLE — refuse a second call, warn unmissably before the first.
 *  2. `requestExit` pricing once a proposal has been DEFEATED — it settles NOW, same as no
 *     proposal at all; it is the REVEAL-PHASE-THROUGH-RESOLUTION window that must be flagged.
 *  3. The creator 5% withdrawal gate — reverts at REQUEST time; refuse before submission.
 *  4. `exitFeeBpsOf` is a CEILING the UI may show, never a promised number.
 *
 * RELATIONSHIP TO `vault-state.mjs`. That module answers "which buttons does a browse-only page
 * enable", and deliberately treats an unresolved input as `available: true, severity: 'warn'` —
 * the right default when nobody is about to sign anything (see its TRAP 1 / TRAP 2 notes). This
 * module answers the narrower, stricter question for the moment a signature is actually
 * requested: an unread input must never resolve to "go ahead" here. The two modules are not
 * merged and are allowed to disagree; `vault-state.mjs` is untouched by this file.
 *
 * Reuses `governance.hasPendingExecution` and `exit-preview.exitFeeBps` rather than re-deriving
 * either — this module and the governance tab must never compute "is this Mode F" or "what fee
 * shows" two different ways.
 */

import { toBig, BPS } from './format.mjs';
import { hasPendingExecution } from './governance.mjs';
import { exitFeeBps } from './exit-preview.mjs';

/** `VaultCore.CREATOR_MIN_STAKE_BPS` (VaultCore.sol:53) — 5%, in bps. */
export const CREATOR_MIN_STAKE_BPS = 500n;

/**
 * @typedef {Object} Refusal
 * @property {'allowed'|'allowed-irreversible'|'refused'|'unknown'} kind
 * @property {string|null} code   the contract's own error identifier, for 'refused'; null otherwise
 * @property {string} reason      what a member can act on
 */

/** @returns {Refusal} */
const allowed = (reason) => ({ kind: 'allowed', code: null, reason });
/** @returns {Refusal} */
const irreversible = (reason) => ({ kind: 'allowed-irreversible', code: null, reason });
/** @returns {Refusal} */
const refused = (code, reason) => ({ kind: 'refused', code, reason });
/** @returns {Refusal} */
const unknown = (reason) => ({ kind: 'unknown', code: null, reason });

/**
 * The one predicate a signing UI should gate a signature on. False for 'refused' AND for
 * 'unknown' — an unread value must never let a member sign.
 * @param {Refusal} v
 */
export function canSign(v) {
  return v.kind === 'allowed' || v.kind === 'allowed-irreversible';
}

// ───────────────────────── 1. skipWindow — irrevocable, no undo ─────────────────────────

/**
 * `VaultCore.skipWindow` (VaultCore.sol:463-471): `require(!skipOptIn[msg.sender],
 * AlreadyOptedIn())` is checked FIRST, and `skipOptIn` is never cleared anywhere in the
 * contract — there is no call that undoes it. Once-per-member-per-vault.
 * @param {{skipOptIn: boolean|null|undefined}} f
 * @returns {Refusal}
 */
export function skipWindowRefusal({ skipOptIn }) {
  if (typeof skipOptIn !== 'boolean') {
    return unknown('Cannot confirm this is safe to sign — skipOptIn was not read.');
  }
  if (skipOptIn) {
    return refused(
      'AlreadyOptedIn',
      'You already skipped the observation window for this vault. It is once-per-member-per-vault ' +
        'and permanent — the contract has no call that clears it, so signing this would only pay ' +
        'gas for a revert.',
    );
  }
  return irreversible(
    'Skipping the 4-hour observation window is PERMANENT for this vault: once signed, there is no ' +
      'undo, no re-opt-out, and no second chance to change your mind.',
  );
}

// ─────────────── 2. requestExit pricing once a proposal has been DEFEATED ───────────────

/**
 * Mirrors `Governance.hasPendingExecution` (Governance.sol:732-747) through `governance.mjs`'s
 * own implementation, so this module and the governance tab can never disagree about it. A
 * Defeated proposal (like Executed, Expired, or no active proposal at all) makes
 * `hasPendingExecution` return `false` — `requestExit` then takes VaultCore's Mode-I branch
 * (VaultCore.sol:556-567) and settles IN THIS TRANSACTION at current NAV, exactly as if no
 * proposal had ever existed. There is nothing special about "the proposal I was watching just got
 * Defeated": it is not queued, not forward-priced to some other number, and not blocked.
 *
 * The reverse is the case actually worth flagging: while `hasPendingExecution` is true (reveal
 * phase through a Passed proposal's execution window — ANY proposal type, not only Rebalance),
 * calling `requestExit` QUEUES the exit irrevocably, and it settles at whatever NAV holds once
 * THAT proposal resolves — including resolving to Defeated. Queuing now is not a bet the proposal
 * passes; a Defeat afterward does not undo the queue or make it settle any differently than an
 * ordinary Mode-F settlement would.
 * @param {{proposal: object|null|'unknown', nowSec: number}} f
 * @returns {Refusal}
 */
export function requestExitPricingRefusal({ proposal, nowSec }) {
  const pending = hasPendingExecution(proposal, nowSec);
  if (pending === null) {
    return unknown(
      'Cannot resolve whether this exit settles now or queues — the proposal deadline this ' +
        'depends on was not read. Do not assume instant settlement.',
    );
  }
  if (pending === true) {
    return irreversible(
      'A proposal is past its commit deadline, so this exit QUEUES — irrevocably, no cancel — and ' +
        'settles later at whatever NAV holds once that proposal resolves, whichever way it ' +
        'resolves, including Defeated. It does not settle now.',
    );
  }
  return allowed(
    'No proposal is currently past its commit deadline (none is active, or the last one already ' +
      'resolved — Defeated, Executed, or Expired all read the same way here), so this exit settles ' +
      'now, in this transaction, at current NAV.',
  );
}

// ──────────────────────── 3. the creator 5% withdrawal gate ────────────────────────

/**
 * Mirrors `VaultCore._checkCreatorGate` (VaultCore.sol:600-608) exactly, including its rounding:
 *   `(sharesOf[member] - burnShares) * BPS >= CREATOR_MIN_STAKE_BPS * (totalShares - burnShares)`
 * — a creator landing at EXACTLY 5% after the burn passes (`>=`, not `>`). Binds ONLY when
 * `member === creator` AND `nonCreatorMemberCount > 0` (other members remain). Checked at
 * REQUEST time for BOTH exit modes — eagerly on the Mode-F queue branch too, the L-1 fix
 * (VaultCore.sol:557-559) — so a gate-violating request reverts before anything is queued, not
 * only at settlement, and the UI must refuse it before submission rather than let the creator eat
 * that revert.
 * @param {{creator: string|null, member: string|null, sharesOf: bigint|string|null,
 *          totalShares: bigint|string|null, nonCreatorMemberCount: bigint|string|null,
 *          burnShares: bigint|string|null}} f
 * @returns {Refusal}
 */
export function creatorGateRefusal({ creator, member, sharesOf, totalShares, nonCreatorMemberCount, burnShares }) {
  if (typeof creator !== 'string' || typeof member !== 'string') {
    return unknown('Cannot confirm the creator gate — creator/member address was not read.');
  }
  if (member.toLowerCase() !== creator.toLowerCase()) {
    return allowed('Not the creator — the withdrawal gate does not apply.');
  }

  const ncmc = toBig(nonCreatorMemberCount);
  if (ncmc === null) {
    return unknown('Cannot confirm the creator gate — nonCreatorMemberCount was not read.');
  }
  if (ncmc === 0n) {
    return allowed('No other members remain, so the creator gate does not bind.');
  }

  const shares = toBig(sharesOf);
  const ts = toBig(totalShares);
  const burn = toBig(burnShares);
  if (shares === null || ts === null || burn === null) {
    return unknown('Cannot confirm the creator gate — sharesOf/totalShares/burnShares were not fully read.');
  }
  if (burn > shares || burn > ts) {
    return unknown('Cannot confirm the creator gate — the burn amount exceeds shares read; inputs look stale or inconsistent.');
  }

  const passes = (shares - burn) * BPS >= CREATOR_MIN_STAKE_BPS * (ts - burn);
  if (!passes) {
    return refused(
      'CreatorStakeGate',
      'As the creator, this exit would take you below 5% of shares while other members remain. ' +
        'Checked at request time — this signature would revert, not merely settle for less.',
    );
  }
  return allowed('Post-exit creator stake stays at or above the 5% minimum.');
}

// ──────────────────── 4. exitFeeBpsOf is a CEILING, not a promise ────────────────────

/**
 * `VaultCore.exitFeeBpsOf` (VaultCore.sol:1073-1075) returns `_exitFeeBps(member)` computed from
 * `lastDepositTime` AT THE MOMENT IT IS CALLED. The fee actually withheld at settlement
 * (VaultCore.sol:621-622, inside `_settleExit`) is not guaranteed to equal this reading, for two
 * independent reasons:
 *   - `_settleExit` recomputes `_exitFeeBps(member)` fresh from `lastDepositTime` AT SETTLEMENT,
 *     never from a value captured at request time. Tenure only advances between now and
 *     settlement, so — assuming no further deposit (see below) — the real fee can only be LOWER
 *     than this reading, making it a ceiling; for a Mode-F queued exit that settles well after
 *     the request, it often is lower.
 *   - it is forced to EXACTLY ZERO if `sharesOf[member] == totalShares` at settlement — the
 *     sole-holder waiver (EE-8/EE-9) — regardless of tenure.
 * The one direction this reading does NOT bound: a fresh `deposit()` between now and settlement
 * resets `lastDepositTime` on the member's ENTIRE position (VaultCore.sol:496, `_mintShares`),
 * which can raise the real fee above this reading. State that plainly rather than calling this an
 * unconditional ceiling.
 * @param {{exitFeeMaxBps: bigint|number|string|null|undefined,
 *          exitFeeDecayPeriodSec: bigint|number|string|null|undefined,
 *          tenureSec: bigint|number|string|null|undefined}} f
 * @returns {{kind:'allowed', ceilingBps:bigint, reason:string}
 *          |{kind:'unknown', ceilingBps:null, reason:string}}
 */
export function exitFeeCeiling({ exitFeeMaxBps, exitFeeDecayPeriodSec, tenureSec }) {
  if (exitFeeMaxBps == null || exitFeeDecayPeriodSec == null || tenureSec == null) {
    return {
      kind: 'unknown',
      ceilingBps: null,
      reason: 'Cannot show an exit fee figure — the tenure inputs were not read. Do not display a number as though it were exact.',
    };
  }
  const ceilingBps = exitFeeBps({ exitFeeMaxBps, exitFeeDecayPeriodSec, tenureSec });
  return {
    kind: 'allowed',
    ceilingBps,
    reason:
      `${ceilingBps} bps is a CEILING, not the fee you will pay: it is waived to zero if you are ` +
      `the vault's sole holder at settlement, it is recomputed from tenure at settlement rather ` +
      `than fixed now, and it will be HIGHER than this if you deposit again before settling.`,
  };
}
