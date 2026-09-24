/**
 * ONE ENTRY PER DOCUMENT, NOT ONE APP.
 *
 * `rollupOptions.input` names the root-level entry HTMLs, so dist/ carries flat files with exactly
 * the filenames the site serves — dist/disclaimers.html, never dist/disclaimers/index.html. There
 * is no router and no client navigation: a nav link is an ordinary document navigation.
 *
 * `notFound` builds 404.html, which Cloudflare Pages serves — with a 404 status — for any path
 * matching no asset. DROPPING IT DOES NOT FAIL THE BUILD, it reinstates a soft-404: with no
 * top-level 404.html the Pages asset server falls back to serving /index.html with a 200 for every
 * unmatched path, which is worse than a missing page because nothing reports it.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const entry = (name: string) => fileURLToPath(new URL(`./${name}`, import.meta.url));

/**
 * `@rwally/terms` resolves to `packages/terms/src/terms-text.mjs` — the ONE Terms of Use string
 * this app and `apps/vaults-ui` both import, so a text change can never reach one and not the
 * other. Same alias-over-npm-dependency convention `apps/vaults-ui/vite.config.ts` uses for
 * `@atlas/*`/`@chain/*`: nothing declares this as a package.json dependency, the path is resolved
 * directly. `src/terms-modules/terms-text.d.ts` (see `tsconfig.json`'s matching `paths` entry)
 * supplies the types tsc needs for this untyped ESM source.
 */
const pkg = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@rwally/terms': pkg('terms/src/terms-text.mjs'),
    },
  },
  build: isSsrBuild
    ? {
        ssr: true,
        rollupOptions: { input: entry('src/entry-server.tsx') },
        outDir: 'dist-ssr',
        emptyOutDir: true,
      }
    : {
        outDir: 'dist',
        emptyOutDir: true,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: {
            index: entry('index.html'),
            howItWorks: entry('how-it-works.html'),
            about: entry('about.html'),
            docs: entry('docs.html'),
            disclaimers: entry('disclaimers.html'),
            terms: entry('terms.html'),
            notFound: entry('404.html'),
          },
        },
      },
}));
