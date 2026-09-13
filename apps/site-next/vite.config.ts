/**
 * Build configuration for the public site.
 *
 * ONE ENTRY PER DOCUMENT, NOT ONE APP. `rollupOptions.input` names the
 * root-level entry HTMLs, so `dist/` carries flat files with exactly the
 * filenames the site serves — `dist/disclaimers.html`, never
 * `dist/disclaimers/index.html`. There is no router and no client navigation: a
 * nav link is an ordinary document navigation, and `site.test.mjs` asserts the
 * `.html` suffix on every one of them.
 *
 * THREE ENTRIES, AND THE THIRD IS NOT A PAGE. `index` and `disclaimers` are the
 * two `PageId`s. `notFound` builds `404.html`, which Cloudflare Pages serves —
 * with a 404 status — for any path matching no asset and no `_redirects` rule.
 * DROPPING IT FROM THIS LIST DOES NOT FAIL THE BUILD, it reinstates a soft-404:
 * with no top-level `404.html` in the output, the Pages asset server falls back
 * to serving `/index.html` with a 200 for every unmatched path. That was the
 * live behaviour of rwally.com until 2026-09-09, and `src/shell/pinned.ts`
 * records the measurement under `NOT_FOUND_ID`.
 *
 * TWO BUILDS, THEN A SPLICE. `npm run build` runs this config twice — once for
 * the client, once with `--ssr` for the server bundle — and then
 * `scripts/prerender.mjs` renders each page and writes the markup into the
 * matching HTML file. The prerender is not an optimisation. The claims guards
 * read the built HTML as text and assert on banner strings, footer sentence
 * COUNTS, exactly one `<h1>`, and `<tr><th scope="row">` cells. A
 * client-rendered app emits `<div id="root"></div>` and fails every one of
 * them.
 *
 * THE TWO SETTINGS BELOW THAT ARE SECURITY, NOT TASTE:
 *
 *   modulePreload.polyfill: false
 *     Vite otherwise injects an INLINE <script> carrying the modulepreload
 *     polyfill. The site's Content-Security-Policy is `script-src 'self'` with
 *     no 'unsafe-inline', so that script is refused by the browser — and the
 *     failure is quiet unless somebody is reading the console. Every browser
 *     this site targets supports modulepreload natively.
 *
 *   assetsInlineLimit: 0
 *     Vite otherwise inlines small assets as `data:` URIs. `font-src 'self'`
 *     does not permit `data:`, so an inlined face would silently not load, and
 *     an inlined SVG would need `img-src data:` for no benefit. Every asset
 *     ships as a file from this origin, which is also what makes it checkable
 *     with `read_network_requests`.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const entry = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],

  build: isSsrBuild
    ? {
        // The SSR bundle is a build artefact consumed by scripts/prerender.mjs
        // and never served. It lives outside dist/ so it cannot be deployed by
        // accident.
        //
        // `ssr: true` plus an explicit `input` rather than `ssr: '<entry>'`.
        // Under Vite 8 the string form leaves the ssr environment's input as
        // the entry HTMLs, and the build stops with "rolldownOptions.
        // input should not be an html file when building for SSR" — a message
        // that reads like a config typo and is really the two forms diverging.
        ssr: true,
        rollupOptions: { input: entry('src/entry-server.tsx') },
        outDir: 'dist-ssr',
        emptyOutDir: true,
      }
    : {
        outDir: 'dist',
        emptyOutDir: true,
        assetsInlineLimit: 0,
        modulePreload: { polyfill: false },
        rollupOptions: {
          input: {
            index: entry('index.html'),
            disclaimers: entry('disclaimers.html'),
            notFound: entry('404.html'),
          },
        },
      },
}));
