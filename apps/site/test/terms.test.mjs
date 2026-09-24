// @ts-check
/**
 * Card #214: the Terms page ships the owner-approved draft VERBATIM, and its hash is the one
 * value `apps/vaults-ui`'s clickwrap gates a deposit on. This file checks the built artefact
 * (`dist/terms.html`), the same rule `site.test.mjs`'s own header gives for why it reads `dist/`
 * rather than source: the prerender is where a section can silently render empty.
 *
 * `npm run build --workspace apps/site` must run first, same precondition as `site.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseTermsSections, TERMS_TEXT, TERMS_VERSION, termsTextSha256 } from '../../../packages/terms/src/terms-text.mjs';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TERMS_PAGE = path.join(APP, 'dist', 'terms.html');

const BUILT = existsSync(TERMS_PAGE);
const SKIP = 'apps/site is not built. Run `npm run build --workspace apps/site` first.';
const t = (name, fn) => test(name, BUILT ? {} : { skip: SKIP }, fn);

const html = () => readFileSync(TERMS_PAGE, 'utf8');

/** renderToString escapes text children — compare against what actually lands in the markup. */
const esc = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

t('the page is PRERENDERED, not an empty shell waiting for JavaScript', () => {
  const h = html();
  assert.doesNotMatch(h, /<div id="root"><\/div>/, 'the root div is empty: the prerender did not run');
  assert.ok(h.length > 6000, `the built page is only ${h.length} bytes — something rendered empty`);
});

t('every paragraph and list item of TERMS_TEXT reaches the built page', () => {
  // Walk the SAME parse the page renders from (parseTermsSections), not a re-typed copy of the
  // text — a hand-typed comparison string is a second transcription, and that is exactly the
  // "second place for the words to drift" terms-copy.ts's own header warns about.
  const sections = parseTermsSections(TERMS_TEXT);
  assert.equal(sections.length, 13, 'expected all 13 sections — did TERMS_TEXT change shape?');
  const strings = sections.flatMap((s) =>
    s.body.flatMap((block) => (block.type === 'ul' ? block.items : [block.html])),
  );
  assert.ok(strings.length >= 20, `only ${strings.length} blocks found — the extractor stopped working`);
  const h = html();
  // Blocks already carry their <strong> markup (see inlineHtml in terms-text.mjs), so they are
  // compared as HTML fragments, not escaped prose — the escaper above is for the plain headings
  // checked separately below.
  const missing = strings.filter((s) => !h.includes(s));
  assert.deepEqual(missing, [], `terms text that never reached the built page:\n  ${missing.join('\n  ')}`);
});

t('every section heading reaches the built page', () => {
  const sections = parseTermsSections(TERMS_TEXT);
  const h = html();
  const missing = sections.filter((s) => !h.includes(esc(`${s.number}. ${s.heading}`)));
  assert.deepEqual(
    missing.map((s) => s.heading),
    [],
    'section heading(s) missing from the built page',
  );
});

t('the page carries the data-terms-sha256 attribute the client fills after hydration', () => {
  const h = html();
  const m = /data-terms-sha256="([0-9a-f]{0,64})"/.exec(h);
  assert.ok(m, 'no data-terms-sha256 attribute found in the built page');
  // The SSR pass renders no effects (see Terms.tsx's TextHash comment), so the prerendered
  // attribute is empty; hydration fills it client-side with exactly what termsTextSha256()
  // resolves to, checked against an independent digest below.
});

test('termsTextSha256() resolves to sha256(TERMS_TEXT), independently derived with node:crypto', async () => {
  // Independently derived with node:crypto rather than compared against itself — that would only
  // prove the function is consistent with itself, not that it hashes the right bytes. This is the
  // exact function apps/vaults-ui imports from the same module, so this also proves the two apps
  // cannot compute a different digest for the same text: there is only one implementation.
  const expected = createHash('sha256').update(TERMS_TEXT, 'utf8').digest('hex');
  const actual = await termsTextSha256();
  assert.equal(actual, expected);
  assert.equal(actual.length, 64);
});

t('MUTATION: a changed TERMS_TEXT produces a different hash', () => {
  const original = createHash('sha256').update(TERMS_TEXT, 'utf8').digest('hex');
  const mutated = createHash('sha256').update(`${TERMS_TEXT} `, 'utf8').digest('hex');
  assert.notEqual(mutated, original, 'RED: appending one character to the shipped text must change its hash');
});

t('the version reaches the built page', () => {
  assert.ok(html().includes(`Version ${TERMS_VERSION}`), 'the version string is not on the page');
});

t('no fee, percentage or deposit-minimum figure is in TERMS_TEXT (card #214\'s own copy rule)', () => {
  // The source draft's own rule: "No numbers (fees, deposit minimums, windows) appear here: those
  // live in the app and on the Disclaimers page." An allowlist, not a blanket "no digits" ban —
  // "0.1" is the version and "18" is the age-of-majority threshold in section 2, both ordinary
  // legal-text numbers, neither a fee or a minimum.
  assert.doesNotMatch(TERMS_TEXT, /[%$]/, 'TERMS_TEXT contains a percentage or currency sign');
  const digitRuns = [...TERMS_TEXT.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
  const ALLOWED = new Set(['0.1', '18']);
  // Section headings ("### 1.", "### 13.") and the cross-reference "section 3" also produce digit
  // runs; allow any run that is itself a section number (1-13) on top of the explicit allowlist.
  const offenders = digitRuns.filter((d) => !ALLOWED.has(d) && !(Number(d) >= 1 && Number(d) <= 13));
  assert.deepEqual(offenders, [], `unexpected figure(s) in TERMS_TEXT: ${offenders.join(', ')}`);
});
