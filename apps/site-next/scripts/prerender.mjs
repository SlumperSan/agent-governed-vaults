// @ts-check
/**
 * Prerender: render the site's documents with React and write the markup into
 * the built HTML files.
 *
 * THREE FILES, TWO OF THEM PAGES. `pages` is the two `PageId`s, and `404.html`
 * is written after the loop through `renderNotFound()`: it is a document the
 * site is never navigated to, so it is in no nav, no sitemap and none of the
 * per-page guards. See `NOT_FOUND_ID` in `src/shell/pinned.ts`.
 *
 * WHY THIS STEP EXISTS. Everything that checks this site reads the built HTML
 * as text. `apps/site/test/site.test.mjs` asserts banner strings, footer
 * sentence COUNTS, exactly one `<h1>`, `<main id="main">`, the position of the
 * skip link, `<tr><th scope="row">…</th><td>…</td></tr>` rows matched with no
 * whitespace between the tags, and `id="r1"`..`id="r15"`. A client-rendered
 * React app ships `<div id="root"></div>` and fails all of it. So the markup has to be in the
 * file, and the browser's job is to hydrate what is already there.
 *
 * WHAT IT DOES. Imports the SSR bundle once, calls `render(page)` for each
 * page and `renderNotFound()` once, and replaces the empty `<div id="root"></div>` in the matching
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

/** The not-found document. Kept as a literal rather than imported from the SSR
 *  bundle's `NOT_FOUND_ID`, so the two names disagreeing is a build failure at
 *  `splice`'s first check rather than a page written to the wrong filename. */
const NOT_FOUND_PAGE = '404.html';

if (!existsSync(SSR_ENTRY)) {
  console.error(
    `prerender: no SSR bundle at ${SSR_ENTRY}\n` +
      'Run `vite build --ssr` before this script — `npm run build` does both in order.',
  );
  process.exit(1);
}

const { render, renderNotFound, pages, landedPages } = await import(pathToFileURL(SSR_ENTRY).href);

/**
 * Splice one page's markup into its built HTML, with the three checks that make
 * a partial prerender an error rather than a silent shrug.
 *
 * EXTRACTED SO `404.html` GETS THE SAME THREE. It is written outside the `pages`
 * loop below, because it is not a `PageId` — see `NOT_FOUND_ID` in
 * `src/shell/pinned.ts` — and the first draft of that write was a bare
 * `writeFileSync` with no checks at all. A 404 page that shipped as an empty
 * root div would still return the 404 status Pages exists to give it, so
 * nothing downstream would go red: the reader would just be told nothing.
 *
 * @param {string} page  file name in dist/
 * @param {string} markup  the rendered inner HTML
 * @returns {number} the markup's length in bytes, for the log line
 */
const splice = (page, markup) => {
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

  if (!markup || markup.length === 0) {
    console.error(`prerender: ${page} rendered nothing`);
    process.exit(1);
  }

  writeFileSync(file, html.replace(ROOT_DIV, `<div id="root">${markup}</div>`), 'utf8');
  return markup.length;
};

const landed = new Set(landedPages());
let wrote = 0;

for (const page of pages) {
  const markup = render(page);
  const bytes = splice(page, markup);
  wrote += 1;

  const h1s = markup.split('<h1').length - 1;
  const body = landed.has(page) ? 'page body' : 'SHELL ONLY — no page body yet';
  console.log(
    `prerender: ${page.padEnd(18)} ${String(bytes).padStart(7)} B  ` + `h1:${h1s}  ${body}`,
  );
}

if (wrote !== pages.length) {
  console.error(`prerender: wrote ${wrote} of ${pages.length} pages`);
  process.exit(1);
}

/**
 * `404.html`, WHICH IS WRITTEN HERE AND NOT COUNTED ABOVE.
 *
 * It is not a `PageId`, so it is not in `pages`, so `landedPages()` says
 * nothing about it and the `wrote !== pages.length` check above must not see
 * it. It still goes through `splice`, so a missing file, a missing root div or
 * an empty render fails the build exactly as they do for the other two.
 *
 * WHY THE FILE HAS TO EXIST AT ALL: without a top-level `404.html` the
 * Cloudflare Pages asset server falls back to serving `/index.html` with a 200
 * for every path that matches no asset, which is the soft-404 measured on the
 * live site on 2026-09-09. The long version is in `src/shell/pinned.ts` under
 * `NOT_FOUND_ID`, and the entry HTML repeats it where a reader deleting the
 * file would see it.
 */
const notFoundMarkup = renderNotFound();
const notFoundBytes = splice(NOT_FOUND_PAGE, notFoundMarkup);
console.log(
  `prerender: ${NOT_FOUND_PAGE.padEnd(18)} ${String(notFoundBytes).padStart(7)} B  ` +
    `h1:${notFoundMarkup.split('<h1').length - 1}  not-found document (not a PageId)`,
);

const missing = pages.filter((/** @type {string} */ p) => !landed.has(p));
if (missing.length > 0) {
  console.log(
    `prerender: ${wrote} pages written. ${missing.length} still carry the shell only ` +
      `(${missing.join(', ')}) — each owes exactly one <h1> from its hero section.`,
  );
} else {
  console.log(`prerender: ${wrote} pages written, all with a page body.`);
}
