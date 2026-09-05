// @ts-check
/**
 * x402 as a PER-CHAIN CAPABILITY, read from the chain configuration.
 *
 * Until now every runtime path assumed x402 metering was universally present and priced per call:
 * `apps/api/src/server.mjs` sent every non-free route through `gate()`, and its discovery document
 * advertised a price for them unconditionally. That was true while the only target chains were
 * Base Sepolia and Base mainnet. It is not true for Robinhood Chain (chain id 4663), where the
 * owner's decision of 2026-09-05 is that there will be no x402.
 *
 * So the capability now comes from the same file that already carries every other per-chain fact —
 * `contracts/config/<chain>.json` — under a top-level `x402` block:
 *
 *     "x402": { "enabled": false, "note": "…" }
 *
 * **An absent block means ENABLED.** That is deliberate and load-bearing: every existing caller
 * that never passes a chain id, every existing test, and `contracts/config/base-mainnet.json`
 * (which declares nothing) all keep behaving exactly as they did. Disabling is opt-in, per chain,
 * and visible in the config diff.
 *
 * ## Parked, not deleted
 *
 * Nothing here removes x402. The middleware, the facilitator, the facilitator-server, the agent
 * SDK's 402 → sign → retry loop and the reference agent's budget are all untouched and still the
 * live path on every chain that does not switch the capability off. Flipping `enabled` back to
 * `true` in one config restores metering on that chain with no other edit.
 *
 * ## Why this reads the file rather than hard-coding a chain id
 *
 * A hard-coded `4663` in runtime code is a second source of truth that drifts from the config the
 * deploy actually uses. Reading the config keeps one. The consequence is that the configuration
 * directory has to exist at runtime, which is why the Dockerfile now copies `contracts/config`
 * into the image (see `.dockerignore`). If it is missing anyway — an older image, a stripped
 * bundle — resolution degrades to `enabled: true`, i.e. today's behaviour, because a capability
 * lookup that cannot read its source must not silently switch a payment gate off.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `contracts/config` as reached from this file: packages/chain-config/src → repo root. */
export const DEFAULT_CONFIG_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'contracts', 'config',
);

/**
 * @typedef {Object} X402Capability
 * @property {number|null} chainId    the chain the answer is about (null = no chain id supplied)
 * @property {string|null} chainName  the config's `chainName`, when a config matched
 * @property {boolean} enabled        may this chain meter reads over x402?
 * @property {string} source          how the answer was reached — for the boot log and for tests
 * @property {string} [note]          the config's own `x402.note`, verbatim
 */

/**
 * Read every `*.json` directly under `dir` and index the ones that declare a numeric `chainId`.
 * Unreadable or malformed files are skipped rather than thrown on: this is a capability lookup on
 * a boot path, and one bad file must not take the process down.
 *
 * @param {{dir?:string}} [opts]
 * @returns {Map<number, {chainName:string|null, x402:{enabled:boolean, note?:string}|null, file:string}>}
 */
export function loadChainCapabilities({ dir = DEFAULT_CONFIG_DIR } = {}) {
  /** @type {Map<number, {chainName:string|null, x402:{enabled:boolean, note?:string}|null, file:string}>} */
  const byChainId = new Map();
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return byChainId;
  }
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object' || !Number.isInteger(json.chainId)) continue;
    const declared = json.x402 && typeof json.x402 === 'object' ? json.x402 : null;
    byChainId.set(json.chainId, {
      chainName: typeof json.chainName === 'string' ? json.chainName : null,
      // Only an explicit `false` disables. A malformed or partial block is not a licence to turn
      // a payment gate off; it falls through to the enabled default like an absent one.
      x402: declared ? { enabled: declared.enabled !== false, ...(typeof declared.note === 'string' ? { note: declared.note } : {}) } : null,
      file,
    });
  }
  return byChainId;
}

/**
 * Resolve the x402 capability for a chain id.
 *
 * @param {number|string|null|undefined} chainId
 * @param {{dir?:string}} [opts]
 * @returns {X402Capability}
 */
export function x402Capability(chainId, { dir = DEFAULT_CONFIG_DIR } = {}) {
  const id = chainId === null || chainId === undefined || chainId === '' ? null : Number(chainId);
  if (id === null || !Number.isFinite(id))
    return { chainId: null, chainName: null, enabled: true, source: 'no chain id configured — x402 metering left on (default)' };

  const entry = loadChainCapabilities({ dir }).get(id);
  if (!entry)
    return { chainId: id, chainName: null, enabled: true, source: `no chain config for chain ${id} — x402 metering left on (default)` };
  if (!entry.x402)
    return { chainId: id, chainName: entry.chainName, enabled: true, source: `${entry.file} declares no x402 block — metering left on (default)` };

  return {
    chainId: id,
    chainName: entry.chainName,
    enabled: entry.x402.enabled,
    source: `${entry.file} sets x402.enabled = ${entry.x402.enabled}`,
    ...(entry.x402.note ? { note: entry.x402.note } : {}),
  };
}
