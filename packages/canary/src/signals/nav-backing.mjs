// @ts-check
/**
 * Signal (b) — NAV BACKING. "navWad diverges from independently-computed holdings > 0.5%."
 *
 * Two legs, both keyed separately so they alert independently:
 *
 * COMPOSITION — recompute navWad from the vault's own component getters and compare.
 *   This reproduces VaultCore.navWad() exactly, including the SV-7 look-through:
 *     nav = idleUsdc*usdcScalar
 *         + Σ assetBalance[a] * oracle.priceWad(a) / assetUnit[a]
 *         + Σ _fullNavWad(child,1) * sharesOf(this) / child.totalShares()
 *   with descendants valued through THIS vault's oracle and THIS vault's assetUnit/usdcScalar,
 *   recursing to MAX_LOOKTHROUGH_DEPTH = 3. `assetUnit` and `usdcScalar` are public getters, so
 *   nothing is re-derived from token decimals and nothing is assumed about USDC being 6dp.
 *
 *   Every read is pinned to ONE block height, so a healthy vault diverges by exactly 0 — this is
 *   an invariant check, not an estimate. It catches the class of bug S6 Finding 1 was (a
 *   look-through that silently dropped grandchild value from the root NAV), an unpriceable basket
 *   asset, and any child whose share accounting has moved out from under its parent.
 *
 * CUSTODY — compare the vault's INTERNAL accounting against the token balances it actually holds.
 *   This is the genuinely independent leg. The comparison is one-sided on purpose:
 *     balanceOf(vault) >= idleUsdc + totalPendingUsdc      (USDC)
 *     balanceOf(vault) >= assetBalance[a]                  (each basket asset)
 *   A SURPLUS is normal and never alerts — donations, escrowed in-kind slices (EE-6 `claimable`),
 *   and observation-window capital (EE-1 `totalPendingUsdc`, deliberately outside NAV) all sit in
 *   the token balance without being in NAV. A SHORTFALL is the alarming direction: the vault
 *   believes it owns more than it holds, so members' NAV is not backed.
 *
 * If the oracle breaker is tripped, navWad() reverts StaleOracle. That is `skipped`, attributed to
 * the oracle signal — not a NAV divergence alert. Never double-page for one root cause.
 */

import { VAULT_VIEWS, ORACLE_VIEWS, ERC20_VIEWS, EXIT_FROZEN_SELECTORS } from '../abis.mjs';
import { ok, alert, skipped, shortAddr, divergenceBps, bpsToPct } from '../signal.mjs';

export const SIGNAL = 'nav-backing';

/** Matches VaultCore.MAX_LOOKTHROUGH_DEPTH. */
const MAX_LOOKTHROUGH_DEPTH = 3;

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {number} [ctx.atBlock]        pin every read to this height (the runner supplies head)
 * @param {number} [ctx.thresholdBps]   composition divergence bar, default 50 = 0.5%
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkNavBacking({ reader, vault, atBlock, thresholdBps = 50 }) {
  const at = atBlock != null ? { blockNumber: atBlock } : {};
  const V = (address, fn, args = []) => reader.read(address, VAULT_VIEWS, fn, args, at);
  const results = [];

  const reportedRes = await reader.tryRead(vault, VAULT_VIEWS, 'navWad', [], at);
  if (!reportedRes.ok) {
    const frozen = isFrozen(reportedRes.revertData);
    results.push(skipped({
      signal: SIGNAL, vault, key: 'composition',
      message: frozen
        ? `NAV check skipped on vault ${shortAddr(vault)}: navWad() reverts StaleOracle — the oracle breaker is tripped (see the oracle-freshness signal for the asset)`
        : `NAV check skipped on vault ${shortAddr(vault)}: navWad() is unreadable: ${reportedRes.error}`,
      detail: { vault, revertData: reportedRes.revertData, attributedTo: frozen ? 'oracle-freshness' : null },
    }));
    return results;
  }

  const oracle = await V(vault, 'oracle');
  const usdcScalar = BigInt(await V(vault, 'usdcScalar'));
  const priceOf = memoPrice(reader, oracle, at);

  let recomputed;
  try {
    recomputed = await selfValue(V, priceOf, vault, usdcScalar, vault);
    for (const child of await childrenOf(V, vault)) {
      const myShares = BigInt(await V(child, 'sharesOf', [vault]));
      if (myShares === 0n) continue;
      const childTotal = BigInt(await V(child, 'totalShares'));
      if (childTotal === 0n) continue;
      // Multiply-then-divide, matching _childValueWad's truncation exactly.
      recomputed += (await fullNav(V, priceOf, child, vault, usdcScalar, 1)) * myShares / childTotal;
    }
  } catch (err) {
    const frozen = isFrozen(err?.revertData);
    results.push(skipped({
      signal: SIGNAL, vault, key: 'composition',
      message: frozen
        ? `NAV recompute skipped on vault ${shortAddr(vault)}: a basket asset price reverts StaleOracle (see the oracle-freshness signal)`
        : `NAV recompute failed on vault ${shortAddr(vault)}: ${err?.message ?? err}`,
      detail: { vault, attributedTo: frozen ? 'oracle-freshness' : null },
    }));
    return results;
  }

  const reported = BigInt(reportedRes.value);
  const bps = divergenceBps(reported, recomputed);
  const detail = {
    vault, atBlock: atBlock ?? null,
    navWad: reported.toString(), recomputedWad: recomputed.toString(),
    divergenceBps: Number(bps),
  };
  const line = `navWad ${reported} vs recomputed ${recomputed} (${bpsToPct(bps)})`;

  results.push(bps > BigInt(thresholdBps)
    ? alert({
      signal: SIGNAL, vault, key: 'composition',
      message: `NAV backing divergence on vault ${shortAddr(vault)}: ${line} — exceeds ${bpsToPct(thresholdBps)}`,
      measured: bpsToPct(bps), threshold: bpsToPct(thresholdBps), detail,
    })
    : ok({
      signal: SIGNAL, vault, key: 'composition',
      message: `NAV backing on vault ${shortAddr(vault)}: ${line}`,
      measured: bpsToPct(bps), threshold: bpsToPct(thresholdBps), detail,
    }));

  results.push(await custodyLeg(reader, V, vault, at));
  return results;
}

/**
 * Custody: does the vault actually hold what its internal accounting claims? Shortfall only —
 * a surplus is EE-1 pending capital, EE-6 escrow, or a donation, none of which are faults.
 */
async function custodyLeg(reader, V, vault, at) {
  const shortfalls = [];
  const checked = [];
  try {
    const usdc = await V(vault, 'usdc');
    const owedUsdc = BigInt(await V(vault, 'idleUsdc')) + BigInt(await V(vault, 'totalPendingUsdc'));
    const heldUsdc = BigInt(await reader.read(usdc, ERC20_VIEWS, 'balanceOf', [vault], at));
    checked.push({ token: usdc, owed: owedUsdc.toString(), held: heldUsdc.toString() });
    if (heldUsdc < owedUsdc) shortfalls.push({ token: usdc, label: 'USDC', owed: owedUsdc, held: heldUsdc });

    for (const asset of await basketOf(V, vault)) {
      const owed = BigInt(await V(vault, 'assetBalance', [asset]));
      if (owed === 0n) continue;
      const held = BigInt(await reader.read(asset, ERC20_VIEWS, 'balanceOf', [vault], at));
      checked.push({ token: asset, owed: owed.toString(), held: held.toString() });
      if (held < owed) shortfalls.push({ token: asset, label: shortAddr(asset), owed, held });
    }
  } catch (err) {
    return skipped({
      signal: SIGNAL, vault, key: 'custody',
      message: `custody check skipped on vault ${shortAddr(vault)}: a token balance is unreadable: ${err?.message ?? err}`,
      detail: { vault },
    });
  }

  if (shortfalls.length === 0) {
    return ok({
      signal: SIGNAL, vault, key: 'custody',
      message: `custody on vault ${shortAddr(vault)}: ${checked.length} token balances cover internal accounting`,
      measured: 'no shortfall', threshold: 'held >= accounted', detail: { vault, checked },
    });
  }
  const worst = shortfalls[0];
  return alert({
    signal: SIGNAL, vault, key: 'custody',
    message: `BACKING SHORTFALL on vault ${shortAddr(vault)}: ${worst.label} accounting says ${worst.owed} but the vault holds ${worst.held} (short ${worst.owed - worst.held})${shortfalls.length > 1 ? ` and ${shortfalls.length - 1} more token(s)` : ''}`,
    measured: `${worst.held} held`, threshold: `>= ${worst.owed} accounted`,
    detail: { vault, shortfalls: shortfalls.map((s) => ({ token: s.token, owed: s.owed.toString(), held: s.held.toString() })), checked },
  });
}

/** idleUsdc + priced basket, for `target`, using `payer`'s scalar/units and oracle (mirrors _fullNavWad). */
async function selfValue(V, priceOf, target, usdcScalar, payer) {
  let nav = BigInt(await V(target, 'idleUsdc')) * usdcScalar;
  for (const asset of await basketOf(V, target)) {
    const bal = BigInt(await V(target, 'assetBalance', [asset]));
    if (bal === 0n) continue;
    const unit = BigInt(await V(payer, 'assetUnit', [asset]));
    if (unit === 0n) throw new Error(`asset ${asset} has no assetUnit on vault ${payer} — it is not in this vault's basket, so navWad cannot price it`);
    nav += bal * (await priceOf(asset)) / unit;
  }
  return nav;
}

/** VaultCore._fullNavWad(v, depth) — descendants priced through the ROOT payer's oracle and units. */
async function fullNav(V, priceOf, target, payer, usdcScalar, depth) {
  let nav = await selfValue(V, priceOf, target, usdcScalar, payer);
  if (depth >= MAX_LOOKTHROUGH_DEPTH) return nav;
  for (const grandchild of await childrenOf(V, target)) {
    const shares = BigInt(await V(grandchild, 'sharesOf', [target]));
    if (shares === 0n) continue;
    const total = BigInt(await V(grandchild, 'totalShares'));
    if (total === 0n) continue;
    nav += (await fullNav(V, priceOf, grandchild, payer, usdcScalar, depth + 1)) * shares / total;
  }
  return nav;
}

async function basketOf(V, target) {
  const n = Number(await V(target, 'basketLength'));
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await V(target, 'basketAssets', [i]));
  return out;
}

async function childrenOf(V, target) {
  const n = Number(await V(target, 'childVaultCount'));
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(await V(target, 'childVaults', [i]));
  return out;
}

/** One priceWad read per asset per check, not one per appearance in the look-through tree. */
function memoPrice(reader, oracle, at) {
  const cache = new Map();
  return async (asset) => {
    const k = String(asset).toLowerCase();
    if (cache.has(k)) return cache.get(k);
    const res = await reader.tryRead(oracle, ORACLE_VIEWS, 'priceWad', [asset], at);
    if (!res.ok) {
      const err = new Error(`priceWad(${asset}) reverted: ${res.error}`);
      // @ts-ignore — carried so the caller can attribute a StaleOracle revert to the oracle signal
      err.revertData = res.revertData;
      throw err;
    }
    const p = BigInt(res.value);
    cache.set(k, p);
    return p;
  };
}

function isFrozen(revertData) {
  return typeof revertData === 'string' && revertData.slice(0, 10) in EXIT_FROZEN_SELECTORS;
}
