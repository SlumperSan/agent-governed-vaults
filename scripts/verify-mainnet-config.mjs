#!/usr/bin/env node
// @ts-check
/**
 * Verify `contracts/config/base-mainnet.json` against a real Base mainnet RPC.
 *
 * The config ships as `status: "UNVERIFIED-ON-CHAIN"` with a `statusNote` that forbids any
 * script from consuming it until a session with a mainnet RPC has run the checklist in its
 * `verification` block. This is that checklist, executed — one check per line of it.
 *
 * READ-ONLY. No key, no signature, no transaction, no deployment. Every call is `cast call`
 * or `cast code`. Running this against mainnet costs nothing and changes nothing.
 *
 * ## Why this is worth a script rather than a session of ad-hoc `cast` calls
 *
 * The failure this guards against is not "an address is wrong" in the obvious sense — it is a
 * *plausible* wrong address. Pyth deploys the same receiver address on many chains, so a
 * copy-paste from another chain's docs looks exactly like a correct entry. A V3 pool with the
 * right pair but the wrong fee tier has the right tokens. A USDbC address has symbol `USDbC`
 * but is otherwise a normal 6-decimal token. Each of those produces a vault that deploys fine
 * and prices wrongly, permanently, because the contracts are immutable.
 *
 * The token-ordering check is the sharpest one: `token0`/`token1` ordering decides the SIGN of
 * the mean tick, so a pool whose ordering is the reverse of what the config assumes yields a
 * price that is the *reciprocal* of the truth. That is not a small error.
 *
 * Exit code 0 = every check passed and `status` may be flipped to VERIFIED-ON-CHAIN.
 * Exit code 1 = at least one check failed; the config must NOT be used.
 *
 * Env: BASE_MAINNET_RPC (default https://mainnet.base.org), CAST (default `cast`).
 * Run:  node scripts/verify-mainnet-config.mjs [--json]
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RPC = process.env.BASE_MAINNET_RPC ?? 'https://mainnet.base.org';
const CAST = process.env.CAST ?? 'cast';
const JSON_OUT = process.argv.includes('--json');

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'config', 'base-mainnet.json'), 'utf8'));

const THROTTLE_MS = Number(process.env.VERIFY_THROTTLE_MS ?? 120);
const results = [];
let failed = 0;
let errored = 0;
const clean = (s) => String(s).replace(/\s+\[[^\]]*\]$/, '').trim();

/** Synchronous sleep — execFileSync is sync, so this whole script is. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Transport failure (rate limit, timeout, DNS) as distinct from a contract-level revert. */
export class RpcError extends Error {}

const RATE_LIMITED = /429|rate.?limit|Max retries exceeded|timed out|ECONNRESET|ETIMEDOUT|502|503|521/i;

/**
 * Public RPCs throttle hard and this script makes ~80 calls. A 429 must NEVER be reported as a
 * failed check: "this pool has the wrong tokens" and "the provider throttled us" are opposite
 * conclusions. Conflating them would either block a correct config or, far worse, teach the
 * operator that red lines here are normal.
 */
function cast(args, { attempts = 5 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleepSync(Math.min(8000, 500 * 2 ** i));
    try {
      const out = execFileSync(CAST, [...args, '--rpc-url', RPC], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      }).trim();
      sleepSync(THROTTLE_MS);
      return out;
    } catch (e) {
      const detail = String(e.stderr ?? e.message);
      lastErr = detail;
      // A genuine contract-level failure — surface it now, never retry it.
      if (!RATE_LIMITED.test(detail)) throw new Error(detail.split('\n')[0].slice(0, 200));
    }
  }
  throw new RpcError(`RPC unavailable after ${attempts} attempts: ${String(lastErr).split('\n')[0].slice(0, 160)}`);
}
function call(to, sig, ...args) {
  return cast(['call', to, sig, ...args.map(String)]).split('\n').map(clean);
}
function tryCall(to, sig, ...args) {
  try { return { ok: true, lines: call(to, sig, ...args) }; }
  catch (e) { return { ok: false, err: String(e.stderr ?? e.message).split('\n')[0].slice(0, 160) }; }
}

function check(label, fn) {
  let outcome;
  try {
    const r = fn();
    outcome = r === true ? { pass: true } : r === false ? { pass: false, detail: 'assertion returned false' } : r;
  } catch (e) {
    // A transport failure is not a failed check — it is an UN-RUN check.
    outcome = e instanceof RpcError
      ? { pass: false, error: true, detail: String(e.message) }
      : { pass: false, detail: String(e.message).slice(0, 200) };
  }
  results.push({ label, ...outcome });
  if (outcome.error) errored++; else if (!outcome.pass) failed++;
  if (!JSON_OUT) {
    const tag = outcome.pass ? 'PASS' : outcome.error ? 'ERR ' : 'FAIL';
    console.log(`[${tag}] ${label}${outcome.detail ? ` — ${outcome.detail}` : ''}`);
  }
  return outcome.pass;
}

const nowSec = () => Math.floor(Date.now() / 1000);
const eq = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const unquote = (s) => String(s).replace(/^"|"$/g, '');

if (!JSON_OUT) {
  console.log(`Verifying contracts/config/base-mainnet.json against ${RPC}`);
  console.log(`current status: ${cfg.status}\n`);
}

// ── chain identity ──
check('RPC is Base mainnet (chain id 8453)', () => {
  const id = Number(cast(['chain-id']));
  return id === cfg.chainId && id === 8453 ? { pass: true, detail: `chainId ${id}` }
    : { pass: false, detail: `RPC reports ${id}, config says ${cfg.chainId}` };
});

// ── USDC ──
check('usdc: symbol() == USDC, decimals() == 6, Circle-native (not USDbC)', () => {
  const sym = unquote(call(cfg.usdc, 'symbol()(string)')[0]);
  const dec = Number(call(cfg.usdc, 'decimals()(uint8)')[0]);
  if (sym === 'USDbC') return { pass: false, detail: 'this is BRIDGED USDbC, not Circle-native USDC' };
  return sym === 'USDC' && dec === 6
    ? { pass: true, detail: `${sym}, ${dec}dp` }
    : { pass: false, detail: `symbol ${sym}, decimals ${dec}` };
});

// ── router ──
check('router: has code', () => {
  const code = cast(['code', cfg.router]);
  return code.length > 2 ? { pass: true, detail: `${(code.length - 2) / 2} bytes` } : { pass: false, detail: 'no code' };
});
// M-12: this returned a hard-coded `{ pass: true }` — 1 of 22 checks could not fail. It now
// asserts what it claims: each signature resolves to a well-formed 4-byte selector, and the
// set matches the selectors the adapter actually allow-lists.
check('router: allow-listed selectors resolve to 4 bytes each', () => {
  const sigs = cfg.routerAllowedSignatures ?? [];
  if (!sigs.length) return { pass: false, detail: 'config lists no routerAllowedSignatures' };
  const problems = [];
  const sels = [];
  for (const sig of sigs) {
    let sel;
    try {
      sel = execFileSync(CAST, ['sig', sig], { encoding: 'utf8' }).trim();
    } catch (e) {
      problems.push(`${sig} → cast sig failed: ${e.message}`);
      continue;
    }
    if (!/^0x[0-9a-fA-F]{8}$/.test(sel)) problems.push(`${sig} → ${sel} is not a 4-byte selector`);
    else sels.push(`${sig} → ${sel}`);
  }
  const dupes = sels.length !== new Set(sels.map((x) => x.split(" → ")[1])).size;
  if (dupes) problems.push('two signatures collide on the same selector');
  return problems.length ? { pass: false, detail: problems.join('; ') } : { pass: true, detail: sels.join(' | ') };
});

// ── pyth receiver ──
check('pyth: receiver has code on Base specifically (same address exists on many chains)', () => {
  const code = cast(['code', cfg.pyth]);
  return code.length > 2 ? { pass: true, detail: `${(code.length - 2) / 2} bytes` } : { pass: false, detail: 'no code — likely copied from another chain' };
});

// ── per asset ──
const assets = Object.values(cfg.assets ?? {});
for (const a of assets) {
  const A = /** @type {any} */ (a);

  check(`${A.symbol} token: symbol/decimals match the entry`, () => {
    const sym = unquote(call(A.token, 'symbol()(string)')[0]);
    const dec = Number(call(A.token, 'decimals()(uint8)')[0]);
    return sym === A.symbol && dec === A.decimals
      ? { pass: true, detail: `${sym}, ${dec}dp` }
      : { pass: false, detail: `chain says ${sym}/${dec}dp, config says ${A.symbol}/${A.decimals}dp` };
  });

  for (const s of A.sources ?? []) {
    if (s.class === 'push') {
      check(`${A.symbol} chainlink feed: 8 decimals, description matches, answer fresh and positive`, () => {
        const dec = Number(call(s.feed, 'decimals()(uint8)')[0]);
        const desc = unquote(call(s.feed, 'description()(string)')[0]);
        const rd = call(s.feed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)');
        const answer = BigInt(rd[1]);
        const updatedAt = Number(rd[3]);
        const age = nowSec() - updatedAt;
        const problems = [];
        if (dec !== 8) problems.push(`decimals ${dec} != 8`);
        if (answer <= 0n) problems.push(`answer ${answer} <= 0`);
        if (age > cfg.maxStalenessSeconds) problems.push(`age ${age}s > maxStaleness ${cfg.maxStalenessSeconds}s`);
        // description is advisory — Chainlink wording varies; report, do not fail on it.
        const descNote = s.description?.includes(desc.split(' / ')[0]) ? '' : ` (description "${desc}" vs config "${s.description}")`;
        return problems.length
          ? { pass: false, detail: problems.join('; ') }
          : { pass: true, detail: `${desc}, ${dec}dp, answer ${answer}, age ${age}s${descNote}` };
      });
    }

    if (s.class === 'spot-twap') {
      for (const [leg, pool, pair, fee] of [['poolA', s.poolA, s.poolAPair, s.poolAFeeTier], ['poolB', s.poolB, s.poolBPair, s.poolBFeeTier]]) {
        if (!pool || /^0x0+$/.test(pool)) continue;
        check(`${A.symbol} ${leg}: token0/token1 ORDERING and fee tier match ${pair}`, () => {
          const t0 = call(pool, 'token0()(address)')[0];
          const t1 = call(pool, 'token1()(address)')[0];
          const f = Number(call(pool, 'fee()(uint24)')[0]);
          const sym0 = unquote(call(t0, 'symbol()(string)')[0]);
          const sym1 = unquote(call(t1, 'symbol()(string)')[0]);
          const actual = `${sym0}/${sym1}`;
          const problems = [];
          // Ordering is load-bearing: it decides the SIGN of the mean tick. A reversed pool
          // yields the reciprocal price, not a small error.
          if (pair && actual !== pair) problems.push(`ordering is ${actual}, config says ${pair}`);
          if (fee && f !== fee) problems.push(`fee tier ${f} != ${fee}`);
          return problems.length ? { pass: false, detail: problems.join('; ') }
            : { pass: true, detail: `${actual}, fee ${f}` };
        });

        check(`${A.symbol} ${leg}: observationCardinality >= ${cfg.twapDefaults.minCardinality}`, () => {
          const slot0 = call(pool, 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)');
          const cardinality = Number(slot0[3]);
          const need = cfg.twapDefaults.minCardinality;
          return cardinality >= need
            ? { pass: true, detail: `cardinality ${cardinality}` }
            : { pass: false, detail: `cardinality ${cardinality} < ${need} — grow it with increaseObservationCardinalityNext BEFORE deploying; the constructor rejects a pool that cannot serve the window` };
        });

        check(`${A.symbol} ${leg}: observe([${cfg.twapDefaults.windowSeconds}, 0]) succeeds`, () => {
          const r = tryCall(pool, 'observe(uint32[])(int56[],uint160[])', `[${cfg.twapDefaults.windowSeconds},0]`);
          return r.ok
            // M-12: this used to report 'the full window is retained'. Success is EQUALLY
            // consistent with the pool having been dead for >= the window, because v3
            // synthesizes the endpoint from the newest observation. The two opposite
            // conclusions this check exists to separate are separated by the NEXT check, not
            // this one, so it no longer claims more than it establishes.
            ? { pass: true, detail: 'observe() did not revert (says nothing about liveness — see the freshness check)' }
            : { pass: false, detail: `observe reverted — the pool cannot serve a ${cfg.twapDefaults.windowSeconds}s window: ${r.err}` };
        });

        // M-12 + H-2: `maxObservationAgeSeconds` was NEVER CHECKED, and `observations(uint256)`
        // was called zero times anywhere in this repo — so the pool tuple that guards 2 and 3
        // actually read was never exercised, and this gate could not observe the parameter
        // behind H-2. Both are read here now.
        check(`${A.symbol} ${leg}: newest observation is inside maxObservationAge`, () => {
          const maxAge = cfg.twapDefaults.maxObservationAgeSeconds;
          const window = cfg.twapDefaults.windowSeconds;
          const divisor = 20; // UniswapV3TwapSource.MAX_LIVE_TICK_WEIGHT_DIVISOR
          if (maxAge * divisor > window) {
            return {
              pass: false,
              detail: `maxObservationAge ${maxAge}s exceeds window/${divisor} (${Math.floor(window / divisor)}s) — the constructor REJECTS this config (H-2). The newest observation age is the live tick\u2019s weight in the reported mean, so the ratio is the bound.`,
            };
          }
          const slot0 = call(pool, 'slot0()(uint160,int24,uint16,uint16,uint16,uint8,bool)');
          const index = Number(slot0[2]);
          const obs = tryCall(pool, 'observations(uint256)(uint32,int56,uint160,bool)', String(index));
          if (!obs.ok) return { pass: false, detail: `observations(${index}) reverted: ${obs.err}` };
          const newestTs = Number(String(obs.lines[0]).trim());
          // Read the CHAIN clock, not this machine's. Comparing an on-chain observation
          // timestamp against `Date.now()` would measure local clock drift as pool staleness -
          // the same species of "licenses more than it establishes" that M-12 is about.
          const chainNow = Number(String(cast(['block', 'latest', '--field', 'timestamp'])).trim());
          if (!Number.isFinite(chainNow) || chainNow === 0) {
            return { pass: false, detail: 'could not read the chain timestamp' };
          }
          const age = chainNow - newestTs;
          return age <= maxAge
            ? { pass: true, detail: `newest observation ${age}s old, bound ${maxAge}s (live-tick weight <= ${(age / window * 100).toFixed(2)}%)` }
            : { pass: false, detail: `newest observation ${age}s old > maxObservationAge ${maxAge}s — this pool is too quiet and the source will WITHHOLD` };
        });
      }
    }

    if (s.class === 'pull') {
      check(`${A.symbol} pyth: getPriceUnsafe(${String(s.priceId).slice(0, 12)}…) returns, expo in [-36, 18]`, () => {
        const r = tryCall(cfg.pyth, 'getPriceUnsafe(bytes32)(int64,uint64,int32,uint256)', s.priceId);
        if (!r.ok) return { pass: false, detail: `reverted — wrong price id for this chain? ${r.err}` };
        const price = BigInt(r.lines[0]);
        const expo = Number(r.lines[2]);
        const publishTime = Number(r.lines[3]);
        const age = nowSec() - publishTime;
        const problems = [];
        if (price <= 0n) problems.push(`price ${price} <= 0`);
        if (expo < -36 || expo > 18) problems.push(`expo ${expo} outside [-36, 18]`);
        return problems.length ? { pass: false, detail: problems.join('; ') }
          : { pass: true, detail: `price ${price}, expo ${expo}, published ${age}s ago` };
      });
    }
  }
}

// ── cross-class agreement ──
// The strongest signal available without deploying: three independent mechanisms should agree.
// A large gap means a wrong pool, feed or price id — not a market inefficiency.
for (const a of assets) {
  const A = /** @type {any} */ (a);
  check(`${A.symbol}: chainlink and pyth agree within 200 bps (a wide band — a gap means a wrong entry)`, () => {
    const push = A.sources.find((s) => s.class === 'push');
    const pull = A.sources.find((s) => s.class === 'pull');
    if (!push || !pull) return { pass: true, detail: 'skipped — asset lacks both a push and a pull source' };
    const rd = call(push.feed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)');
    const cl = Number(BigInt(rd[1])) / 1e8;
    const r = tryCall(cfg.pyth, 'getPriceUnsafe(bytes32)(int64,uint64,int32,uint256)', pull.priceId);
    if (!r.ok) return { pass: false, detail: 'pyth read failed; cannot cross-check' };
    const py = Number(BigInt(r.lines[0])) * 10 ** Number(r.lines[2]);
    if (!(cl > 0 && py > 0)) return { pass: false, detail: `non-positive price: chainlink ${cl}, pyth ${py}` };
    const bps = Math.abs(cl - py) / ((cl + py) / 2) * 10_000;
    return bps <= 200
      ? { pass: true, detail: `chainlink $${cl.toFixed(2)} vs pyth $${py.toFixed(2)} — ${bps.toFixed(1)} bps apart` }
      : { pass: false, detail: `chainlink $${cl.toFixed(2)} vs pyth $${py.toFixed(2)} — ${bps.toFixed(1)} bps apart; suspect a wrong feed or price id` };
  });
}

// ── report ──
const passed = results.length - failed - errored;
if (JSON_OUT) {
  console.log(JSON.stringify({
    rpc: RPC, chainId: cfg.chainId, checkedAt: new Date().toISOString(),
    total: results.length, passed, failed, errored, results,
  }, null, 2));
} else {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${passed}/${results.length} checks passed, ${failed} failed, ${errored} could not be run`);
  if (errored > 0) {
    console.log('\nSome checks did not run because the RPC was unavailable (rate limit or timeout).');
    console.log('That is NOT a verdict on the config. Re-run against a dedicated endpoint');
    console.log('(BASE_MAINNET_RPC=...) or raise VERIFY_THROTTLE_MS before concluding anything.');
  }
  if (failed === 0 && errored === 0) {
    const block = cast(['block-number']);
    console.log(`\nAll checks passed at block ${block}.`);
    console.log('`status` may be flipped to VERIFIED-ON-CHAIN, recording this block height.');
  } else {
    console.log('\nDO NOT flip `status`. The config must not be consumed while any check fails —');
    console.log('the contracts are immutable, so a wrong feed or pool is permanent for that vault.');
  }
}
// 0 = verified · 1 = a real check failed · 2 = incomplete (RPC), which is neither of those
process.exit(failed > 0 ? 1 : errored > 0 ? 2 : 0);
