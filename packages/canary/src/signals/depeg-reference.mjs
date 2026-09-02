// @ts-check
/**
 * Signal (i) — DEPEG REFERENCE. Closes G4 (OPS-8, "USDC depeg. Undetected internally: days") from
 * Business/Operations/Monitoring Gap Analysis.md §2 — see §3 item 6 for the spec this file
 * implements, in its "cheapest possible form".
 *
 * WHAT THIS EXISTS FOR. `ChainlinkOracle` and `OracleAggregator` both PIN USDC at $1.00 rather than
 * measuring it — deposits and exits price USDC at par through the whole vault, unconditionally, by
 * design. That means a sustained USDC depeg produces no freeze, no staleness, and no divergence
 * anywhere else in this package: `nav-backing` recomputes NAV through the very same pin, so a depeg
 * cancels on both sides of that comparison exactly the way a mis-scaled feed does in
 * `feed-identity.mjs`. The event is externally loud (every exchange and stablecoin tracker sees it),
 * but nothing OF OURS measures it or triggers the de-list decision this protocol depends on a human
 * making.
 *
 * PURELY INFORMATIONAL, ON PURPOSE. This signal reads a Chainlink USDC/USD Data Feed on Base — a
 * reference the vault's own oracle never consults — and ALERTs when it strays outside 0.995..1.005.
 * There is no on-chain remedy: the contract will keep pricing USDC at exactly $1.00 regardless of
 * what this signal reports, by design, and every message below says so explicitly so a reader never
 * mistakes this for a contract-level freeze the way `oracle-freshness` is. Two things it does NOT
 * report as a depeg: a non-positive answer, and a reading older than `USDC_USD_FEED_MAX_AGE_SEC`.
 * Both are faults in this detector's own input, and both say so — a monitor that reports its own
 * breakage as evidence is worse than one that stays quiet about it. See
 * `contracts/config/base-mainnet.json`'s `usdcReferenceFeeds` block, which names this exact
 * feed as "the off-chain monitoring inputs for that residual (a canary signal, not an on-chain
 * input)" — this file is that canary signal.
 *
 * FEED ADDRESS, AND WHY THERE IS NO GUESSED TESTNET DEFAULT. The mainnet feed
 * (`0x7e860098F58bBFC8648a4311b374B1D669a2bc6B`) is VERIFIED ON-CHAIN — it is
 * `base-mainnet.json`'s `usdcReferenceFeeds.chainlinkUsdcUsd`, read on 2026-08-24. No equivalent is
 * documented in `contracts/config/deployments/base-sepolia.json` or `base-sepolia.json`, and this
 * file does not invent one — canary-runner.mjs defaults `USDC_USD_FEED_ADDRESS` to the mainnet
 * address ONLY when `CHAIN_ID` is 8453; every other chain id needs the address set explicitly. Left
 * unset on a non-mainnet chain, this signal reports `skipped` (a real configuration fact, not a
 * blind detector) rather than probing a mainnet-only contract address that has no code elsewhere and
 * would otherwise read as a permanent DETECTOR BROKEN.
 */

import { AGGREGATOR_V3_VIEWS, CHAINLINK_FEED_IDENTITY_VIEWS } from '../abis.mjs';
import { ok, alert, skipped, detectorBroken, shortAddr } from '../signal.mjs';
import { scaleForDecimals } from './feed-identity.mjs';

export const SIGNAL = 'depeg-reference';

/** The band from Monitoring Gap Analysis.md §3 item 6: 0.995 .. 1.005, expressed in WAD. */
export const LOWER_BOUND_WAD = 995_000000000000000n;
export const UPPER_BOUND_WAD = 1_005000000000000000n;

/**
 * One empty `eth_call` is RPC noise; three consecutive is the feed — the same damping
 * `feed-identity.mjs` uses, and it is now actually WIRED UP. It was previously declared here,
 * documented as if it were in force, and only ever stuffed into `detail.minConsecutive` on results
 * that never reached the code path that reads it — the first failed read went BLIND immediately
 * (Review115 F8). `transitions.mjs` honours `detail.minConsecutive`, so setting it on the two
 * unreadable branches below IS the damping. Applied only to those two: a stale-but-answering feed
 * and a non-positive answer are definite observations, not transport noise.
 */
export const UNREADABLE_SWEEPS = 3;

/**
 * How old the reference reading may be before this detector calls itself BLIND rather than
 * reporting the stale number as in-band. A frozen aggregator pinned at $1.0000 reads "healthy"
 * forever otherwise — and a depeg is precisely when a feed is most likely to be disrupted, so the
 * silently-dead case is the one G4 cannot afford (Review115 F6).
 *
 * This is a bound WE choose, not a property of the feed: `contracts/config/base-mainnet.json`'s
 * `usdcReferenceFeeds` block documents no heartbeat for `chainlinkUsdcUsd` (unlike the asset feeds,
 * which carry `heartbeatSeconds`/`feedCadenceSeconds`), and nothing in this repo has verified one.
 * So the default is deliberately generous — a full day, well past any plausible stablecoin-feed
 * heartbeat — to make a false BLIND essentially impossible while still catching a feed that has
 * genuinely stopped. Override with `USDC_USD_FEED_MAX_AGE_SEC` once a real cadence is measured;
 * `detail.ageSec` is reported on every reading, in band or not, so it can be calibrated from data
 * rather than guessed at again.
 */
export const DEFAULT_MAX_AGE_SEC = 86_400;

/**
 * @param {Object} ctx
 * @param {any} ctx.reader
 * @param {string} ctx.vault
 * @param {string|null} [ctx.feed] the USDC/USD Chainlink feed address, or null when unconfigured
 * @param {number} [ctx.chainId]   only used to word the "unconfigured" message
 * @param {number} [ctx.nowSec]    chain time, seconds — the staleness leg is skipped without it
 * @param {number} [ctx.maxAgeSec] staleness bound; see DEFAULT_MAX_AGE_SEC
 * @returns {Promise<import('../signal.mjs').SignalResult[]>}
 */
export async function checkDepegReference({ reader, vault, feed, chainId, nowSec, maxAgeSec = DEFAULT_MAX_AGE_SEC }) {
  const base = { signal: SIGNAL, vault };

  if (!feed) {
    return [skipped({
      ...base,
      message: `USDC depeg reference not configured for vault ${shortAddr(vault)} on chain ${chainId ?? 'unknown'}: no known Chainlink USDC/USD feed is documented for this chain. Set USDC_USD_FEED_ADDRESS to enable — the vault's OWN pricing is unaffected either way, since the oracle pins USDC at $1.00 regardless (G4)`,
      detail: { vault, chainId: chainId ?? null, configured: false },
    })];
  }

  const [round, dec] = await Promise.all([
    reader.tryRead(feed, AGGREGATOR_V3_VIEWS, 'latestRoundData', []),
    reader.tryRead(feed, CHAINLINK_FEED_IDENTITY_VIEWS, 'decimals', []),
  ]);

  if (!round.ok || !dec.ok) {
    return [detectorBroken({
      ...base,
      message: `USDC DEPEG REFERENCE BLIND for vault ${shortAddr(vault)}: the reference feed at ${shortAddr(feed)} did not answer ${!round.ok ? 'latestRoundData()' : ''}${!round.ok && !dec.ok ? ' or ' : ''}${!dec.ok ? 'decimals()' : ''} (${(round.error ?? dec.error) || 'no error text'}). This is a monitoring gap only — the vault's own oracle still pins USDC at $1.00 unconditionally and is unaffected — but this canary cannot currently see a depeg forming`,
      detail: {
        vault, feed, minConsecutive: UNREADABLE_SWEEPS,
        roundError: round.error ?? null, decimalsError: dec.error ?? null,
      },
    })];
  }

  const decimals = Number(dec.value);
  const scale = scaleForDecimals(decimals);
  if (scale == null) {
    return [detectorBroken({
      ...base,
      message: `USDC DEPEG REFERENCE BLIND for vault ${shortAddr(vault)}: the reference feed at ${shortAddr(feed)} reports ${decimals} decimals, which no WAD scale can express (needs 0..18) — the reading cannot be normalized. The vault's own oracle still pins USDC at $1.00 unconditionally`,
      detail: { vault, feed, decimals, minConsecutive: UNREADABLE_SWEEPS },
    })];
  }

  const { answer, updatedAt } = normalizeRound(round.value);
  const priceWad = answer * scale;
  const ageSec = nowSec == null ? null : nowSec - Number(updatedAt);
  const detail = {
    vault, feed, decimals, answer: answer.toString(), updatedAtSec: Number(updatedAt),
    ageSec, maxAgeSec,
    priceWad: priceWad.toString(),
    lowerBoundWad: LOWER_BOUND_WAD.toString(), upperBoundWad: UPPER_BOUND_WAD.toString(),
    pinnedByContractAt: '1.00',
  };

  // A non-positive answer is a BROKEN AGGREGATOR, not a $0.00 USDC. Folding it into the depeg ALERT
  // emitted de-list evidence — "reads $0.0000, outside the 0.995..1.005 band" — for what is a fault
  // in the monitor's own input (Review115 F7). This package's post-#89 discipline is that a detector
  // fault says so.
  if (answer <= 0n) {
    return [detectorBroken({
      ...base,
      message: `USDC DEPEG REFERENCE BLIND for vault ${shortAddr(vault)}: the reference feed at ${shortAddr(feed)} answered ${answer}, which is not a price — a non-positive answer is a broken aggregator, NOT a USDC valuation, and this signal will not report it as depeg evidence. The vault's own oracle still pins USDC at $1.00 unconditionally and is unaffected, but this canary cannot currently see a depeg forming`,
      detail,
    })];
  }

  // A feed frozen at $1.0000 reads in-band forever. Age past the bound is the incident, the same way
  // `oracle-health.mjs` treats age past the heartbeat — and it is BLIND, not an ALERT, because a
  // stale reference says nothing about where USDC actually is.
  if (ageSec != null && ageSec > maxAgeSec) {
    return [detectorBroken({
      ...base,
      message: `USDC DEPEG REFERENCE STALE for vault ${shortAddr(vault)}: the reference feed at ${shortAddr(feed)} last updated ${ageSec}s ago, past the ${maxAgeSec}s bound (USDC_USD_FEED_MAX_AGE_SEC). Its last answer of ${formatUsd(priceWad)} is not current evidence either way — a frozen feed reads in-band indefinitely, which is exactly how this detector goes silently dead during the disruption a depeg causes. The vault's own oracle still pins USDC at $1.00 unconditionally and is unaffected`,
      measured: `${ageSec}s`, threshold: `${maxAgeSec}s`, detail,
    })];
  }

  if (priceWad < LOWER_BOUND_WAD || priceWad > UPPER_BOUND_WAD) {
    return [alert({
      ...base,
      message: `USDC DEPEG REFERENCE OUT OF BAND for vault ${shortAddr(vault)}: the Chainlink USDC/USD reference feed at ${shortAddr(feed)} reads ${formatUsd(priceWad)}, outside the 0.995..1.005 band. This is EXTERNAL, informational evidence for the de-list decision only — the contract's oracle pins USDC at exactly $1.00 for every deposit, exit and NAV computation regardless of this reading, by design, and will keep doing so until a human relists or unwinds the vault`,
      measured: formatUsd(priceWad), threshold: '0.995 .. 1.005', detail,
    })];
  }

  return [ok({
    ...base,
    message: `USDC depeg reference in band for vault ${shortAddr(vault)}: ${formatUsd(priceWad)} against the 0.995..1.005 band (the vault's own oracle pins USDC at $1.00 regardless)`,
    measured: formatUsd(priceWad), threshold: '0.995 .. 1.005', detail,
  })];
}

/** `latestRoundData` returns (roundId, answer, startedAt, updatedAt, answeredInRound). */
function normalizeRound(v) {
  const [, answer, , updatedAt] = Array.isArray(v)
    ? v
    : [v?.roundId, v?.answer, v?.startedAt, v?.updatedAt];
  return { answer: BigInt(answer ?? 0), updatedAt: BigInt(updatedAt ?? 0) };
}

/** WAD price, 4dp — enough resolution to show a depeg's magnitude without false precision. */
function formatUsd(priceWad) {
  const cents = priceWad < 0n
    ? -((-priceWad * 10000n) / 1_000000000000000000n)
    : (priceWad * 10000n) / 1_000000000000000000n;
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 10000n;
  const frac = abs % 10000n;
  return `$${sign}${whole}.${String(frac).padStart(4, '0')}`;
}
