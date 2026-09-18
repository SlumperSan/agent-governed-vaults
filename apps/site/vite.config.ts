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

export default defineConfig(({ isSsrBuild }) => ({
  plugins: [react()],
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
            disclaimers: entry('disclaimers.html'),
            notFound: entry('404.html'),
          },
        },
      },
}));
