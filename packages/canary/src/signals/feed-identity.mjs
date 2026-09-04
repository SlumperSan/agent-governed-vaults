// @ts-check
/**
 * Signal (g) — FEED IDENTITY. The on-chain half of G2 (OPS-3, aggregator-swap drift).
 *
 * WHAT THIS EXISTS FOR. `ChainlinkOracle`'s constructor proves three things about every feed it
 * lists — that the feed describes itself as USD-quoted (`_requireUsdQuote`), that it reports 8
 * decimals, and that `10**(18 - decimals)` is therefore the right `scale` — and then caches the
 * result in an IMMUTABLE `feedOf` entry and never looks again. Chainlink meanwhile swaps the
 * aggregator behind an `EACAggregatorProxy` as routine operation, and the proxy forwards
 * `decimals()` / `description()` to whichever aggregator is current. So the contract's three
 * construction-time proofs can silently stop being true, on a contract that cannot re-check them.
 *
 * This signal is the thing that re-checks them, every sweep. It is not a second staleness detector:
 * `oracle-freshness` owns the freeze, and a mis-scaled feed is not frozen — it prices perfectly,
 * just wrongly, which is exactly why nothing else in the canary can see it. `nav-backing` recomputes
 * NAV through the same `oracle.priceWad(asset)`, so a uniform mis-scale cancels on both sides of its
 * comparison and that signal stays silent through the whole event.
 *
 * ── GROUND TRUTH, AND WHY THERE IS ALMOST NO CONFIGURATION HERE ─────────────────────────────────
 *
 * The comparison that matters for the decimals leg is LIVE-vs-CACHED, not live-vs-config, and the
 * cached value IS observable on-chain: `feedOf(asset)` is a public mapping getter and `scale` is
 * literally `10**(18 - feedDecimals)` as cached at construction. So the check is
 *
 *     10n ** (18n - BigInt(feed.decimals())) === feedOf(asset).scale
 *
 * with BOTH sides read from the chain. No pin, no env var, no config file, nothing that can go
 * stale, nothing to maintain, and it is correct on the very first sweep after a cold start — which
 * matters, because a swap that happens while the canary is down must still be caught when it comes
 * back. The denomination leg is the same shape: it re-runs the constructor's own `_requireUsdQuote`
 * predicate against the description the proxy reports now.
 *
 * Only the IDENTITY leg — "which aggregator is behind the proxy" — needs a remembered value, and it
 * is the leg that carries no harm on its own. Its pin is observed on first sight and kept in the
 * canary's own state file (see `applyIdentityObservations` at the bottom, and canary-runner.mjs).
 * Rejected alternatives, and their failure modes, are recorded in docs/CANARY.md §3(g).
 *
 * ── SEVERITY, AND THE CALIBRATION TRAP THIS PACKAGE HAS BEEN BITTEN BY TWICE ────────────────────
 *
 * A Chainlink aggregator swap is ROUTINE AND LEGITIMATE — `phaseId` exists to count them. A
 * `decimals()` change is not routine and is the one that silently mis-scales every price. Those two
 * facts must not produce the same behaviour, so they do not:
 *
 *   - a HARM finding (decimals/scale, or a description that stopped quoting USD) ALERTS and
 *     LATCHES. There is no operator action that repairs it — the oracle's config is immutable — so
 *     the vault stays not-OK until it is evacuated or the oracle is replaced. It must never
 *     self-clear.
 *   - a benign IDENTITY change ALERTS EXACTLY ONCE and then clears, because the runner re-pins to
 *     the observed identity and the next sweep matches. It is a notification ("go read Chainlink's
 *     announcement"), not a standing incident.
 *
 * The self-clear is not a softening, it is the calibration. Latching a benign swap would park a
 * permanent not-OK row in `tracker.unhealthy()`, in the heartbeat summary and in `ops-check`, with
 * no action that clears it — which IS the muting pressure `ORACLE_MIN_MARGIN` and
 * `ORACLE_STALENESS_WARN_PCT` were both calibrated against. The transition line itself is emitted
 * durably either way; that is how every alert in this package reaches a human.
 *
 * And the alert level is safe for the identity leg for a reason the flat staleness bar could not
 * claim: a Chainlink feed's aggregator is swapped on the order of once or twice a YEAR, not dozens
 * of times a day. Rarity is what makes "page and let a human check the announcement" the right
 * calibration here and the wrong one there.
 *
 * Critically, the self-clear is GATED on the harm legs: the identity alert only clears because the
 * decimals and denomination checks passed on the same sweep. A swap that also moves decimals leaves
 * the harm leg alerting, and the vault stays not-OK. That conjunction is pinned by two adjacent
 * tests in test/feed-identity.test.mjs.
 *
 * ── A CHECK THAT CANNOT RUN IS NEVER SILENT ────────────────────────────────────────────────────
 *
 * Every branch below that cannot measure returns `detectorBroken`, which the transition tracker
 * re-asserts on a doubling backoff. The one departure from `oracle-health.mjs` is
 * `minConsecutive: UNREADABLE_SWEEPS`: every blind branch here is triggered by an eth_call coming
 * back empty, and PR #92 recorded observing exactly that against `aggregator()` on 2026-08-30 —
 * a single empty return is RPC noise, three consecutive is the feed. oracle-health needs no such
 * damping because its blind branch is structural (an oracle answering an ABI it does not have),
 * not a transient read.
 *
 * Fans out one result per (vault, asset), keyed by asset, like `oracle-freshness`.
 */

import { CHAINLINK_ORACLE_VIEWS, CHAINLINK_FEED_IDENTITY_VIEWS, ORACLE_VIEWS } from '../abis.mjs';
import { ok, alert, skipped, detectorBroken, signalId, shortAddr } from '../signal.mjs';

/**
 * Its OWN signal name, deliberately not `oracle-freshness`. Two reasons: this is a different
 * detector answering a different question (is the price RIGHT, not is the price FRESH), and the
 * soak's `series-analysis.mjs` keys the freeze verdict off every transition id starting
 * `oracle-freshness|`, so folding these rows in there would put identity noise inside the drill's
 * freeze evidence.
 */
export const SIGNAL = 'feed-identity';

/** Consecutive unreadable sweeps before a blind leg is escalated. See the header. */
export const UNREADABLE_SWEEPS = 3;

const ZERO = '0x0000000000000000000000000000000000000000';
const isZero = (a) => typeof a !== 'string' || /^0x0{40}$/i.test(a);
const eqAddr = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();

/**
 * `ChainlinkOracle` caches `scale = 10**(18 - decimals)` in a `uint64`. Anything that cannot be
 * expressed that way could never have been cached, so it is a mismatch by construction rather than
 * an arithmetic problem to work around.
 *
 * This function exists mostly to stop `10n ** BigInt(18 - d)` from throwing a RangeError on a
 * negative exponent: a swapped aggregator reporting 18 decimals is PRECISELY the drift this signal
 * is for, and letting it throw would convert the named ALERT into the runner's generic "signal
 * ERRORED" detectorBroken — a real freeze reported as a monitoring fault.
 *
 * @param {unknown} d
 * @returns {bigint|null} null when no cacheable scale exists for `d`
 */
export function scaleForDecimals(d) {
  const n = typeof d === 'bigint' ? Number(d) : Number(d);
  if (!Number.isInteger(n) || n < 0 || n > 18) return null;
  return 10n ** BigInt(18 - n);
}

/**
 * `ChainlinkOracle._requireUsdQuote`, mirrored: the description must end in `USD` as a whole word,
 * i.e. the last three characters are `USD` and the one before them is a pair separator (`' '` or
 * `'/'`). The separator is what stops `"ETH / PYUSD"` — an ETH price quoted in a USD-ish TOKEN —
 * from passing on a bare suffix match.
 *
 * Chainlink feed descriptions are ASCII, so comparing JS code units matches the contract's byte
 * comparison. A description that is not ASCII fails the suffix test anyway.
 *
 * @param {unknown} description
 */
export function isUsdQuoted(description) {
  if (typeof description !== 'string' || description.length < 4) return false;
  if (description.slice(-3) !== 'USD') return false;
  const sep = description[description.length - 4];
  return sep === ' ' || sep === '/';
}

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {string} ctx.oracle
 * @param {string[]} ctx.assets
 * @param {Record<string, {feed?:string|null, aggregator?:string|null, phaseId?:string|null}>} [ctx.pins]
 *        remembered identities, keyed by this signal's transition id. Read-only here: the runner
 *        owns the write, via `applyIdentityObservations`.
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkFeedIdentity({ reader, vault, oracle, assets, pins = {} }) {
  if (!Array.isArray(assets) || assets.length === 0) return [];

  // The SAME flavor probe `oracle-health.mjs` uses, in the same order, deliberately: two signals
  // that disagreed about which oracle is deployed would be worse than either being wrong.
  const seq = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'sequencerUptimeFeed', []);
  if (!seq.ok) {
    const legacy = await reader.tryRead(oracle, ORACLE_VIEWS, 'assetConfig', [assets[0]]);
    if (legacy.ok && seq.kind === 'revert') {
      // A CONFIRMED retired `OracleAggregator`. There is no Chainlink proxy anywhere in that
      // regime, so feed identity is not a thing that exists to be blind about — its sources are
      // fixed addresses in an immutable config. Nothing to report is the honest answer, not a
      // suppressed one.
      //
      // "CONFIRMED" is carried by `seq.kind === 'revert'`, and that guard is the point: this is
      // the one branch in the package that returns SILENCE. Reached on a transport failure it
      // would conclude "retired aggregator, nothing to monitor" from a 429 that happened to hit
      // the first probe and miss the second, and the signal would go quiet with no line at all.
      return [];
    }
    const unreachable = seq.kind === 'transport' || legacy.kind === 'transport';
    // Neither ABI answered. This IS a blind detector, and it is reported here as well as under
    // `oracle-freshness`: that signal's line says the vault is unmonitored for the staleness
    // FREEZE, which is a different capability from the one this signal provides.
    return [detectorBroken({
      signal: SIGNAL, vault, key: 'flavor',
      message: unreachable
        ? `FEED IDENTITY DETECTOR BLIND on vault ${shortAddr(vault)}: the oracle at ${shortAddr(oracle)} could not be probed (sequencerUptimeFeed: ${seq.error ?? 'no error text'}; assetConfig: ${legacy.error ?? 'no error text'}), so no feed can be located to check. This vault is UNMONITORED for aggregator-swap drift this sweep — this says nothing about the oracle's ABI`
        : `FEED IDENTITY DETECTOR BLIND on vault ${shortAddr(vault)}: the oracle at ${shortAddr(oracle)} answers neither ChainlinkOracle.sequencerUptimeFeed() nor OracleAggregator.assetConfig(), so no feed can be located to check. This vault is UNMONITORED for aggregator-swap drift, not clean`,
      detail: {
        vault, oracle, minConsecutive: UNREADABLE_SWEEPS,
        chainlinkProbeError: seq.error ?? null, legacyProbeError: legacy.error ?? null,
        chainlinkProbeKind: seq.kind ?? null, legacyProbeKind: legacy.kind ?? null,
        unreachable,
      },
    })];
  }

  const out = [];
  for (const asset of assets) {
    out.push(await assetIdentity({ reader, vault, oracle, asset, pins }));
  }
  return out;
}

/** @returns {Promise<import('../signal.mjs').SignalResult>} */
async function assetIdentity({ reader, vault, oracle, asset, pins }) {
  const base = { signal: SIGNAL, vault, key: asset };
  const id = signalId(SIGNAL, vault, asset);
  const pin = pins?.[id] ?? null;
  const blind = (message, detail) => detectorBroken({
    ...base, message, detail: { vault, oracle, asset, minConsecutive: UNREADABLE_SWEEPS, ...detail },
  });

  const cfgRead = await reader.tryRead(oracle, CHAINLINK_ORACLE_VIEWS, 'feedOf', [asset]);
  if (!cfgRead.ok) {
    return blind(
      cfgRead.kind === 'revert'
        ? `FEED IDENTITY DETECTOR BLIND for asset ${shortAddr(asset)} on vault ${shortAddr(vault)}: feedOf() on ${shortAddr(oracle)} reverts (${cfgRead.error}) even though the oracle answered as a ChainlinkOracle, so the cached scale this check compares against cannot be read. This asset is UNMONITORED for aggregator-swap drift, not clean`
        : `FEED IDENTITY DETECTOR BLIND for asset ${shortAddr(asset)} on vault ${shortAddr(vault)}: feedOf() on ${shortAddr(oracle)} could not be read (${cfgRead.error}) — the call did not reach the chain, so no revert was observed and the cached scale this check compares against is unavailable. This asset is UNMONITORED for aggregator-swap drift this sweep, not clean`,
      { error: cfgRead.error ?? null, kind: cfgRead.kind ?? null },
    );
  }
  const cfg = normalizeFeedConfig(cfgRead.value);

  if (isZero(cfg.feed)) {
    // A KNOWN state, not a blind one: either the asset is unlisted — in which case
    // `oracle-freshness` is already paging, because priceWad reverts permanently — or it is the
    // oracle's pinned USDC leg, which has no feed and therefore no identity to drift. Reported
    // once, never escalated, exactly like the other "another signal owns this" skips.
    return skipped({
      ...base,
      message: `feed identity cannot be checked for ${shortAddr(asset)} on vault ${shortAddr(vault)}: feedOf() lists no feed for it. Either the asset is unlisted — in which case oracle-freshness is paging, since priceWad reverts permanently — or it is the oracle's pinned USDC leg, which has no aggregator behind it`,
      detail: { vault, oracle, asset, listed: false, attributedTo: 'oracle-freshness' },
    });
  }

  // One round trip for the four proxy reads. tryRead never throws, so a partial failure is data.
  const [desc, dec, agg, phase] = await Promise.all([
    reader.tryRead(cfg.feed, CHAINLINK_FEED_IDENTITY_VIEWS, 'description', []),
    reader.tryRead(cfg.feed, CHAINLINK_FEED_IDENTITY_VIEWS, 'decimals', []),
    reader.tryRead(cfg.feed, CHAINLINK_FEED_IDENTITY_VIEWS, 'aggregator', []),
    reader.tryRead(cfg.feed, CHAINLINK_FEED_IDENTITY_VIEWS, 'phaseId', []),
  ]);

  const observedIdentity = {
    feed: cfg.feed,
    aggregator: agg.ok && typeof agg.value === 'string' ? agg.value : null,
    phaseId: phase.ok && phase.value != null ? String(phase.value) : null,
  };
  const detail = {
    vault, oracle, asset,
    feed: cfg.feed,
    cachedScale: cfg.scale.toString(),
    liveDecimals: dec.ok ? Number(dec.value) : null,
    liveDescription: desc.ok ? String(desc.value) : null,
    pinnedAggregator: pin?.aggregator ?? null,
    pinnedPhaseId: pin?.phaseId ?? null,
    observedIdentity,
  };

  // HARM LEGS FIRST, in the constructor's own order (`_requireUsdQuote`, then `decimals`). Order
  // decides which cause a responder chases — the Dev11 lesson, applied here too.
  if (!desc.ok || !dec.ok) {
    return blind(
      `FEED IDENTITY DETECTOR BLIND for ${shortAddr(asset)} on vault ${shortAddr(vault)}: the feed at ${shortAddr(cfg.feed)} did not answer ${!desc.ok ? 'description()' : ''}${!desc.ok && !dec.ok ? ' or ' : ''}${!dec.ok ? 'decimals()' : ''} (${(desc.error ?? dec.error) || 'no error text'}), so neither the denomination nor the cached-scale check could run. This asset is UNMONITORED for aggregator-swap drift, not clean`,
      { ...detail, descriptionError: desc.error ?? null, decimalsError: dec.error ?? null },
    );
  }

  const description = String(desc.value);
  if (!isUsdQuoted(description)) {
    return alert({
      ...base,
      message: `FEED DENOMINATION DRIFT for ${shortAddr(asset)} on vault ${shortAddr(vault)}: the feed at ${shortAddr(cfg.feed)} now describes itself as ${JSON.stringify(description)}, which is NOT USD-quoted. ChainlinkOracle proved this feed was USD-quoted once, at construction, and its config is immutable — every price it has served since the change is denominated in something else, and NAV, deposits and exits are all wrong rather than frozen. Verify against Chainlink's announcement and treat the vault as mispriced`,
      measured: JSON.stringify(description), threshold: 'a description ending in "USD" as a whole word',
      detail: { ...detail, usdQuoted: false, harm: 'denomination' },
    });
  }

  const liveDecimals = Number(dec.value);
  const expectedScale = scaleForDecimals(liveDecimals);
  if (expectedScale == null || expectedScale !== cfg.scale) {
    const factor = expectedScale == null ? null : ratio(expectedScale, cfg.scale);
    return alert({
      ...base,
      message: `FEED DECIMALS DRIFT for ${shortAddr(asset)} on vault ${shortAddr(vault)}: the feed at ${shortAddr(cfg.feed)} now reports ${liveDecimals} decimals, but the oracle cached scale ${cfg.scale}${expectedScale == null ? ' and no cacheable scale exists for that many decimals (scale is 10**(18-decimals), which requires decimals <= 18)' : ` when the correct scale for ${liveDecimals} decimals is ${expectedScale}`}. Every price this asset has served since the change is mis-scaled${factor ? ` by ${factor}` : ''} — the vault is NOT frozen, it is silently WRONG, and nothing else in the canary can see it because nav-backing recomputes through the same priceWad. The oracle's config is immutable: this cannot be repaired, only evacuated`,
      measured: `decimals ${liveDecimals}`,
      threshold: `the cached scale ${cfg.scale} (decimals ${scaleToDecimals(cfg.scale) ?? '?'})`,
      detail: { ...detail, expectedScale: expectedScale == null ? null : expectedScale.toString(), harm: 'decimals' },
    });
  }

  // IDENTITY LEG. Harm-free by itself, and only reached once both harm legs have passed.
  if (!agg.ok && !phase.ok) {
    return blind(
      `FEED IDENTITY DETECTOR BLIND for ${shortAddr(asset)} on vault ${shortAddr(vault)}: the feed at ${shortAddr(cfg.feed)} answered neither aggregator() nor phaseId() (${(agg.error ?? phase.error) || 'no error text'}), so an aggregator swap cannot be observed at all. The denomination and cached-scale checks DID pass this sweep — the harm checks are running; it is the swap NOTICE that is blind`,
      { ...detail, aggregatorError: agg.error ?? null, phaseIdError: phase.error ?? null },
    );
  }

  const swap = convictSwap(pin, observedIdentity);
  if (swap) {
    return alert({
      ...base,
      message: `AGGREGATOR SWAPPED behind the feed for ${shortAddr(asset)} on vault ${shortAddr(vault)}: ${swap}. This is LEGITIMATE routine Chainlink operation and there is nothing to fix on-chain — but it is the only event that can invalidate the oracle's cached scale, so verify it against Chainlink's announcement (a deprecation is announced off-chain and looks like ordinary staleness only AFTER the response window closes). The denomination and cached-scale checks passed against the NEW aggregator on this same sweep, which is what says the swap was harmless; this alert clears itself next sweep`,
      measured: `aggregator ${observedIdentity.aggregator ?? 'unreadable'} / phaseId ${observedIdentity.phaseId ?? 'unreadable'}`,
      threshold: `aggregator ${pin?.aggregator ?? 'unpinned'} / phaseId ${pin?.phaseId ?? 'unpinned'}`,
      detail: { ...detail, swapped: true, harm: null },
    });
  }

  const partial = observedIdentity.aggregator == null || observedIdentity.phaseId == null;
  return ok({
    ...base,
    message: pin
      ? `feed identity unchanged for ${shortAddr(asset)} on vault ${shortAddr(vault)}: ${liveDecimals} decimals matching the cached scale ${cfg.scale}, ${JSON.stringify(description)} still USD-quoted, aggregator ${observedIdentity.aggregator ?? 'unreadable this sweep'} phaseId ${observedIdentity.phaseId ?? 'unreadable this sweep'}`
      : `feed identity PINNED for ${shortAddr(asset)} on vault ${shortAddr(vault)} on first sight: aggregator ${observedIdentity.aggregator ?? 'unreadable'} phaseId ${observedIdentity.phaseId ?? 'unreadable'}, ${liveDecimals} decimals matching the cached scale ${cfg.scale}. A swap that happened BEFORE this pin is invisible to the identity leg — the decimals and denomination checks above do not depend on it and cover the harm regardless; scripts/verify-chainlink-oracle.mjs compares against the config's own aggregatorPin, which is the half that survives a canary restart`,
    measured: `decimals ${liveDecimals}`, threshold: `the cached scale ${cfg.scale}`,
    detail: { ...detail, pinned: pin != null, identityPartial: partial },
  });
}

/**
 * Decide whether the observed identity CONVICTS a swap against the pin, mirroring the argument in
 * `scripts/verify-chainlink-oracle.mjs` rather than inventing a second one.
 *
 * `phaseId` increments on every swap and is a single word, so it convicts on its own. A changed
 * `aggregator()` convicts only when both sides are actually readable — a read that came back empty
 * is not evidence of a swap, and PR #92 recorded observing exactly that burst on 2026-08-30.
 *
 * @returns {string|null} the human clause for the alert line, or null for "no swap evidenced"
 */
function convictSwap(pin, observed) {
  if (!pin) return null; // nothing pinned yet: first sight is not a change
  if (pin.phaseId != null && observed.phaseId != null && String(pin.phaseId) !== String(observed.phaseId)) {
    return `phaseId moved ${pin.phaseId} -> ${observed.phaseId}${observed.aggregator && pin.aggregator && !eqAddr(pin.aggregator, observed.aggregator) ? ` and aggregator() moved ${pin.aggregator} -> ${observed.aggregator}` : ''}`;
  }
  if (pin.aggregator && observed.aggregator && !eqAddr(pin.aggregator, observed.aggregator)) {
    return `aggregator() moved ${pin.aggregator} -> ${observed.aggregator} (phaseId ${observed.phaseId ?? 'unreadable'})`;
  }
  if (pin.feed && observed.feed && !eqAddr(pin.feed, observed.feed)) {
    // The oracle's config is immutable, so this should be unreachable — which is exactly why it is
    // worth saying out loud if it ever happens: it would mean the vault's oracle itself changed.
    return `the ORACLE now lists a different feed for this asset: ${pin.feed} -> ${observed.feed}`;
  }
  return null;
}

/**
 * Fold this sweep's observations into the remembered identities. Pure; the runner calls it and
 * persists the result to the canary state file.
 *
 * FIELD-BY-FIELD, and NEVER writing an absent value over a present one. That rule is Dev12's
 * recorded bug stated as a guard: a pinned leg emitting a zero from an empty struct "would have
 * overwritten a real heartbeat with zero — absent is the honest value". Here the equivalent
 * mistake would erase the anchor with a null on the one sweep an `aggregator()` read came back
 * empty, and the next real swap would then go unnarrated.
 *
 * @param {Record<string, any>} pins
 * @param {import('../signal.mjs').SignalResult[]} results
 * @returns {Record<string, any>} a new map; `pins` is not mutated
 */
export function applyIdentityObservations(pins, results) {
  const next = { ...(pins ?? {}) };
  for (const r of results ?? []) {
    if (r?.signal !== SIGNAL) continue;
    const obs = r.detail?.observedIdentity;
    if (!obs) continue; // a blind or skipped leg observed nothing; keep whatever is pinned
    const merged = { ...(next[r.id] ?? {}) };
    for (const field of ['feed', 'aggregator', 'phaseId']) {
      if (obs[field] != null) merged[field] = obs[field];
    }
    if (merged.feed == null && merged.aggregator == null && merged.phaseId == null) continue;
    next[r.id] = merged;
  }
  return next;
}

/** `feedOf` is a mapping-to-struct getter, flattened to (feed, heartbeat, scale, min, max). */
function normalizeFeedConfig(v) {
  const [feed, , scale] = Array.isArray(v) ? v : [v?.feed, v?.heartbeat, v?.scale];
  return { feed: typeof feed === 'string' ? feed : ZERO, scale: BigInt(scale ?? 0) };
}

/** Invert `10**(18 - d)` for the alert line, or null when the cached scale is not a power of ten. */
function scaleToDecimals(scale) {
  for (let d = 0; d <= 18; d += 1) if (10n ** BigInt(18 - d) === scale) return d;
  return null;
}

/**
 * How wrong the PRICE is, not how wrong the scale is — that is the number an operator reading one
 * line at 3am has to act on. `priceWad = answer * cachedScale`, so the price is off by exactly
 * `cachedScale / correctScale`.
 */
function ratio(expected, cached) {
  if (cached === 0n || expected === 0n) return null;
  if (cached > expected) return `${cached / expected}x too HIGH`;
  if (expected > cached) return `${expected / cached}x too LOW`;
  return null;
}
