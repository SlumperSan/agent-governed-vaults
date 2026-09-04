#!/usr/bin/env node
// @ts-check
/**
 * DRILL 4 instrument — oracle health time series (read-only, never signs).
 *
 * ## What this measures, and why it was rewritten (C-6 pivot)
 *
 * This file used to poll each asset's per-source `latestPrice()` and compute a quorum margin
 * "exactly as OracleAggregator computes it". `OracleAggregator` was RETIRED by the C-6 pivot —
 * it lives in `contracts/test/retired/` and is not on the launch path. The deployed oracle is
 * {ChainlinkOracle}: ONE genuine Chainlink Data Feed per asset, no median, no quorum, no source
 * set. Its read surface is `priceWad` / `feedOf` / `usdc` / `sequencerUptimeFeed` / `GRACE_PERIOD`.
 *
 * The old sampler did not merely go quiet against that oracle — it FABRICATED breaches. The
 * address book back-fills `sources = [feed]` and `quorum = 1`, `latestPrice()` reverts on a
 * Chainlink proxy, the revert was swallowed into `fresh: false`, and every sample of a perfectly
 * healthy oracle recorded `margin = -1`. `series-analysis.summarize` counts `margin < 0` as a
 * breach, so drill 4 would report a staleness event that never happened. That is the failure
 * mode this rewrite exists to remove, and the rule it teaches: **a measurement tool must not
 * degrade gracefully.** An unreadable observation is recorded as missing evidence, never folded
 * into a value that reads as a finding.
 *
 * ## What we sample, every tick, from CHAIN time (never the host clock — the contract uses
 * `block.timestamp` and so must we)
 *
 * Per vault (the sequencer gate runs BEFORE any price is trusted, so it is one row, not per-asset):
 *   - the uptime feed's `answer` + `startedAt`, and whether the 3600s grace tail has elapsed.
 *     `updatedAt` is deliberately IGNORED: the uptime feed only writes on an up<->down transition,
 *     so staleness-checking it would report a permanent outage on a healthy chain.
 * Per asset:
 *   - `feedOf(asset)` → feed, heartbeat, scale, sane-price band. The staleness bound is read from
 *     the CHAIN, not from the address book's `oracle.maxStalenessSeconds`: the contract's config is
 *     immutable and the JSON is editable, so the JSON is the thing that can drift. A disagreement
 *     is recorded as `boundDrift`.
 *   - the feed's `latestRoundData()` → `updatedAt`, the resulting age, and the age as a fraction
 *     of that heartbeat (how close the breaker is)
 *   - `priceWad(asset)` — GROUND TRUTH. Fail-closed means the revert IS the freeze; the field
 *     reads above exist only to ATTRIBUTE it to one of the contract's causes, in the contract's
 *     own order (sequencer first — see `attributeAsset`).
 *   - whether `cancelPending()` is still statically callable  <-- the FREEZE-SAFETY property
 *
 * Semantics are mirrored from `packages/canary/src/signals/oracle-health.mjs` (PR #89), which
 * models the same contract over a different transport. Two boundaries copied deliberately, because
 * getting either wrong pages a poll early or a poll late: staleness trips at age STRICTLY GREATER
 * than the heartbeat, and the sane-price band is enabled by `maxPriceWad != 0` ALONE.
 *
 * The freeze-safety check is the other point of the drill. SF-2/K-4 freeze every NAV path on a
 * stale oracle, exits included, with no hatch. `cancelPending` is the one member-capital path that
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
import { fileURLToPath } from 'node:url';
import { loadDeployment } from './deployment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://base-sepolia-rpc.publicnode.com';
const CAST = process.env.CAST ?? 'cast';
const SERIES = process.env.SOAK_SERIES ?? path.join(ROOT, 'data', 'oracle-series.jsonl');
const SAMPLE_MS = Number(process.env.SOAK_SAMPLE_MS ?? 120_000);
const PROBE_MEMBER = process.env.SOAK_PROBE_MEMBER ?? '';
const VAULTS = (process.env.SOAK_VAULTS ?? '').split(',').map((v) => v.trim()).filter(Boolean);
const STATE_PATH = process.env.SOAK_INDEXER_STATE ?? path.join(ROOT, 'data', 'indexer-state.json');

/**
 * The vaults to probe `cancelPending` against — explicit `SOAK_VAULTS`, else every vault the
 * indexer has projected. Mirrors `canary-runner.resolveVaults`, and for the same reason.
 *
 * WHY THE FALLBACK EXISTS. `run-soak.ps1` sets `SOAK_PROBE_MEMBER` — with a comment explaining
 * exactly why drill 4's freeze-safety probe needs it — and never set `SOAK_VAULTS`, which is the
 * other half of the same wiring. So `VAULTS` was `[]`, the probe `.map` produced NO ROWS AT ALL,
 * and every sample recorded `freezeSafety: []`. Drill 4 then correctly refused to claim freeze
 * safety, but the reason looked like "no pending deposit existed" rather than "the probe was never
 * configured" — two very different facts.
 *
 * It also cannot be fixed by setting `SOAK_VAULTS` at launch: drills 1 and 2 CREATE their vaults
 * at runtime, so the addresses do not exist when the sampler starts. Discovery is the only
 * configuration that is correct on the first sample and still correct on the hundredth.
 */
function resolveProbeVaults() {
  if (VAULTS.length > 0) return { vaults: VAULTS, source: 'SOAK_VAULTS' };
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    // `vaults` is a serialized Map: [[address, projection], ...].
    const found = (state.vaults ?? []).map((e) => (Array.isArray(e) ? e[0] : e?.vault)).filter(Boolean);
    if (found.length > 0) return { vaults: found, source: 'indexer' };
    return { vaults: [], source: 'indexer-empty' };
  } catch {
    return { vaults: [], source: 'no-indexer-state' };
  }
}

const dep = loadDeployment(
  path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json'),
  { expectChainId: 84532 },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => s.replace(/\s+\[[^\]]*\]$/, '').trim();

/**
 * A transport failure is NOT a contract verdict. Conflating the two is how a rate-limited public
 * RPC turns into "the oracle is frozen" in a report — the same defect `verify-chainlink-oracle.mjs`
 * found in itself when a dropped `aggregator()` call announced a swap that never happened.
 *
 * SINGLE SOURCE, in `lib.mjs`. This used to be defined here and `lib.mjs`'s own `tryCall` had no
 * equivalent at all, which is how drill 3 came to assert `!attempt.ok` as proof that a call had
 * been REFUSED — an assertion a 429 satisfies. Two copies of a security-relevant regex drift; one
 * of them would eventually be the stale one. Re-exported so this module's public API is unchanged.
 */
import { classifyCallError } from './lib.mjs';

export { classifyCallError };

/** @returns {{ok:true,out:string}|{ok:false,err:string,kind:'revert'|'transport'}} */
function tryCast(args, { attempts = 2 } = {}) {
  let last = { ok: /** @type {false} */ (false), err: 'never ran', kind: /** @type {'transport'} */ ('transport') };
  for (let i = 0; i < attempts; i++) {
    try {
      return { ok: true, out: execFileSync(CAST, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim() };
    } catch (e) {
      const raw = e.stderr ? String(e.stderr).trim() : String(e.message);
      const err = raw.split('\n').slice(0, 2).join(' ').slice(0, 220);
      last = { ok: false, err, kind: classifyCallError(err) };
      // A revert is the answer, not a fault — never retry it. A transport blip gets one more try,
      // because a single dropped read should not punch a hole in the series.
      if (last.kind === 'revert') return last;
    }
  }
  return last;
}
const callRaw = (to, sig, ...args) => tryCast(['call', to, sig, ...args.map(String), '--rpc-url', RPC]);

/** `cast sig "StaleOracle(address)"` — pinned, so a signature change in the interface surfaces here. */
export const SEL_STALE_ORACLE = '0xa2671f4b';

/** `cast sig "NoPending()"` — pinned, not computed, so a rename in the contract surfaces here. */
export const SEL_NO_PENDING = '0xda7557bc';

/**
 * Classify a `cancelPending()` static call into a FOUR-STATE verdict.
 *
 * This is the evidence drill 4 turns on, so "it failed" is not good enough — the call can fail for
 * three entirely different reasons and only one of them is a finding:
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
 *   'unreadable'      the call was ATTEMPTED and the transport failed (rate limit, timeout,
 *                     unreachable RPC). Missing evidence, never a finding — see below.
 *
 * NOTE the classifier is FAIL-OPEN by default: `classifyCallError` is effectively
 * `REVERTED.test(err) ? 'revert' : 'transport'`, so an error string this file does not recognise
 * lands on 'transport' and therefore 'unreadable' rather than 'BLOCKED'. Against a real RPC `cast`
 * prints "execution reverted", which is matched, so the production path classifies correctly; but
 * an exotic client wording would be recorded as missing evidence rather than as a finding. That is
 * the quieter failure and it is deliberate — a fabricated "member funds are trapped" page is worse
 * than a sample scored unmeasured — but it is stated here rather than left to be discovered.
 *
 * @param {{ok:true,out:string}|{ok:false,err:string,kind?:'revert'|'transport'}} r
 * @param {string|null} pendingAmount
 * @returns {'callable'|'n/a-no-pending'|'unreadable'|'BLOCKED'}
 */
export function classifyCancelPending(r, pendingAmount) {
  if (r.ok) return 'callable';
  if (r.err.includes(SEL_NO_PENDING)) return 'n/a-no-pending';
  // A TRANSPORT failure is not a contract verdict — this file's own header says so, and the
  // priceWad path already honours it via `kind === 'transport'`. This branch did not, and the
  // consequence is worse here than there: two consecutive rate-limits against a public RPC would
  // have fallen through to BLOCKED, which drill 4 prints as "freeze-safety VIOLATED" — a
  // fabricated claim that member funds were trapped, caused by a 429. Recorded as unreadable
  // instead, which counts as missing evidence and pages nobody.
  //
  // Latent until now: `VAULTS` was always empty, so this classifier never ran on a live probe.
  // The discovery fallback is what makes it reachable, at 3 vaults every 120 s.
  if (r.kind === 'transport') return 'unreadable';
  // Defence in depth: if the revert data was truncated by the RPC, a zero pending balance is
  // itself sufficient to explain a NoPending revert.
  if (pendingAmount === '0') return 'n/a-no-pending';
  return 'BLOCKED';
}

// ── pure state machines (unit-tested; no chain, no clock, no fs) ─────────────

/**
 * The sequencer gate, mirroring `ChainlinkOracle._requireSequencerUp`.
 *
 * FIELD DISCIPLINE: `answer` (0 = up, 1 = down) and `startedAt` (the restart time) decide it, and
 * `updatedAt` is ignored — the uptime feed is event-driven, so a months-old `updatedAt` is its
 * healthy steady state.
 *
 * @param {{feed: string, round: null | {ok: true, answer: string, startedAt: number}
 *          | {ok: false, err: string, kind: 'revert'|'transport'}, chainNow: number, grace: number}} args
 * @returns {{configured: boolean, state: string, causeKey: string|null, cause: string|null,
 *            unreadable: boolean, answer: string|null, startedAtSec: number|null,
 *            upForSec: number|null, resumesAtSec: number|null, gracePeriodSec: number}}
 */
export function sequencerState({ feed, round, chainNow, grace }) {
  const base = {
    configured: !/^0x0{40}$/i.test(feed), state: 'not-configured', causeKey: null, cause: null,
    unreadable: false, answer: null, startedAtSec: null, upForSec: null, resumesAtSec: null,
    gracePeriodSec: grace,
  };
  // Not a fault and not health: off a sequencer L2 (Base Sepolia leaves this at address(0) by
  // design) `_requireSequencerUp` is a no-op, so there is nothing to observe. On Base MAINNET the
  // same reading means the deployment shipped with no sequencer guard at all.
  if (!base.configured || round == null) return base;

  if (!round.ok) {
    if (round.kind === 'transport') {
      return { ...base, state: 'unreadable', unreadable: true, cause: `uptime feed unreadable (${round.err})` };
    }
    // The contract try/catches this and reverts StaleOracle: a live vault-wide freeze.
    return {
      ...base, state: 'feed-reverts', causeKey: 'sequencer-feed-reverts',
      cause: `the sequencer uptime feed itself reverts (${round.err})`,
    };
  }

  const answer = String(round.answer);
  const startedAt = Number(round.startedAt);
  const on = { ...base, answer, startedAtSec: startedAt };

  if (answer !== '0') {
    return { ...on, state: 'down', causeKey: 'sequencer-down', cause: `the L2 sequencer is reporting DOWN (answer ${answer})` };
  }
  if (startedAt === 0 || startedAt > chainNow) {
    return {
      ...on, state: 'unusable-round', causeKey: 'sequencer-unusable-round',
      cause: `the sequencer uptime round has no usable startedAt (${startedAt} against chain time ${chainNow})`,
    };
  }
  const upFor = chainNow - startedAt;
  if (upFor <= grace) {
    // The contract reverts while `block.timestamp - startedAt <= GRACE_PERIOD`, so the first second
    // that prices again is startedAt + GRACE_PERIOD + 1 — the only honest ETA this protocol has.
    return {
      ...on, state: 'grace', causeKey: 'sequencer-grace', upForSec: upFor,
      resumesAtSec: startedAt + grace + 1,
      cause: `the sequencer is inside its post-restart grace period (up ${upFor}s of ${grace}s)`,
    };
  }
  return { ...on, state: 'up', upForSec: upFor };
}

/**
 * Reproduce `ChainlinkOracle.priceWad`'s per-asset checks, in the contract's ORDER, and name the
 * FIRST one that would revert. Attribution only — the verdict comes from `priceWad` itself.
 *
 * The order is load-bearing, not cosmetic. `_requireSequencerUp` runs before any feed is read, so
 * when the sequencer is in its grace hour AND the feed has aged out, the contract reverts on the
 * sequencer. The Base outages on record ran 2,760s / 9,432s / 3,612s, and a feed on a 3600s
 * heartbeat is stale by the end of any of them — "outage + stale feed" IS the shape of the grace
 * hour, so naming the heartbeat there would send a responder after the wrong thing.
 *
 * @param {{cfg: {feed: string, heartbeat: number, scale: bigint, minPriceWad: bigint, maxPriceWad: bigint},
 *          round: {ok: true, answer: string, updatedAt: number} | {ok: false, err: string, kind: 'revert'|'transport'},
 *          chainNow: number, pinned: boolean,
 *          sequencer: {causeKey: string|null, cause: string|null}}} args
 * @returns {{causeKey: string|null, cause: string|null, ageSec: number|null, unreadable: boolean,
 *            detail: Record<string, any>}}
 */
export function attributeAsset({ cfg, round, chainNow, pinned, sequencer }) {
  // The sequencer gate short-circuits everything below it, so it is answered first whatever the
  // feed says. `causeKey` null means "the gate is not the reason".
  const seqFirst = sequencer.causeKey
    ? { causeKey: sequencer.causeKey, cause: sequencer.cause }
    : null;

  if (pinned) {
    // `priceWad` returns 1e18 before ever reading a feed; only the sequencer gate can freeze it.
    return { ...(seqFirst ?? { causeKey: null, cause: null }), ageSec: null, unreadable: false, detail: { pinned: true } };
  }
  if (/^0x0{40}$/i.test(cfg.feed)) {
    return seqFirst
      ? { ...seqFirst, ageSec: null, unreadable: false, detail: { listed: false } }
      : {
        causeKey: 'unlisted', ageSec: null, unreadable: false,
        cause: 'the asset is not listed on this oracle (feedOf returns address(0))',
        detail: { listed: false },
      };
  }
  if (!round.ok) {
    if (round.kind === 'transport') {
      return {
        causeKey: seqFirst?.causeKey ?? null, cause: seqFirst?.cause ?? null, ageSec: null, unreadable: true,
        detail: { listed: true, feedUnreadable: true, feedError: round.err },
      };
    }
    return seqFirst
      ? { ...seqFirst, ageSec: null, unreadable: false, detail: { listed: true, feedReverts: true, feedError: round.err } }
      : {
        causeKey: 'feed-reverts', ageSec: null, unreadable: false,
        cause: `its Chainlink feed reverts (${round.err}) — a deprecated or dead feed fails closed with no fallback`,
        detail: { listed: true, feedReverts: true, feedError: round.err },
      };
  }

  const answer = BigInt(round.answer);
  const updatedAt = Number(round.updatedAt);
  const age = chainNow - updatedAt;
  /** @type {Record<string, any>} */
  const detail = { listed: true, feedReverts: false, answer: answer.toString(), updatedAtSec: updatedAt, ageSec: age };
  const first = (causeKey, cause, extra = {}) =>
    seqFirst
      ? { ...seqFirst, ageSec: age, unreadable: false, detail: { ...detail, ...extra } }
      : { causeKey, cause, ageSec: age, unreadable: false, detail: { ...detail, ...extra } };

  if (answer <= 0n) return first('non-positive-answer', `its feed answers ${answer}, which is non-positive`);
  if (updatedAt === 0) return first('unset-round', 'its feed reports an unset round (updatedAt = 0)');
  if (updatedAt > chainNow) {
    return first('future-timestamp', `its feed reports a FUTURE timestamp (updatedAt ${updatedAt} > chain time ${chainNow})`);
  }
  // The contract's bound is `updatedAt < now - heartbeat`, i.e. it trips at age STRICTLY GREATER
  // than the heartbeat. Age exactly equal is still fresh; getting this wrong reports a freeze one
  // poll early on every heartbeat-cadence feed.
  if (cfg.heartbeat > 0 && age > cfg.heartbeat) {
    return first(
      'heartbeat-exceeded',
      `its Chainlink feed last updated ${age}s ago, past its ${cfg.heartbeat}s heartbeat`,
      { staleBySec: age - cfg.heartbeat },
    );
  }

  const derived = answer * cfg.scale;
  detail.derivedPriceWad = derived.toString();
  // Band gating mirrors the contract EXACTLY: it keys on `maxPriceWad` alone. A floor with no
  // ceiling is rejected at construction, so `max == 0` is the only "disabled" spelling.
  if (cfg.maxPriceWad !== 0n && (derived < cfg.minPriceWad || derived > cfg.maxPriceWad)) {
    return first(
      'band-trip',
      `its price ${derived} is outside the configured sane-price band [${cfg.minPriceWad}, ${cfg.maxPriceWad}] — the defence against a feed reporting a deprecated clamp value during a depeg or flash crash`,
      { inBand: false },
    );
  }
  if (cfg.maxPriceWad !== 0n) detail.inBand = true;

  return seqFirst
    ? { ...seqFirst, ageSec: age, unreadable: false, detail }
    : { causeKey: null, cause: null, ageSec: age, unreadable: false, detail };
}

// ── chain reads ──────────────────────────────────────────────────────────────

/** Decode the 5-word Chainlink latestRoundData tuple. */
function readRound(feed) {
  const r = callRaw(feed, 'latestRoundData()(uint80,int256,uint256,uint256,uint80)');
  if (!r.ok) return r;
  const l = r.out.split('\n').map(clean);
  return { ok: /** @type {true} */ (true), answer: l[1], startedAt: Number(l[2]), updatedAt: Number(l[3]) };
}

/** `feedOf` is a mapping-to-struct getter: (feed, heartbeat, scale, minPriceWad, maxPriceWad). */
function readFeedConfig(asset) {
  const r = callRaw(dep.aggregator, 'feedOf(address)(address,uint32,uint64,uint128,uint128)', asset);
  if (!r.ok) return r;
  const l = r.out.split('\n').map(clean);
  return {
    ok: /** @type {true} */ (true),
    cfg: {
      feed: l[0], heartbeat: Number(l[1]), scale: BigInt(l[2]),
      minPriceWad: BigInt(l[3]), maxPriceWad: BigInt(l[4]),
    },
  };
}

/**
 * Prove the deployed oracle is the one this sampler models, ONCE, before any series line exists.
 *
 * There is deliberately no fall-back to the retired quorum sampler: nothing points this script at a
 * pre-pivot address book (`loadDeployment` is pinned to `base-sepolia.json` / chain 84532), so a
 * legacy path here would be untested dead code. If the probe fails the sampler REFUSES rather than
 * writing a series nobody can trust — a soak that produces no evidence is recoverable, one that
 * produces wrong evidence is what this rewrite is fixing.
 */
function probeOracle() {
  const seq = callRaw(dep.aggregator, 'sequencerUptimeFeed()(address)');
  if (seq.ok) return { sequencerFeed: clean(seq.out) };
  throw new Error(
    `oracle-sampler: the oracle at ${dep.aggregator} does not answer ChainlinkOracle.sequencerUptimeFeed() ` +
    `(${seq.err}). This sampler models ChainlinkOracle (the C-6 launch oracle) and nothing else; the retired ` +
    'OracleAggregator quorum sampler was removed with the pivot. Refusing to write a series rather than ' +
    'record observations of a contract this script does not understand.',
  );
}

function sample(env) {
  const blk = tryCast(['block', 'latest', '-f', 'timestamp', '--rpc-url', RPC]);
  if (!blk.ok) return { t: new Date().toISOString(), error: `chain time unreadable: ${blk.err}` };
  const chainNow = Number(blk.out);

  const seqFeed = env.sequencerFeed;
  const seqRound = /^0x0{40}$/i.test(seqFeed) ? null : readRound(seqFeed);
  const seq = sequencerState({ feed: seqFeed, round: seqRound, chainNow, grace: env.grace });

  const assets = dep.assets.map((a) => {
    const pinned = env.pinnedUsdc != null && a.token.toLowerCase() === env.pinnedUsdc.toLowerCase();
    const cfgRead = readFeedConfig(a.token);
    if (!cfgRead.ok) {
      // `feedOf` is a public mapping getter — it answers for EVERY address, listed or not. A failure
      // here means the read did not reach the contract we probed, so this asset is UNOBSERVED.
      return {
        symbol: a.symbol, asset: a.token, unreadable: true, ageUnreadable: true,
        unreadableReason: `feedOf() unreadable (${cfgRead.err})`,
        ageSec: null, ageFractionOfBound: null, priceReverts: null,
      };
    }
    const cfg = cfgRead.cfg;
    const round = pinned || /^0x0{40}$/i.test(cfg.feed) ? { ok: /** @type {false} */ (false), err: 'no feed listed', kind: /** @type {'revert'} */ ('revert') } : readRound(cfg.feed);
    const price = callRaw(dep.aggregator, 'priceWad(address)(uint256)', a.token);
    const at = attributeAsset({ cfg, round, chainNow, pinned, sequencer: seq });

    // TWO independent pieces of evidence, deliberately NOT collapsed into one flag:
    //  - `unreadable`: the FREEZE VERDICT is missing. `priceWad` is ground truth, but only a REVERT
    //    is a verdict — a transport failure says nothing about the contract, so the sample counts
    //    as neither breach nor health.
    //  - `ageUnreadable`: the age is missing (the feed's own round could not be read), but the
    //    verdict may still be sound. Losing the age must not discard a good freeze observation, and
    //    a null age must not be folded into the worst-case-age documentation as a zero.
    const priceUnreadable = !price.ok && price.kind === 'transport';
    const unreadable = priceUnreadable;

    return {
      symbol: a.symbol,
      asset: a.token,
      unreadable,
      unreadableReason: priceUnreadable ? `priceWad unreadable (${price.err})` : null,
      ageUnreadable: at.unreadable,
      listed: !/^0x0{40}$/i.test(cfg.feed),
      feed: cfg.feed,
      // The bound is the CONTRACT's heartbeat, read on-chain, not the address book's global.
      // A PINNED asset has no feed and therefore no bound: `feedOf` returns the zero struct, and
      // emitting its `heartbeat: 0` would both report permanent bound drift and overwrite a real
      // heartbeat in the reduction. Absent is the honest value, not zero.
      staleBoundSec: pinned ? null : cfg.heartbeat,
      staleBoundSource: pinned ? null : 'feedOf.heartbeat',
      configMaxStalenessSeconds: dep.maxStalenessSeconds,
      boundDrift: !pinned && dep.maxStalenessSeconds > 0 && dep.maxStalenessSeconds !== cfg.heartbeat,
      feedUpdatedAt: at.detail.updatedAtSec ?? null,
      ageSec: at.ageSec,
      ageFractionOfBound: at.ageSec != null && cfg.heartbeat > 0 ? +(at.ageSec / cfg.heartbeat).toFixed(6) : null,
      answer: at.detail.answer ?? null,
      derivedPriceWad: at.detail.derivedPriceWad ?? null,
      minPriceWad: cfg.minPriceWad.toString(),
      maxPriceWad: cfg.maxPriceWad.toString(),
      bandEnabled: cfg.maxPriceWad !== 0n,
      inBand: at.detail.inBand ?? null,
      pinned,
      priceWad: price.ok ? clean(price.out) : null,
      priceReverts: price.ok ? false : priceUnreadable ? null : true,
      priceIsStaleOracle: !price.ok && !priceUnreadable ? price.err.includes(SEL_STALE_ORACLE) : null,
      priceError: price.ok ? null : price.err,
      frozenCauseKey: price.ok ? null : at.causeKey,
      frozenCause: price.ok ? null : at.cause,
      // A freeze the model cannot explain is still a freeze. Flagging it says the ATTRIBUTION is
      // missing, not that nothing happened — the drill must never read this as health.
      attributionGap: !price.ok && !priceUnreadable && at.causeKey == null,
    };
  });

  // FREEZE-SAFETY: cancelPending must stay callable while the oracle is frozen.
  //
  // An EMPTY probe set must record itself. Mapping over `[]` yields `[]`, which reads downstream as
  // "probed, nothing to report" when the truth is "never probed" — the silent-inertness failure
  // this repository has shipped three times. One sentinel row per sample keeps it in the series.
  const { vaults: probeVaults, source: probeSource } = resolveProbeVaults();
  const probeOne = (vault) => {
    if (!PROBE_MEMBER) return { vault, probed: false, verdict: 'not-probed', reason: 'no SOAK_PROBE_MEMBER set' };
    const pend = callRaw(vault, 'pendingDeposit(address)(uint256,uint64)', PROBE_MEMBER);
    const pendingAmount = pend.ok ? clean(pend.out.split('\n')[0]) : null;
    const r = tryCast(['call', vault, 'cancelPending()', '--from', PROBE_MEMBER, '--rpc-url', RPC]);
    return {
      vault, probed: true, member: PROBE_MEMBER, pendingAmount,
      verdict: classifyCancelPending(r, pendingAmount),
      detail: r.ok ? 'static call returned successfully' : r.err,
    };
  };
  const freezeSafety = probeVaults.length === 0
    ? [{ vault: null, probed: false, verdict: 'not-configured', reason: `no vaults to probe (${probeSource})` }]
    : probeVaults.map(probeOne);

  return { t: new Date().toISOString(), chainNow, oracle: dep.aggregator, sequencer: seq, assets, freezeSafety };
}

// Runner guard: the pure classifiers above are unit-tested, and an infinite sampling loop at
// import time would hang the test process. Only sample when invoked as a script.
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { sequencerFeed } = probeOracle();
  const graceRead = callRaw(dep.aggregator, 'GRACE_PERIOD()(uint256)');
  const pinRead = callRaw(dep.aggregator, 'usdc()(address)');
  const env = {
    sequencerFeed,
    grace: graceRead.ok ? Number(clean(graceRead.out)) : 3600,
    pinnedUsdc: pinRead.ok && !/^0x0{40}$/i.test(clean(pinRead.out)) ? clean(pinRead.out) : null,
  };

  fs.mkdirSync(path.dirname(SERIES), { recursive: true });
  console.log(`[oracle-sampler] rpc=${RPC} every ${SAMPLE_MS}ms -> ${SERIES}`);
  console.log(`[oracle-sampler] ChainlinkOracle ${dep.aggregator}, sequencerUptimeFeed=${sequencerFeed}, GRACE_PERIOD=${env.grace}s, assets=${dep.assets.map((a) => a.symbol).join(',')}`);
  for (;;) {
    const s = sample(env);
    fs.appendFileSync(SERIES, JSON.stringify(s) + '\n');
    const summary = (s.assets ?? [])
      .map((a) => a.unreadable
        ? `${a.symbol} UNREADABLE`
        : `${a.symbol} age=${a.ageSec}s/${a.staleBoundSec}s${a.priceReverts ? ` FROZEN(${a.frozenCauseKey ?? 'unattributed'})` : ''}`)
      .join('  ');
    const seqNote = s.sequencer && s.sequencer.state !== 'up' && s.sequencer.state !== 'not-configured'
      ? `  sequencer=${s.sequencer.state}` : '';
    console.log(`[oracle-sampler ${s.t}] ${summary || s.error}${seqNote}`);
    await sleep(SAMPLE_MS);
  }
}
