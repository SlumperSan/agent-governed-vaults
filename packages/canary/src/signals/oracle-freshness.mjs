// @ts-check
/**
 * Signal (a) — ORACLE FRESHNESS. "See the staleness breaker coming, before it freezes capital."
 *
 * MODELLED ON THE DEPLOYED ORACLE, which since the C-6 pivot is
 * contracts/src/oracle/ChainlinkOracle.sol: ONE genuine Chainlink Data Feed per asset, no median,
 * no quorum, no per-vault source list. The old shape of this signal (`freshSources - quorum`,
 * `ORACLE_MIN_MARGIN`) described the retired {OracleAggregator} and could not be ported, because
 * neither `sources` nor a `quorum` exists any more: a single feed is either inside its heartbeat
 * or it is not.
 *
 * WHY THE SHAPE OF THIS FILE MATTERS. The previous version read `assetConfig(address)`, which
 * exists only on the retired aggregator, so against the launch deployment it reverted on every
 * poll, for every asset, on every vault, and parked permanently in `skipped` — the canary was
 * silent about oracle freshness because it was BLIND to it (found in the gate-7 restore drill,
 * docs/RESTORE-DRILL.md §5). Two structural defences against a repeat:
 *   1. The ALERT path depends only on `priceWad`, the one view every IOracleAggregator implements.
 *      Whatever oracle a vault is pinned to, "is the breaker tripped right now" is always measured.
 *      Only the forward-looking headroom needs the ChainlinkOracle-specific reads, and when those
 *      are unavailable the signal says so ONCE per vault instead of going quiet.
 *   2. test/abis.test.mjs checks every fragment this file reads against the COMPILED contracts.
 *
 * WHAT IS MEASURED, per (vault, asset):
 *   priceWad(asset)  — the breaker itself. It never returns 0 and never returns a stale price; it
 *                      reverts StaleOracle. A revert IS a live capital freeze: every NAV path in
 *                      the vault reverts with it, INCLUDING EXITS, by design and with no hatch
 *                      (SF-2/K-4). That is the page.
 *   HEADROOM         — `heartbeat - (chainNow - feed.updatedAt)`: how much silence the asset's feed
 *                      has left before ChainlinkOracle rejects it as stale. This replaces the old
 *                      source-count margin, and it is the "coming, not arrived" half of the signal.
 *                      Reported in bps of the heartbeat so ONE bar works across a 3,600 s mainnet
 *                      heartbeat and the 86,400 s testnet one (see the address book).
 *
 * CALIBRATION, which decides whether the signal is usable at all. A Chainlink feed publishes on a
 * deviation threshold OR its own heartbeat, and the oracle's configured heartbeat is set at or
 * above the feed's, so a HEALTHY feed sits far from the bound: Base Sepolia's ETH/USD was 307 s
 * into an 86,400 s heartbeat when the address book was verified (99.6% headroom), and Base mainnet
 * ETH/USD publishes at least every 1,200 s against a 3,600 s bound (>= 66% headroom). Alerting at
 * 25% headroom therefore never fires in steady state, and still leaves 15 minutes of warning on
 * mainnet. A bar set much higher would page forever and get the canary muted — the same mistake in
 * the other direction from being blind.
 *
 * THE SEQUENCER GATE IS PART OF FRESHNESS, and it fans out as its own key. ChainlinkOracle runs
 * `_requireSequencerUp` BEFORE any price is read, so a down (or just-restarted) Base sequencer
 * freezes EVERY asset on EVERY vault priced by that oracle. It gets one result, not one per asset:
 * when that gate is failing the per-asset results are DEGRADED and attributed to it, so one root
 * cause produces one page — the same discipline nav-backing and exit-liveness already follow.
 * `address(0)` (the deliberate testnet configuration) means the contract skips the gate, so the
 * canary reports it healthy and stays silent; treating "not configured" as degraded would recreate
 * the never-green signal this rewrite exists to remove.
 *
 * The staleness clock is CHAIN time (latest block timestamp), never the monitoring host's clock.
 */

import {
  ORACLE_VIEWS, CHAINLINK_ORACLE_VIEWS, CHAINLINK_FEED_VIEWS, EXIT_FROZEN_SELECTORS,
} from '../abis.mjs';
import { ok, alert, skipped, shortAddr, bpsToPct } from '../signal.mjs';

export const SIGNAL = 'oracle-freshness';

/** Fan-out keys that are not a basket asset. */
export const SEQUENCER_KEY = 'sequencer';
export const MODEL_KEY = 'oracle-model';

const ZERO = '0x0000000000000000000000000000000000000000';
const eq = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const isZero = (a) => !a || eq(a, ZERO);

/** ChainlinkOracle's own default, used only if GRACE_PERIOD() cannot be read. */
const GRACE_PERIOD_FALLBACK = 3600;

/**
 * @param {Object} ctx
 * @param {any} ctx.reader              injected chain reader (see ../reader.mjs)
 * @param {string} ctx.vault            the vault being watched
 * @param {string} ctx.oracle           its oracle (VaultCore.oracle(), immutable)
 * @param {string[]} ctx.assets         the vault's basket assets (what navWad actually prices)
 * @param {number} ctx.nowSec           chain time, seconds
 * @param {number} [ctx.minHeadroomBps] alert when a feed's remaining heartbeat <= this (default 2500 = 25%)
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkOracleFreshness({ reader, vault, oracle, assets, nowSec, minHeadroomBps = 2500 }) {
  const out = [];
  const model = await readOracleModel(reader, oracle);

  /** @type {{reason:string, message:string}|null} */
  let gateFailing = null;

  if (model.chainlink) {
    const seq = await checkSequencerGate({ reader, vault, oracle, model, nowSec });
    out.push(seq.result);
    gateFailing = seq.failing;
  } else {
    // Say the coverage limit ONCE per vault rather than once per asset: the breaker check below
    // still runs on every asset, so this is a narrowed check, not a dead one.
    out.push(skipped({
      signal: SIGNAL, vault, key: MODEL_KEY,
      message: `oracle ${shortAddr(oracle)} on vault ${shortAddr(vault)} does not answer the ChainlinkOracle read surface (${model.error}) — heartbeat headroom and the L2 sequencer gate CANNOT be measured on it. Breaker detection (priceWad reverts StaleOracle) still runs per asset, so a freeze is still paged; the early warning is not. The launch oracle is contracts/src/oracle/ChainlinkOracle.sol (C-6)`,
      detail: { vault, oracle, error: model.error, chainlinkModel: false },
    }));
  }

  for (const asset of assets) {
    out.push(await checkAsset({ reader, vault, oracle, asset, model, nowSec, minHeadroomBps, gateFailing }));
  }

  return out;
}

// ── the L2 sequencer gate (ChainlinkOracle._requireSequencerUp) ──────────────

/**
 * Reproduces `_requireSequencerUp` exactly, including what it deliberately does NOT check: the
 * uptime feed's own `updatedAt` is event-driven (it writes only on an up<->down transition), so a
 * long-unchanged timestamp is its HEALTHY steady state. Staleness-checking it would page forever
 * on a perfectly good sequencer.
 */
async function checkSequencerGate({ reader, vault, oracle, model, nowSec }) {
  const feed = model.sequencerUptimeFeed;
  const base = { vault, oracle, sequencerUptimeFeed: feed, gracePeriodSec: model.gracePeriod };

  if (isZero(feed)) {
    return {
      failing: null,
      result: ok({
        signal: SIGNAL, vault, key: SEQUENCER_KEY,
        message: `no L2 sequencer uptime feed configured on oracle ${shortAddr(oracle)} (address(0)) — ChainlinkOracle skips the uptime gate on this chain, so there is nothing to watch`,
        measured: 'not configured', threshold: 'gate skipped when unset',
        detail: { ...base, configured: false },
      }),
    };
  }

  const res = await reader.tryRead(feed, CHAINLINK_FEED_VIEWS, 'latestRoundData', []);
  if (!res.ok) {
    return {
      failing: { reason: 'uptime-feed-unreadable', message: 'the sequencer uptime feed does not answer latestRoundData' },
      result: alert({
        signal: SIGNAL, vault, key: SEQUENCER_KEY,
        message: `L2 sequencer uptime feed ${shortAddr(feed)} is UNREADABLE (${res.error}) — ChainlinkOracle catches that and reverts StaleOracle for EVERY asset, so NAV and exits are frozen on every vault priced by oracle ${shortAddr(oracle)}`,
        measured: 'unreadable', threshold: 'answer 0 (up), past grace',
        detail: { ...base, error: res.error },
      }),
    };
  }

  const { answer, startedAt } = normalizeRound(res.value);
  const upFor = nowSec - Number(startedAt);
  const detail = { ...base, answer: String(answer), startedAt: Number(startedAt), upForSec: upFor };

  if (answer !== 0n) {
    return {
      failing: { reason: 'sequencer-down', message: 'the L2 sequencer is reported DOWN' },
      result: alert({
        signal: SIGNAL, vault, key: SEQUENCER_KEY,
        message: `the L2 sequencer is DOWN (uptime feed ${shortAddr(feed)} answer=${answer}) — every priceWad on oracle ${shortAddr(oracle)} reverts StaleOracle: NAV and exits are frozen for every vault it prices, and stay frozen for ${model.gracePeriod}s after it recovers`,
        measured: `answer ${answer}`, threshold: 'answer 0 (up)', detail,
      }),
    };
  }

  if (Number(startedAt) === 0 || Number(startedAt) > nowSec) {
    return {
      failing: { reason: 'uptime-round-unstarted', message: 'the uptime round has no usable startedAt' },
      result: alert({
        signal: SIGNAL, vault, key: SEQUENCER_KEY,
        message: `L2 sequencer uptime round on feed ${shortAddr(feed)} has an unusable startedAt (${startedAt}) — ChainlinkOracle treats that as DOWN and reverts StaleOracle for every asset on oracle ${shortAddr(oracle)}`,
        measured: `startedAt ${startedAt}`, threshold: `0 < startedAt <= ${nowSec}`, detail,
      }),
    };
  }

  if (upFor <= model.gracePeriod) {
    return {
      failing: { reason: 'within-grace', message: 'the sequencer restarted inside its grace period' },
      result: alert({
        signal: SIGNAL, vault, key: SEQUENCER_KEY,
        message: `the L2 sequencer restarted ${upFor}s ago, inside the ${model.gracePeriod}s grace period — prices stay gated (StaleOracle on every asset of oracle ${shortAddr(oracle)}) for another ${model.gracePeriod - upFor}s. Nothing to fix; capital unfreezes when the window elapses`,
        measured: `up ${upFor}s`, threshold: `> ${model.gracePeriod}s`, detail,
      }),
    };
  }

  return {
    failing: null,
    result: ok({
      signal: SIGNAL, vault, key: SEQUENCER_KEY,
      message: `L2 sequencer up for ${upFor}s on oracle ${shortAddr(oracle)} (grace ${model.gracePeriod}s cleared)`,
      measured: `up ${upFor}s`, threshold: `> ${model.gracePeriod}s`, detail,
    }),
  };
}

// ── per basket asset ────────────────────────────────────────────────────────

async function checkAsset({ reader, vault, oracle, asset, model, nowSec, minHeadroomBps, gateFailing }) {
  const id = { signal: SIGNAL, vault, key: asset };
  const price = await reader.tryRead(oracle, ORACLE_VIEWS, 'priceWad', [asset]);
  const feed = await readFeedConfig(reader, oracle, asset, model);
  const round = feed.ok && !isZero(feed.address)
    ? await reader.tryRead(feed.address, CHAINLINK_FEED_VIEWS, 'latestRoundData', [])
    : null;

  const measured = measureFeed({ feed, round, nowSec });
  const detail = {
    vault, asset, oracle,
    priceWad: price.ok ? String(price.value) : null,
    feed: feed.ok ? feed.address : null,
    heartbeatSec: feed.ok ? feed.heartbeat : null,
    ...measured.detail,
  };

  // ── 1. the breaker is TRIPPED (or the oracle is failing in a way the protocol does not model)
  if (!price.ok) {
    // One root cause, one page: the sequencer gate short-circuits before the price read, so every
    // asset would otherwise alert for the sequencer's reason. The sequencer key carries that page.
    if (gateFailing) {
      return skipped({
        ...id,
        message: `oracle freshness for ${shortAddr(asset)} on vault ${shortAddr(vault)} cannot be measured: ${gateFailing.message}, and ChainlinkOracle runs that gate BEFORE any price read — priceWad reverts for every asset until it clears (see the ${SEQUENCER_KEY} alert on this vault)`,
        detail: { ...detail, attributedTo: `${SIGNAL}|${vault}|${SEQUENCER_KEY}`, gateFailing: gateFailing.reason },
      });
    }

    const selector = String(price.revertData ?? '').slice(0, 10).toLowerCase();
    if (!(selector in EXIT_FROZEN_SELECTORS)) {
      // Deliberately still an ALERT. Whatever the reason, a reverting priceWad reverts every NAV
      // path in the vault; and there is no "could not classify, assume healthy" branch here, the
      // same rule the exit-liveness classifier follows.
      return alert({
        ...id,
        message: `priceWad(${shortAddr(asset)}) on oracle ${shortAddr(oracle)} reverts with an UNRECOGNIZED error (${price.error}) — not StaleOracle. Every NAV path on vault ${shortAddr(vault)} that prices this asset reverts with it, exits included. Either the oracle is not the contract this canary models, or it is failing in a way the protocol does not describe: inspect it before trusting any other signal on this vault`,
        measured: `revert ${selector || 'no returndata'}`, threshold: 'priceWad returns a price',
        detail: { ...detail, revertData: price.revertData ?? null, revertName: null },
      });
    }

    return alert({
      ...id,
      message: `oracle breaker TRIPPED for ${shortAddr(asset)} on vault ${shortAddr(vault)}: priceWad reverts StaleOracle — NAV and exits are frozen for this vault. Cause: ${measured.tripCause}`,
      // `measured` rides in the one-line transition suffix "(measured X, threshold Y)", so it stays
      // SHORT: the cause is a sentence and already lives in the message and in detail.tripCause.
      measured: 'StaleOracle', threshold: 'priceWad returns a price',
      detail: { ...detail, revertName: 'StaleOracle', tripCause: measured.tripCause },
    });
  }

  // ── 2. priced fine. How much heartbeat is left before it is not?
  //
  // `gateFailing` can still be set here: the sequencer read and this price read are separate
  // eth_calls within one sweep (this signal pins no block), so a sequencer that recovered — or a
  // grace window that elapsed — between them yields an ALERTing sequencer key beside a priced
  // asset. Both are true as measured; carrying the reason into `detail` is what lets a webhook
  // consumer reconcile the pair instead of reading them as a contradiction.
  if (gateFailing) detail.gateFailing = gateFailing.reason;

  if (!model.chainlink) {
    return ok({
      ...id,
      message: `oracle prices ${shortAddr(asset)} on vault ${shortAddr(vault)} (priceWad ${price.value}); heartbeat headroom is not measurable on this oracle model — see the ${MODEL_KEY} line for this vault`,
      measured: 'priced', threshold: 'priceWad returns a price',
      detail: { ...detail, headroomBps: null },
    });
  }

  if (!feed.ok) {
    return skipped({
      ...id,
      message: `oracle ${shortAddr(oracle)} prices ${shortAddr(asset)} but its feed config is unreadable (${feed.error}) — the freeze alarm still works, the heartbeat early-warning for this asset does not`,
      detail,
    });
  }

  if (isZero(feed.address)) {
    if (eq(asset, model.usdc)) {
      return ok({
        ...id,
        message: `${shortAddr(asset)} is the oracle's pinned USDC leg on vault ${shortAddr(vault)} — priced at 1e18 with no feed, so it has no heartbeat to run out`,
        measured: 'pinned 1e18', threshold: 'n/a (no feed)',
        detail: { ...detail, pinned: true, headroomBps: null },
      });
    }
    // priceWad returned a price for an asset the feed map says is unlisted and the pin does not
    // cover. Not a freeze (capital is fine), but the canary's model of this oracle is wrong.
    return skipped({
      ...id,
      message: `oracle ${shortAddr(oracle)} priced ${shortAddr(asset)} on vault ${shortAddr(vault)} while reporting NO feed for it and no USDC pin match — the canary's model of this oracle is wrong, so its heartbeat early-warning for this asset cannot be trusted. Verify the oracle against contracts/src/oracle/ChainlinkOracle.sol`,
      detail: { ...detail, pinned: false, headroomBps: null },
    });
  }

  if (!round || !round.ok) {
    return skipped({
      ...id,
      message: `feed ${shortAddr(feed.address)} for ${shortAddr(asset)} on vault ${shortAddr(vault)} does not answer latestRoundData (${round?.error ?? 'not read'}) — priceWad still prices the asset, so this is an early-warning gap, not a freeze`,
      detail,
    });
  }

  const { headroomSec, headroomBps } = measured;
  if (headroomBps === null) {
    // No heartbeat to measure against. ChainlinkOracle's constructor forbids a zero heartbeat, so
    // this means the canary is reading something that is not the oracle it thinks it is — which is
    // DEGRADED, never a `0 <= bar` alert on a null.
    return skipped({
      ...id,
      message: `oracle ${shortAddr(oracle)} reports a zero/unreadable heartbeat for ${shortAddr(asset)} on vault ${shortAddr(vault)} — ChainlinkOracle rejects that at construction, so this oracle is not the contract the canary models. Pricing works; the heartbeat early-warning does not`,
      detail,
    });
  }
  const bar = `> ${bpsToPct(minHeadroomBps)} of the ${feed.heartbeat}s heartbeat`;
  if (headroomBps <= minHeadroomBps) {
    return alert({
      ...id,
      message: `oracle feed for ${shortAddr(asset)} on vault ${shortAddr(vault)} is ${headroomSec}s from its staleness bound (${bpsToPct(headroomBps)} of its ${feed.heartbeat}s heartbeat left, last update ${measured.ageSec}s ago) — when it elapses priceWad reverts StaleOracle and NAV and exits freeze. Chase the feed (${shortAddr(feed.address)}) now, there is no contract-side remedy afterwards`,
      measured: `${headroomSec}s (${bpsToPct(headroomBps)})`, threshold: bar, detail,
    });
  }

  return ok({
    ...id,
    message: `oracle feed for ${shortAddr(asset)} on vault ${shortAddr(vault)} has ${headroomSec}s of heartbeat left (${bpsToPct(headroomBps)}, last update ${measured.ageSec}s ago)`,
    measured: `${headroomSec}s (${bpsToPct(headroomBps)})`, threshold: bar, detail,
  });
}

// ── reads ───────────────────────────────────────────────────────────────────

/**
 * Identify the oracle model ONCE per vault, and collect what the gate needs.
 *
 * `sequencerUptimeFeed()` is the probe because it is the cheapest read that only ChainlinkOracle
 * answers, and the value is needed anyway. GRACE_PERIOD is read rather than hardcoded; if that one
 * read fails the contract's own constant is used as a fallback and recorded in the detail.
 */
async function readOracleModel(reader, oracle) {
  const seq = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'sequencerUptimeFeed', []);
  if (!seq.ok) return { chainlink: false, error: seq.error, sequencerUptimeFeed: null, usdc: null, gracePeriod: GRACE_PERIOD_FALLBACK };

  const [usdc, grace] = await Promise.all([
    reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'usdc', []),
    reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'GRACE_PERIOD', []),
  ]);
  return {
    chainlink: true,
    error: null,
    sequencerUptimeFeed: seq.value,
    usdc: usdc.ok ? usdc.value : null,
    gracePeriod: grace.ok ? Number(grace.value) : GRACE_PERIOD_FALLBACK,
    gracePeriodRead: grace.ok,
  };
}

/** `feedOf(asset)` — the asset's single feed and the heartbeat its staleness is measured against. */
async function readFeedConfig(reader, oracle, asset, model) {
  if (!model.chainlink) return { ok: false, error: 'oracle is not a ChainlinkOracle', address: null, heartbeat: 0 };
  const res = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'feedOf', [asset]);
  if (!res.ok) return { ok: false, error: res.error, address: null, heartbeat: 0 };
  const v = res.value;
  const [address, heartbeat, scale, minPriceWad, maxPriceWad] = Array.isArray(v)
    ? v
    : [v.feed, v.heartbeat, v.scale, v.minPriceWad, v.maxPriceWad];
  return {
    ok: true, error: null,
    address: address ?? ZERO,
    heartbeat: Number(heartbeat ?? 0),
    // The oracle's OWN cached 10**(18 - feedDecimals). Read, never assumed: the band comparison
    // below has to be the one priceWad performs, not a guess at the feed's decimals.
    scale: BigInt(scale ?? 0),
    minPriceWad: BigInt(minPriceWad ?? 0),
    maxPriceWad: BigInt(maxPriceWad ?? 0),
  };
}

/**
 * Turn the feed round into the numbers both branches need, and — when the breaker is tripped —
 * name WHY, by walking ChainlinkOracle.priceWad's own reject order. Without this an operator reads
 * "TRIPPED" and chases the feed operator when the real cause was the sane-price band.
 */
function measureFeed({ feed, round, nowSec }) {
  const empty = { headroomSec: null, headroomBps: null, ageSec: null, detail: {}, tripCause: 'unknown' };
  if (!feed.ok) return { ...empty, tripCause: `the oracle's feed config is unreadable (${feed.error})` };
  if (isZero(feed.address)) {
    return { ...empty, tripCause: 'the asset is NOT LISTED on this oracle (no feed, and it is not the pinned USDC leg) — it can never be priced by it' };
  }
  if (!round || !round.ok) {
    return { ...empty, detail: { feedError: round?.error ?? 'not read' }, tripCause: `the feed at ${shortAddr(feed.address)} itself reverts (${round?.error ?? 'not read'})` };
  }

  const { answer, updatedAt } = normalizeRound(round.value);
  const ageSec = nowSec - Number(updatedAt);
  const heartbeat = feed.heartbeat > 0 ? feed.heartbeat : 0;
  const headroomSec = heartbeat > 0 ? heartbeat - ageSec : null;
  const headroomBps = heartbeat > 0 ? Math.floor((headroomSec * 10000) / heartbeat) : null;
  const detail = {
    updatedAt: Number(updatedAt), ageSec, headroomSec, headroomBps,
    answer: String(answer),
    bandMinWad: String(feed.minPriceWad ?? 0n), bandMaxWad: String(feed.maxPriceWad ?? 0n),
  };

  let tripCause;
  if (answer <= 0n) tripCause = `the feed reports a non-positive answer (${answer}) — a broken or deprecated feed`;
  else if (Number(updatedAt) === 0) tripCause = 'the feed round is unset (updatedAt 0) — an incomplete round';
  else if (Number(updatedAt) > nowSec) tripCause = `the feed timestamp is in the FUTURE (updatedAt ${updatedAt} > chain time ${nowSec})`;
  else if (heartbeat > 0 && ageSec > heartbeat) tripCause = `the feed is STALE — last update ${ageSec}s ago, past its ${heartbeat}s heartbeat by ${ageSec - heartbeat}s`;
  else if (outOfBand(answer, feed)) {
    tripCause = `the price is OUTSIDE the oracle's sane-price band (band ${feed.minPriceWad}..${feed.maxPriceWad} WAD) — the depeg / deprecated-clamp defence fired, so the feed reads "fresh" but is not trusted`;
  } else {
    tripCause = 'UNCLASSIFIED — the feed itself reads healthy, so the revert came from somewhere this signal does not model. Read ChainlinkOracle.priceWad against the deployed bytecode';
  }

  return { headroomSec, headroomBps, ageSec, detail, tripCause };
}

/**
 * The sane-price band, mirroring ChainlinkOracle: `maxPriceWad == 0` disables it, and the answer is
 * lifted to WAD with the oracle's own cached `scale` rather than an assumed decimals count.
 */
function outOfBand(answer, feed) {
  if (!feed.maxPriceWad || !feed.scale) return false;
  const priceWad = BigInt(answer) * feed.scale;
  return priceWad < feed.minPriceWad || priceWad > feed.maxPriceWad;
}

/** latestRoundData returns (roundId, answer, startedAt, updatedAt, answeredInRound). */
function normalizeRound(v) {
  const [, answer, startedAt, updatedAt] = Array.isArray(v)
    ? v
    : [v.roundId, v.answer, v.startedAt, v.updatedAt];
  return { answer: BigInt(answer ?? 0), startedAt: BigInt(startedAt ?? 0), updatedAt: BigInt(updatedAt ?? 0) };
}
