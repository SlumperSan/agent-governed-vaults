/**
 * The one hook every live component uses.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect, because this
 * store is genuinely external: it exists before any component mounts, it
 * outlives every one of them, and two components read it at once. That is the
 * case the hook was added to React for, and it is what makes the server
 * snapshot a separate function rather than a guess.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { serverSnapshot, snapshot, start, subscribe, type LiveState } from './store';

export function useLive(): LiveState {
  useEffect(start, []);
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

/**
 * How old a feed print is, in the shortest form that is still unambiguous.
 *
 * THIS IS A FRESHNESS STATEMENT, NOT A CLOCK. It exists so that a price is never
 * rendered alone, because a price rendered alone is read as a quote from now.
 * The equity feeds on chain 4663 stop printing when the market closes and are
 * routinely twenty to fifty hours old across a weekend, so "now" is the one
 * thing this must never imply.
 *
 * It rounds DOWN and never says "just now": a print thirty seconds old reads as
 * "0m", which is honest about being a print rather than a stream. Above a day it
 * switches to days, because "31h" and "1d 7h" are the same fact and the second
 * one is the one a reader acts on.
 */
export function age(updatedAt: number, now: number): string {
  const s = Math.max(0, now - updatedAt);
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  return h === 0 ? d + 'd' : d + 'd ' + h + 'h';
}

/**
 * Whether a print is inside twenty-four hours.
 *
 * EIGHTY-SIX THOUSAND FOUR HUNDRED SECONDS IS A NUMBER THE DEPLOYED CONTRACTS
 * USE, not a number chosen to make this page's colours work. `ChainlinkOracle`
 * at 0x79279FBa on chain 4663 was read on 2026-09-05 and returns a heartbeat of
 * 86,400 for the WETH feed, which is the ETH/USD proxy this page reads; its
 * `priceWad` reverts rather than serving a price older than that. So for the ETH
 * feed this boundary is literally the contracts' own, and a print this function
 * calls stale is a print the protocol would refuse to price.
 *
 * FOR THE EQUITY FEED IT IS A COMPARISON, AND THE PAGE SAYS SO RATHER THAN
 * BLURRING IT. The deployed oracle prices two assets, and neither of them is a
 * stock token: the equity feed is not admitted to it and has no configured
 * heartbeat there. It is drawn against the same twenty-four-hour line because
 * that is the line Chainlink's own directory gives it and because the
 * comparison is the honest one to make, not because the protocol prices it.
 * Nothing on this page says the protocol holds, prices or trades that asset.
 *
 * IT IS RENDERED AS A WORD AND A COLOUR, never a colour alone. The panel writes
 * "inside 24h" or "past 24h" beside the dot, because a reader who cannot
 * distinguish the two hues has to get the same fact.
 */
export const HEARTBEAT_SECONDS = 86400;

export function withinHeartbeat(updatedAt: number, now: number): boolean {
  return now - updatedAt <= HEARTBEAT_SECONDS;
}
