/**
 * ONE ENTRY, AND FOUR ALIASES THAT POINT OUT OF THIS APP.
 *
 * The `@atlas/*` aliases resolve to `apps/web/src/*.mjs` — the allocator front
 * end's pure modules, each mirroring a contract term for term and each tested
 * under `apps/web/test/`. This app imports them rather than copying them, so
 * there is exactly one implementation of every governed number in the repo.
 * If an alias is ever pointed at a local copy, the copy becomes a second
 * implementation of a consensus rule and the tests that cover it stop covering
 * what ships. Do not do that.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const atlas = (name: string) => fileURLToPath(new URL(`../web/src/${name}.mjs`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@atlas/format': atlas('format'),
      '@atlas/governance': atlas('governance'),
      '@atlas/vault-view': atlas('vault-view'),
      '@atlas/fixtures': atlas('fixtures'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
