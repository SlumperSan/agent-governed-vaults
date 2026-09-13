// @ts-check
/**
 * Composes a vault record + the viewer's position into the facts every screen renders. Kept out
 * of index.html so the derivations that decide what a user is shown are testable.
 */

import { toBig, USDC_SCALAR } from './format.mjs';
import { capacity } from './deposit-preview.mjs';
import { exitFeeBps } from './exit-preview.mjs';
import { resolveExitMode } from './governance.mjs';
import { actions, vaultStatus } from './vault-state.mjs';
import { stackedPerfFeeBps, stackedExitFeeCapBps } from './fees.mjs';

/**
 * Per-asset oracle health. A freeze is PER ASSET — `ChainlinkOracle.priceWad(asset)` reverts
 * `StaleOracle` for the one asset whose single feed went stale, and `VaultCore.navWad` walks the
 * whole basket, so a single stale feed freezes the entire vault. Showing which asset, and how far
 * past its bound, is what turns "frozen" from a scary opaque word into a legible mechanism.
 *
 * A ZERO balance is skipped entirely: `navWad` walks the basket under `if (bal != 0)`
 * (VaultCore.sol:284-287), so it never prices an asset the vault does not hold, and a stale feed
 * on one freezes nothing on-chain. Reporting it as a freeze would disable deposits, activation
 * and exits on a vault the contract would happily serve. An UNKNOWN balance is not zero and is
 * still assessed.
 *
 * @param {Array<{symbol:string, balance?:any, oracleUpdatedAt:number|null,
 *                maxStalenessSec:number|null, priceWad:any}>} basket
 * @param {number} nowSec
 */
export function oracleHealth(basket, nowSec) {
  const assets = (basket ?? []).map((a) => {
    if ('balance' in a && toBig(a.balance) === 0n) {
      return { symbol: a.symbol, state: /** @type {const} */ ('unheld'), ageSec: null, boundSec: null, overBySec: null };
    }
    if (!Number.isFinite(a.oracleUpdatedAt) || !Number.isFinite(a.maxStalenessSec)) {
      return { symbol: a.symbol, state: /** @type {const} */ ('unknown'), ageSec: null, boundSec: null, overBySec: null };
    }
    const age = Math.max(0, nowSec - Number(a.oracleUpdatedAt));
    const bound = Number(a.maxStalenessSec);
    if (age > bound) {
      return { symbol: a.symbol, state: /** @type {const} */ ('stale'), ageSec: age, boundSec: bound, overBySec: age - bound };
    }
    // Within bound, but close enough that a user should not start a transaction on it.
    const state = age > bound * 0.8 ? /** @type {const} */ ('ageing') : /** @type {const} */ ('fresh');
    return { symbol: a.symbol, state, ageSec: age, boundSec: bound, overBySec: null };
  });
  const stale = assets.filter((a) => a.state === 'stale');
  const unknown = assets.filter((a) => a.state === 'unknown');
  return {
    assets,
    frozen: stale.length > 0,
    // A vault whose feed freshness we cannot read is not provably live.
    determinable: unknown.length === 0,
    culprits: stale.map((a) => a.symbol),
  };
}

/**
 * Voting-eligible stake, mirroring `VaultCore.votingEligibleShares` (VaultCore.sol:1025-1028):
 * the parent vault reads 0, everyone else reads `sharesOf[member] - queuedExitShares[member]`.
 *
 * It is its own derivation because both subtractions are invisible on a page that shows only a
 * share balance. A Mode-F exit locks shares the instant it is QUEUED — `requestExit` writes
 * `queuedExitShares` and calls `_snapshot` in the same transaction (VaultCore.sol:551-556) — and
 * `requestExit(shares)` takes any amount up to the balance, so a PARTIAL queue leaves a real
 * voting remainder that "queued / not queued" alone cannot express.
 *
 * `eligibleShares` is not the same claim as "shares you can vote with today": `commitVote` weighs
 * `min(pastVotingEligibleShares(createdAt-1), votingEligibleShares(now))` (Governance.sol:352-356),
 * so stake minted after a proposal was created is eligible here and still carries no weight in
 * that proposal. This is the eligibility term, and nothing more.
 *
 * @param {{shares:bigint, queuedExitShares:bigint, isParentVault:boolean}} p
 * @returns {{shares:bigint, lockedShares:bigint, eligibleShares:bigint, isParentVault:boolean,
 *            reason:'parent'|'queued'|'full'}}
 */
export function votingEligibility({ shares, queuedExitShares, isParentVault }) {
  // The carve-out is the contract's FIRST branch and never reads `queuedExitShares`, so a parent
  // vault reports its zero for the reason the contract gives, queued exit or not.
  if (isParentVault) {
    return { shares, lockedShares: 0n, eligibleShares: 0n, isParentVault: true, reason: 'parent' };
  }
  // Clamped defensively only: `requestExit` requires `sharesOf >= shares`, shares are
  // non-transferable, and a member with a queued exit cannot queue again, so the contract cannot
  // reach queued > held. Incoherent input renders as zero, never as a negative share count.
  const locked = queuedExitShares > shares ? shares : queuedExitShares;
  return {
    shares,
    lockedShares: locked,
    eligibleShares: shares - locked,
    isParentVault: false,
    reason: locked > 0n ? 'queued' : 'full',
  };
}

/**
 * The viewer's position in one vault, valued at the vault's NAV/share.
 * @param {object} vault
 * @param {object|null} holding
 * @param {number} nowSec
 * @param {string|null} [viewerAddress] whose position this is — compared against the vault's
 *   registered parent, to mirror the contract's parent-vault carve-out
 * @returns {{shares:bigint, valueUsdc:bigint|null, costBasisUsdc:bigint|null,
 *            pnlUsdc:bigint|null, tenureSec:number, feeBpsNow:bigint, isSoleHolder:boolean,
 *            queuedExitShares:bigint, voting:ReturnType<typeof votingEligibility>}|null}
 */
export function position(vault, holding, nowSec, viewerAddress) {
  if (!vault || !holding) return null;
  const shares = toBig(holding.shares) ?? 0n;
  const totalShares = toBig(vault.totalShares) ?? 0n;
  const navWad = toBig(vault.navWad);
  const basis = toBig(holding.costBasisUsdc);

  // value = shares/totalShares × NAV, in USDC. Unknowable while frozen — NAV cannot be read —
  // and equally unknowable when the freeze state itself is unknown (`frozen: null`).
  let valueUsdc = null;
  if (vault.frozen === false && navWad !== null && totalShares > 0n) {
    valueUsdc = (navWad * shares) / totalShares / USDC_SCALAR;
  }

  const tenureSec = Math.max(0, nowSec - Number(holding.lastDepositTime ?? nowSec));
  const isSoleHolder = totalShares > 0n && shares === totalShares;
  const queuedExitShares = toBig(holding.queuedExitShares) ?? 0n;

  // A ROOT vault carries `parent: null`, and `parentVault()` returns address(0) there — never a
  // member — so the carve-out cannot bite, and a record missing the field reads as root. Both
  // record producers set it: `fixtures.mjs` verbatim, `mapVaultRecords` as `v.parent ?? null`.
  const parent = vault.parent ?? null;

  return {
    shares,
    valueUsdc,
    costBasisUsdc: basis,
    pnlUsdc: valueUsdc !== null && basis !== null ? valueUsdc - basis : null,
    tenureSec,
    feeBpsNow: exitFeeBps({
      exitFeeMaxBps: vault.exitFeeMaxBps,
      exitFeeDecayPeriodSec: vault.exitFeeDecayPeriodSec,
      tenureSec,
      isSoleHolder,
    }),
    isSoleHolder,
    queuedExitShares,
    voting: votingEligibility({
      shares,
      queuedExitShares,
      isParentVault: parent !== null && eqAddr(viewerAddress, parent),
    }),
  };
}

/**
 * Everything a card or a detail page needs, in one object, so the two cannot disagree about
 * whether a vault is frozen or whether its exits queue.
 *
 * @param {object} vault    a fixture/API vault record
 * @param {object|null} wallet
 * @param {number} nowSec
 */
export function vaultView(vault, wallet, nowSec) {
  const holding = wallet?.positions?.find((p) => eqAddr(p.vault, vault.address)) ?? null;
  const pendingDeposit = wallet?.pending?.find((p) => eqAddr(p.vault, vault.address)) ?? null;

  const oracle = oracleHealth(vault.basket, nowSec);
  // TRI-STATE, not a boolean. `true` = a feed is provably past its bound; `false` = every held
  // asset is provably within it; `null` = we cannot tell, which is neither. A source that carries
  // no oracle data at all (the metered API sets `frozen: null`) must not render as "not frozen" —
  // the freeze is the most consequential state in the product and a false negative on it is the
  // one that traps capital.
  const frozen = vault.frozen === true || oracle.frozen
    ? true
    : vault.frozen === null || vault.frozen === undefined || !oracle.determinable
      ? null
      : false;

  const navWadRaw = toBig(vault.navWad);
  const cap = capacity({
    navUsdc: navWadRaw === null ? null : navWadRaw / USDC_SCALAR,
    totalPendingUsdc: vault.totalPendingUsdc ?? null,
    capacityCapUsdc: vault.capacityCapUsdc ?? 0n,
  });

  // The derived freeze state, not the record's own flag, decides whether the position can be
  // valued — so a card and the detail page cannot disagree about it.
  const pos = position({ ...vault, frozen }, holding, nowSec, wallet?.address ?? null);

  const mode = resolveExitMode(vault.proposal ?? null, nowSec);

  const facts = {
    frozen,
    attested: Boolean(vault.attested),
    exitMode: mode.mode,
    isMember: (pos?.shares ?? 0n) > 0n,
    hasPendingDeposit: Boolean(pendingDeposit),
    pendingMatured: Boolean(pendingDeposit) && nowSec >= Number(pendingDeposit.availableAt),
    hasQueuedExit: (pos?.queuedExitShares ?? 0n) > 0n,
    capacityFull: cap.capped && cap.determinable && cap.headroom === 0n,
    capacityKnown: cap.determinable,
    walletConnected: Boolean(wallet),
  };

  const levels = Number(vault.depth ?? 0) + 1;
  return {
    vault,
    holding,
    pendingDeposit,
    position: pos,
    oracle,
    frozen,
    capacity: cap,
    mode,
    facts,
    status: vaultStatus(facts),
    actions: actions(facts),
    fees: {
      levels,
      stackedPerfFeeBps: stackedPerfFeeBps(levels),
      stackedExitFeeCapBps: stackedExitFeeCapBps((vault.exitFeeMaxBpsByLevel ?? []).slice(0, levels)),
      // null, not 0: an unexposed exit-fee ceiling is not a vault that charges no exit fee.
      exitFeeMaxBps: vault.exitFeeMaxBps === null || vault.exitFeeMaxBps === undefined ? null : Number(vault.exitFeeMaxBps),
      exitFeeDecayPeriodSec: vault.exitFeeDecayPeriodSec === null || vault.exitFeeDecayPeriodSec === undefined ? null : Number(vault.exitFeeDecayPeriodSec),
    },
  };
}

function eqAddr(a, b) {
  return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
}

/** Sort keys for discovery. Each names the signal it ranks on, so the UI never sorts on a proxy. */
export const SORTS = {
  capacity: { label: 'Capacity used', fn: (a, b) => (b.capacity.usedBps ?? -1) - (a.capacity.usedBps ?? -1) },
  size: { label: 'Vault NAV', fn: (a, b) => cmpBig(toBig(b.vault.navWad) ?? 0n, toBig(a.vault.navWad) ?? 0n) },
  members: { label: 'Members', fn: (a, b) => Number(b.vault.holderCount ?? 0) - Number(a.vault.holderCount ?? 0) },
  // An unexposed ceiling sorts last rather than as free.
  fee: { label: 'Lowest exit fee', fn: (a, b) => (a.fees.exitFeeMaxBps ?? Infinity) - (b.fees.exitFeeMaxBps ?? Infinity) },
};

function cmpBig(x, y) {
  return x > y ? 1 : x < y ? -1 : 0;
}
