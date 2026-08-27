#!/usr/bin/env node
// @ts-check
/**
 * DRILL 4 instrument — oracle staleness time series (read-only, never signs).
 *
 * The Base Sepolia config runs THREE ChainlinkSourceAdapter instances over ONE underlying feed
 * per asset (the documented testnet compromise — see `testnetCompromise` in the chain config).
 * A consequence worth stating plainly, because it shapes what this drill can prove:
 *
 *   All three sources share a single heartbeat. They go stale TOGETHER. So the aggregator's
 *   freshness margin (freshSources - quorum) is all-or-nothing: 1 while the feed is alive,
 *   -2 the moment it lapses. There is no gradual decay to observe, and the canary's
 *   oracle-freshness signal will therefore jump OK -> ALERT with no intermediate state.
 *
 * What we sample, every tick, from CHAIN time (never the host clock — the contract uses
 * block.timestamp and so must we):
 *   - each underlying feed's `updatedAt` and the resulting age
 *   - the age as a fraction of maxStaleness (86400s), i.e. how close the breaker is
 *   - whether `priceWad(asset)` currently reverts (the breaker's live verdict)
 *   - whether `cancelPending()` is still statically callable  <-- the FREEZE-SAFETY property
 *
 * The freeze-safety check is the point of the drill. SF-2/K-4 freeze every NAV path on a stale
 * oracle, exits included, with no hatch. `cancelPending` is the one member-capital path that
 * must survive, because a pending deposit has not been priced yet: it is escrowed USDC, not a
 * share of NAV, so returning it needs no oracle. We prove it by static call (`cast call --from`)
 * against a real pending depositor, which costs no signature and no gas.
 *
 * Output: one JSON line per sample to the series file, so a gap in the series is visible as a
 * timestamp jump rather than being silently interpolated.
 *
 * Env: BASE_SEPOLIA_RPC, SOAK_SERIES (default data/oracle-series.jsonl),
 *      SOAK_SAMPLE_MS (default 120000), SOAK_PROBE_MEMBER (address to probe cancelPending as)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadDeployment } from './deployment.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://base-sepolia-rpc.publicnode.com';
const CAST = process.env.CAST ?? 'cast';
const SERIES = process.env.SOAK_SERIES ?? path.join(ROOT, 'data', 'oracle-series.jsonl');
const SAMPLE_MS = Number(process.env.SOAK_SAMPLE_MS ?? 120_000);
const PROBE_MEMBER = process.env.SOAK_PROBE_MEMBER ?? '';
const VAULTS = (process.env.SOAK_VAULTS ?? '').split(',').map((v) => v.trim()).filter(Boolean);

const dep = loadDeployment(
  path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json'),
  { expectChainId: 84532 },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/\s+\[[^\]]*\]$/, '').trim();

/** @returns {{ok:true,out:string}|{ok:false,err:string}} */
function tryCast(args) {
  try {
    return { ok: true, out: execFileSync(CAST, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim() };
  } catch (e) {
    const raw = e.stderr ? String(e.stderr).trim() : String(e.message);
    return { ok: false, err: raw.split('\n').slice(0, 2).join(' ').slice(0, 220) };
  }
}
const callRaw = (to, sig, ...args) => tryCast(['call', to, sig, ...args.map(String), '--rpc-url', RPC]);

/** Decode the 5-word Chainlink latestRoundData tuple; we only need updatedAt (word 3). */
function feedUpdatedAt(feed) {
  const r = callRaw(feed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)');
  if (!r.ok) return { ok: false, err: r.err };
  const lines = r.out.split('\n').map(clean);
  return { ok: true, answer: lines[1], updatedAt: Number(lines[3]) };
}

/** `cast sig "NoPending()"` — pinned, not computed, so a rename in the contract surfaces here. */
export const SEL_NO_PENDING = '0xda7557bc';

/**
 * Classify a `cancelPending()` static call into a TRI-STATE verdict.
 *
 * This is the evidence drill 4 turns on, so "it reverted" is not good enough — the call reverts
 * for two entirely different reasons and only one of them is a finding:
 *
 *   'callable'        the escrow-return path is open. THIS is the freeze-safety property.
 *   'n/a-no-pending'  reverted NoPending(): there is no pending deposit for this member to
 *                     cancel. Says NOTHING about the oracle. Scoring it as a failure would be
 *                     a false alarm; scoring it as a pass would be a false pass — which is the
 *                     more dangerous error, since it would let the drill claim freeze-safety
 *                     was proven when nothing was ever probed.
 *   'BLOCKED'         reverted for any other reason. While the oracle is frozen this is the
 *                     real finding: a path that must never consult a price just did.
 *
 * @param {{ok:true,out:string}|{ok:false,err:string}} r
 * @param {string|null} pendingAmount
 * @returns {'callable'|'n/a-no-pending'|'BLOCKED'}
 */
export function classifyCancelPending(r, pendingAmount) {
  if (r.ok) return 'callable';
  if (r.err.includes(SEL_NO_PENDING)) return 'n/a-no-pending';
  // Defence in depth: if the revert data was truncated by the RPC, a zero pending balance is
  // itself sufficient to explain a NoPending revert.
  if (pendingAmount === '0') return 'n/a-no-pending';
  return 'BLOCKED';
}

function sample() {
  const blk = tryCast(['block', 'latest', '-f', 'timestamp', '--rpc-url', RPC]);
  if (!blk.ok) return { t: new Date().toISOString(), error: `chain time unreadable: ${blk.err}` };
  const chainNow = Number(blk.out);

  const assets = dep.assets.map((a) => {
    const f = feedUpdatedAt(a.underlyingFeed);
    const price = callRaw(dep.aggregator, 'priceWad(address)(uint256)', a.token);
    // Per-source freshness exactly as OracleAggregator.priceWad computes it.
    let fresh = 0;
    const sources = a.sources.map((src) => {
      const r = callRaw(src, 'latestPrice()(uint256,uint256)');
      if (!r.ok) return { source: src, fresh: false, reason: 'revert' };
      const [p, updatedAt] = r.out.split('\n').map(clean);
      const isFresh = BigInt(p) > 0n && Number(updatedAt) >= chainNow - dep.maxStalenessSeconds;
      if (isFresh) fresh++;
      return { source: src, fresh: isFresh, updatedAt: Number(updatedAt) };
    });
    return {
      symbol: a.symbol,
      feedUpdatedAt: f.ok ? f.updatedAt : null,
      ageSec: f.ok ? chainNow - f.updatedAt : null,
      maxStalenessSeconds: dep.maxStalenessSeconds,
      ageFractionOfBound: f.ok ? +((chainNow - f.updatedAt) / dep.maxStalenessSeconds).toFixed(6) : null,
      freshSources: fresh,
      quorum: a.quorum,
      margin: fresh - a.quorum,
      priceWad: price.ok ? clean(price.out) : null,
      priceReverts: !price.ok,
      priceError: price.ok ? null : price.err,
      sources,
    };
  });

  // FREEZE-SAFETY: cancelPending must stay callable while the oracle is frozen.
  const freezeSafety = VAULTS.map((vault) => {
    if (!PROBE_MEMBER) return { vault, probed: false, verdict: 'not-probed', reason: 'no SOAK_PROBE_MEMBER set' };
    const pend = callRaw(vault, 'pendingDeposit(address)(uint256,uint64)', PROBE_MEMBER);
    const pendingAmount = pend.ok ? clean(pend.out.split('\n')[0]) : null;
    const r = tryCast(['call', vault, 'cancelPending()', '--from', PROBE_MEMBER, '--rpc-url', RPC]);
    return {
      vault, probed: true, member: PROBE_MEMBER, pendingAmount,
      verdict: classifyCancelPending(r, pendingAmount),
      detail: r.ok ? 'static call returned successfully' : r.err,
    };
  });

  return { t: new Date().toISOString(), chainNow, assets, freezeSafety };
}

// Runner guard: the pure classifiers above are unit-tested, and an infinite sampling loop at
// import time would hang the test process. Only sample when invoked as a script.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (invokedDirectly) {
  fs.mkdirSync(path.dirname(SERIES), { recursive: true });
  console.log(`[oracle-sampler] rpc=${RPC} every ${SAMPLE_MS}ms -> ${SERIES}`);
  console.log(`[oracle-sampler] maxStaleness=${dep.maxStalenessSeconds}s, assets=${dep.assets.map((a) => a.symbol).join(',')}`);
  for (;;) {
    const s = sample();
    fs.appendFileSync(SERIES, JSON.stringify(s) + '\n');
    const summary = (s.assets ?? []).map((a) => `${a.symbol} age=${a.ageSec}s margin=${a.margin}${a.priceReverts ? ' FROZEN' : ''}`).join('  ');
    console.log(`[oracle-sampler ${s.t}] ${summary || s.error}`);
    await sleep(SAMPLE_MS);
  }
}
