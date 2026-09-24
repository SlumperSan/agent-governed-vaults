/**
 * OFAC SDN digital-currency address screening — card 213. `sdn-addresses.ts` is the vendored data
 * (see that file's header, and `scripts/build-sdn-list.mjs` for how it is built); this module is
 * the check itself, imported by `wallet.tsx` (surfaces the refusal at connect) and by
 * `chain-actions.ts`'s `simulateThenWrite` (the single choke point every signed write in this app
 * routes through — approve, deposit, commitVote, revealVote, requestExit — so gating there refuses
 * all five without repeating the check per call site).
 *
 * FRONT END ONLY, AND THE COPY SAYS SO. This screens what THIS Interface will submit on a member's
 * behalf; it has no ability to stop a call made directly against the Protocol's own permissionless
 * contracts (Terms of Use draft v0.1 §3). Never render or log a claim that the Protocol itself
 * blocks a sanctioned address — only that this front end refuses to sign for it.
 *
 * NOTHING ABOUT A CHECKED ADDRESS IS SENT OR STORED BY THIS CHECK. `isSanctionedAddress` is a pure,
 * synchronous Set lookup against the vendored list already bundled into this app; no network call,
 * no third party, no local storage write.
 */
// Explicit `.ts` extension, unlike every sibling import in this app: this module (and its
// `sdn-addresses.ts` data file) must be importable directly under plain `node --test`, which
// follows Node's own ESM resolution — no extension inference — rather than tsc/vite's bundler
// resolution. `tsconfig.json`'s `allowImportingTsExtensions` is on for exactly this file, gated on
// `noEmit: true` (already set here) per TypeScript's own requirement for the flag. Every OTHER
// cross-module import in this app stays extensionless; this is the one leaf `chain-actions.ts` and
// `wallet.tsx` reach through that also needs to be a real, runnable Node unit under test — see
// `test/sanctions.test.mjs`'s header for why.
import { SDN_ADDRESS_DATA } from './sdn-addresses.ts';

/** The exact line card 213 specifies, unchanged wherever it is shown. */
export const SANCTIONS_REFUSAL_MESSAGE =
  "This address matches a U.S. sanctions list, so this website won't submit transactions for it. The Protocol's contracts are permissionless, and this screens our front end only.";

/**
 * How stale the vendored list may get before it can no longer be trusted. OFAC updates the SDN
 * list on an irregular cadence — sometimes several times a week — so this is deliberately much
 * shorter than a "the government moves slowly" instinct would pick; a wallet sanctioned the week
 * after this list was last built must not silently pass for months. Re-run
 * `scripts/build-sdn-list.mjs` before this ships if `assertSdnListFresh` below is what is failing
 * the gate — do not raise this number to make it pass.
 */
export const SDN_LIST_MAX_AGE_DAYS = 30;

const SDN_ADDRESS_SET: ReadonlySet<string> = new Set(SDN_ADDRESS_DATA.addresses.map((a) => a.toLowerCase()));

/** Case-insensitive: EIP-55 checksum casing is a display convention, not a different address. */
export function isSanctionedAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  return SDN_ADDRESS_SET.has(address.toLowerCase());
}

/** Milliseconds-based, so a test can pass a fixed `now` rather than depending on the real clock. */
export function sdnListAgeDays(now: number = Date.now()): number {
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  return (now - fetchedMs) / 86_400_000;
}

/**
 * Throws when the vendored list is older than `SDN_LIST_MAX_AGE_DAYS` — called from
 * `apps/vaults-ui/test/sanctions.test.mjs`'s real-clock test, which runs in `npm run gate`
 * (`test:backend`), so a rotting list fails the gate rather than silently under-screening
 * forever. THIS ALONE IS CI-TIME ONLY, and reads the real clock only when a caller omits `now` —
 * it is not, by itself, a runtime guard: a deployed build ships whatever `sdn-addresses.ts` it
 * was built with and keeps serving it however old it gets, since nothing here re-runs the gate
 * against a live clock after deploy. `assertNotSanctioned` below is the runtime counterpart
 * (card 217): it calls this same predicate on every write, not just in CI.
 */
export function assertSdnListFresh(now?: number): void {
  const age = sdnListAgeDays(now);
  if (age > SDN_LIST_MAX_AGE_DAYS) {
    throw new Error(
      `sanctions.ts: the vendored SDN address list is ${Math.floor(age)} day(s) old (fetched ${SDN_ADDRESS_DATA.fetchedAt}), ` +
        `older than the ${SDN_LIST_MAX_AGE_DAYS}-day freshness ceiling. Re-run apps/vaults-ui/scripts/build-sdn-list.mjs and commit the refreshed src/lib/sdn-addresses.ts.`,
    );
  }
}

/** Thrown by `assertNotSanctioned` — `chain-actions.ts` lets this propagate as-is rather than
 *  rewrapping it, so the member-facing text stays exactly `SANCTIONS_REFUSAL_MESSAGE`. */
export class SanctionsRefusalError extends Error {
  constructor() {
    super(SANCTIONS_REFUSAL_MESSAGE);
    this.name = 'SanctionsRefusalError';
  }
}

/** The exact line shown for a write refused because the list itself cannot be trusted, never
 *  because a specific address matched it — kept short and distinct from
 *  `SANCTIONS_REFUSAL_MESSAGE` so the two causes are never confused in member-facing copy. */
export const SANCTIONS_LIST_STALE_MESSAGE = 'sanctions list out of date';

/**
 * Thrown by `assertNotSanctioned` (card 217) when the vendored list is too old to answer the
 * question it is asked at all — an unusable screen, not a clean one. FAILS CLOSED, the same
 * direction `functions/_middleware.js`'s `isSanctionedRequest` takes on a missing `cf`: absent
 * proof the address is clean, the write is refused, never silently allowed through on a stale
 * list nobody caught. */
export class SanctionsListStaleError extends Error {
  constructor() {
    super(SANCTIONS_LIST_STALE_MESSAGE);
    this.name = 'SanctionsListStaleError';
  }
}

/**
 * The write-path gate. Called first thing inside `simulateThenWrite`, before any simulate or
 * sign — a listed address never even reaches the `eth_call` that simulate-before-sign runs.
 *
 * RUNTIME FRESHNESS CHECK (card 217), CHECKED FIRST. Staleness used to be
 * enforced only by `assertSdnListFresh`'s CI-time test against the real clock (see that
 * function's own comment) — a deployed build keeps serving whatever list it shipped with,
 * however old it gets, since nothing re-checks it after deploy. This calls the same
 * `sdnListAgeDays`/`SDN_LIST_MAX_AGE_DAYS` comparison on every write and fails CLOSED: once the
 * list is more than `SDN_LIST_MAX_AGE_DAYS` old, every write that brings value IN or votes
 * refuses with `SanctionsListStaleError`, for listed and unlisted addresses alike: a stale list
 * cannot prove an address is clean.
 *
 * EXCEPT a member taking their own money OUT (`STALE_LIST_EXEMPT_FUNCTIONS`: requestExit,
 * claimEscrowed). Those are still checked against the bundled list, so a listed address is still
 * refused, but a stale list does not block them. The CTO decided this on 2026-09-24. Freezing
 * every member's exit in this UI because the team's monthly list refresh slipped is a
 * self-inflicted withdrawal freeze. It also buys no control, because `requestExit` and
 * `claimEscrowed` are callable on the contract directly and this check is front-end only.
 * `now` is test-only: production call sites never pass it, so this always reads the real clock
 * there.
 */
export const STALE_LIST_EXEMPT_FUNCTIONS: ReadonlySet<string> = new Set(['requestExit', 'claimEscrowed']);

export function assertNotSanctioned(address: string | null | undefined, now?: number, functionName?: string): void {
  const exempt = functionName !== undefined && STALE_LIST_EXEMPT_FUNCTIONS.has(functionName);
  if (!exempt && sdnListAgeDays(now) > SDN_LIST_MAX_AGE_DAYS) throw new SanctionsListStaleError();
  if (isSanctionedAddress(address)) throw new SanctionsRefusalError();
}
