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
 *   - a feed with unexpected `decimals()` (the WAD scale is cached at construction from it);
 *   - a stale feed whose last answer is already older than its own heartbeat;
 *   - a non-positive answer (a broken/deprecated feed);
 *   - a missing L2 Sequencer Uptime Feed (mandatory on Base — the ChainlinkOracle reverts without it).
 * Each check below fails the config rather than letting the deploy proceed.
 *
 * Exit 0 = every listed feed passed; the `chainlinkOracle` block may be flipped to VERIFIED and the
 *          deployed oracle address added to BLESSED_ORACLES (Deploy.s.sol).
 * Exit 1 = at least one check failed; do NOT deploy the oracle.
 *
 * Env: BASE_MAINNET_RPC (default https://mainnet.base.org), CAST (default `cast`).
 * Run:  node scripts/verify-chainlink-oracle.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org';
const CAST = process.env.CAST ?? 'cast';
const JSON_OUT = process.argv.includes('--json');
const ZERO = '0x0000000000000000000000000000000000000000';

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
  // (roundId, answer, startedAt, updatedAt, answeredInRound)
  try {
    const out = cast(['call', addr, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)', '--rpc-url', RPC]);
    const parts = out.split(/\s+/).filter(Boolean);
    return { answer: BigInt(parts[1]), updatedAt: BigInt(parts[3]) };
  } catch {
    return null;
  }
}

function main() {
  const cfgPath = path.join(ROOT, 'contracts/config/base-mainnet.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const co = cfg.chainlinkOracle;
  if (!co) {
    check('chainlinkOracle block present', false, 'no `chainlinkOracle` key in base-mainnet.json');
    return finish();
  }

  // 1. Sequencer uptime feed — mandatory on Base.
  const seq = co.sequencerUptimeFeed;
  if (!seq || seq === ZERO) {
    check('sequencer uptime feed set', false, 'sequencerUptimeFeed is empty/zero — REQUIRED on Base mainnet');
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
    // decimals <= 18
    const dec = callUint(feed, 'decimals()(uint8)');
    check(`${label}: feed decimals <= 18`, dec !== null && BigInt(dec) <= 18n, `decimals=${dec}`);
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
    // sane-price band well-formed (0/0 disabled, else min <= max)
    const mn = BigInt(a.minPriceWad ?? '0');
    const mx = BigInt(a.maxPriceWad ?? '0');
    check(`${label}: sane-price band well-formed`, mx === 0n ? mn === 0n : mn <= mx, `min=${mn} max=${mx}`);
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
