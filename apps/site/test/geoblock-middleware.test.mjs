// @ts-check
/**
 * Card 212 — the sanctions-jurisdiction geofence in `functions/_middleware.js`. That file has no
 * imports of its own, so unlike most `.ts`/`.tsx` wiring in this repo it is a real, directly
 * importable ES module under plain `node --test` — this is a live behavioral test, not a source
 * guard, and the MUTATION test below actually re-executes a mutated copy of the real source rather
 * than re-typing a fixture by hand.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSanctionedRequest } from '../functions/_middleware.js';

const APP = fileURLToPath(new URL('..', import.meta.url));
const MIDDLEWARE_PATH = join(APP, 'functions/_middleware.js');
const MIDDLEWARE_SRC = readFileSync(MIDDLEWARE_PATH, 'utf8');

// ─────────────────────────────────── blocked: countries ───────────────────────────────────

for (const [code, program] of [
  ['CU', 'Cuba'],
  ['IR', 'Iran'],
  ['KP', 'North Korea'],
]) {
  test(`isSanctionedRequest: blocks cf.country === '${code}' (${program})`, () => {
    assert.equal(isSanctionedRequest({ country: code }), true);
  });
}

// ─────────────────────────────────── blocked: Ukraine regions ───────────────────────────────────

for (const [regionCode, area] of [
  ['43', 'Crimea'],
  ['UA-43', 'Crimea (prefixed form)'],
  ['40', 'Sevastopol'],
  ['14', 'Donetsk ("DNR")'],
  ['09', 'Luhansk ("LNR")'],
]) {
  test(`isSanctionedRequest: blocks cf.country === 'UA' with cf.regionCode === '${regionCode}' (${area})`, () => {
    assert.equal(isSanctionedRequest({ country: 'UA', regionCode }), true);
  });
}

test('isSanctionedRequest: does NOT block Ukraine outside the listed region codes — the rest of Ukraine is not comprehensively sanctioned', () => {
  assert.equal(isSanctionedRequest({ country: 'UA', regionCode: '30' }), false); // Kyiv city
  assert.equal(isSanctionedRequest({ country: 'UA' }), false); // no regionCode at all
});

// ─────────────────────────────────── allowed ───────────────────────────────────

test('isSanctionedRequest: allows an ordinary country', () => {
  assert.equal(isSanctionedRequest({ country: 'US' }), false);
  assert.equal(isSanctionedRequest({ country: 'DE' }), false);
});

test('isSanctionedRequest: Syria (SY) is deliberately NOT blocked — OFAC replaced the comprehensive Syria program with the targeted PAARSS program in 2025', () => {
  assert.equal(isSanctionedRequest({ country: 'SY' }), false);
});

// ─────────────────────────────────── missing cf: explicit, documented fail-closed ───────────────────────────────────

test('isSanctionedRequest: a MISSING cf object is blocked (fail closed) — an explicit decision, not a silent allow', () => {
  assert.equal(isSanctionedRequest(undefined), true);
  assert.equal(isSanctionedRequest(null), true);
});

test('the fail-closed decision for missing cf is documented in the source, not just in this test', () => {
  assert.match(MIDDLEWARE_SRC, /MISSING `cf` FAILS CLOSED/);
});

// ─────────────────────────────────── onRequest wiring ───────────────────────────────────

test('onRequest returns HTTP 451 for a blocked request, before the canonical-host redirect runs', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const request = new Request('https://rwally.pages.dev/', { headers: {} });
  Object.defineProperty(request, 'cf', { value: { country: 'IR' } });
  const res = await onRequest({ request, next: async () => new Response('should not reach here') });
  assert.equal(res.status, 451);
  const body = await res.text();
  assert.match(body, /This restriction applies to this website\s*\nonly/s);
});

test('the 451 page says the screen is front-end-only and the Protocol is permissionless — no other claim', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const request = new Request('https://rwally.com/', {});
  Object.defineProperty(request, 'cf', { value: { country: 'CU' } });
  const res = await onRequest({ request, next: async () => new Response('unused') });
  const body = await res.text();
  assert.match(body, /permissionless/);
  assert.doesNotMatch(body, /Cuba|Iran|North Korea|Crimea|Donetsk|Luhansk/);
});

test('onRequest still applies the canonical-host redirect for an allowed request', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const request = new Request('https://rwally.pages.dev/about.html', {});
  Object.defineProperty(request, 'cf', { value: { country: 'US' } });
  let nextCalled = false;
  const res = await onRequest({ request, next: async () => { nextCalled = true; return new Response('ok'); } });
  assert.equal(nextCalled, false, 'a non-canonical host must redirect, not call next()');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://rwally.com/about.html');
});

test('onRequest calls next() for an allowed request already on the canonical host', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const request = new Request('https://rwally.com/about.html', {});
  Object.defineProperty(request, 'cf', { value: { country: 'US' } });
  let nextCalled = false;
  const res = await onRequest({ request, next: async () => { nextCalled = true; return new Response('ok'); } });
  assert.equal(nextCalled, true);
  assert.equal(res.status, 200);
});

// ─────────────────────────────────── MUTATION ───────────────────────────────────

/** Re-executes a mutated copy of the REAL source (not a hand-typed fixture) as a data: URI module,
 *  so this proves something about the actual file rather than about a re-typed lookalike. */
async function importMutated(sourceTransform) {
  const mutated = sourceTransform(MIDDLEWARE_SRC);
  const encoded = `data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`;
  return import(encoded);
}

test('MUTATION: removing Cuba (CU) from SANCTIONED_COUNTRIES lets a Cuba-geolocated request through', async () => {
  const mutated = await importMutated((src) => {
    const before = src;
    const after = src.replace("'CU', // Cuba Sanctions\n  ", '');
    assert.notEqual(after, before, 'replacement did not match — did the source formatting change?');
    return after;
  });
  assert.equal(mutated.isSanctionedRequest({ country: 'CU' }), false, 'RED: with CU removed, a Cuba request must no longer be blocked — proves the real per-country test above is live, not vacuous');
  // The other two listed countries are untouched by this one mutation.
  assert.equal(mutated.isSanctionedRequest({ country: 'IR' }), true);
});

test('MUTATION: removing Crimea (43/UA-43) from SANCTIONED_UA_REGION_CODES lets a Crimea-geolocated request through', async () => {
  const mutated = await importMutated((src) => {
    const before = src;
    const after = src.replace("'43', 'UA-43', // Crimea (Avtonomna Respublika Krym)\n  ", '');
    assert.notEqual(after, before, 'replacement did not match — did the source formatting change?');
    return after;
  });
  assert.equal(mutated.isSanctionedRequest({ country: 'UA', regionCode: '43' }), false, 'RED: with Crimea removed, that region must no longer be blocked');
  assert.equal(mutated.isSanctionedRequest({ country: 'UA', regionCode: '14' }), true, 'Donetsk is untouched by this one mutation');
});

test('MUTATION: inverting the missing-cf fail-closed decision to fail OPEN is caught', async () => {
  const mutated = await importMutated((src) => {
    const before = src;
    const after = src.replace('if (!cf) return true;', 'if (!cf) return false;');
    assert.notEqual(after, before, 'replacement did not match — did the source formatting change?');
    return after;
  });
  assert.equal(mutated.isSanctionedRequest(undefined), false, 'RED: a fail-open mutation must show cf-missing no longer blocking — proves the real fail-closed test above is live');
});
