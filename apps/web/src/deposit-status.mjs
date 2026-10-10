// @ts-check
/**
 * A member's deposit status across the four-hour observation window, from chain-read fields.
 *
 * `VaultCore._deposit` (contracts/src/VaultCore.sol:420-434): a first deposit from a member with
 * no shares and no cleared window does NOT mint. It escrows the USDC into `pendingDeposit[member]`
 * with `availableAt = block.timestamp + OBSERVATION_WINDOW` (4 hours, line 52) and mints nothing
 * until someone calls `activate(member)` (line 441-446) — PERMISSIONLESS, callable by anyone, but
 * NOT automatic. A pending deposit whose window has elapsed still shows zero shares and a
 * non-empty `pendingDeposit` entry until that call lands. That is a real, distinct on-chain state,
 * not a display nuance: a member who reads "waiting" past `availableAt` will not go look for a
 * button that activates their own deposit for them, because none does.
 *
 * THE ONE THING THIS MODULE REFUSES TO DO. Every input here can independently be missing —
 * `pendingDeposit(member)` unread, `sharesOf(member)` unread, no wallet clock yet. Reading absent
 * data as "no pending deposit" is the single most expensive lie available: it is the SAME shape a
 * genuinely empty position renders as, so a member whose read simply failed sees a calm, settled
 * screen instead of a stale one. `'unknown'` is therefore its own state, sorted before every other
 * branch, and nothing downstream of it inspects a field this function did not first validate.
 *
 * WHY A CONTRADICTORY READ ALSO RESOLVES TO `'unknown'`. `pendingDeposit[m].amountUsdc > 0` and
 * `sharesOf[m] > 0` cannot both be true from ONE atomic read of `VaultCore` — `_mintShares` is the
 * only path that raises `sharesOf`, and both its callers either take the immediate-mint branch
 * (which never creates a pending deposit) or `_activatePending` (which `delete`s the pending entry
 * before minting, line 448). VaultCore has no share-transfer function either (shares are not an
 * ERC-20 here), so nothing else can raise `sharesOf` out from under a live pending entry. A caller
 * that reads `pendingDeposit` and `sharesOf` in two separate rounds — `chain-reader.mjs`'s rounds
 * are per-address, not one multicall across a wallet's whole position — CAN observe this
 * combination if `activate()` lands between the two reads. That is a torn read, not a fact about
 * the member's position, and picking one field to believe is a guess this module does not make.
 *
 * @typedef {'unknown'|'none'|'waiting'|'available'|'active'} DepositStatusState
 *
 * @typedef {Object} DepositStatus
 * @property {DepositStatusState} state
 * @property {string} label short, UI-facing
 * @property {string} detail one sentence, says what the member can or cannot do right now
 * @property {number|null} availableAt unix seconds the window clears, or when it already did.
 *   Non-null only for `'waiting'` and `'available'`.
 * @property {number|null} secondsRemaining seconds until `availableAt`, floored at 0.
 *   Non-null only for `'waiting'` — the one state with a countdown to show.
 */

/**
 * @param {unknown} v
 * @returns {bigint|null} null for anything that is not a non-negative integer amount — never a
 *   silent 0n, because "could not read the pending amount" and "no pending amount" must stay
 *   distinguishable all the way to `state`.
 */
function nonNegativeBig(v) {
  let b;
  if (typeof v === 'bigint') {
    b = v;
  } else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) return null;
    b = BigInt(v);
  } else if (typeof v === 'string' && /^\d+$/.test(v.trim())) {
    b = BigInt(v.trim());
  } else {
    return null;
  }
  return b < 0n ? null : b;
}

/**
 * @param {unknown} v
 * @returns {number|null} null for anything that is not a finite, non-negative unix-seconds value.
 *   `Number(null)` is `0` and `Number('')` is `0`, both of which would classify a MISSING
 *   timestamp as the epoch rather than unread (freshness.mjs's `classify` guards the same trap) —
 *   so non-numeric, non-string-with-content types are rejected before any coercion happens.
 */
function nonNegativeSec(v) {
  if (typeof v !== 'number' && typeof v !== 'bigint' && !(typeof v === 'string' && v.trim() !== '')) {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Classify one member's deposit position. Pure — no network, no clock read; the caller supplies
 * `now`. Mirrors `resolveExitMode`'s shape in `governance.mjs`: a small closed set of states, a
 * label and a detail sentence the UI can render without deciding anything itself.
 *
 * @param {{pendingAmountUsdc: unknown, availableAt: unknown, sharesOf: unknown, now: unknown}} v
 *   `pendingAmountUsdc`/`sharesOf` — base USDC units / WAD shares, as `bigint`, a decimal string,
 *   or a safe-integer `number`; anything else (including `null`/`undefined`) is UNREAD.
 *   `availableAt`/`now` — unix seconds.
 * @returns {DepositStatus}
 */
export function classifyDepositStatus({ pendingAmountUsdc, availableAt, sharesOf, now }) {
  const pending = nonNegativeBig(pendingAmountUsdc);
  const shares = nonNegativeBig(sharesOf);
  const nowSec = nonNegativeSec(now);

  if (pending === null || shares === null || nowSec === null) {
    return freeze({
      state: 'unknown',
      label: 'Deposit status unread',
      detail:
        'This wallet has not read enough of your on-chain deposit state to say whether you have ' +
        'a deposit waiting, ready, or already active. Re-read before acting.',
      availableAt: null,
      secondsRemaining: null,
    });
  }

  if (pending > 0n) {
    if (shares > 0n) {
      // Unreachable from one atomic VaultCore read (see module header) — a torn read across
      // separate rounds, not a position either field alone can be trusted to describe.
      return freeze({
        state: 'unknown',
        label: 'Deposit status unread',
        detail:
          'Your pending deposit and your share balance were read at different times and ' +
          'disagree with each other — this reflects a read timing gap, not your on-chain ' +
          'position. Re-read before acting.',
        availableAt: null,
        secondsRemaining: null,
      });
    }

    const at = nonNegativeSec(availableAt);
    if (at === null) {
      return freeze({
        state: 'unknown',
        label: 'Deposit status unread',
        detail:
          'You have a pending deposit escrowed, but this wallet could not read when its ' +
          'four-hour observation window clears. Re-read before acting.',
        availableAt: null,
        secondsRemaining: null,
      });
    }

    if (nowSec < at) {
      return freeze({
        state: 'waiting',
        label: 'Deposit pending — observation window open',
        detail:
          'Your deposit is escrowed and mints no shares yet. It clears its four-hour ' +
          'observation window at the time shown; no action is needed before then.',
        availableAt: at,
        secondsRemaining: Math.max(0, at - nowSec),
      });
    }

    return freeze({
      state: 'available',
      label: 'Deposit ready to activate',
      detail:
        'Your observation window has elapsed. Shares have not minted yet — activation is a ' +
        'separate on-chain call, anyone may send it, and it is not automatic.',
      availableAt: at,
      secondsRemaining: null,
    });
  }

  if (shares > 0n) {
    return freeze({
      state: 'active',
      label: 'Position active',
      detail: 'You hold shares in this vault and have no deposit waiting on the observation window.',
      availableAt: null,
      secondsRemaining: null,
    });
  }

  return freeze({
    state: 'none',
    label: 'No pending deposit',
    detail: 'You have no deposit waiting on the observation window and hold no shares in this vault.',
    availableAt: null,
    secondsRemaining: null,
  });
}

function freeze(x) {
  return Object.freeze(x);
}
