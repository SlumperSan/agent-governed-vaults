// @ts-check
/**
 * Prerender: render the eight pages with React and write the markup into the
 * eight built HTML files.
 *
 * WHY THIS STEP EXISTS. Everything that checks this site reads the built HTML
 * as text. `apps/site/test/site.test.mjs` asserts banner strings, footer
 * sentence COUNTS, exactly one `<h1>`, `<main id="main">`, the position of the
 * skip link, `<tr><th scope="row">…</th><td>…</td></tr>` rows matched with no
 * whitespace between the tags, and `id="r1"`..`id="r15"`. A client-rendered
 * React app ships `<div id="root"></div>` and fails all of it. So the markup has to be in the
 * file, and the browser's job is to hydrate what is already there.
 *
 * WHAT IT DOES. Imports the SSR bundle once, calls `render(page)` for each of
 * the eight, and replaces the empty `<div id="root"></div>` in the matching
 * `dist/<page>.html` with the same div carrying the rendered markup. Nothing
 * else about the file is touched: the head — title, description, canonical and
 * social preview — was written by hand into the entry HTML and is copied
 * through by the client build untouched.
 *
 * IT FAILS THE BUILD RATHER THAN WARNING. A silent partial prerender is the
 * expensive failure here, because the symptom appears days later as a copy
 * guard going red on a sentence nobody edited. So: a missing file, a missing
 * root div, or a page whose markup came back empty is an error and a non-zero
 * exit.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const DIST = path.join(APP, 'dist');
const SSR_ENTRY = path.join(APP, 'dist-ssr', 'entry-server.js');

const ROOT_DIV = '<div id="root"></div>';

if (!existsSync(SSR_ENTRY)) {
  console.error(
    `prerender: no SSR bundle at ${SSR_ENTRY}\n` +
      'Run `vite build --ssr` before this script — `npm run build` does both in order.',
  );
  process.exit(1);
}

const { render, pages, landedPages } = await import(pathToFileURL(SSR_ENTRY).href);

const landed = new Set(landedPages());
let wrote = 0;

for (const page of pages) {
  const file = path.join(DIST, page);
  if (!existsSync(file)) {
    console.error(`prerender: ${page} is missing from dist/ — check rollupOptions.input`);
    process.exit(1);
  }

  const html = readFileSync(file, 'utf8');
  if (!html.includes(ROOT_DIV)) {
    console.error(
      `prerender: ${page} has no empty ${ROOT_DIV} to splice into.\n` +
        'The entry HTML must carry exactly that div, and this script must run on a fresh build.',
    );
    process.exit(1);
  }

  const markup = render(page);
  if (!markup || markup.length === 0) {
    console.error(`prerender: ${page} rendered nothing`);
    process.exit(1);
  }

  writeFileSync(file, html.replace(ROOT_DIV, `<div id="root">${markup}</div>`), 'utf8');
  wrote += 1;

  const h1s = markup.split('<h1').length - 1;
  const body = landed.has(page) ? 'page body' : 'SHELL ONLY — no page body yet';
  console.log(
    `prerender: ${page.padEnd(18)} ${String(markup.length).padStart(7)} B  ` + `h1:${h1s}  ${body}`,
  );
}

if (wrote !== pages.length) {
  console.error(`prerender: wrote ${wrote} of ${pages.length} pages`);
  process.exit(1);
}

const missing = pages.filter((/** @type {string} */ p) => !landed.has(p));
if (missing.length > 0) {
  console.log(
    `prerender: ${wrote} pages written. ${missing.length} still carry the shell only ` +
      `(${missing.join(', ')}) — each owes exactly one <h1> from its hero section.`,
  );
} else {
  console.log(`prerender: ${wrote} pages written, all with a page body.`);
}
