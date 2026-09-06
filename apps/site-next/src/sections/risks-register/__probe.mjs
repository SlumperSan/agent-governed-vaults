/**
 * risks-register probe — renders this section on its own and asserts, against
 * the emitted bytes, every check `apps/site/test/site.test.mjs` makes of the
 * risk register, plus a byte-for-byte diff of all fifteen entries against
 * `apps/site/risks.html`.
 *
 * WHY THIS EXISTS RATHER THAN `npm run build`. Nothing composes this section
 * into a page yet — `src/pages/` is Integrate's, and until RisksPage assembles
 * it, `dist/risks.html` contains not one byte of this markup. `tsc -b` will
 * typecheck the files and Rollup will tree-shake them straight back out, so a
 * green build says the section compiles and nothing at all about whether it
 * satisfies the guards. This does.
 *
 * Run:  node src/sections/risks-register/__probe.mjs
 * from apps/site-next. Output goes to the OS temp directory, never under src/:
 * `claims-lede-truth.test.mjs` walks every .md/.html/.txt/.json in the tree,
 * so a build artefact left beside the source is a file the claims guard reads
 * as if it were a page.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const SOURCE = path.resolve(root, '../site/risks.html');

/* ── render ───────────────────────────────────────────────────────────────── */

const out = mkdtempSync(path.join(tmpdir(), 'risks-register-probe-'));
let html;
try {
  await build({
    root,
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    // The bundle is written to the OS temp directory, which is outside this
    // package and so outside Node's resolution path for `react-dom`. Bundling
    // the dependencies in is what lets the artefact live somewhere the claims
    // guard's filesystem walk will never reach.
    ssr: { noExternal: true },
    build: {
      ssr: true,
      outDir: out,
      emptyOutDir: true,
      minify: false,
      rollupOptions: { input: path.join(here, '__probe-entry.tsx') },
    },
  });
  const mod = await import(pathToFileURL(path.join(out, '__probe-entry.js')).href);
  html = mod.render();
} finally {
  rmSync(out, { recursive: true, force: true });
}

/* ── parse both sides with the same shapes ────────────────────────────────── */

const source = readFileSync(SOURCE, 'utf8');

const parseSource = (text) =>
  [...text.matchAll(/<article class="risk" id="(r\d+)">([\s\S]*?)<\/article>/g)].map(
    ([, id, body]) => ({
      id,
      severityClass: body.match(/<span class="([^"]+)">/)[1],
      severityLabel: body.match(/<span class="[^"]+">([\s\S]*?)<\/span>/)[1],
      heading: body.match(/<h2[^>]*>([\s\S]*?)<\/h2>/)[1],
      rows: [...body.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => [m[1], m[2]]),
    }),
  );

const expected = parseSource(source);
const actual = parseSource(html);

let checks = 0;
const ok = (cond, message) => {
  assert.ok(cond, message);
  checks++;
};

/* ── 1. the article set, and the exact opening tag ────────────────────────── */

const ids = actual.map((a) => a.id);
ok(ids.length === 15, `expected fifteen articles, rendered ${ids.length}`);
assert.deepEqual(
  ids,
  Array.from({ length: 15 }, (_, i) => `r${i + 1}`),
  'the fifteen anchors must be r1..r15 in document order — risks-contents derives its heading and its jump list from exactly this set',
);
checks++;
for (const id of ids) {
  ok(
    html.includes(`<article class="risk" id="${id}">`),
    `${id}: the opening tag must be exactly <article class="risk" id="${id}"> — class first, id second, no other attribute`,
  );
}

/* ── 2. every cell byte-equal to the reviewed source ──────────────────────── */

assert.deepEqual(
  actual,
  expected,
  'the rendered register diverges from apps/site/risks.html — every heading, chip and cell must be byte-identical',
);
checks++;

/* ── 3. the derived unmitigated count ─────────────────────────────────────── */

const doneCells = [...html.matchAll(/<dt>What is done<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) =>
  m[1].replace(/<[^>]*>/g, '').trim(),
);
ok(
  doneCells.length === 15,
  `the guard parsed ${doneCells.length} "What is done" cells, not fifteen — it admits no attribute on <dt> or <dd> and no whitespace between them`,
);
const unmitigated = actual.filter((a, i) => doneCells[i].startsWith('Nothing')).map((a) => a.id);
assert.deepEqual(
  unmitigated,
  ['r1', 'r2', 'r4', 'r6', 'r8', 'r10', 'r15'],
  `seven cells must begin with "Nothing" — risks-hero says "Seven of these have no mitigation" and who-its-for says "the seven where the honest answer is that nothing is done", and both are computed from this list`,
);
checks++;

/* ── 4. the sequencer pin ─────────────────────────────────────────────────── */

const r5 = html.slice(html.indexOf('id="r5"'), html.indexOf('id="r6"'));
ok(!/severity--mitigated/.test(r5), 'r5 must not carry the mitigated chip');
ok(
  /never (?:run|executed) against a real/i.test(r5),
  'r5 must say the sequencer path has never executed against a real feed',
);
ok(!/severity--mitigated/.test(html), 'the mitigated chip appears nowhere in this register');

/* ── 6. the config-derived strings pinned to this page ────────────────────── */

for (const pin of [
  '24 hours in the reference configuration',
  'reference 100 USDC minimum deposit',
  'about 400 USDC',
  '$100',
  '$100,000',
  '$1,000',
  '$1,000,000',
  '3,600 seconds',
]) {
  ok(html.includes(pin), `the config-pinned string ${JSON.stringify(pin)} is missing`);
}

/* ── 7. the banned shapes ─────────────────────────────────────────────────── */

for (const re of [
  /\bpassed[-\s]but[-\s]pending\b/i,
  /\bpassed[-\s]but[-\s]unexecuted\b/i,
  /\bbetween a vote passing\b/i,
  /\bvote passing and execut/i,
  /\brebalance has passed but has not yet executed\b/i,
  /no share of the exit fee/i,
  /must be topped up/i,
  /set lower by many vaults/i,
  /all of which are now resolved/i,
]) {
  ok(!re.test(html), `a banned shape is present: ${re}`);
}
ok(
  !html.includes('50,000') || /\bplanned\b/.test(html),
  'the 50,000 figure must be labelled planned in the same markup',
);

/* ── 8. the exactly-one-h1 rule, and the pinned footer sentences ──────────── */

ok(!/<h1[\s>]/.test(html), 'this section renders no <h1> — risks-hero owns the only one on the page');

// The two counted footer sentences must not appear in this section: the guard
// strips only the permitted number of copies per page, so a third anywhere —
// including here — reds the "those three words appear only inside the footer
// sentences" check. They are assembled from fragments rather than written out,
// so this file never becomes the surface that carries an extra copy itself.
const FOOTER_SENTENCES = [
  ['No token. No points. No ', 'air', 'drop. No ', 'pre', 'sale.'].join(''),
  ['Source-available under BUSL-1.1 — not ', 'open ', 'source.'].join(''),
];
for (const sentence of FOOTER_SENTENCES) {
  ok(!html.includes(sentence), `a counted footer sentence must not appear here: ${JSON.stringify(sentence)}`);
}

console.log(`risks-register probe: ${checks} checks passed, ${html.length} bytes rendered`);
