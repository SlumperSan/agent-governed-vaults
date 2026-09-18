/**
 * The built page says what `src/copy.ts` says, and says nothing it must not.
 *
 * IT READS `dist/index.html`, NOT THE SOURCE. A guard that reads the components proves the strings
 * exist in a file; it does not prove they reached the page. The prerender is where a section can
 * silently render empty, so the built artefact is the thing under test. `npm run build --workspace
 * apps/site` must run first — `scripts/gate.mjs` orders it that way and CI mirrors it.
 *
 * FOUR TESTS, DELIBERATELY. An earlier draft had seven; three were cut because the operator wording
 * and the advice/forecast shapes are ALREADY enforced on every public surface, including this page's
 * dist/, by `scripts/test/claims-lede-truth.test.mjs`, and a second implementation of one rule
 * drifts from the first. What remains is what nothing else in the repository would report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PAGE = path.join(APP, 'dist', 'index.html');
const COPY = path.join(APP, 'src', 'copy.ts');

const BUILT = existsSync(PAGE);
const SKIP = 'dist/index.html is not built. Run `npm run build --workspace apps/site` first.';
const t = (name, fn) => test(name, BUILT ? {} : { skip: SKIP }, fn);

const html = () => readFileSync(PAGE, 'utf8');

/**
 * The copy source with comments stripped.
 *
 * STRIPPING THEM IS LOAD-BEARING, not tidiness. copy.ts opens with a prose header, and prose
 * contains apostrophes — "the operator's lack of power". A quote scan treats that apostrophe as the
 * start of a literal and swallows the header as one enormous "sentence" that never appears on the
 * page, reddening this file for the wrong reason. That happened on the first run.
 */
const copySource = () =>
  readFileSync(COPY, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

/** renderToString escapes text children, so compare against the bytes that actually land. */
const esc = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

t('the page is PRERENDERED, not an empty shell waiting for JavaScript', () => {
  const h = html();
  assert.doesNotMatch(
    h,
    /<div id="root"><\/div>/,
    'the root div is empty: the prerender did not run, and every check below would be reading a shell'
  );
  assert.ok(
    h.length > 6000,
    `the built page is only ${h.length} bytes. It carries five sections and should be far longer — ` +
      'something rendered empty.'
  );
});

t('every sentence in copy.ts reaches the built page', () => {
  // Pulled out of the source rather than re-typed here: a copy of the copy is a second place for it
  // to drift, and this file would then pin the drift instead of catching it.
  //
  // EXTRACTED PER LINE, and that is not a style choice. A whole-file scan for quoted runs cannot
  // tell a closing quote from an opening one, so it matches from the end of one string to the start
  // of the next and reports the punctuation between them as missing copy. Within one line the
  // quotes pair correctly, and every literal in copy.ts opens and closes on a single line: the long
  // sentences are concatenated with `+`, one fragment per line, and each fragment has to reach the
  // page on its own regardless.
  const lines = copySource().split(/\r?\n/);
  const strings = lines
    .flatMap((line) => [...line.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]))
    .map((s) => s.replace(/\\'/g, "'"))
    .filter((s) => s.length >= 25 && !s.includes('://'));

  assert.ok(
    strings.length >= 12,
    `only ${strings.length} copy strings found — the extractor has stopped working, and this test ` +
      'would pass by checking almost nothing'
  );

  const h = html();
  const missing = strings.filter((s) => !h.includes(esc(s)));
  assert.deepEqual(missing, [], `copy that never reached the page:\n  ${missing.join('\n  ')}`);
});

t('the page does not claim a deployment it does not have', () => {
  const h = html().toLowerCase();
  for (const banned of ['is deployed on', 'now live on', 'deployed on arc', 'live on arc']) {
    assert.ok(!h.includes(banned), `the page claims a deployment: "${banned}". Nothing is deployed.`);
  }
  assert.ok(html().includes('not yet deployed'), 'the page must say plainly that it is not deployed');
});

t('the product phrase survives as ONE contiguous string in the rendered HTML', () => {
  // THIS TEST EXISTS BECAUSE THE PAGE ONCE FAILED IT. The hero headline wrapped one word in an <em>
  // to colour it gold. That split `the AI agent trading index` across elements in the built HTML,
  // so the by-name exemption in scripts/test/claims-lede-truth.test.mjs stopped matching and the
  // page was reported for claiming an AI agent trades — which it does not.
  //
  // The accent is a CSS gradient on the h1 now. If anyone reaches for markup to style a word of this
  // phrase again, it goes red HERE, rather than three files away in a guard whose message points at
  // a claim nobody made.
  assert.match(
    html(),
    /AI agent trading index/,
    'the product phrase is broken up by markup in the rendered HTML; style it with CSS, not with an ' +
      'element inside the headline'
  );
});
