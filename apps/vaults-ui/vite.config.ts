/**
 * ONE ENTRY, AND A SET OF ALIASES THAT POINT OUT OF THIS APP.
 *
 * The `@atlas/*` aliases resolve to `apps/web/src/*.mjs` — the allocator front
 * end's pure modules, each mirroring a contract term for term and each tested
 * under `apps/web/test/`. `@chain/*` is the same idea one layer further out:
 * `act.mjs`'s write-call ABI fragments and `abis.mjs`'s read-call ABI fragments
 * already live in `packages/reference-agent/src` and `packages/canary/src`,
 * tested against the compiled contracts there (`packages/canary/test/abis.test.mjs`
 * recomputes every read selector, and `packages/reference-agent/test` exercises the
 * write shapes end to end). This app imports every one of them rather than copying
 * them, so there is exactly one implementation of every governed number and every
 * call shape in the repo. If an alias is ever pointed at a local copy, the copy
 * becomes a second implementation of a consensus rule and the tests that cover it
 * stop covering what ships. Do not do that.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const atlas = (name: string) => fileURLToPath(new URL(`../web/src/${name}.mjs`, import.meta.url));
const agent = (name: string) => fileURLToPath(new URL(`../../packages/reference-agent/src/${name}.mjs`, import.meta.url));
const canary = (name: string) => fileURLToPath(new URL(`../../packages/canary/src/${name}.mjs`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@atlas/format': atlas('format'),
      '@atlas/governance': atlas('governance'),
      '@atlas/vault-view': atlas('vault-view'),
      '@atlas/fixtures': atlas('fixtures'),
      // vote-custody.mjs imports VOTE_COMMIT_ZERO from './chain-reader.mjs' by relative path, so
      // that file is pulled in by vite's own resolver once vote-custody is aliased in — it does
      // not need its own alias entry for that import to work. It gets one anyway because this
      // app also calls planVoteCommit/assembleVoteCommit directly (see src/lib/chain-actions.ts).
      '@atlas/vote-custody': atlas('vote-custody'),
      '@atlas/chain-reader': atlas('chain-reader'),
      // Write-call ABI fragments (deposit/approve/commitVote/revealVote/requestExit) — the same
      // ones packages/reference-agent's autonomous actor sends, so a wallet-connected member and
      // an agent never disagree about what a "deposit" or "reveal" transaction looks like.
      '@chain/act': agent('act'),
      // Read-call ABI fragments (VAULT_VIEWS, GOVERNANCE_VIEWS) — the same table
      // planVoteCommit/assembleVoteCommit above name their reads against by string ('VAULT_VIEWS',
      // 'GOVERNANCE_VIEWS'); this app resolves those names to these arrays before calling viem.
      '@chain/abis': canary('abis'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    /**
     * BOTH OF THESE ARE REQUIRED BY public/_headers, not preferences.
     *
     * `modulePreload.polyfill` emits an INLINE <script>, and the policy is
     * `script-src 'self'` with no 'unsafe-inline'. Left on, the browser refuses
     * the polyfill at load time -- a runtime failure no build step reports.
     *
     * `assetsInlineLimit: 0` keeps every asset a file this origin served. The
     * policy is `img-src 'self'` with no `data:`, so a small image the bundler
     * decided to inline as a data URI would be refused where the same image at
     * its own URL is served.
     */
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
  },
});
