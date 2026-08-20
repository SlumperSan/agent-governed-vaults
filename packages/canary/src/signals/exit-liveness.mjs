// @ts-check
/**
 * Signal (d) — EXIT LIVENESS. The H-1 regression sentinel.
 *
 * H-1 / MO-1: a creator-chosen bookkeeping module (governance, feeEngine, registry) that reverts,
 * burns gas, or bombs returndata could brick every exit in a vault forever, with no upgrade path.
 * The contract mitigates it — module calls are gas-capped at 300k and returndata-bounded to one
 * word, and a failing governance falls back to Mode I. This signal is the sentinel that proves
 * the mitigation still holds on the deployed bytecode: it static-calls `requestExit` as a REAL
 * member and classifies the revert.
 *
 * ── The failure mode this design exists to avoid ──
 * `requestExit` reverts `ZeroAmount` on 0 shares and `InsufficientShares` unless the CALLER holds
 * them. Probing from an arbitrary address therefore always reverts with a gate error, and the
 * sentinel would report healthy forever while exits were bricked. So the probe requires a member
 * who actually holds shares — supplied from the indexer's projection share book. With no such
 * member the result is `skipped`, never `ok`: a check that cannot run has not passed.
 *
 * ── Classification (three-way, not two) ──
 *   GATE   (ZeroAmount, InsufficientShares, ExitAlreadyQueued, CreatorStakeGate,
 *           ExitNeedsChildSettlement, ChildSettlementPending) — the caller's own position makes
 *           the call invalid. Expected. OK.
 *   FROZEN (StaleOracle) — the SF-2/K-4 breaker. By design, but it IS a live capital freeze, so it
 *           is `skipped` and attributed to the oracle signal, which pages for it. Never reported
 *           as OK — an operator must not read "exits fine" while capital is frozen.
 *   FAULT  (everything else: Reentrancy, Panic, Error(string), an unrecognized selector, or
 *           EMPTY returndata) — ALERT. Empty/unrecognized returndata is the actual H-1 signature
 *           (a module that ran out of its gas cap or bombed returndata), so it must land here.
 *           There is deliberately no "could not classify, assume healthy" branch.
 *   SUCCESS — the call did not revert. Exits are live. OK.
 *
 * READ-ONLY: `eth_call` with an impersonated `from`. Nothing is signed, nothing is broadcast, and
 * no key exists in this package. The chain state is never touched.
 */

import { REQUEST_EXIT_SELECTOR, EXIT_GATE_SELECTORS, EXIT_FROZEN_SELECTORS, EXIT_FAULT_SELECTORS } from '../abis.mjs';
import { ok, alert, skipped, shortAddr } from '../signal.mjs';

export const SIGNAL = 'exit-liveness';

/**
 * ABI-encode `requestExit(uint256 shares)`. Hand-rolled so the module needs no encoder dependency;
 * one static uint256 argument is the whole encoding. test/abis.test.mjs cross-checks the selector.
 * @param {bigint} shares
 */
export function encodeRequestExit(shares) {
  return REQUEST_EXIT_SELECTOR + BigInt(shares).toString(16).padStart(64, '0');
}

/**
 * Choose which member to probe with. Prefers a non-creator holder (the creator hits the CM-1
 * stake gate, which is a gate revert and so a weaker probe), largest balance first for stability
 * across polls. Falls back to the creator if they are the only holder — with no other members
 * `nonCreatorMemberCount == 0`, so the gate does not apply and the probe is still meaningful.
 * Pure and separately tested.
 * @param {Iterable<[string,bigint]>} shareBook
 * @param {string} [creator]
 * @returns {{member:string, shares:bigint}|null}
 */
export function pickProbeMember(shareBook, creator) {
  const c = typeof creator === 'string' ? creator.toLowerCase() : null;
  const holders = [...(shareBook ?? [])]
    .map(([member, shares]) => ({ member, shares: BigInt(shares) }))
    .filter((h) => h.shares > 0n);
  if (holders.length === 0) return null;
  const rank = (h) => (h.member.toLowerCase() === c ? 1 : 0); // non-creator first
  holders.sort((a, b) => rank(a) - rank(b) || (b.shares > a.shares ? 1 : b.shares < a.shares ? -1 : 0));
  return holders[0];
}

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {Map<string,bigint>|Iterable<[string,bigint]>} [ctx.shareBook]  state.shares.get(vault)
 * @param {string} [ctx.creator]  the vault creator, so the probe can prefer a non-creator member
 * @param {bigint} [ctx.probeShares]  amount to probe with (default 1 — the smallest valid request)
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkExitLiveness({ reader, vault, shareBook, creator, probeShares = 1n }) {
  const probe = pickProbeMember(shareBook, creator);
  if (!probe) {
    return [skipped({
      signal: SIGNAL, vault,
      message: `exit-liveness sentinel CANNOT RUN on vault ${shortAddr(vault)}: the indexer projection lists no member holding shares, so requestExit has no valid caller to probe with — this vault is unmonitored for H-1, it is not healthy`,
      detail: { vault, reason: 'no-eligible-member' },
    })];
  }

  const shares = probeShares < probe.shares ? probeShares : probe.shares;
  const res = await reader.staticCall({
    to: vault,
    from: probe.member,
    data: encodeRequestExit(shares),
  });
  const detail = { vault, probeMember: probe.member, probeShares: shares.toString(), revertData: res.data ?? null };

  if (res.ok) {
    return [ok({
      signal: SIGNAL, vault,
      message: `exits live on vault ${shortAddr(vault)}: requestExit(${shares}) static-calls clean as ${shortAddr(probe.member)}`,
      measured: 'no revert', threshold: 'no non-gate revert', detail,
    })];
  }

  const selector = typeof res.data === 'string' && res.data.length >= 10 ? res.data.slice(0, 10).toLowerCase() : null;

  if (selector && selector in EXIT_GATE_SELECTORS) {
    const name = EXIT_GATE_SELECTORS[selector];
    return [ok({
      signal: SIGNAL, vault,
      message: `exits live on vault ${shortAddr(vault)}: requestExit reverted ${name}, a caller-position gate, not a fault`,
      measured: name, threshold: 'no non-gate revert', detail: { ...detail, revertName: name },
    })];
  }

  if (selector && selector in EXIT_FROZEN_SELECTORS) {
    return [skipped({
      signal: SIGNAL, vault,
      message: `exit-liveness sentinel cannot run on vault ${shortAddr(vault)}: requestExit reverts StaleOracle — the oracle breaker has frozen exits (SF-2/K-4, by design). The oracle-freshness signal pages for this; H-1 coverage is suspended until the breaker clears`,
      detail: { ...detail, revertName: 'StaleOracle', attributedTo: 'oracle-freshness' },
    })];
  }

  // Everything else is a fault. Empty returndata and unrecognized selectors land HERE, not in ok.
  const name = (selector && EXIT_FAULT_SELECTORS[selector])
    || (selector ? `unrecognized revert ${selector}` : 'EMPTY returndata (out-of-gas or returndata bomb)');
  return [alert({
    signal: SIGNAL, vault,
    message: `EXIT LIVENESS BROKEN on vault ${shortAddr(vault)} (H-1 regression): requestExit(${shares}) as member ${shortAddr(probe.member)} reverts with ${name} — a non-gate revert means members cannot exit`,
    measured: name, threshold: 'no non-gate revert',
    detail: { ...detail, revertName: name, threatModelRow: 'MO-1 (review H-1)' },
  })];
}
