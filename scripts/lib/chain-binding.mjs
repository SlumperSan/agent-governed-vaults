// @ts-check
/**
 * Shared pure decision: does the RPC that answered belong to the chain something in THIS run
 * declared? Used by `scripts/verify-mainnet-config.mjs` and `scripts/live-x402-run.mjs` (#204).
 *
 * ## The implementation moved to `packages/chain-config/src/chain-binding.mjs`; this re-exports it
 *
 * When #278 landed, both callers were under `scripts/`, so the decision lived here. Closing the
 * rest of #204 added three more callers — `packages/indexer`, `packages/canary` and
 * `packages/reference-agent` — and none of them can import this file: `Dockerfile` copies
 * `packages` and `apps` and does NOT copy `scripts`, so a `../../../scripts/...` import resolves
 * on a developer's checkout and throws MODULE_NOT_FOUND inside the container.
 *
 * Rather than keep a second copy in sync by hand, the implementation moved to `packages/` — which
 * both sides can reach — and this module re-exports it unchanged. The import path every existing
 * caller uses is therefore untouched, and there is exactly one statement of the rule. Two
 * statements of one rule drift, and then neither can be trusted.
 *
 * `chainBindingVerdict` keeps its exact signature and behaviour. `assertChainBinding` and
 * `ChainBindingError` are re-exported too, for any future script that wants the RPC-reading form
 * rather than the pure one.
 *
 * Deliberately still NOT imported from `scripts/verify-chainlink-oracle.mjs`'s own copy: that file
 * is a script, not a library — its top level reads a config path off `process.env.CONFIG` and can
 * `process.exit(1)` on `import` alone. Folding its copy in as well means editing that file, which
 * is a separate change.
 */
export { chainBindingVerdict, assertChainBinding, ChainBindingError } from '../../packages/chain-config/src/chain-binding.mjs';
