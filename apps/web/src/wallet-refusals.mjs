// @ts-check
/**
 * REFUSALS for the six member write-path calls (2026-09-19 Connect-and-sign scope, "hard part
 * 3"): `deposit`, `cancelPending`, `skipWindow`, `requestExit`, `activate`, `settleQueuedExit`.
 * Pure: state in, a verdict out. No wallet, no network, no `viem`.
 *
 * RELATIONSHIP TO `vault-state.mjs`. That module already computes "which buttons does a
 * browse-only UI enable", and it makes a deliberate, tested, DIFFERENT call from this one: an
 * unknown freeze state or unknown exit mode there still returns `available: true` with a `warn`
 * severity (see its TRAP 1/TRAP 2 comments and the "still usable" test). That is the right
 * default for a page nobody is about to sign anything from. This module backs the moment
 * `apps/vaults-ui` actually asks someone to sign a transaction, and the bar there is stricter:
 * an unread input must NEVER resolve to a signable verdict, full stop — see requirement 2 below.
 * The two modules are not required to agree and are not merged; `vault-state.mjs` is untouched by
 * this change (2026-09-19 findings note records the split rather than picking one silently).
 *
 * ALSO ALSO ALSO `isCreatorBelowGate` IS NOT INPUT HERE. `vault-state.mjs` takes it as a
 * pre-computed optional boolean — omit the property and that creator's exit reads `available:
 * true`, which is exactly the "guard returns the success value when its input is missing" shape
 * the task warns about. This module takes the PRIMITIVES `VaultCore._checkCreatorGate` itself
 * reads (`creator`, `member`, `sharesOf`, `totalShares`, `nonCreatorMemberCount`) and derives the
 * gate here, so there is no boolean a caller can simply forget to set.
 *
 * FOUR VERDICT KINDS, not two:
 *   'allowed'              — the call will not revert, on what was read.
 *   'allowed-irreversible' — will not revert, AND it does something that cannot be undone once
 *                            signed (skipWindow's opt-in burn; requestExit's Mode-F queue).
 *   'refused'              — a specific on-chain revert IS predicted, named by the contract's own
 *                            error identifier, from state that WAS read.
 *   'unknown'               — a value this verdict depends on was not read. Carries `missing`, the
 *                            exact field names, so a caller can see what to fetch.
 * `canSign(v)` is the one predicate a UI should gate a signature on — true only for the first two
 * kinds — so nothing downstream can quietly treat 'unknown' as go-ahead.
 *
 * REQUIREMENT 2, MADE MECHANICAL: every gate below is a chain of early returns, each one checking
 * whether its own inputs were read BEFORE looking at their value. A field that is `null` or
 * `undefined` is "not read" throughout — `toBig` already treats both that way, and the local
 * `bool()` helper below does the same for booleans. There is deliberately no default branch that
 * falls through to `allowed`; every function's last line is a real check, never a bare return.
 *
 * WHAT THIS DOES NOT COVER (say so rather than implying completeness):
 *  - The four governance actions (`commit`/`reveal`/`setDelegate`/`setStandingDefault`) and
 *    commit-reveal salt custody — a separate session owns that (worktree `wt-wallet-salt-custody`).
 *  - The four-hour pending-deposit-gap UX (worktree `wt-wallet-pending-gap`).
 *  - `_settleExit`'s child-unwind shortfall loop (`ExitNeedsChildSettlement`) — `exit-preview.mjs`
 *    already documents this as unmodelled for the same reason: no child data is threaded through.
 *  - In-kind escrow / `claimEscrowed` — a distinct action, not in the scope table's six.
 *  - Gas, ERC-20 `approve`/`allowance` and wallet USDC balance — real reverts, but at the token
 *    contract, not VaultCore/Governance, and not enumerated in the six actions this task names.
 *  - Where `frozen` itself comes from — this module takes it as an input exactly like
 *    `vault-state.mjs` does; deriving it is `chain-reader.mjs`'s job.
 */

import { toBig } from './format.mjs';
import { exitFeeBps } from './exit-preview.mjs';

export const BPS = 10_000n;
/** `VaultCore.CREATOR_MIN_STAKE_BPS` (VaultCore.sol:53). */
export const CREATOR_MIN_STAKE_BPS = 500n;

// ─────────────────────────────── verdict shape ────────────────────────────────

/**
 * @typedef {Object} Verdict
 * @property {'allowed'|'allowed-irreversible'|'refused'|'unknown'} kind
 * @property {string} reason  empty for a plain 'allowed'; otherwise what a member can act on
 * @property {string} [code]  the contract's own error identifier, for 'refused'
 * @property {string[]} [missing]  field names not read, for 'unknown'
 * @property {string[]} [notes]  non-blocking consequences worth surfacing before signing
 */

/** @returns {Verdict} */
const allowed = (notes) => ({ kind: 'allowed', reason: '', ...(notes?.length ? { notes } : {}) });
/** @returns {Verdict} */
const irreversible = (reason, notes) => ({ kind: 'allowed-irreversible', reason, ...(notes?.length ? { notes } : {}) });
/** @returns {Verdict} */
const refused = (code, reason) => ({ kind: 'refused', code, reason });
/** @returns {Verdict} */
const unread = (missing) => ({
  kind: 'unknown',
  missing,
  reason: `Cannot confirm this will not revert — not read: ${missing.join(', ')}.`,
});

/**
 * The one predicate a signing UI should act on. False for 'refused' AND for 'unknown' — an unread
 * value must never let a member sign.
 * @param {Verdict} v
 */
export function canSign(v) {
  return v.kind === 'allowed' || v.kind === 'allowed-irreversible';
}

/** `typeof` boolean check that treats `undefined` the same as `null`: "not read". */
function bool(v) {
  return typeof v === 'boolean' ? v : null;
}

// ─────────────────────────── shared: the creator gate ─────────────────────────

/**
 * Mirrors `VaultCore._checkCreatorGate` (VaultCore.sol:601-608) from primitives, not from a
 * pre-computed boolean. Binds ONLY when `member === creator` AND `nonCreatorMemberCount > 0`
 * (other members remain); a non-creator, or a creator in a vault with no other members, always
 * passes without needing `sharesOf`/`totalShares` at all.
 *
 * `>=`, not `>`: `(sharesOf - burnShares) * BPS >= CREATOR_MIN_STAKE_BPS * (totalShares -
 * burnShares)` — a creator landing at EXACTLY 5% after the burn passes the gate.
 *
 * @param {{creator:string|null, member:string|null, sharesOf:bigint|string|null,
 *          totalShares:bigint|string|null, nonCreatorMemberCount:bigint|string|null,
 *          burnShares:bigint|string|null}} p
 * @returns {{known:false, missing:string[]}|{known:true, blocked:boolean}}
 */
export function creatorGate({ creator, member, sharesOf, totalShares, nonCreatorMemberCount, burnShares }) {
  const missing = [];
  if (typeof creator !== 'string') missing.push('creator');
  if (typeof member !== 'string') missing.push('member');
  if (missing.length > 0) return { known: false, missing };
  if (member !== creator) return { known: true, blocked: false }; // gate binds only the creator

  const ncmc = toBig(nonCreatorMemberCount);
  if (ncmc === null) return { known: false, missing: ['nonCreatorMemberCount'] };
  if (ncmc === 0n) return { known: true, blocked: false }; // sole/last member: gate does not bind

  const shares = toBig(sharesOf);
  const ts = toBig(totalShares);
  const burn = toBig(burnShares);
  const m2 = [];
  if (shares === null) m2.push('sharesOf');
  if (ts === null) m2.push('totalShares');
  if (burn === null) m2.push('burnShares');
  if (m2.length > 0) return { known: false, missing: m2 };

  const passes = (shares - burn) * BPS >= CREATOR_MIN_STAKE_BPS * (ts - burn);
  return { known: true, blocked: !passes };
}

// ───────────────────────────────── 1. deposit ─────────────────────────────────

/**
 * `VaultCore.deposit`/`_deposit` (VaultCore.sol:392-435). Checked in the contract's own order:
 * `ZeroAmount` → `BelowMinDeposit` → `navWad()` (frozen) UNCONDITIONALLY, before the cap is even
 * consulted → `CapacityExceeded` only if the vault is capped → `PendingExists` only on the
 * window-entry branch.
 *
 * @param {{amountUsdc:bigint|string|null, minDepositUsdc:bigint|string|null,
 *          frozen:boolean|null, capacityCapUsdc:bigint|string|null, navUsdc:bigint|string|null,
 *          totalPendingUsdcVault:bigint|string|null, windowCleared:boolean|null,
 *          sharesOf:bigint|string|null, pendingDeposit:{amountUsdc:bigint|string}|null,
 *          queuedExitShares?:bigint|string|null}} f
 * @returns {Verdict}
 */
export function deposit(f) {
  const amount = toBig(f.amountUsdc);
  if (amount === null || amount <= 0n) return refused('ZeroAmount', 'Enter an amount above zero.');

  const minDeposit = toBig(f.minDepositUsdc);
  if (minDeposit === null) return unread(['minDepositUsdc']);
  if (amount < minDeposit) {
    return refused('BelowMinDeposit', `Below this vault's minimum deposit (immutable, set at creation).`);
  }

  // Unconditional: `navWad()` is read before the cap is even checked (VaultCore.sol:413), so
  // EVERY deposit reverts while the oracle is frozen, capped vault or not.
  const frozen = bool(f.frozen);
  if (frozen === null) return unread(['frozen']);
  if (frozen === true) {
    return refused(
      'StaleOracle',
      "deposit() reads NAV before it even checks the capacity cap, so it reverts while this vault's oracle is frozen — regardless of headroom.",
    );
  }

  const cap = toBig(f.capacityCapUsdc);
  if (cap === null) return unread(['capacityCapUsdc']);
  if (cap !== 0n) {
    const nav = toBig(f.navUsdc);
    const pendingTotal = toBig(f.totalPendingUsdcVault);
    if (nav === null) return unread(['navUsdc']);
    if (pendingTotal === null) return unread(['totalPendingUsdcVault']);
    if (nav + pendingTotal + amount > cap) {
      return refused(
        'CapacityExceeded',
        'This deposit would push the vault over its capacity cap — capacity counts live NAV plus everyone’s escrowed pending deposits, not NAV alone.',
      );
    }
  }

  const windowCleared = bool(f.windowCleared);
  const sharesHeld = toBig(f.sharesOf);
  const immediate = windowCleared === true || (sharesHeld !== null && sharesHeld > 0n);
  if (!immediate) {
    if (windowCleared === null || sharesHeld === null) return unread(['windowCleared', 'sharesOf']);
    const pd = f.pendingDeposit;
    if (!pd) return unread(['pendingDeposit']);
    const pdAmount = toBig(pd.amountUsdc);
    if (pdAmount === null) return unread(['pendingDeposit.amountUsdc']);
    if (pdAmount !== 0n) {
      return refused('PendingExists', 'You already have a deposit in the 4-hour observation window. Cancel or activate it first — one pending deposit per member.');
    }
  }

  const notes = [];
  notes.push(
    immediate
      ? 'Shares mint at the NAV of the block this lands in — an estimate now, not a promise.'
      : 'Escrowed for 4 hours, mints 0 shares and no vote until activate() is called for you. This deposit resets your exit-fee tenure clock on your ENTIRE position, not just this amount.',
  );
  const queued = toBig(f.queuedExitShares ?? null);
  if (queued !== null && queued > 0n) {
    notes.push(
      'You have a queued, irrevocable exit. This deposit still takes the immediate-mint path (you already hold shares) and resets your deposit-tenure clock — which RAISES the exit fee your queued exit will pay at settlement, since the fee is recomputed from tenure at settle time, not fixed when you queued.',
    );
  }
  return allowed(notes);
}

// ───────────────────────────── 2. cancelPending ───────────────────────────────

/**
 * `VaultCore.cancelPending` (VaultCore.sol:448-459). Reads no oracle at all — the one action that
 * is never blocked by a frozen vault (M-2's fix: the alternative stranded a blacklisted member's
 * escrow forever).
 * @param {{pendingDeposit:{amountUsdc:bigint|string}|null}} f
 * @returns {Verdict}
 */
export function cancelPending(f) {
  const pd = f.pendingDeposit;
  if (!pd) return unread(['pendingDeposit']);
  const amount = toBig(pd.amountUsdc);
  if (amount === null) return unread(['pendingDeposit.amountUsdc']);
  if (amount === 0n) return refused('NoPending', 'Nothing pending to cancel.');
  return allowed(['Reads no oracle — this is available even while the vault is frozen.']);
}

// ─────────────────────────────── 3. skipWindow ────────────────────────────────

/**
 * `VaultCore.skipWindow` (VaultCore.sol:463-471). IRREVOCABLE: once-per-member-per-vault, no
 * un-opt-in. If a pending deposit exists it activates immediately in the SAME transaction via
 * `_activatePending` → `_mintShares` → `navWad()` — so with a pending deposit present this also
 * reverts while frozen; with nothing pending it reads no oracle at all and succeeds regardless.
 * @param {{skipOptIn:boolean|null, pendingDeposit:{amountUsdc:bigint|string}|null,
 *          frozen:boolean|null}} f
 * @returns {Verdict}
 */
export function skipWindow(f) {
  const optedIn = bool(f.skipOptIn);
  if (optedIn === null) return unread(['skipOptIn']);
  if (optedIn === true) {
    return refused('AlreadyOptedIn', 'You already burned this vault’s one-time skip opt-in.');
  }

  const pd = f.pendingDeposit;
  if (!pd) return unread(['pendingDeposit']);
  const pdAmount = toBig(pd.amountUsdc);
  if (pdAmount === null) return unread(['pendingDeposit.amountUsdc']);

  if (pdAmount > 0n) {
    const frozen = bool(f.frozen);
    if (frozen === null) return unread(['frozen']);
    if (frozen === true) {
      return refused(
        'StaleOracle',
        'skipWindow() would activate your pending deposit in the same transaction, which mints at NAV — and reverts while the oracle is frozen. The opt-in is NOT burned on a revert.',
      );
    }
    return irreversible(
      'Irrevocable: permanently burns your one-time skip opt-in for this vault, AND immediately mints your pending deposit at the current NAV — four hours earlier than it would otherwise price.',
      ['This cannot be undone once signed, whichever way NAV moves after.'],
    );
  }

  return irreversible(
    'Irrevocable: permanently burns your one-time skip opt-in for this vault, right now, for no immediate benefit — you have nothing pending to activate early.',
  );
}

// ────────────────────────────── 4. requestExit ────────────────────────────────

/**
 * `VaultCore.requestExit` (VaultCore.sol:551-567). Order: `ZeroAmount` → `ExitAlreadyQueued` →
 * `InsufficientShares` → branch on `Governance.hasPendingExecution` (VaultCore's own
 * `_pendingExecution`, VaultCore.sol:573-585):
 *   Mode F (pending execution true) — creator gate checked HERE (the L-1 fix, VaultCore.sol:557-559)
 *     before queuing; no oracle read; the exit is QUEUED and settles at whatever NAV holds when the
 *     pending proposal executes or expires — including a vote that is DEFEATED, since
 *     `hasPendingExecution` covers the whole reveal-through-resolution window, not "will pass".
 *   Mode I (no pending execution) — settles in the SAME transaction via `_settleExit`, which
 *     re-checks the creator gate (`fromQueue=false`) and reads the oracle to price the payout.
 * @param {{burnShares:bigint|string|null, queuedExitShares:bigint|string|null,
 *          sharesOf:bigint|string|null, hasPendingExecution:boolean|null,
 *          creator:string|null, member:string|null, totalShares:bigint|string|null,
 *          nonCreatorMemberCount:bigint|string|null, frozen:boolean|null,
 *          exitFeeMaxBps?:bigint|number|string|null, exitFeeDecayPeriodSec?:bigint|number|string|null,
 *          tenureSec?:bigint|number|string|null}} f
 * @returns {Verdict}
 */
export function requestExit(f) {
  const burn = toBig(f.burnShares);
  if (burn === null || burn <= 0n) return refused('ZeroAmount', 'Enter a share amount above zero.');

  const queued = toBig(f.queuedExitShares);
  if (queued === null) return unread(['queuedExitShares']);
  if (queued !== 0n) {
    return refused('ExitAlreadyQueued', 'An exit is already queued for you — one at a time, and it cannot be cancelled or added to.');
  }

  const sharesHeld = toBig(f.sharesOf);
  if (sharesHeld === null) return unread(['sharesOf']);
  if (sharesHeld < burn) return refused('InsufficientShares', 'You do not hold that many shares.');

  const pendingExec = bool(f.hasPendingExecution);
  if (pendingExec === null) return unread(['hasPendingExecution']);

  const gate = creatorGate({
    creator: f.creator,
    member: f.member,
    sharesOf: sharesHeld,
    totalShares: f.totalShares,
    nonCreatorMemberCount: f.nonCreatorMemberCount,
    burnShares: burn,
  });
  if (!gate.known) return unread(gate.missing);
  if (gate.blocked) {
    return refused(
      'CreatorStakeGate',
      'This would take you, the creator, below 5% of shares while other members remain. Checked at REQUEST time, not at settlement — the request itself reverts.',
    );
  }

  const feeCaveats = exitFeeCaveats(f);

  if (pendingExec === true) {
    return irreversible(
      'Queues this exit — irrevocable, no cancel. It settles at whatever NAV holds when the CURRENT proposal executes or expires, including a vote that is DEFEATED; queuing during the window does not mean it will pass. Your shares lose their vote the instant this is signed.',
      feeCaveats,
    );
  }

  const frozen = bool(f.frozen);
  if (frozen === null) return unread(['frozen']);
  if (frozen === true) {
    return refused('StaleOracle', 'Settles in this same transaction, which prices your in-kind slice through the oracle — and the oracle is frozen.');
  }
  return allowed(['Settles now, in this transaction, at current NAV.', ...feeCaveats]);
}

/**
 * `exitFeeBpsOf` is a CEILING, never the fee that lands — twice over. `_settleExit` waives it
 * entirely for a sole holder (`memberShares == totalShares` AT SETTLEMENT, VaultCore.sol:622),
 * and it recomputes `_exitFeeBps(member)` from `lastDepositTime` AT SETTLEMENT (VaultCore.sol:621)
 * — never at request/queue time. So even the tenure component shown now is not fixed; a deposit
 * between queuing and settling resets the tenure clock and can raise it (see the `deposit` note
 * above).
 * @param {{exitFeeMaxBps?:any, exitFeeDecayPeriodSec?:any, tenureSec?:any}} f
 * @returns {string[]}
 */
function exitFeeCaveats(f) {
  if (f.exitFeeMaxBps == null || f.exitFeeDecayPeriodSec == null || f.tenureSec == null) return [];
  const ceilingBps = exitFeeBps({
    exitFeeMaxBps: f.exitFeeMaxBps,
    exitFeeDecayPeriodSec: f.exitFeeDecayPeriodSec,
    tenureSec: f.tenureSec,
  });
  return [
    `Exit fee ceiling right now: ${ceilingBps} bps — NOT the amount you will pay. It is waived to zero if you are the vault's sole holder at settlement, and recomputed from tenure at settlement, not fixed today.`,
  ];
}

// ────────────────────────────────── 5. activate ───────────────────────────────

/**
 * `VaultCore.activate(member)` (VaultCore.sol:440-445) — PERMISSIONLESS: `msg.sender` need not be
 * `member`. Order: `NoPending` → `WindowNotElapsed` → `_activatePending` → `_mintShares` →
 * `navWad()` (frozen).
 * @param {{pendingDeposit:{amountUsdc:bigint|string, availableAt:number|string}|null,
 *          nowSec:number|null, frozen:boolean|null}} f
 * @returns {Verdict}
 */
export function activate(f) {
  const pd = f.pendingDeposit;
  if (!pd) return unread(['pendingDeposit']);
  const amount = toBig(pd.amountUsdc);
  if (amount === null) return unread(['pendingDeposit.amountUsdc']);
  if (amount === 0n) return refused('NoPending', 'Nothing pending to activate for this member.');

  const availableAt = Number(pd.availableAt);
  const now = Number(f.nowSec);
  if (!Number.isFinite(availableAt)) return unread(['pendingDeposit.availableAt']);
  if (!Number.isFinite(now)) return unread(['nowSec']);
  if (now < availableAt) {
    return refused('WindowNotElapsed', 'The 4-hour observation window has not elapsed yet.');
  }

  const frozen = bool(f.frozen);
  if (frozen === null) return unread(['frozen']);
  if (frozen === true) {
    return refused('StaleOracle', 'Mints at activation NAV, and the oracle is frozen.');
  }
  // Discriminator #305 applies to this surface too: `activate(member)` names the member, so this
  // call may be offered as "activate on their behalf" and must not read as "the member did this".
  return allowed(['This credits shares to the member whose pending deposit it is — not to whoever signs it.']);
}

// ───────────────────────────── 6. settleQueuedExit ────────────────────────────

/**
 * `VaultCore.settleQueuedExit(member)` (VaultCore.sol:591-598) — PERMISSIONLESS. Order:
 * `NoQueuedExit` → `ExecutionStillPending` (`_pendingExecution()`) → `_settleExit(member, shares,
 * true)`, which does NOT re-check the creator gate (`fromQueue=true` — VaultCore.sol:615-617
 * documents why: it was already checked at queue time, and re-checking could strand a queue that
 * passed the gate when membership has since grown) but DOES read the oracle to price the payout.
 * @param {{queuedExitShares:bigint|string|null, hasPendingExecution:boolean|null,
 *          frozen:boolean|null, exitFeeMaxBps?:any, exitFeeDecayPeriodSec?:any, tenureSec?:any}} f
 * @returns {Verdict}
 */
export function settleQueuedExit(f) {
  const queued = toBig(f.queuedExitShares);
  if (queued === null) return unread(['queuedExitShares']);
  if (queued === 0n) return refused('NoQueuedExit', 'No queued exit to settle for this member.');

  const pendingExec = bool(f.hasPendingExecution);
  if (pendingExec === null) return unread(['hasPendingExecution']);
  if (pendingExec === true) {
    return refused('ExecutionStillPending', 'The proposal that queued this exit has not executed or expired yet.');
  }

  const frozen = bool(f.frozen);
  if (frozen === null) return unread(['frozen']);
  if (frozen === true) {
    return refused('StaleOracle', 'Settlement prices the in-kind payout through the oracle, and the oracle is frozen.');
  }

  return allowed([
    'This credits the payout to the member whose exit was queued — not to whoever signs it (discriminator #305).',
    ...exitFeeCaveats(f),
  ]);
}
