// @ts-check
/**
 * Card 212 — the sanctions-jurisdiction geofence in `functions/_middleware.js` for the member
 * surface. Same shape as `apps/site/test/geoblock-middleware.test.mjs`; kept as its own file (not
 * imported from the sibling project) because the two `_middleware.js` files are intentionally
 * separate copies — see this app's `functions/_middleware.js` header for why, and
 * `scripts/test/sanctioned-jurisdictions-sync.test.mjs` (repo root) for the guard that keeps the
 * two copies of the constants from drifting apart.
 *
 * Real behavioral tests, not source guards: `functions/_middleware.js` has no imports of its own,
 * so it is directly importable under plain `node --test`.
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

test('isSanctionedRequest: does NOT block Ukraine outside the listed region codes', () => {
  assert.equal(isSanctionedRequest({ country: 'UA', regionCode: '30' }), false); // Kyiv city
  assert.equal(isSanctionedRequest({ country: 'UA' }), false);
});

// ─────────────────────────────────── allowed ───────────────────────────────────

test('isSanctionedRequest: allows an ordinary country', () => {
  assert.equal(isSanctionedRequest({ country: 'US' }), false);
  assert.equal(isSanctionedRequest({ country: 'DE' }), false);
});

test('isSanctionedRequest: Syria (SY) is deliberately NOT blocked', () => {
  assert.equal(isSanctionedRequest({ country: 'SY' }), false);
});

// ─────────────────────────────────── missing cf: fail closed ───────────────────────────────────

test('isSanctionedRequest: a MISSING cf object is blocked (fail closed)', () => {
  assert.equal(isSanctionedRequest(undefined), true);
  assert.equal(isSanctionedRequest(null), true);
});

// ─────────────────────────────────── onRequest wiring (no canonical-host redirect here) ───────────────────────────────────

test('onRequest returns HTTP 451 for a blocked request', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const request = new Request('https://app.rwally.com/', {});
  Object.defineProperty(request, 'cf', { value: { country: 'KP' } });
  let nextCalled = false;
  const res = await onRequest({ request, next: async () => { nextCalled = true; return new Response('should not reach here'); } });
  assert.equal(res.status, 451);
  assert.equal(nextCalled, false);
});

test('onRequest calls next() for an allowed request', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const request = new Request('https://app.rwally.com/', {});
  Object.defineProperty(request, 'cf', { value: { country: 'US' } });
  let nextCalled = false;
  const res = await onRequest({ request, next: async () => { nextCalled = true; return new Response('ok'); } });
  assert.equal(nextCalled, true);
  assert.equal(res.status, 200);
});

test('the 451 page says front-end-only, permissionless, and names no specific jurisdiction', async () => {
  const { onRequest } = await import('../functions/_middleware.js');
  const request = new Request('https://app.rwally.com/', {});
  Object.defineProperty(request, 'cf', { value: { country: 'CU' } });
  const res = await onRequest({ request, next: async () => new Response('unused') });
  const body = await res.text();
  assert.match(body, /permissionless/);
  assert.doesNotMatch(body, /Cuba|Iran|North Korea|Crimea|Donetsk|Luhansk/);
});

// ─────────────────────────────────── MUTATION ───────────────────────────────────

async function importMutated(sourceTransform) {
  const mutated = sourceTransform(MIDDLEWARE_SRC);
  const encoded = `data:text/javascript;base64,${Buffer.from(mutated, 'utf8').toString('base64')}`;
  return import(encoded);
}

test('MUTATION: removing North Korea (KP) from SANCTIONED_COUNTRIES lets a KP-geolocated request through', async () => {
  const mutated = await importMutated((src) => {
    const before = src;
    const after = src.replace("'KP', // North Korea Sanctions\n]", ']');
    assert.notEqual(after, before, 'replacement did not match — did the source formatting change?');
    return after;
  });
  assert.equal(mutated.isSanctionedRequest({ country: 'KP' }), false, 'RED: with KP removed, a North Korea request must no longer be blocked');
  assert.equal(mutated.isSanctionedRequest({ country: 'IR' }), true);
});

test('MUTATION: removing Luhansk (09/UA-09) lets that region through', async () => {
  const mutated = await importMutated((src) => {
    const before = src;
    const after = src.replace("'09', 'UA-09', // Luhansk oblast (so-called \"LNR\")\n]", ']');
    assert.notEqual(after, before, 'replacement did not match — did the source formatting change?');
    return after;
  });
  assert.equal(mutated.isSanctionedRequest({ country: 'UA', regionCode: '09' }), false, 'RED: with Luhansk removed, it must no longer be blocked');
});

test('MUTATION: inverting the missing-cf fail-closed decision to fail OPEN is caught', async () => {
  const mutated = await importMutated((src) => {
    const before = src;
    const after = src.replace('if (!cf) return true;', 'if (!cf) return false;');
    assert.notEqual(after, before, 'replacement did not match — did the source formatting change?');
    return after;
  });
  assert.equal(mutated.isSanctionedRequest(undefined), false, 'RED: a fail-open mutation must show cf-missing no longer blocking');
});

test('MUTATION: an onRequest that skips the sanctions check entirely is caught', async () => {
  const mutated = await importMutated((src) => {
    const before = src;
    const after = src.replace(
      'export const onRequest = async (context) => {\n  const { request, next } = context;\n  if (isSanctionedRequest(request.cf)) return sanctionsBlockedResponse();\n  return next();\n};',
      'export const onRequest = async (context) => {\n  const { request, next } = context;\n  return next();\n};',
    );
    assert.notEqual(after, before, 'replacement did not match — did onRequest\'s source formatting change?');
    return after;
  });
  const request = new Request('https://app.rwally.com/', {});
  Object.defineProperty(request, 'cf', { value: { country: 'KP' } });
  let nextCalled = false;
  const res = await mutated.onRequest({ request, next: async () => { nextCalled = true; return new Response('reached'); } });
  assert.equal(nextCalled, true, 'RED: with the check stripped from onRequest, a KP request must reach next() unblocked');
  assert.equal(res.status, 200);
});
