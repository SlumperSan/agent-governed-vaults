// @ts-check
/**
 * Classifies a member's position relative to `VaultCore`'s observation window — the four hours
 * between a first `deposit()` and the `activate()` that turns escrowed USDC into shares and a
 * vote. Pure: no wallet, no network, no clock of its own. Every input is a value the caller read
 * from chain (or didn't), passed straight through.
 *
 * WHY THIS EXISTS. `deposit-preview.mjs` answers "what will THIS deposit do". This module answers
 * "what state is the member already IN, and what may the surface legally offer them right now."
 * The two are siblings: `entryPath`/`entryPathIsCertain` there decide which branch a NEW deposit
 * takes; `classifyDepositPosition` here decides what to render for a deposit that may already
 * exist. Neither duplicates the other's branch.
 *
 * UNREAD IS NOT ABSENT, AND ABSENT IS NOT ZERO. `format.mjs#toBig` already encodes "unparseable ⇒
 * null, never a silent 0" (see its own doc comment) and `governance.mjs` already has a live
 * `'unknown'` sentinel for the same reason. This module inherits that discipline for the fourth
 * time in this app and gives it one state, `unread`, that every other state is defined to exclude:
 * a caller cannot reach `none`/`pending`/`matured`/`active` without every required field having
 * been read. This repo has shipped "no data rendered as no deposit" more than once — that is
 * exactly the defect this state exists to make structurally impossible.
 *
 * THE DISCRIMINATOR FROM PR #305, APPLIED HERE. `activate(address)` names the member as a
 * parameter, so anyone may call it for them (VaultCore.sol: "Callable by anyone."); `cancelPending()`
 * and `skipWindow()` take no address, so only `msg.sender` can invoke them. Every action this
 * module returns carries `callableBy: 'anyone' | 'member'` taken straight from that shape, and no
 * `describe` string below uses a second-person pronoun — "your deposit", "you may cancel" — because
 * the same verdict renders for the member looking at their own position AND for a keeper looking at
 * someone else's. The caller chooses the pronoun from `callableBy`; this module never guesses it.
 *
 * CONTRACT INVARIANTS THIS MODULE LEANS ON, READ FROM `_deposit`/`_activatePending`/`skipWindow`:
 *   - `pendingDeposit[member].amountUsdc` is the contract's OWN sentinel for "nothing pending"
 *     (`require(p.amountUsdc > 0, NoPending())` in both `activate` and `cancelPending`), so amount
 *     — not `availableAt` — is the discriminator for whether a pending record exists.
 *   - A pending record and a share balance are mutually exclusive. `_activatePending` and
 *     `skipWindow` both `delete pendingDeposit[member]` before any shares mint, and `_deposit`'s
 *     window branch only runs `if (!windowCleared[msg.sender] && sharesOf[msg.sender] == 0)`. Seeing
 *     both positive at once is not a state the chain can produce — it is two reads from different
 *     blocks, or a torn read, and this module refuses to pick one and calls it `indeterminate`.
 *   - `availableAt` is set to `block.timestamp + OBSERVATION_WINDOW` in the same statement that
 *     writes a positive `amountUsdc`, and `delete` clears both fields together, so a positive amount
 *     paired with `availableAt === 0` is equally unreachable on-chain. Also `indeterminate`, not
 *     `matured` — the task's own zero-`availableAt` boundary case is this exact bug: a naive
 *     `chainNow >= availableAt` reads `chainNow >= 0` as always true and would offer `activate` on a
 *     torn read.
 */

import { toBig } from './format.mjs';

/** The six mutually-exclusive states a position can be classified into. */
export const DEPOSIT_STATE = Object.freeze({
  /** One or more required inputs was not supplied or did not parse. Never render this as any of
   *  the states below — it means "go read again", not "nothing to show". */
  UNREAD: 'unread',
  /** `pendingAmountUsdc === 0` and `sharesHeld === 0`: never deposited, or a prior pending deposit
   *  was cancelled and nothing replaced it. */
  NONE: 'none',
  /** A pending deposit exists and `chainNowSec < availableAt`. */
  PENDING: 'pending',
  /** A pending deposit exists and `chainNowSec >= availableAt` — `activate` will succeed. */
  MATURED: 'matured',
  /** `sharesHeld > 0`: the member holds shares and votes. A later deposit mints immediately. */
  ACTIVE: 'active',
  /** The inputs contradict a contract invariant (see module header). Reads were taken, but they
   *  cannot both be true on-chain — treat as unsafe to act on, same as `unread`. */
  INDETERMINATE: 'indeterminate',
});

/** `VaultCore`'s own revert names, reused verbatim so a blocked action's `reason` reads the same
 *  as the error the member would hit if the surface offered it anyway (mirrors the convention in
 *  `deposit-preview.mjs`'s `blockers[].code`). */
const REVERT = Object.freeze({
  NO_PENDING: 'NoPending',
  PENDING_EXISTS: 'PendingExists',
  WINDOW_NOT_ELAPSED: 'WindowNotElapsed',
  ALREADY_OPTED_IN: 'AlreadyOptedIn',
});

/**
 * @param {string} code
 * @param {boolean} offerable
 * @param {'member'|'anyone'} callableBy
 * @param {string|null} [reason] set when `offerable` is false: the contract revert this would hit,
 *   or `'Unread'`/`'Indeterminate'` when the block is about missing/contradictory data rather than
 *   contract state.
 */
function action(code, offerable, callableBy, reason = null) {
  return Object.freeze({ code, offerable, callableBy, reason });
}

const UNREADABLE_ACTIONS = Object.freeze([
  action('deposit', false, 'member', 'Unread'),
  action('cancelPending', false, 'member', 'Unread'),
  action('activate', false, 'anyone', 'Unread'),
]);

const INDETERMINATE_ACTIONS = Object.freeze([
  action('deposit', false, 'member', 'Indeterminate'),
  action('cancelPending', false, 'member', 'Indeterminate'),
  action('activate', false, 'anyone', 'Indeterminate'),
]);

/**
 * `skipWindow()` is orthogonal to the pending/matured/none/active split above — the contract lets
 * a member burn it in ANY of those states (its only guard is `!skipOptIn[msg.sender]`), and it is
 * irrevocable once used. Computed once, alongside the state, rather than folded into `actions` for
 * one state, so a caller cannot mistake "not part of this state's action list" for "not offered".
 * @param {boolean|null|undefined} skipOptIn
 */
function skipWindowAction(skipOptIn) {
  if (skipOptIn === true) return action('skipWindow', false, 'member', REVERT.ALREADY_OPTED_IN);
  if (skipOptIn === false) return { ...action('skipWindow', true, 'member', null), irrevocable: true };
  return action('skipWindow', false, 'member', 'Unread'); // skipOptIn not supplied — never assume false
}

/**
 * @param {Object} p
 * @param {bigint|string|null} [p.pendingAmountUsdc] `pendingDeposit(member).amountUsdc` — 0 means
 *   the contract's own "nothing pending" (`NoPending()`), not "not read".
 * @param {bigint|string|null} [p.availableAt] `pendingDeposit(member).availableAt`, unix seconds.
 * @param {bigint|string|null} [p.chainNowSec] the current block/chain timestamp — never wall-clock
 *   `Date.now()`; an absent chain time is `unread`, not "now".
 * @param {bigint|string|null} [p.sharesHeld] `sharesOf(member)`.
 * @param {boolean|null|undefined} [p.skipOptIn] `skipOptIn(member)` — omit or pass `null`/`undefined`
 *   when not read; `skipWindow` is never offered on an assumed `false`.
 * @returns {{state:string, missing:ReadonlyArray<string>, reasons:ReadonlyArray<string>,
 *   secondsRemaining:number|null, actions:ReadonlyArray<{code:string,offerable:boolean,
 *   callableBy:'member'|'anyone',reason:string|null}>,
 *   skipWindow:{code:string,offerable:boolean,callableBy:'member',reason:string|null,irrevocable?:boolean},
 *   describe:string}}
 */
export function classifyDepositPosition(p = {}) {
  const amount = toBig(p.pendingAmountUsdc);
  const availableAt = toBig(p.availableAt);
  const chainNow = toBig(p.chainNowSec);
  const shares = toBig(p.sharesHeld);

  const missing = [];
  if (amount === null) missing.push('pendingAmountUsdc');
  if (availableAt === null) missing.push('availableAt');
  if (chainNow === null) missing.push('chainNowSec');
  if (shares === null) missing.push('sharesHeld');

  if (missing.length > 0) {
    return Object.freeze({
      state: DEPOSIT_STATE.UNREAD,
      missing: Object.freeze(missing),
      reasons: Object.freeze([]),
      secondsRemaining: null,
      actions: UNREADABLE_ACTIONS,
      skipWindow: skipWindowAction(undefined),
      describe: 'Position not read yet — do not render this as "nothing pending" or any other settled state.',
    });
  }

  // Contract invariants (see module header). A violation here means the reads do not describe one
  // consistent block, not that the module gets to guess which field to trust.
  const reasons = [];
  if (amount > 0n && shares > 0n) reasons.push('amount-and-shares-both-positive');
  if (amount > 0n && availableAt === 0n) reasons.push('zero-available-at-with-pending');

  if (reasons.length > 0) {
    return Object.freeze({
      state: DEPOSIT_STATE.INDETERMINATE,
      missing: Object.freeze([]),
      reasons: Object.freeze(reasons),
      secondsRemaining: null,
      actions: INDETERMINATE_ACTIONS,
      skipWindow: skipWindowAction(undefined),
      describe: 'Reads contradict a VaultCore invariant — reread before rendering anything.',
    });
  }

  const skip = skipWindowAction(p.skipOptIn ?? null);

  if (shares > 0n) {
    return Object.freeze({
      state: DEPOSIT_STATE.ACTIVE,
      missing: Object.freeze([]),
      reasons: Object.freeze([]),
      secondsRemaining: null,
      actions: Object.freeze([
        action('deposit', true, 'member', null),
        action('cancelPending', false, 'member', REVERT.NO_PENDING),
        action('activate', false, 'anyone', REVERT.NO_PENDING),
      ]),
      skipWindow: skip,
      describe: 'Holds shares and votes. A deposit here mints immediately — nothing is pending.',
    });
  }

  if (amount === 0n) {
    return Object.freeze({
      state: DEPOSIT_STATE.NONE,
      missing: Object.freeze([]),
      reasons: Object.freeze([]),
      secondsRemaining: null,
      actions: Object.freeze([
        action('deposit', true, 'member', null),
        action('cancelPending', false, 'member', REVERT.NO_PENDING),
        action('activate', false, 'anyone', REVERT.NO_PENDING),
      ]),
      skipWindow: skip,
      describe: 'No deposit pending and no shares held.',
    });
  }

  // amount > 0n, shares === 0n, availableAt > 0n from here — a real pending deposit.
  const matured = chainNow >= availableAt; // contract: `activate` requires `block.timestamp >= p.availableAt`
  const secondsRemaining = matured ? 0 : Number(availableAt - chainNow);

  return Object.freeze({
    state: matured ? DEPOSIT_STATE.MATURED : DEPOSIT_STATE.PENDING,
    missing: Object.freeze([]),
    reasons: Object.freeze([]),
    secondsRemaining,
    actions: Object.freeze([
      action('deposit', false, 'member', REVERT.PENDING_EXISTS),
      // cancelPending has NO availableAt check on-chain — it stays offerable after the window
      // elapses, right up until someone actually calls activate. The member can still pull out of
      // a matured deposit, and a keeper cranking `activate` races them for it; the surface must not
      // imply cancellation closes the moment the countdown hits zero.
      action('cancelPending', true, 'member', null),
      action('activate', matured, 'anyone', matured ? null : REVERT.WINDOW_NOT_ELAPSED),
    ]),
    skipWindow: skip,
    describe: matured
      ? 'The observation window has elapsed. Anyone may call activate for this member to mint the ' +
        'shares; the member may still cancel instead, and whichever happens first wins.'
      : 'A deposit is escrowed inside the observation window: no shares, no vote yet. The member ' +
        'may cancel for a full refund; activate will revert until the window elapses.',
  });
}
