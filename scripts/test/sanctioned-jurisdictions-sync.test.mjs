// @ts-check
/**
 * Card 212 keeps two copies of the sanctioned-jurisdiction lists — one in
 * `apps/site/functions/_middleware.js`, one in `apps/vaults-ui/functions/_middleware.js` — rather
 * than a shared import, because the two are independently-bundled Cloudflare Pages projects (see
 * either file's own header for why a cross-project relative import was rejected). "A single
 * constant, verified against OFAC's current programs" (card 212's own words) then has to be
 * enforced BETWEEN the two files rather than by there being only one file, which is what this guard
 * does: extract each file's `SANCTIONED_COUNTRIES`/`SANCTIONED_UA_REGION_CODES` literal and assert
 * they are identical, AND that they match the exact set this test itself hardcodes as the
 * currently-approved list — so a change to either middleware file that drifts from the other, or
 * from what was actually researched and approved, reds here rather than silently shipping two
 * different geofences under one name.
 *
 * THE APPROVED LIST, AND ITS CITATION. Verified directly against OFAC's own live "Sanctions
 * Programs and Country Information" page (https://ofac.treasury.gov/sanctions-programs-and-country-information,
 * read 2026-09-23) — not copied from this repo's own older notes
 * (`Business/Legal/Jurisdiction and Geofence Options.md`), which still lists Syria. OFAC's current
 * "Active Sanctions Programs" table carries no "Syria Sanctions" program: the former country-wide
 * Syrian Sanctions Regulations were replaced in 2025, after the fall of the Assad government, by
 * "Promoting Accountability for Assad and Regional Stabilization Sanctions" (PAARSS) — a targeted,
 * list-based program, not a comprehensive embargo, so Syria is deliberately absent below. Crimea
 * and the so-called "DNR"/"LNR" areas of Ukraine remain comprehensively embargoed under the
 * "Ukraine-/Russia-related Sanctions" program (EO 13685, EO 14065) independently of the rest of
 * Ukraine, which is not comprehensively sanctioned.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SITE_MIDDLEWARE = readFileSync(join(ROOT, 'apps/site/functions/_middleware.js'), 'utf8');
const VAULTS_UI_MIDDLEWARE = readFileSync(join(ROOT, 'apps/vaults-ui/functions/_middleware.js'), 'utf8');

/** Pulls the quoted-string entries out of a `const NAME = new Set([ ... ]);` block, in order. */
function extractSetLiteral(src, constName) {
  const re = new RegExp(`const ${constName} = new Set\\(\\[([\\s\\S]*?)\\]\\);`);
  const m = re.exec(src);
  assert.ok(m, `${constName} not found as a "const ${constName} = new Set([...]);" block`);
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

// The approved list, hardcoded here so drift from EITHER middleware file is visible against it,
// not just against each other (two files agreeing with each other while both having drifted from
// what was actually researched would otherwise pass silently).
const APPROVED_COUNTRIES = ['CU', 'IR', 'KP'];
const APPROVED_UA_REGION_CODES = ['43', 'UA-43', '40', 'UA-40', '14', 'UA-14', '09', 'UA-09'];

for (const [label, src] of [
  ['apps/site', SITE_MIDDLEWARE],
  ['apps/vaults-ui', VAULTS_UI_MIDDLEWARE],
]) {
  test(`${label}/functions/_middleware.js: SANCTIONED_COUNTRIES matches the approved list exactly`, () => {
    assert.deepEqual(extractSetLiteral(src, 'SANCTIONED_COUNTRIES'), APPROVED_COUNTRIES);
  });

  test(`${label}/functions/_middleware.js: SANCTIONED_UA_REGION_CODES matches the approved list exactly`, () => {
    assert.deepEqual(extractSetLiteral(src, 'SANCTIONED_UA_REGION_CODES'), APPROVED_UA_REGION_CODES);
  });

  test(`${label}/functions/_middleware.js: does not list Syria (SY) as a blocked country`, () => {
    assert.ok(!extractSetLiteral(src, 'SANCTIONED_COUNTRIES').includes('SY'), 'Syria is no longer comprehensively sanctioned by OFAC as of 2025 — see this file\'s header');
  });
}

test('the two middleware files agree with each other, not just with the hardcoded approved list', () => {
  assert.deepEqual(
    extractSetLiteral(SITE_MIDDLEWARE, 'SANCTIONED_COUNTRIES'),
    extractSetLiteral(VAULTS_UI_MIDDLEWARE, 'SANCTIONED_COUNTRIES'),
  );
  assert.deepEqual(
    extractSetLiteral(SITE_MIDDLEWARE, 'SANCTIONED_UA_REGION_CODES'),
    extractSetLiteral(VAULTS_UI_MIDDLEWARE, 'SANCTIONED_UA_REGION_CODES'),
  );
});

test('MUTATION: one file drifting by a single country is caught', () => {
  const drifted = VAULTS_UI_MIDDLEWARE.replace("'KP', // North Korea Sanctions\n", '');
  assert.notEqual(drifted, VAULTS_UI_MIDDLEWARE, 'replacement did not match — did the source formatting change?');
  assert.notDeepEqual(
    extractSetLiteral(SITE_MIDDLEWARE, 'SANCTIONED_COUNTRIES'),
    extractSetLiteral(drifted, 'SANCTIONED_COUNTRIES'),
    'RED: removing one country from one copy must be visible as a mismatch between the two files',
  );
});

test('non-vacuity: both lists actually have entries (an empty Set would make every test above pass vacuously)', () => {
  assert.ok(APPROVED_COUNTRIES.length >= 3);
  assert.ok(APPROVED_UA_REGION_CODES.length >= 4);
});
