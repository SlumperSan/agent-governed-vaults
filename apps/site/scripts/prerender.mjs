/**
 * Writes the rendered markup into each built page.
 *
 * IT FAILS LOUDLY RATHER THAN SILENTLY SHIPPING AN EMPTY PAGE. Every step throws with a named
 * reason: a missing SSR bundle, a missing entry HTML, a root div edited out, or markup that came
 * back suspiciously short. A prerender that quietly writes nothing produces a site that looks fine
 * to a browser with JavaScript and empty to everything else — including the guards that read the
 * built pages, which would then pass on pages containing no claims at all.
 *
 * THE PAGE LIST COMES FROM THE SSR BUNDLE, not from a copy kept here. Two lists of pages drift, and
 * the one that drifts is always the one nobody looks at. `404.html` is written alongside them but
 * is NOT in that list and is not counted against it — it is not a PageId, because nothing navigates
 * to it. See src/pages.ts.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SSR_ENTRY = path.join(APP, 'dist-ssr', 'entry-server.js');
const DIST = path.join(APP, 'dist');
const ROOT_DIV = '<div id="root"></div>';
const NOT_FOUND = '404.html';
/**
 * PER-PAGE FLOORS, NOT ONE NUMBER.
 *
 * The floor exists so a section that renders empty is caught rather than shipped. A single global
 * value cannot do that job here: the 404 is legitimately ~1.1 KB, so a floor low enough to admit it
 * would admit a homepage that had lost four of its five sections. Lowering the global number to
 * make the 404 pass is exactly how a guard stops guarding.
 *
 * These are minima with real headroom, not measurements — a floor set at today's byte count reds on
 * the next honest edit.
 */
const FLOORS = {
  // 70% of each page's measured render, rounded to 100. Set that way on purpose: a floor at the
  // current byte count reds on the next honest edit, and a floor set low enough to admit the 1.5 KB
  // 404 would admit a homepage that had lost four of its five sections. Every number here was
  // measured after verifying the page rendered all its sections, not guessed and then lowered until
  // the build went green — which is how a floor stops being a floor.
  'index.html': 3400,
  'how-it-works.html': 2300,
  'about.html': 2000,
  'docs.html': 2500,
  'disclaimers.html': 28400,
  '404.html': 1100,
}
const DEFAULT_FLOOR = 2000;

if (!existsSync(SSR_ENTRY)) {
  throw new Error(`prerender: no SSR bundle at ${SSR_ENTRY}. Run \`vite build --ssr\` first.`);
}

const { render, pages } = await import(pathToFileURL(SSR_ENTRY).href);
if (!Array.isArray(pages) || pages.length === 0) {
  throw new Error('prerender: the SSR bundle exported no page list, so nothing would be written.');
}

function write(page) {
  const file = path.join(DIST, page);
  if (!existsSync(file)) {
    throw new Error(`prerender: no built page at ${file}. Is ${page} listed in vite.config.ts input?`);
  }

  const markup = render(page);
  const floor = FLOORS[page] ?? DEFAULT_FLOOR;
  if (typeof markup !== 'string' || markup.length < floor) {
    throw new Error(
      `prerender: ${page} rendered ${typeof markup} of length ${markup?.length ?? 0}, under its ` +
        `${floor}-byte floor. Something rendered empty. If this page legitimately shrank, move its ` +
        'floor deliberately rather than lowering it to whatever it happens to be now.',
    );
  }

  const html = readFileSync(file, 'utf8');
  if (!html.includes(ROOT_DIV)) {
    throw new Error(
      `prerender: ${page} does not carry ${ROOT_DIV}. The entry HTML must contain exactly that div, ` +
        'and this script must run on a fresh build rather than over its own output.',
    );
  }

  writeFileSync(file, html.replace(ROOT_DIV, `<div id="root">${markup}</div>`), 'utf8');
  return markup.length;
}

let wrote = 0;
for (const page of pages) {
  const n = write(page);
  console.log(`prerender: ${page} — ${n} bytes`);
  wrote += 1;
}
if (wrote !== pages.length) {
  throw new Error(`prerender: wrote ${wrote} of ${pages.length} pages`);
}

// 404.html is written here and NOT counted above: it is not a PageId, so `pages` does not carry it
// and the completeness check must not expect it. It still has to exist — without a top-level
// 404.html the Cloudflare Pages asset server serves /index.html with a 200 for every unmatched
// path, which is a soft-404 that nothing reports.
const n404 = write(NOT_FOUND);
console.log(`prerender: ${NOT_FOUND} — ${n404} bytes (not a PageId)`);
