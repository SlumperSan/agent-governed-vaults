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
 *   - a stale feed whose last answer is already older than its own heartbeat;
 *   - a non-positive answer (a broken/deprecated feed);
 *   - a heartbeat or sane-price band outside the bounds the ChainlinkOracle constructor enforces
 *     (a heartbeat so long the staleness guard can never fire, or a band so wide it admits anything).
 *   - a missing L2 Sequencer Uptime Feed (mandatory on Base — the ChainlinkOracle reverts without it).
 * Each check below fails the config rather than letting the deploy proceed.
 *
 * Exit 0 = every listed feed passed; the `chainlinkOracle` block may be flipped to VERIFIED and the
 *          deployed oracle address added to BLESSED_ORACLES (Deploy.s.sol).
 * Exit 1 = at least one check failed; do NOT deploy the oracle.
 *
 * Env: CONFIG (config to verify; default contracts/config/base-mainnet.json — may also be passed as a
 *        *.json path arg), BASE_MAINNET_RPC / BASE_RPC (RPC override; default derived from the config's
 *        chainId — Base mainnet 8453 or Base Sepolia 84532), CAST (default `cast`).
 *        The L2 sequencer feed is REQUIRED only on Base mainnet; off-mainnet an empty one is accepted
 *        (the guard is skipped there and mock-tested in ChainlinkOracle.t.sol).
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
// RPC: explicit env wins; otherwise pick the public Base RPC for the config's chain.
const RPC =
  process.env.BASE_MAINNET_RPC ??
  process.env.BASE_RPC ??
  (CFG.chainId === 84532 ? 'https://sepolia.base.org' : 'https://mainnet.base.org');
// Mainnet is the only chain where the L2 sequencer uptime feed is mandatory (ChainlinkOracle reverts
// every price without it). Off-mainnet (testnet/local) an empty sequencer means the guard is skipped.
const IS_MAINNET = CFG.chainId === 8453;
const CAST = process.env.CAST ?? 'cast';
const JSON_OUT = process.argv.includes('--json');
const ZERO = '0x0000000000000000000000000000000000000000';
// Mirrors of the bounds ChainlinkOracle's constructor now enforces (MIN_HEARTBEAT / MAX_HEARTBEAT /
// MAX_BAND_RATIO). Duplicated here on purpose: catching a bad config BEFORE `--broadcast` costs a
// read-only run, and catching it after costs a redeploy of an immutable contract.
const MIN_HEARTBEAT = 600n;
const MAX_HEARTBEAT = 86400n;
const MAX_BAND_RATIO = 1000n;

/** @type {{name:string, ok:boolean, detail:string}[]} */
const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: String(detail) });

function cast(args) {
  return execFileSync(CAST, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
    const out = cast(['call', addr, sig, '--rpc-url', RPC]);
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
function isUsdQuoted(description) {
  if (typeof description !== 'string' || description.length < 4) return false;
  if (description.slice(-3) !== 'USD') return false;
  const sep = description[description.length - 4];
  return sep === ' ' || sep === '/';
}
function callUint(addr, sig) {
  // returns a decimal string, or null on revert / no code
  try {
    const out = cast(['call', addr, sig, '--rpc-url', RPC]);
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
    const out = cast(['call', addr, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)', '--rpc-url', RPC]);
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

function main() {
  const cfg = CFG;
  const co = cfg.chainlinkOracle;
  if (!co) {
    check('chainlinkOracle block present', false, 'no `chainlinkOracle` key in base-mainnet.json');
    return finish();
  }

  // 1. Sequencer uptime feed — mandatory on Base.
  const seq = co.sequencerUptimeFeed;
  if (!seq || seq === ZERO) {
    check(
      'sequencer uptime feed',
      !IS_MAINNET,
      IS_MAINNET
        ? 'empty/zero — REQUIRED on Base mainnet (ChainlinkOracle reverts every price without it)'
        : 'empty/zero — guard intentionally skipped off-mainnet (testnet exercise; mock-tested in ChainlinkOracle.t.sol)',
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
    }
  }

  finish();
}

function finish() {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  if (JSON_OUT) {
    console.log(JSON.stringify({ passed, failed, total: results.length, results }, null, 2));
  } else {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.detail}`);
    console.log(`\n${passed}/${results.length} checks passed${failed ? `, ${failed} FAILED — do NOT deploy the oracle` : ''}`);
  }
  process.exit(failed === 0 && results.length > 0 ? 0 : 1);
}

main();
