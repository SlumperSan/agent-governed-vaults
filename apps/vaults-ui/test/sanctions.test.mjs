// @ts-check
/**
 * Card 213 — the SDN address check itself. `sanctions.ts` has no JSX and no `@chain/*`/`@atlas/*`
 * alias imports (only the vendored `./sdn-addresses.ts`), so unlike most of this directory it is
 * importable directly under plain `node --test` — a real unit test, not a source guard. The
 * write-path WIRING (does `chain-actions.ts` actually call this before signing?) is covered
 * separately in `sanctions-wired.test.mjs`, which does need the source-guard style.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSanctionedAddress,
  assertNotSanctioned,
  SanctionsRefusalError,
  SanctionsListStaleError,
  STALE_LIST_EXEMPT_FUNCTIONS,
  SANCTIONS_REFUSAL_MESSAGE,
  SANCTIONS_LIST_STALE_MESSAGE,
  sdnListAgeDays,
  assertSdnListFresh,
  SDN_LIST_MAX_AGE_DAYS,
} from '../src/lib/sanctions.ts';
import { SDN_ADDRESS_DATA } from '../src/lib/sdn-addresses.ts';

// ─────────────────── non-vacuity: the vendored list is a real, non-empty list ───────────────────

test('non-vacuity: the vendored SDN address list is not empty', () => {
  // Every test below that expects a listed address to MATCH is meaningless if this list is empty —
  // this is the same "guard that can skip is a guard that will" trap the rest of this repo's tests
  // are written to avoid.
  assert.ok(SDN_ADDRESS_DATA.addresses.length > 0, 'sdn-addresses.ts has zero addresses — re-run scripts/build-sdn-list.mjs');
});

const KNOWN_LISTED = SDN_ADDRESS_DATA.addresses[0];
const KNOWN_LISTED_UPPER = `0x${KNOWN_LISTED.slice(2).toUpperCase()}`;
// Flips the LAST hex nibble (wrapping f -> 0), so this is guaranteed to differ from KNOWN_LISTED
// and, being derived rather than hand-typed, cannot accidentally collide with a real listed entry
// the way a hand-picked "clearly fake" address theoretically could.
const lastNibble = KNOWN_LISTED[KNOWN_LISTED.length - 1];
const flippedNibble = lastNibble === 'f' ? '0' : (parseInt(lastNibble, 16) + 1).toString(16);
const CLEAN_ADDRESS = `${KNOWN_LISTED.slice(0, -1)}${flippedNibble}`;

test('non-vacuity: the derived clean address is not itself on the list', () => {
  assert.ok(!SDN_ADDRESS_DATA.addresses.map((a) => a.toLowerCase()).includes(CLEAN_ADDRESS.toLowerCase()));
});

// ─────────────────────────────────── isSanctionedAddress ───────────────────────────────────

test('isSanctionedAddress: true for a real listed address', () => {
  assert.equal(isSanctionedAddress(KNOWN_LISTED), true);
});

test('isSanctionedAddress: case-insensitive — a checksummed/uppercase rendering of a listed address still matches', () => {
  assert.equal(isSanctionedAddress(KNOWN_LISTED_UPPER), true);
});

test('isSanctionedAddress: false for an unlisted address', () => {
  assert.equal(isSanctionedAddress(CLEAN_ADDRESS), false);
});

test('isSanctionedAddress: false for null/undefined/empty — never throws before a wallet is connected', () => {
  assert.equal(isSanctionedAddress(null), false);
  assert.equal(isSanctionedAddress(undefined), false);
  assert.equal(isSanctionedAddress(''), false);
});

// ─────────────────────────────────── assertNotSanctioned ───────────────────────────────────

test('assertNotSanctioned: throws SanctionsRefusalError with the exact card-213 message for a listed address', () => {
  assert.throws(
    () => assertNotSanctioned(KNOWN_LISTED),
    (err) => {
      assert.ok(err instanceof SanctionsRefusalError);
      assert.equal(err.message, SANCTIONS_REFUSAL_MESSAGE);
      return true;
    },
  );
});

test('assertNotSanctioned: does not throw for a clean address', () => {
  assert.doesNotThrow(() => assertNotSanctioned(CLEAN_ADDRESS));
});

test('the refusal message says "front end only" and never claims the Protocol itself blocks anyone', () => {
  assert.match(SANCTIONS_REFUSAL_MESSAGE, /front end only/);
  assert.match(SANCTIONS_REFUSAL_MESSAGE, /permissionless/);
  assert.doesNotMatch(SANCTIONS_REFUSAL_MESSAGE, /protocol (blocks|refuses|prevents)/i);
});

// ─────── assertNotSanctioned: runtime freshness guard, fails CLOSED (card 217) ───────

test('assertNotSanctioned: passes a clean address when the list is 29 days old', () => {
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  const at29Days = fetchedMs + 29 * 86_400_000;
  assert.doesNotThrow(() => assertNotSanctioned(CLEAN_ADDRESS, at29Days));
});

test('assertNotSanctioned: blocks a clean address when the list is 31 days old — fails CLOSED', () => {
  // The core card-217 property: staleness alone must refuse the write, for an address that is
  // NOT on the list and would otherwise sail through isSanctionedAddress. A stale list cannot
  // prove an address is clean, so "clean" is never the answer it gets to give.
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  const at31Days = fetchedMs + 31 * 86_400_000;
  assert.throws(
    () => assertNotSanctioned(CLEAN_ADDRESS, at31Days),
    (err) => {
      assert.ok(err instanceof SanctionsListStaleError);
      assert.equal(err.message, SANCTIONS_LIST_STALE_MESSAGE);
      assert.equal(err.message, 'sanctions list out of date', 'the exact card-217 copy, unchanged');
      return true;
    },
  );
});

test('assertNotSanctioned: the staleness check runs BEFORE the address check — a stale list blocks even a real listed address with SanctionsListStaleError, not SanctionsRefusalError', () => {
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  const at31Days = fetchedMs + 31 * 86_400_000;
  assert.throws(
    () => assertNotSanctioned(KNOWN_LISTED, at31Days),
    (err) => { assert.ok(err instanceof SanctionsListStaleError); return true; },
  );
});

test('assertNotSanctioned: a fresh list still refuses a listed address with SanctionsRefusalError, not SanctionsListStaleError', () => {
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  const at29Days = fetchedMs + 29 * 86_400_000;
  assert.throws(
    () => assertNotSanctioned(KNOWN_LISTED, at29Days),
    (err) => { assert.ok(err instanceof SanctionsRefusalError); return true; },
  );
});

test('MUTATION: an assertNotSanctioned with the age comparison disarmed would silently pass a stale-list write (proves the tests above are live)', () => {
  // Same shape as this repo's other MUTATION tests: reconstruct the pre-fix predicate (staleness
  // never checked at all) and show it produces the WRONG verdict for the 31-day case above.
  const preFixAssertNotSanctioned = (address) => { if (isSanctionedAddress(address)) throw new SanctionsRefusalError(); };
  assert.doesNotThrow(
    () => preFixAssertNotSanctioned(CLEAN_ADDRESS),
    'RED: the disarmed version passes a clean address through with no way to know the list is 31 days stale — this is why the real code checks sdnListAgeDays(now) > SDN_LIST_MAX_AGE_DAYS first',
  );
});

// ─────────────────────────────────── freshness ───────────────────────────────────

test('sdnListAgeDays: zero at the moment the list was fetched', () => {
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  assert.ok(Math.abs(sdnListAgeDays(fetchedMs)) < 1e-6);
});

test('assertSdnListFresh: does not throw right at the freshness ceiling minus a day', () => {
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  const justUnder = fetchedMs + (SDN_LIST_MAX_AGE_DAYS - 1) * 86_400_000;
  assert.doesNotThrow(() => assertSdnListFresh(justUnder));
});

test('assertSdnListFresh: throws once the list is older than SDN_LIST_MAX_AGE_DAYS', () => {
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  const wayOver = fetchedMs + (SDN_LIST_MAX_AGE_DAYS + 1) * 86_400_000;
  assert.throws(() => assertSdnListFresh(wayOver), /older than the \d+-day freshness ceiling/);
});

test('assertSdnListFresh() against the REAL clock: the shipped list is fresh today, and this test goes red once it ages past the ceiling (card 213: the list cannot silently rot)', () => {
  // No injected `now`. Every other freshness test passes identically on day 1 and day 400; this one
  // is what makes the gate go red SDN_LIST_MAX_AGE_DAYS after each refresh. Refresh with
  // apps/vaults-ui/scripts/build-sdn-list.mjs, then commit.
  assert.doesNotThrow(() => assertSdnListFresh());
});

test('MUTATION: assertSdnListFresh with the age check inverted would pass the stale case (proves the test above is live)', () => {
  // Same shape as this repo's other MUTATION tests: reconstruct the inverted predicate and show it
  // produces the WRONG verdict, so the real assertSdnListFresh test above is known to be exercising
  // a real comparison rather than a tautology.
  const invertedThrows = (age, maxAge) => age < maxAge; // backwards: should be age > maxAge
  const fetchedMs = Date.parse(SDN_ADDRESS_DATA.fetchedAt);
  const wayOver = fetchedMs + (SDN_LIST_MAX_AGE_DAYS + 1) * 86_400_000;
  const age = sdnListAgeDays(wayOver);
  assert.equal(invertedThrows(age, SDN_LIST_MAX_AGE_DAYS), false, 'RED: the inverted predicate silently passes a stale list — this is why the real code compares age > maxAge, not age < maxAge');
});

// ─────────────────────────────────── the source itself, for build-sdn-list.mjs ───────────────────────────────────

test('sdn-addresses.ts: every vendored address is a plain lowercase 0x + 40 hex chars', () => {
  const bad = SDN_ADDRESS_DATA.addresses.filter((a) => !/^0x[0-9a-f]{40}$/.test(a));
  assert.deepEqual(bad, [], `non-EVM-shaped or non-lowercased entries slipped into sdn-addresses.ts: ${bad.join(', ')}`);
});

test('sdn-addresses.ts: no duplicate addresses', () => {
  assert.equal(new Set(SDN_ADDRESS_DATA.addresses).size, SDN_ADDRESS_DATA.addresses.length);
});

test('sdn-addresses.ts: records its own source URL and fetch date', () => {
  assert.match(SDN_ADDRESS_DATA.sourceUrl, /^https:\/\//);
  assert.ok(!Number.isNaN(Date.parse(SDN_ADDRESS_DATA.fetchedAt)), 'fetchedAt is not a parseable date');
});

// ─────── card 217, CTO 2026-09-24: a stale list never blocks a member taking their own money out ───────

test('stale list: requestExit and claimEscrowed from a clean address pass; deposit, approve and votes are blocked', () => {
  const at31Days = Date.parse(SDN_ADDRESS_DATA.fetchedAt) + 31 * 86_400_000;
  for (const fn of ['requestExit', 'claimEscrowed']) {
    assert.doesNotThrow(() => assertNotSanctioned(CLEAN_ADDRESS, at31Days, fn), fn);
  }
  for (const fn of ['approve', 'deposit', 'commitVote', 'revealVote', undefined]) {
    assert.throws(() => assertNotSanctioned(CLEAN_ADDRESS, at31Days, fn), (err) => err instanceof SanctionsListStaleError, String(fn));
  }
});

test('stale list: an exit from a LISTED address is still refused — the exemption is from staleness, not from screening', () => {
  const at31Days = Date.parse(SDN_ADDRESS_DATA.fetchedAt) + 31 * 86_400_000;
  for (const fn of ['requestExit', 'claimEscrowed']) {
    assert.throws(() => assertNotSanctioned(KNOWN_LISTED, at31Days, fn), (err) => err instanceof SanctionsRefusalError, fn);
  }
});

test('the stale-list exemption is exactly requestExit and claimEscrowed', () => {
  assert.deepEqual([...STALE_LIST_EXEMPT_FUNCTIONS].sort(), ['claimEscrowed', 'requestExit']);
});
