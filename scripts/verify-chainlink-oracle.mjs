#!/usr/bin/env node
// @ts-check
/**
 * Verify the `chainlinkOracle` block of `contracts/config/base-mainnet.json` against a real Base
 * mainnet RPC, BEFORE deploying the blessed ChainlinkOracle (the C-6 launch resolution).
 *
 * READ-ONLY. No key, no signature, no transaction, no deployment. Every call is `cast call` or
 * `cast code`. Running this against mainnet costs nothing and changes nothing.
 *
 * ## Why this is worth a script
 *
 * ChainlinkOracle is IMMUTABLE and prices every vault that uses it. A wrong or fake feed address
 * looks exactly like a correct one until it prices a vault wrong, permanently. The specific traps:
 *   - a *plausible* wrong feed (right pair, wrong deployment / a copy-paste from another chain);
 *   - a feed quoted in the WRONG DENOMINATION — Base has `CBETH / ETH` and no cbETH/USD feed, so an
 *     ETH-denominated price would be read as dollars by NAV, deposits, exits and rebalances alike;
 *   - a feed with unexpected `decimals()` (the WAD scale is cached at construction from it);
 *   - AGGREGATOR-SWAP DRIFT: the configured addresses are `EACAggregatorProxy` instances and
 *     Chainlink swaps the aggregator behind them as routine operation, so the `decimals()` the
 *     oracle cached at construction is a one-time snapshot of a mutable upstream. See
 *     `docs/LAUNCH-READINESS.md` section 4 row 14 and
 *     `contracts/test/audit/AuditAggregatorSwapDrift.t.sol`.
 *
 * ## Re-run this AFTER deploying, not only before
 *
 * The decimals check below is a COMPLETE test of the aggregator-swap-drift residual AT THE
 * SAMPLING INSTANT, because `ChainlinkOracle` derives its cached `scale` from nothing else: if a
 * feed still reports 8 decimals WHEN YOU RUN THIS, a deployed oracle's cached `scale` is still
 * correct no matter how many times the aggregator was swapped up to that moment. It says nothing
 * about the interval between two runs -- a swap that drifts and is caught between them is invisible
 * here until the next run -- so the exposure window is the cadence, and the cadence is the control.
 * Since #103 the canary's `feed-identity` signal closes that window to one sweep by comparing live
 * `decimals()` against the deployed oracle's cached scale; this script is the git-tracked second
 * line. It is read-only and keyless, so it is safe to run on
 * a cadence against a live deployment -- that is the off-chain half of the accepted residual. The
 * per-feed `aggregatorPin` block makes a swap VISIBLE (reported as DRIFT, never a failure -- a swap
 * is legitimate Chainlink operation), so an operator can tell "nothing moved" apart from "it moved
 * and the decimals still check out".
 *   - a stale feed whose last answer is already older than its own heartbeat;
 *   - a non-positive answer (a broken/deprecated feed);
 *   - a heartbeat or sane-price band outside the bounds the ChainlinkOracle constructor enforces
 *     (a heartbeat so long the staleness guard can never fire, or a band so wide it admits anything).
 *   - a missing L2 Sequencer Uptime Feed (mandatory on every chain except the exempt ids below — the
 *     ChainlinkOracle would otherwise serve prices computed while the sequencer was down).
 * Each check below fails the config rather than letting the deploy proceed.
 *
 * Exit 0 = every listed feed passed; the `chainlinkOracle` block may be flipped to VERIFIED and the
 *          deployed oracle address added to BLESSED_ORACLES (Deploy.s.sol).
 * Exit 1 = at least one check failed; do NOT deploy the oracle.
 *
 * Env: CONFIG (config to verify; default contracts/config/base-mainnet.json — may also be passed as a
 *        *.json path arg), BASE_MAINNET_RPC / BASE_RPC (RPC override; default derived from the config's
 *        chainId — Base mainnet 8453 or Base Sepolia 84532; any other chainId must supply BASE_RPC
 *        explicitly), CAST (default `cast`).
 *        The L2 sequencer feed is REQUIRED on every chain except local 31337 and Base Sepolia 84532,
 *        whose config leaves it empty by design (the guard is skipped there and mock-tested in
 *        ChainlinkOracle.t.sol). Same allowlist, same fail-closed default, as the on-chain rule in
 *        DeployChainlinkOracle.s.sol — keep the two in sync.
 * Run:  node scripts/verify-chainlink-oracle.mjs [--json]                 # mainnet (default)
 *       CONFIG=contracts/config/base-sepolia.json node scripts/verify-chainlink-oracle.mjs   # testnet
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Which config to verify: env CONFIG, or a *.json path argument, else the mainnet config (back-compat).
const CFG_PATH_REL =
  process.env.CONFIG ?? process.argv.find((a) => a.endsWith('.json')) ?? 'contracts/config/base-mainnet.json';
const CFG_PATH = path.isAbsolute(CFG_PATH_REL) ? CFG_PATH_REL : path.join(ROOT, CFG_PATH_REL);
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
// RPC: explicit env wins; otherwise the public Base RPC for the config's chain. Only the two chains
// this repo has configs for get a default: an UNRECOGNIZED chainId used to fall through to Base
// mainnet, which would have read feed addresses off the wrong chain and reported the result as a
// verification. Demand an explicit RPC instead (same fail-closed default as the sequencer rule below).
const DEFAULT_RPC = {8453: 'https://mainnet.base.org', 84532: 'https://sepolia.base.org'}[CFG.chainId];
const RPC = process.env.BASE_MAINNET_RPC ?? process.env.BASE_RPC ?? DEFAULT_RPC;
if (!RPC) {
  console.error(
    `verify-chainlink-oracle: no default RPC for chainId ${CFG.chainId} (${CFG_PATH_REL}). ` +
      'Set BASE_RPC to an RPC for THAT chain — guessing one would verify feeds against the wrong chain.',
  );
  process.exit(1);
}
// Which chains may ship WITHOUT an L2 sequencer uptime feed: an ALLOWLIST of the ids known to have
// none (local anvil; Base Sepolia, whose config leaves it empty by design), fail-closed for every
// other id — this mirrors DeployChainlinkOracle.requiresSequencerUptimeFeed, which is the guard that
// actually blocks the deploy. Previously this was `chainId === 8453`, so a config for any OTHER L2
// passed verification with an empty sequencer feed, matching the deploy-script hole (fixed 2026-08-29).
const SEQUENCER_EXEMPT_CHAIN_IDS = new Set([31337, 84532]);
const SEQUENCER_REQUIRED = !SEQUENCER_EXEMPT_CHAIN_IDS.has(CFG.chainId);
const CAST = process.env.CAST ?? 'cast';
const JSON_OUT = process.argv.includes('--json');
const ZERO = '0x0000000000000000000000000000000000000000';
// Mirrors of the bounds ChainlinkOracle's constructor now enforces (MIN_HEARTBEAT / MAX_HEARTBEAT /
// MAX_BAND_RATIO). Duplicated here on purpose: catching a bad config BEFORE `--broadcast` costs a
// read-only run, and catching it after costs a redeploy of an immutable contract.
const MIN_HEARTBEAT = 600n;
const MAX_HEARTBEAT = 86400n;
const MAX_BAND_RATIO = 1000n;

/**
 * `--strict` (or STRICT=1) makes NOTICES set the exit code. Off by default, because the two
 * callers want opposite things: a pre-deploy run must not be blocked by a legitimate aggregator
 * swap, while the RECURRING run (DEPLOYMENT.md section 7a) exists precisely to notice that a swap
 * happened. Residual row 14 is accepted ON the basis that this script surfaces drift -- and a
 * notice that exits 0 into a cron surfaces nothing.
 */
const STRICT = process.argv.includes('--strict') || process.env.STRICT === '1';

/** @type {{name:string, ok:boolean, drift?:boolean, detail:string}[]} */
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail) });
/**
 * A NOTICE, not a verdict. Counted separately from passes -- never folded into them -- and it sets
 * the exit code only under `--strict`.
 * Chainlink swapping the aggregator behind a proxy is legitimate routine operation, so hard-failing
 * on it would block a correct deploy for a benign upstream event -- the same trap that makes an
 * on-chain re-check a bad idea (see LAUNCH-READINESS section 4 row 14). The safety verdict is
 * carried by the `decimals() == 8` check, which is independent of how many swaps happened.
 */
const notice = (name, detail) => results.push({ name, ok: true, drift: true, detail: String(detail) });

function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
/**
 * `cast` with one retry. The public Base RPC rate-limits a burst of calls, and this script fires
 * one burst per feed: observed 2026-08-30, a mid-sweep `aggregator()` read came back empty while
 * the identical call succeeded three times in a row on its own. An un-retried hiccup would FAIL the
 * `decimals() == 8` check and exit 1 -- blocking a correct deploy on network noise, which is a
 * strictly worse outcome than the extra round trip. A genuine revert simply fails twice.
 */
function castRetry(args) {
  try {
    return cast(args);
  } catch {
    return cast(args);
  }
}
function code(addr) {
  try {
    return cast(['code', addr, '--rpc-url', RPC]);
  } catch {
    return '0x';
  }
}
function callString(addr, sig) {
  // returns the string, or null on revert / no code. `cast` prints a string return wrapped in
  // double quotes ("ETH / USD"); strip them.
  try {
    const out = castRetry(['call', addr, sig, '--rpc-url', RPC]);
    return out.replace(/^"(.*)"$/s, '$1');
  } catch {
    return null;
  }
}
/**
 * Mirrors `ChainlinkOracle._requireUsdQuote` byte for byte: the feed's own description must end in
 * `USD` as a WHOLE WORD — last three chars `USD`, preceded by a pair separator (' ' or '/'). The
 * separator is what rejects "ETH / PYUSD" (a USD-ish token, not USD) on a bare suffix match.
 */
export function isUsdQuoted(description) {
  if (typeof description !== 'string' || description.length < 4) return false;
  if (description.slice(-3) !== 'USD') return false;
  const sep = description[description.length - 4];
  return sep === ' ' || sep === '/';
}
function callUint(addr, sig) {
  // returns a decimal string, or null on revert / no code
  try {
    const out = castRetry(['call', addr, sig, '--rpc-url', RPC]);
    return BigInt(out).toString();
  } catch {
    return null;
  }
}
function latestRoundData(addr) {
  // (roundId, answer, startedAt, updatedAt, answeredInRound). `cast` prints one value per line and
  // annotates large ints with a scientific-notation suffix, e.g. "244049270000 [2.44e11]" — take
  // the leading integer token of each line and ignore the annotation.
  try {
    const out = castRetry(['call', addr, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)', '--rpc-url', RPC]);
    const nums = out
      .split('\n')
      .map((l) => l.trim().split(/\s+/)[0])
      .filter((x) => /^-?\d+$/.test(x));
    if (nums.length < 5) return null;
    return { answer: BigInt(nums[1]), startedAt: BigInt(nums[2]), updatedAt: BigInt(nums[3]) };
  } catch {
    return null;
  }
}

/** Read an address-returning view; null on revert / no code. */
function callAddr(addr, sig) {
  try {
    const m = castRetry(['call', addr, sig, '--rpc-url', RPC]).match(/0x[0-9a-fA-F]{40}/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/**
 * Compare a feed's currently-active aggregator against the one the config pinned when it was last
 * verified. PURE -- no RPC, no config -- so the decision table is unit-testable.
 *
 * `EACAggregatorProxy` forwards `decimals()` and `description()` to whichever aggregator is current
 * and increments `phaseId` on every swap. `ChainlinkOracle` reads those ONCE, at construction, and
 * caches `scale = 10**(18 - decimals)`; its config is immutable. A swap is therefore the only event
 * that could invalidate the cached scale, and `phaseId` is the cheapest signal that one happened.
 *
 * @param {{implementation?:string, phaseId?:number|string}|undefined|null} pin config `aggregatorPin`
 * @param {{implementation:string|null, phaseId:string|null}} observed what the proxy reports now
 * @returns {{status:'ok'|'drift'|'unpinned'|'unreadable', message:string}}
 */
export function compareAggregatorPin(pin, observed) {
  const obsImpl = observed && observed.implementation != null ? observed.implementation : null;
  const obsPhase = observed && observed.phaseId != null ? observed.phaseId : null;
  if (obsImpl === null && obsPhase === null) {
    return {
      status: 'unreadable',
      message: 'proxy answered neither aggregator() nor phaseId() -- not an EACAggregatorProxy, or a non-standard feed',
    };
  }
  if (!pin || (!pin.implementation && pin.phaseId === undefined)) {
    return {
      status: 'unpinned',
      message: `no aggregatorPin recorded -- add {"implementation":"${obsImpl}","phaseId":${obsPhase}} so a future swap is detectable`,
    };
  }
  const samePhase = pin.phaseId === undefined || obsPhase === null || String(pin.phaseId) === String(obsPhase);
  // A read that did not answer is NOT evidence of a swap. Saying "SWAPPED -> now null" is a false
  // alarm, and it is the one this notice produced on its very first live run (a rate-limited public
  // RPC dropped one `aggregator()` call). Only phaseId can convict on its own.
  if (obsImpl === null) {
    if (!samePhase) {
      return {
        status: 'drift',
        message:
          `AGGREGATOR SWAPPED: phaseId moved ${pin.phaseId} -> ${obsPhase} (aggregator() did not answer this run). ` +
          'Legitimate Chainlink operation, NOT a failure. Confirm the decimals check above still passes, then update aggregatorPin.',
      };
    }
    return {
      status: 'unreadable',
      message: `aggregator() did not answer -- pin NOT confirmed. phaseId ${obsPhase} still matches the pin, so no swap is evidenced; re-run before reading anything into it.`,
    };
  }
  const sameImpl =
    typeof pin.implementation === 'string' && pin.implementation.toLowerCase() === obsImpl.toLowerCase();
  if (sameImpl && samePhase) {
    return { status: 'ok', message: `aggregator ${obsImpl} phaseId ${obsPhase} -- unchanged since the pin` };
  }
  return {
    status: 'drift',
    message:
      `AGGREGATOR SWAPPED: pinned ${pin.implementation} (phaseId ${pin.phaseId}) -> now ${obsImpl} (phaseId ${obsPhase}). ` +
      'Legitimate Chainlink operation, NOT a failure. Confirm the decimals check above still passes -- that is what ' +
      'proves a deployed oracle cached scale is still correct -- then update aggregatorPin in the config.',
  };
}

/**
 * Is the sane-price band tight enough that a 2-DECIMAL aggregator-swap drift leaves it?
 *
 * This is the check that makes residual row 14 true rather than merely asserted. `ChainlinkOracle`
 * caches `scale` from a one-time `decimals()` read, and the argument for accepting that -- instead
 * of re-checking on every read and risking a permanent freeze -- is that the band already catches
 * every drift with a Chainlink precedent: 18 decimals, and any shift of >= 2. But `priceWad` trips
 * only on `p < min || p > max`, so THAT argument holds only while the band is tight relative to the
 * live price. A band of $0.01..$1e12 satisfies "a band is set" and catches nothing.
 *
 * The predicate is exactly the drift arithmetic. A +2-decimal swap multiplies the reported price by
 * 100 and a -2-decimal swap divides it by 100, so the band bounds both iff
 *   priceWad * 100 > maxPriceWad   and   priceWad / 100 < minPriceWad.
 *
 * It is deliberately a FUNCTION OF THE LIVE PRICE, not of the band alone: if the asset falls far
 * enough, a fixed band stops bounding the drift even though nothing about the config changed. That
 * is a true statement about the residual widening, and the deployer should see it. Hard-failing is
 * safe here in a way it is not on-chain -- a false reject costs a re-run, not a frozen vault.
 *
 * @param {bigint} priceWad live price, WAD  @param {bigint} min  @param {bigint} max
 * @returns {{ok:boolean, detail:string}}
 */
export function bandBoundsTwoDecimalDrift(priceWad, min, max) {
  if (max === 0n || min === 0n || min > max) {
    return { ok: false, detail: `band disabled or malformed (min=${min} max=${max})` };
  }
  if (priceWad <= 0n) return { ok: false, detail: `no live price to size the band against (priceWad=${priceWad})` };
  const upOk = priceWad * 100n > max;
  const downOk = priceWad / 100n < min;
  const usd = (v) => (v / 10n ** 16n).toString().replace(/(\d+)(\d\d)$/, '$1.$2');
  if (upOk && downOk) {
    return {
      ok: true,
      detail: `price $${usd(priceWad)} in $${usd(min)}..$${usd(max)}; a +/-2-decimal drift (x100 / /100) leaves it`,
    };
  }
  return {
    ok: false,
    detail:
      `BAND NO LONGER BOUNDS a 2-decimal aggregator-swap drift AT THIS PRICE: price ${usd(priceWad)}, ` +
      `band ${usd(min)}..${usd(max)}. ` +
      `${!upOk ? `x100 = ${usd(priceWad * 100n)} is still <= the ceiling. ` : ''}` +
      `${!downOk ? `/100 = ${usd(priceWad / 100n)} is still >= the floor (the contract's check is exclusive, so equal does not revert either). ` : ''}` +
      'CHECK WHICH INPUT MOVED before editing anything: this fails either because the band is too wide ' +
      'OR because the asset moved far enough that a fixed band stopped covering the drift, with no config ' +
      'change at all. Residual-register row 14 accepts the cached-scale risk BECAUSE the band fail-closes ' +
      'on a >= 2-decimal drift AT THE LIVE PRICE; whichever input moved, that argument no longer holds. ' +
      'Retune the band, or re-open row 14.',
  };
}

function main() {
  const cfg = CFG;
  const co = cfg.chainlinkOracle;
  if (!co) {
    check('chainlinkOracle block present', false, 'no `chainlinkOracle` key in base-mainnet.json');
    return finish();
  }

  // 1. Sequencer uptime feed — mandatory on every chain outside the exempt allowlist.
  const seq = co.sequencerUptimeFeed;
  if (!seq || seq === ZERO) {
    check(
      'sequencer uptime feed',
      !SEQUENCER_REQUIRED,
      SEQUENCER_REQUIRED
        ? `empty/zero — REQUIRED on chain ${CFG.chainId} (the deploy script refuses it; without the feed the oracle would price through a sequencer outage)`
        : 'empty/zero — guard intentionally skipped on an exempt chain (testnet exercise; mock-tested in ChainlinkOracle.t.sol)',
    );
  } else {
    const hasCode = code(seq).length > 2;
    check('sequencer uptime feed has code', hasCode, `${seq} code.length ${hasCode ? '> 0' : '== 0'}`);
    const rd = latestRoundData(seq);
    check('sequencer uptime feed answers', rd !== null, rd ? `answer=${rd.answer} (0=up,1=down)` : 'latestRoundData reverted');
  }

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const assets = Array.isArray(co.assets) ? co.assets : [];
  if (assets.length === 0) check('at least one asset feed listed', false, 'chainlinkOracle.assets is empty');

  for (const a of assets) {
    const label = a.symbol || a.asset || '(asset)';
    const feed = a.feed;
    if (!feed || feed === ZERO || /^</.test(String(feed))) {
      check(`${label}: feed address populated`, false, `feed is a placeholder/zero (${feed})`);
      continue;
    }
    // code
    check(`${label}: feed has code`, code(feed).length > 2, feed);

    // DENOMINATION. The oracle returns a USD price to every consumer (NAV, deposits, exits,
    // rebalances) and nothing downstream can tell a USD number from an ETH-denominated one. Base
    // ships a `CBETH / ETH` feed and NO cbETH/USD feed, so the wrong-denomination wire-up is one
    // copy-paste away and is silent forever once deployed. ChainlinkOracle's constructor enforces
    // this on-chain; the two checks here are the fast, pre-deploy half:
    //   1. the feed's OWN description must be USD-quoted (the same predicate the constructor uses);
    //   2. it must EQUAL the `feedDescriptionOnChain` the config commits to — which is what catches
    //      the "plausible wrong feed" (right pair, wrong deployment / a copy-paste from another
    //      chain) that check 1 alone cannot see.
    const desc = callString(feed, 'description()(string)');
    check(`${label}: feed description is USD-quoted`, isUsdQuoted(desc), `description=${JSON.stringify(desc)}`);
    const expectedDesc = a.feedDescriptionOnChain;
    check(
      `${label}: description matches config feedDescriptionOnChain`,
      typeof expectedDesc === 'string' && expectedDesc.length > 0 && desc === expectedDesc,
      typeof expectedDesc === 'string' && expectedDesc.length > 0
        ? `on-chain=${JSON.stringify(desc)} config=${JSON.stringify(expectedDesc)}`
        : 'config has no `feedDescriptionOnChain` — add the EXACT on-chain description string so a swapped feed is detectable',
    );

    // decimals == 8: Chainlink's USD-feed convention (ETH-denominated feeds are 18). The oracle
    // caches `scale` from this and its constructor pins it to 8, so anything else is both a
    // denomination smell and an un-deployable config.
    const dec = callUint(feed, 'decimals()(uint8)');
    check(`${label}: feed decimals == 8 (USD convention)`, dec !== null && BigInt(dec) === 8n, `decimals=${dec}`);

    // AGGREGATOR-SWAP DRIFT (notice only). The decimals check above is the safety verdict; this one
    // tells the operator WHETHER the upstream moved since the config was last verified -- the
    // difference between "nothing changed" and "it changed and re-checked clean".
    const pinResult = compareAggregatorPin(a.aggregatorPin, {
      implementation: callAddr(feed, 'aggregator()(address)'),
      phaseId: callUint(feed, 'phaseId()(uint16)'),
    });
    if (pinResult.status === 'ok') {
      check(`${label}: aggregator unchanged since pin`, true, pinResult.message);
    } else {
      notice(`${label}: aggregator pin`, pinResult.message);
    }
    // latestRoundData: positive answer, fresh within heartbeat
    const rd = latestRoundData(feed);
    if (!rd) {
      check(`${label}: latestRoundData answers`, false, 'reverted / no code');
      continue;
    }
    check(`${label}: answer > 0`, rd.answer > 0n, `answer=${rd.answer}`);
    const hb = BigInt(a.heartbeatSeconds ?? 0);
    const age = nowSec > rd.updatedAt ? nowSec - rd.updatedAt : 0n;
    check(`${label}: fresh within heartbeat`, hb > 0n && age <= hb, `age=${age}s heartbeat=${hb}s`);
    check(
      `${label}: heartbeat within on-chain bounds`,
      hb >= MIN_HEARTBEAT && hb <= MAX_HEARTBEAT,
      `heartbeat=${hb}s (constructor accepts ${MIN_HEARTBEAT}..${MAX_HEARTBEAT}s; below the floor freezes a healthy feed, above the ceiling the staleness guard can never fire)`,
    );
    // sane-price band: a MAINNET blessed oracle MUST set one (the depeg-clamp defence — Chainlink
    // deprecated its on-aggregator min/maxAnswer, so a clamp value can read "fresh"). Require a
    // non-zero, well-ordered band. (Audit Council follow-up: the band was off in every fixture.)
    const mn = BigInt(a.minPriceWad ?? '0');
    const mx = BigInt(a.maxPriceWad ?? '0');
    check(
      `${label}: sane-price band set (depeg defence)`,
      mx > 0n && mn > 0n && mn < mx,
      mx === 0n || mn === 0n ? `min=${mn} max=${mx} — BAND DISABLED; set a real min/max for a mainnet feed` : `min=${mn} max=${mx}`,
    );
    // Width and containment, mirroring the constructor. A band wider than MAX_BAND_RATIO admits a
    // >99.9% collapse as "sane"; a band that already excludes the live answer reverts on first read.
    if (mn > 0n && mx > mn) {
      check(`${label}: band width within on-chain bound`, mx <= mn * MAX_BAND_RATIO, `ratio=${mx / mn}x (max ${MAX_BAND_RATIO}x)`);
      const scale = dec !== null && BigInt(dec) <= 18n ? 10n ** (18n - BigInt(dec)) : null;
      const spotWad = scale !== null && rd.answer > 0n ? rd.answer * scale : null;
      check(
        `${label}: live price inside the band`,
        spotWad !== null && spotWad >= mn && spotWad <= mx,
        spotWad === null ? 'could not scale the live answer to WAD' : `spot=${spotWad} band=[${mn},${mx}]`,
      );
      // BAND WIDTH, not just band presence. "A band is set" is not the property residual row 14
      // depends on -- it depends on the band being tight enough that a 2-decimal aggregator-swap
      // drift leaves it. Checked against the live answer, because that is what the band is compared
      // against at runtime. Sized in WAD from the feed's own decimals so it stays correct if the
      // 8-decimal pin is ever relaxed.
      if (spotWad !== null) {
        const width = bandBoundsTwoDecimalDrift(spotWad, mn, mx);
        // Named as price-contingent because it is: this flips from pass to fail with NO config
        // change, purely because the asset moved. That is the check telling the truth about the
        // band rather than a false alarm -- but an operator reading a FAIL needs to know which of
        // the two inputs moved before hunting for a config error that is not there.
        check(
          `${label}: band bounds a 2-decimal drift AT THE LIVE PRICE (residual row 14)`,
          width.ok,
          width.detail,
        );
      }
    }
  }

  finish();
}

function finish() {
  // Three counts, not two. A notice used to be counted as a pass, so a config with an unpinned or
  // unreadable aggregator still printed "18/18 checks passed" -- and that tally is what residual
  // row 14 cites as evidence the feeds are clean. A summary that cannot express "not clean" is not
  // evidence. `passed + noticed + failed === total`, always.
  const noticed = results.filter((r) => r.drift).length;
  const passed = results.filter((r) => r.ok && !r.drift).length;
  const failed = results.length - passed - noticed;
  if (JSON_OUT) {
    console.log(
      JSON.stringify({ passed, failed, drift: noticed, strict: STRICT, total: results.length, results }, null, 2),
    );
  } else {
    for (const r of results) console.log(`${r.drift ? 'DRIFT' : r.ok ? 'PASS ' : 'FAIL '} ${r.name} — ${r.detail}`);
    const noticeTail = STRICT
      ? ' — --strict, so these set the exit code'
      : ' — read them; re-run with --strict to make them exit non-zero';
    console.log(
      `\n${passed}/${results.length} checks passed` +
        `${failed ? `, ${failed} FAILED — do NOT deploy the oracle` : ''}` +
        `${noticed ? `, ${noticed} DRIFT notice(s)${noticeTail}` : ''}`,
    );
  }
  process.exit(failed > 0 || results.length === 0 || (STRICT && noticed > 0) ? 1 : 0);
}

// Importable by unit tests without firing the RPC sweep: only run when this file is the entrypoint.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
