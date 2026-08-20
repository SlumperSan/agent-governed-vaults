// @ts-check
/**
 * Signal (a) — ORACLE FRESHNESS. "Any basket asset within 1 breaker-trip of StaleOracle."
 *
 * OracleAggregator.priceWad(asset) reverts StaleOracle when fewer than `quorum` of the asset's
 * sources are fresh, and that revert freezes every NAV path in the vault INCLUDING EXITS — by
 * design, with no hatch (SF-2/K-4). So the operator must see the breaker coming, not learn about
 * it from trapped members.
 *
 * MARGIN = freshSources - quorum: how many FURTHER sources can go dark before capital freezes.
 *   margin >  0  ->  healthy: it takes margin+1 more failures to trip
 *   margin == 0  ->  ALERT: the vault is within ONE breaker-trip — any single source failure freezes it
 *   margin <  0  ->  ALERT: already tripped, priceWad reverts right now
 *
 * So the default bar is `margin <= 0`, which is exactly the runbook's "within 1 breaker-trip of
 * StaleOracle". Calibration matters here: a vault running the protocol minimum (3 sources,
 * quorum 2) sits at margin 1 when perfectly healthy, and alerting on that would page forever and
 * get the canary muted. Operators who want the earlier warning set ORACLE_MIN_MARGIN=1.
 *
 * Freshness is reproduced exactly as the contract computes it (OracleAggregator.priceWad):
 *   a source counts as fresh iff latestPrice() returns priceWad > 0 AND updatedAt >= now - maxStaleness,
 *   and a REVERTING source is simply not fresh — it must not be treated as an error here either,
 *   or one broken feed would page while quorum still holds.
 *
 * The staleness clock is CHAIN time (latest block timestamp), never the monitoring host's clock.
 *
 * Fans out one result per (vault, asset) so a single stale asset cannot flap the whole vault.
 */

import { ORACLE_VIEWS, PRICE_SOURCE_VIEWS } from '../abis.mjs';
import { ok, alert, skipped, shortAddr } from '../signal.mjs';

export const SIGNAL = 'oracle-freshness';

/**
 * @param {Object} ctx
 * @param {any} ctx.reader            injected chain reader (see ../reader.mjs)
 * @param {string} ctx.vault          the vault being watched
 * @param {string} ctx.oracle         its OracleAggregator address
 * @param {string[]} ctx.assets       the vault's basket assets (what navWad actually prices)
 * @param {number} ctx.nowSec         chain time, seconds
 * @param {number} [ctx.minMargin]    alert when freshSources - quorum <= this (default 0)
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkOracleFreshness({ reader, vault, oracle, assets, nowSec, minMargin = 0 }) {
  const out = [];

  for (const asset of assets) {
    const cfg = await reader.tryRead(oracle, ORACLE_VIEWS, 'assetConfig', [asset]);
    if (!cfg.ok) {
      out.push(skipped({
        signal: SIGNAL, vault, key: asset,
        message: `oracle config unreadable for asset ${shortAddr(asset)} on vault ${shortAddr(vault)}: ${cfg.error}`,
        detail: { vault, asset, oracle },
      }));
      continue;
    }

    const { sources, maxStaleness, quorum } = normalizeConfig(cfg.value);
    if (sources.length === 0) {
      // priceWad() reverts StaleOracle for an unlisted asset — the breaker, not a zero price.
      // A basket asset the oracle does not list means the vault is already frozen for that asset.
      out.push(alert({
        signal: SIGNAL, vault, key: asset,
        message: `oracle has NO sources listed for basket asset ${shortAddr(asset)} on vault ${shortAddr(vault)} — priceWad reverts StaleOracle, NAV and exits are frozen`,
        measured: '0 sources', threshold: '>= 3 sources',
        detail: { vault, asset, oracle, sources: 0 },
      }));
      continue;
    }

    const minUpdated = nowSec > maxStaleness ? nowSec - maxStaleness : 0;
    let fresh = 0;
    const stale = [];
    for (const source of sources) {
      const res = await reader.tryRead(source, PRICE_SOURCE_VIEWS, 'latestPrice', []);
      // A reverting source is not fresh. Same rule the aggregator applies in its try/catch.
      if (!res.ok) { stale.push({ source, reason: 'reverted' }); continue; }
      const [priceWad, updatedAt] = normalizePrice(res.value);
      if (priceWad > 0n && Number(updatedAt) >= minUpdated) fresh += 1;
      else stale.push({ source, reason: priceWad > 0n ? `stale by ${minUpdated - Number(updatedAt)}s` : 'zero price' });
    }

    const margin = fresh - quorum;
    const detail = {
      vault, asset, oracle, freshSources: fresh, totalSources: sources.length,
      quorum, margin, maxStalenessSec: maxStaleness, staleSources: stale,
    };

    if (margin < 0) {
      out.push(alert({
        signal: SIGNAL, vault, key: asset,
        message: `oracle breaker TRIPPED for ${shortAddr(asset)} on vault ${shortAddr(vault)}: ${fresh}/${sources.length} sources fresh, quorum ${quorum} — priceWad reverts StaleOracle, NAV and exits are frozen`,
        measured: `${fresh} fresh`, threshold: `>= ${quorum} (quorum)`, detail,
      }));
    } else if (margin <= minMargin) {
      out.push(alert({
        signal: SIGNAL, vault, key: asset,
        message: `oracle freshness margin ${margin} for ${shortAddr(asset)} on vault ${shortAddr(vault)}: ${fresh}/${sources.length} sources fresh, quorum ${quorum} — ${margin === 0 ? 'ANY' : `${margin + 1} more`} source failure freezes NAV and exits`,
        measured: `margin ${margin}`, threshold: `> ${minMargin}`, detail,
      }));
    } else {
      out.push(ok({
        signal: SIGNAL, vault, key: asset,
        message: `oracle margin ${margin} for ${shortAddr(asset)} on vault ${shortAddr(vault)} (${fresh}/${sources.length} fresh, quorum ${quorum})`,
        measured: `margin ${margin}`, threshold: `> ${minMargin}`, detail,
      }));
    }
  }

  return out;
}

/** assetConfig returns a 3-tuple; viem hands back an array or an object depending on ABI shape. */
function normalizeConfig(v) {
  const [sources, maxStaleness, quorum] = Array.isArray(v)
    ? v
    : [v.sources, v.maxStaleness, v.quorum];
  return { sources: [...(sources ?? [])], maxStaleness: Number(maxStaleness), quorum: Number(quorum) };
}

/** latestPrice returns (priceWad, updatedAt). */
function normalizePrice(v) {
  const [p, u] = Array.isArray(v) ? v : [v.priceWad, v.updatedAt];
  return [BigInt(p ?? 0), BigInt(u ?? 0)];
}
