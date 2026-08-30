// @ts-check
/**
 * Signal (a), LIVE FLAVOR — ORACLE HEALTH against `ChainlinkOracle`.
 *
 * The C-6 pivot replaced the bespoke multi-source `OracleAggregator` with one genuine Chainlink
 * Data Feed per asset. There is no quorum and no source set any more, so there is no margin to
 * report: an asset is either priceable or frozen. `signals/oracle-freshness.mjs` still measures the
 * retired regime and is still correct for a pre-pivot deployment; this module measures the live one,
 * and `checkOracleSignals()` at the bottom picks between them by probing the deployed oracle.
 *
 * WHAT FREEZES A VAULT (mirrored from ChainlinkOracle.priceWad, in the contract's own order):
 *   1. the L2 sequencer is down, or is inside its 3600s post-restart grace window
 *   2. the asset is not listed (`feedOf(asset).feed == address(0)`)
 *   3. the feed reverts, answers <= 0, or reports an unset (0) or future `updatedAt`
 *   4. `updatedAt < now - heartbeat` — aged past the feed's configured heartbeat
 *   5. `answer * scale` falls outside the configured sane-price band
 * Any one of those reverts `StaleOracle(asset)`, which freezes EVERY NAV path of the vault
 * including exits (SF-2 / K-4). There is no hatch and no fallback feed.
 *
 * GROUND TRUTH IS `priceWad(asset)` ITSELF. The sweep calls it and treats a revert as the incident,
 * because fail-closed means the revert IS the freeze. The per-field reads exist to ATTRIBUTE that
 * revert to one of the five causes above so the on-call line is actionable — never to second-guess
 * the contract. When the contract reverts and none of the five causes matches, that is reported as
 * an alert WITH the gap named, not swallowed: a detector that cannot explain a freeze it can see is
 * still telling the truth about the freeze.
 *
 * THE CLOCK IS CHAIN TIME, never the monitoring host's — a skewed box must not invent staleness.
 *
 * Fans out one result per (vault, asset), plus one per vault keyed `sequencer`, so a single stale
 * asset cannot flap the whole vault and the sequencer state has its own transition history.
 */

import { CHAINLINK_ORACLE_VIEWS, AGGREGATOR_V3_VIEWS, ORACLE_VIEWS, EXIT_FROZEN_SELECTORS } from '../abis.mjs';
import { ok, alert, skipped, detectorBroken, shortAddr } from '../signal.mjs';
import { checkOracleFreshness } from './oracle-freshness.mjs';

/**
 * Deliberately the SAME signal name the retired flavor uses. It is one detector with two
 * implementations: the transition ids stay stable across a redeploy, `docs/CANARY.md` §3(a) keeps
 * describing one signal, and nav-backing's "see the oracle-freshness signal, which pages for it"
 * attribution is true again — which is exactly what it stopped being at the pivot.
 */
export const SIGNAL = 'oracle-freshness';

/** ChainlinkOracle.GRACE_PERIOD, used only if the constant cannot be read from the deployment. */
const DEFAULT_GRACE_PERIOD = 3600;

const ZERO = '0x0000000000000000000000000000000000000000';
const isZero = (a) => typeof a !== 'string' || /^0x0{40}$/i.test(a);
const eqAddr = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const STALE_ORACLE = Object.keys(EXIT_FROZEN_SELECTORS)[0];

/**
 * Route to whichever oracle flavor is actually deployed.
 *
 * Probe order is live-first: `sequencerUptimeFeed()` exists on `ChainlinkOracle` and on nothing
 * else the canary can be pointed at, and it takes no arguments, so the probe does not depend on the
 * basket. `assetConfig` is the retired aggregator's tell (it returns cleanly even for an unlisted
 * asset, so a listed-vs-unlisted asset cannot confuse the probe).
 *
 * An oracle that answers NEITHER is a broken detector, not a healthy vault — that is the failure
 * this whole module exists to make impossible.
 *
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {string} ctx.oracle
 * @param {string[]} ctx.assets
 * @param {number} ctx.nowSec
 * @param {number} [ctx.minMargin]        retired flavor only: fresh-sources-minus-quorum bar
 * @param {number} [ctx.stalenessWarnPct] live flavor only: warn at this % of heartbeat (0 = off)
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkOracleSignals(ctx) {
  const { reader, vault, oracle, assets } = ctx;
  if (!Array.isArray(assets) || assets.length === 0) return [];

  const seq = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'sequencerUptimeFeed', []);
  if (seq.ok) return checkChainlinkOracle({ ...ctx, sequencerFeed: seq.value });

  const legacy = await reader.tryRead(oracle, ORACLE_VIEWS, 'assetConfig', [assets[0]]);
  if (legacy.ok) return checkOracleFreshness(ctx);

  return [detectorBroken({
    signal: SIGNAL, vault, key: 'flavor',
    message: `ORACLE DETECTOR BLIND on vault ${shortAddr(vault)}: the oracle at ${shortAddr(oracle)} answers neither ChainlinkOracle.sequencerUptimeFeed() nor OracleAggregator.assetConfig(), so NO oracle check is running for this vault. It is UNMONITORED for the staleness freeze, not healthy`,
    detail: {
      vault, oracle,
      chainlinkProbeError: seq.error ?? null,
      legacyProbeError: legacy.error ?? null,
    },
  })];
}

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {string} ctx.oracle
 * @param {string[]} ctx.assets
 * @param {number} ctx.nowSec
 * @param {string} ctx.sequencerFeed
 * @param {number} [ctx.stalenessWarnPct]
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkChainlinkOracle({ reader, vault, oracle, assets, nowSec, sequencerFeed, stalenessWarnPct = 0 }) {
  const out = [];

  const graceRead = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'GRACE_PERIOD', []);
  const grace = graceRead.ok ? Number(graceRead.value) : DEFAULT_GRACE_PERIOD;

  const seq = await sequencerLeg({ reader, vault, oracle, sequencerFeed, nowSec, grace });
  out.push(seq.result);

  // Read the pin once per vault. A pinned asset is never in a basket (VaultCore rejects USDC as a
  // basket entry), so this is belt-and-braces — but a pin misread as an unlisted asset would page
  // forever, and the read is one call.
  const pinRead = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'usdc', []);
  const pinned = pinRead.ok && !isZero(pinRead.value) ? pinRead.value : null;

  for (const asset of assets) {
    out.push(await assetLeg({
      reader, vault, oracle, asset, nowSec, pinned,
      sequencerCause: seq.cause, stalenessWarnPct,
    }));
  }

  return out;
}

// ── the sequencer gate ───────────────────────────────────────────────────────

/**
 * `ChainlinkOracle._requireSequencerUp` runs BEFORE any price is trusted, so when it trips EVERY
 * asset of EVERY vault on this oracle is frozen at once — which is why it is one result per vault,
 * not per asset.
 *
 * FIELD DISCIPLINE, because getting this wrong yields a detector that reads healthy through an
 * outage: the gate uses `answer` (0 = up, 1 = down) and `startedAt` (the restart time), and
 * DELIBERATELY ignores `updatedAt`. The uptime feed is event-driven — it only writes on an
 * up<->down transition — so a `updatedAt` months in the past is its healthy steady state, and
 * staleness-checking it would report a permanent outage on a perfectly healthy chain.
 *
 * @returns {Promise<{result: import('../signal.mjs').SignalResult, cause: string|null}>}
 */
async function sequencerLeg({ reader, vault, oracle, sequencerFeed, nowSec, grace }) {
  const base = { signal: SIGNAL, vault, key: 'sequencer' };

  if (isZero(sequencerFeed)) {
    // Not a detector fault and not health: the contract's own guard is inert here, so there is
    // nothing to watch. Off a sequencer L2 that is correct; on Base mainnet it means the deployment
    // shipped with NO sequencer guard at all, which is worth exactly one loud line either way.
    return {
      cause: null,
      result: skipped({
        ...base,
        message: `sequencer gate not configured on the oracle at ${shortAddr(oracle)} for vault ${shortAddr(vault)}: sequencerUptimeFeed is address(0), so ChainlinkOracle._requireSequencerUp is a no-op and this sub-check cannot run. Correct off a sequencer L2 (local/testnet); on Base mainnet it means the deployment has no sequencer guard`,
        detail: { vault, oracle, sequencerUptimeFeed: ZERO, configured: false },
      }),
    };
  }

  const rd = await reader.tryRead(sequencerFeed, AGGREGATOR_V3_VIEWS, 'latestRoundData', []);
  if (!rd.ok) {
    // The contract try/catches this and reverts StaleOracle, so it is a live freeze, not a blind
    // detector: we can see the cause perfectly well.
    return {
      cause: 'the sequencer uptime feed itself reverts',
      result: alert({
        ...base,
        message: `SEQUENCER UPTIME FEED UNREADABLE for vault ${shortAddr(vault)}: latestRoundData() on ${shortAddr(sequencerFeed)} reverts (${rd.error}) — ChainlinkOracle catches this and reverts StaleOracle for EVERY asset, so NAV and exits are frozen vault-wide`,
        measured: 'feed reverts', threshold: 'answers latestRoundData',
        detail: { vault, oracle, sequencerUptimeFeed: sequencerFeed, error: rd.error ?? null },
      }),
    };
  }

  const { answer, startedAt } = normalizeRound(rd.value);
  const detail = {
    vault, oracle, sequencerUptimeFeed: sequencerFeed,
    answer: answer.toString(), startedAtSec: Number(startedAt), gracePeriodSec: grace,
  };

  if (answer !== 0n) {
    return {
      cause: 'the L2 sequencer is reporting DOWN',
      result: alert({
        ...base,
        message: `BASE SEQUENCER DOWN for vault ${shortAddr(vault)}: uptime feed answer ${answer} (0 = up) — every asset reverts StaleOracle, so NAV and exits are frozen vault-wide. Nobody can transact on the L2 at all; pricing resumes ${grace}s AFTER the sequencer restarts, not at the restart itself`,
        measured: `answer ${answer}`, threshold: 'answer 0 (up)', detail,
      }),
    };
  }

  if (startedAt === 0n || Number(startedAt) > nowSec) {
    return {
      cause: 'the sequencer uptime round has no usable startedAt',
      result: alert({
        ...base,
        message: `SEQUENCER UPTIME ROUND UNUSABLE for vault ${shortAddr(vault)}: startedAt=${startedAt} against chain time ${nowSec} — the contract treats this as down and reverts StaleOracle for every asset, so NAV and exits are frozen vault-wide`,
        measured: `startedAt ${startedAt}`, threshold: `0 < startedAt <= ${nowSec}`, detail,
      }),
    };
  }

  const upFor = nowSec - Number(startedAt);
  // The contract reverts while `block.timestamp - startedAt <= GRACE_PERIOD`, so the first second
  // that prices again is startedAt + GRACE_PERIOD + 1. That exact number is the only honest ETA
  // this protocol can ever publish (it is a contract constant), so it rides in the alert.
  if (upFor <= grace) {
    const resumesAtSec = Number(startedAt) + grace + 1;
    return {
      cause: 'the sequencer is inside its post-restart grace period',
      result: alert({
        ...base,
        message: `SEQUENCER GRACE PERIOD for vault ${shortAddr(vault)}: the sequencer restarted ${upFor}s ago and the ${grace}s grace window has not elapsed, so every asset still reverts StaleOracle — the chain looks alive while the vault stays frozen. Pricing resumes at unix ${resumesAtSec} (in ${resumesAtSec - nowSec}s)`,
        measured: `up ${upFor}s`, threshold: `> ${grace}s since startedAt`,
        detail: { ...detail, upForSec: upFor, resumesAtSec, resumesInSec: resumesAtSec - nowSec },
      }),
    };
  }

  return {
    cause: null,
    result: ok({
      ...base,
      message: `sequencer up for ${upFor}s on vault ${shortAddr(vault)} (grace ${grace}s elapsed)`,
      measured: `up ${upFor}s`, threshold: `> ${grace}s since startedAt`,
      detail: { ...detail, upForSec: upFor },
    }),
  };
}

// ── one basket asset ─────────────────────────────────────────────────────────

/** @returns {Promise<import('../signal.mjs').SignalResult>} */
async function assetLeg({ reader, vault, oracle, asset, nowSec, pinned, sequencerCause, stalenessWarnPct }) {
  const base = { signal: SIGNAL, vault, key: asset };

  const cfgRead = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'feedOf', [asset]);
  if (!cfgRead.ok) {
    // `feedOf` is a public mapping getter: it answers for EVERY address, including unlisted ones.
    // A revert here means the contract is not the ChainlinkOracle the flavor probe said it was, so
    // this detector is blind rather than looking at a broken vault.
    return detectorBroken({
      ...base,
      message: `ORACLE DETECTOR BLIND for asset ${shortAddr(asset)} on vault ${shortAddr(vault)}: feedOf() on ${shortAddr(oracle)} reverts (${cfgRead.error}) even though the oracle answered as a ChainlinkOracle. This asset is UNMONITORED for the staleness freeze, not healthy`,
      detail: { vault, oracle, asset, error: cfgRead.error ?? null },
    });
  }

  const cfg = normalizeFeedConfig(cfgRead.value);

  if (pinned && eqAddr(asset, pinned)) {
    return ok({
      ...base,
      message: `asset ${shortAddr(asset)} on vault ${shortAddr(vault)} is the oracle's pinned USDC leg — priceWad returns $1.00 and can never go stale (it can still be frozen by the sequencer gate, which has its own key)`,
      measured: 'pinned 1e18', threshold: 'pinned',
      detail: { vault, oracle, asset, pinned: true },
    });
  }

  // GROUND TRUTH. Fail-closed means the revert IS the incident, so ask the contract directly rather
  // than inferring the freeze from the fields.
  const price = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'priceWad', [asset]);
  const round = isZero(cfg.feed)
    ? { ok: false, error: 'no feed listed' }
    : await reader.tryRead(cfg.feed, AGGREGATOR_V3_VIEWS, 'latestRoundData', []);

  const facts = describe({ cfg, round, nowSec });
  const detail = {
    vault, oracle, asset,
    feed: cfg.feed, heartbeatSec: cfg.heartbeat,
    minPriceWad: cfg.minPriceWad.toString(), maxPriceWad: cfg.maxPriceWad.toString(),
    bandEnabled: cfg.maxPriceWad !== 0n,
    priceWad: price.ok ? String(price.value) : null,
    priceWadReverts: !price.ok,
    ...facts.detail,
  };

  if (!price.ok) {
    const isStaleOracle = typeof price.revertData === 'string'
      && price.revertData.slice(0, 10).toLowerCase() === STALE_ORACLE;
    const cause = facts.cause ?? sequencerCause ?? null;
    return alert({
      ...base,
      message: cause
        ? `ORACLE FROZEN for ${shortAddr(asset)} on vault ${shortAddr(vault)}: priceWad reverts ${isStaleOracle ? 'StaleOracle' : `with ${price.revertData ?? 'no data'}`} because ${cause} — NAV, deposits, rebalances and EXITS are all frozen for this vault. Nothing on-chain can be done: the heartbeat, the band and the feed are immutable`
        : `ORACLE FROZEN for ${shortAddr(asset)} on vault ${shortAddr(vault)}: priceWad reverts ${isStaleOracle ? 'StaleOracle' : `with ${price.revertData ?? 'no data'}`} — NAV, deposits, rebalances and EXITS are frozen — but NONE of the causes this detector knows about (sequencer, unlisted, dead feed, non-positive answer, heartbeat, sane-price band) explains it. The freeze is real; the attribution is missing, so this detector's model of the oracle is incomplete`,
      measured: 'priceWad reverts', threshold: 'priceWad returns',
      detail: {
        ...detail,
        revertData: price.revertData ?? null,
        attributedCause: cause,
        // Deliberately NOT `detectorBroken`: the freeze is detected and paged. This flag says the
        // EXPLANATION is missing, which is a bug in this file, not a blind spot in the alerting.
        attributionGap: cause == null,
      },
    });
  }

  // priceWad answered, so nothing is frozen right now. The only remaining question is proximity.
  const warnAt = stalenessWarnPct > 0 && cfg.heartbeat > 0
    ? Math.floor((cfg.heartbeat * stalenessWarnPct) / 100)
    : null;
  if (warnAt != null && facts.ageSec != null && facts.ageSec >= warnAt) {
    return alert({
      ...base,
      message: `oracle answer AGEING for ${shortAddr(asset)} on vault ${shortAddr(vault)}: last update ${facts.ageSec}s ago against a ${cfg.heartbeat}s heartbeat (${stalenessWarnPct}% bar). The vault is still priceable; it freezes the moment the age passes the heartbeat`,
      measured: `age ${facts.ageSec}s`, threshold: `< ${warnAt}s (${stalenessWarnPct}% of ${cfg.heartbeat}s)`,
      detail: { ...detail, stalenessWarnPct, warnAtSec: warnAt },
    });
  }

  return ok({
    ...base,
    message: `oracle healthy for ${shortAddr(asset)} on vault ${shortAddr(vault)}: priceWad ${price.value}${facts.ageSec != null ? `, answer ${facts.ageSec}s old against a ${cfg.heartbeat}s heartbeat` : ''}`,
    measured: facts.ageSec != null ? `age ${facts.ageSec}s` : 'priceWad returns',
    threshold: cfg.heartbeat > 0 ? `<= ${cfg.heartbeat}s heartbeat` : 'priceWad returns',
    detail,
  });
}

/**
 * Reproduce ChainlinkOracle.priceWad's per-asset checks, in the contract's order, and name the
 * FIRST one that would revert. Attribution only — the verdict comes from priceWad itself.
 *
 * @returns {{cause: string|null, ageSec: number|null, detail: Record<string,any>}}
 */
function describe({ cfg, round, nowSec }) {
  if (isZero(cfg.feed)) {
    return { cause: 'the asset is not listed on this oracle (feedOf returns address(0))', ageSec: null, detail: { listed: false } };
  }
  if (!round.ok) {
    return {
      cause: `its Chainlink feed reverts (${round.error}) — a deprecated or dead feed fails closed with no fallback`,
      ageSec: null,
      detail: { listed: true, feedReverts: true, feedError: round.error ?? null },
    };
  }

  const { answer, updatedAt } = normalizeRound(round.value);
  const age = nowSec - Number(updatedAt);
  const detail = {
    listed: true, feedReverts: false,
    answer: answer.toString(), updatedAtSec: Number(updatedAt), ageSec: age,
  };

  if (answer <= 0n) return { cause: `its feed answers ${answer}, which is non-positive`, ageSec: age, detail };
  if (updatedAt === 0n) return { cause: 'its feed reports an unset round (updatedAt = 0)', ageSec: age, detail };
  if (Number(updatedAt) > nowSec) {
    return { cause: `its feed reports a FUTURE timestamp (updatedAt ${updatedAt} > chain time ${nowSec})`, ageSec: age, detail };
  }

  // The contract's bound is `updatedAt < now - heartbeat`, i.e. it trips at age > heartbeat. Age
  // exactly equal to the heartbeat is still fresh — the boundary is deliberate, and getting it
  // wrong here would page one poll early on every heartbeat-cadence feed.
  if (cfg.heartbeat > 0 && age > cfg.heartbeat) {
    return {
      cause: `its Chainlink feed last updated ${age}s ago, past its ${cfg.heartbeat}s heartbeat`,
      ageSec: age,
      detail: { ...detail, staleBySec: age - cfg.heartbeat },
    };
  }

  const priceWad = answer * cfg.scale;
  detail.derivedPriceWad = priceWad.toString();
  // Band gating mirrors the contract EXACTLY: it keys on maxPriceWad alone. A config with a floor
  // and no ceiling is rejected at construction, so `max == 0` is the only "disabled" spelling.
  if (cfg.maxPriceWad !== 0n && (priceWad < cfg.minPriceWad || priceWad > cfg.maxPriceWad)) {
    return {
      cause: `its price ${priceWad} is outside the configured sane-price band [${cfg.minPriceWad}, ${cfg.maxPriceWad}] — the defence against a feed reporting a deprecated clamp value during a depeg or flash crash`,
      ageSec: age,
      detail: { ...detail, inBand: false },
    };
  }
  if (cfg.maxPriceWad !== 0n) detail.inBand = true;

  return { cause: null, ageSec: age, detail };
}

// ── shape normalisation (viem hands back an array or an object depending on ABI shape) ──

/** `feedOf` is a mapping-to-struct getter, flattened to (feed, heartbeat, scale, min, max). */
function normalizeFeedConfig(v) {
  const [feed, heartbeat, scale, minPriceWad, maxPriceWad] = Array.isArray(v)
    ? v
    : [v?.feed, v?.heartbeat, v?.scale, v?.minPriceWad, v?.maxPriceWad];
  return {
    feed: typeof feed === 'string' ? feed : ZERO,
    heartbeat: Number(heartbeat ?? 0),
    scale: BigInt(scale ?? 1),
    minPriceWad: BigInt(minPriceWad ?? 0),
    maxPriceWad: BigInt(maxPriceWad ?? 0),
  };
}

/** `latestRoundData` returns (roundId, answer, startedAt, updatedAt, answeredInRound). */
function normalizeRound(v) {
  const [, answer, startedAt, updatedAt] = Array.isArray(v)
    ? v
    : [v?.roundId, v?.answer, v?.startedAt, v?.updatedAt];
  return { answer: BigInt(answer ?? 0), startedAt: BigInt(startedAt ?? 0), updatedAt: BigInt(updatedAt ?? 0) };
}
