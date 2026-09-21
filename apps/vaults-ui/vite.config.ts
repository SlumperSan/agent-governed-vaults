/**
 * ONE ENTRY, AND ALIASES THAT POINT OUT OF THIS APP.
 *
 * The `@atlas/*` aliases resolve to `apps/web/src/*.mjs` — the allocator front
 * end's pure modules, each mirroring a contract term for term and each tested
 * under `apps/web/test/`. This app imports them rather than copying them, so
 * there is exactly one implementation of every governed number in the repo.
 * If an alias is ever pointed at a local copy, the copy becomes a second
 * implementation of a consensus rule and the tests that cover it stop covering
 * what ships. Do not do that.
 *
 * `@chain/*` is the SAME rule applied one package further out: `packages/canary/src/abis.mjs`
 * already declares every read-call ABI fragment a chain read needs, drift-checked against the
 * compiled contracts by `packages/canary/test/abis.test.mjs`; `packages/reference-agent/src/act.mjs`
 * carries the write-call fragments the same way, tested end to end under
 * `packages/reference-agent/test`; and `packages/chain-config/src/chain-binding.mjs` is the ONLY
 * place #204 (an RPC answering for a chain nobody asked it to confirm) is decided. A local copy of
 * any of the three would drift from what it mirrors silently — the same argument as `@atlas/*`,
 * aimed at the three packages `src/lib/live-vaults.ts` and `src/lib/chain-actions.ts` need and
 * `apps/web/src` cannot import itself (it is zero-dependency by its own header).
 *
 * NO `@atlas/fixtures` ALIAS. `apps/web/src/fixtures.mjs` is the allocator front end's OWN test
 * fixtures, not this workspace's data source — plan item 0.7 removed the last import of it from
 * `src/`, and `test/csp.test.mjs` asserts none of its labelled values ever reach `dist/`.
 * Re-adding this alias is the easiest way to reintroduce the regression that test exists to catch.
 */
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const atlas = (name: string) => fileURLToPath(new URL(`../web/src/${name}.mjs`, import.meta.url));
const pkg = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@atlas/format': atlas('format'),
      '@atlas/governance': atlas('governance'),
      '@atlas/vault-view': atlas('vault-view'),
      '@atlas/chain-reader': atlas('chain-reader'),
      '@atlas/freshness': atlas('freshness'),
      // vote-custody.mjs imports VOTE_COMMIT_ZERO from './chain-reader.mjs' by relative path, so
      // that file is pulled in by vite's own resolver once vote-custody is aliased in — it does
      // not need its own alias entry for that import to work. It gets one anyway because this
      // app also calls planVoteCommit/assembleVoteCommit directly (see src/lib/chain-actions.ts).
      '@atlas/vote-custody': atlas('vote-custody'),
      // Pre-flight refusal checks (#341) and deposit-status classification (#340) — both pure,
      // both already tested under apps/web/test/. This app calls them rather than re-deriving the
      // creator gate, the Mode-F exit warning, or the observation-window states a second time.
      '@atlas/wallet-refusals': atlas('wallet-refusals'),
      '@atlas/deposit-status': atlas('deposit-status'),
      // The frozen/queued-exit/creator-gate refusal VERDICTS themselves (not just the two
      // standalone checks above) — `actions(facts).exit` is what decides whether the exit button
      // signs at all, so a frozen vault's irrevocable-Mode-F trap is refused here rather than
      // re-derived a second time in a component.
      '@atlas/vault-state': atlas('vault-state'),
      // The exit-quote math (P-O12) — mirrors VaultCore._settleExit/_exitFeeBps term for term,
      // already tested under apps/web/test/exit-preview.test.mjs. Before this alias, the member
      // surface asked someone to request an exit without telling them what they would receive;
      // the code that could tell them already existed in the sibling app and was never imported.
      '@atlas/exit-preview': atlas('exit-preview'),
      '@chain/abis': pkg('canary/src/abis.mjs'),
      '@chain/binding': pkg('chain-config/src/chain-binding.mjs'),
      // Write-call ABI fragments (deposit/approve/commitVote/revealVote/requestExit) — the same
      // ones packages/reference-agent's autonomous actor sends, so a wallet-connected member and
      // an agent never disagree about what a "deposit" or "reveal" transaction looks like.
      '@chain/act': pkg('reference-agent/src/act.mjs'),
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
