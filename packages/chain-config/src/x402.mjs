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
 * that never passes a chain id and every existing test keeps behaving exactly as it did.
 * Disabling is opt-in, per chain, and visible in the config diff. Since 2026-09-09 all three
 * shipped configs declare the block out loud, so the absent-block path is exercised by a
 * synthetic config directory in `apps/api/test/x402-capability.test.mjs` rather than by any
 * file that ships.
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
 * `config/networks` — the same question for a network that has no EVM chain id.
 *
 * WHY A SECOND DIRECTORY RATHER THAN A FILE IN `contracts/config`. That directory is the vault
 * DEPLOYMENT configuration: oracle parameters, governance defaults, asset lists, read by Solidity
 * through `vm.readFile` and by `DeployTestnet.s.sol`. Solana has no vault deployment and never
 * will from this repository — the contracts are Solidity. Putting `solana-mainnet.json` there
 * would also walk straight into `scripts/test/config-doc-truth.test.mjs`, which enumerates every
 * `*-mainnet.json` under `contracts/config` and asserts a `govDefencesNote` on each. A payment
 * network has no governance defences, so that file would red the suite the day it landed, and the
 * fix would be an exemption — a list of "not really a chain config" entries inside a guard whose
 * whole value is that it enumerates rather than lists.
 *
 * So: EVM chains keep answering by chain id out of the deployment configs, unchanged and with no
 * gas-snapshot risk, and non-EVM payment networks answer by NAME out of their own directory.
 */
export const DEFAULT_NETWORK_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', 'config', 'networks',
);

/**
 * @typedef {Object} X402Capability
 * @property {number|null} chainId    the chain the answer is about (null = no chain id supplied)
 * @property {string|null} network    the network NAME the answer is about, for non-EVM networks
 * @property {string|null} chainName  the config's `chainName`, when a config matched
 * @property {boolean} enabled        may this chain meter reads over x402?
 * @property {string} source          how the answer was reached — for the boot log and for tests
 * @property {string} [note]          the config's own `x402.note`, verbatim
 * @property {string} [scheme]        the settlement scheme this network uses, e.g. `exact-svm`
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
 * Read every `*.json` directly under `dir` and index the ones that declare a string `network`.
 *
 * Same shape and same failure posture as `loadChainCapabilities`: a malformed file is skipped, not
 * thrown on, and a partial `x402` block does not disable. Names are indexed lower-cased, because
 * `NETWORK=Solana-Mainnet` in a `.env` is the same network as `solana-mainnet` and a capability
 * lookup that says otherwise switches a payment gate off by capitalisation.
 *
 * @param {{dir?:string}} [opts]
 * @returns {Map<string, {network:string, chainName:string|null, scheme:string|null, x402:{enabled:boolean, note?:string}|null, file:string}>}
 */
export function loadNetworkCapabilities({ dir = DEFAULT_NETWORK_DIR } = {}) {
  /** @type {Map<string, {network:string, chainName:string|null, scheme:string|null, x402:{enabled:boolean, note?:string}|null, file:string}>} */
  const byName = new Map();
  /** @type {string[]} */
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return byName;
  }
  for (const file of files) {
    let json;
    try {
      json = JSON.parse(readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      continue;
    }
    if (!json || typeof json !== 'object' || typeof json.network !== 'string' || !json.network.trim()) continue;
    const declared = json.x402 && typeof json.x402 === 'object' ? json.x402 : null;
    byName.set(json.network.trim().toLowerCase(), {
      network: json.network.trim(),
      chainName: typeof json.chainName === 'string' ? json.chainName : null,
      scheme: typeof json.scheme === 'string' ? json.scheme : null,
      x402: declared ? { enabled: declared.enabled !== false, ...(typeof declared.note === 'string' ? { note: declared.note } : {}) } : null,
      file,
    });
  }
  return byName;
}

/**
 * Resolve the x402 capability for a chain id OR a network name.
 *
 * ## Why this takes two kinds of key
 *
 * It used to take a chain id and do `Number(key)`, rejecting anything non-finite. That was right
 * while every target was EVM. Solana has no chain id, and the consequence was not a clean failure:
 * `x402Capability('solana-mainnet')` produced `NaN`, fell into the "no chain id configured" branch
 * and returned `enabled: true` with no config consulted. Fail-CLOSED, so nothing came off a payment
 * gate by accident — but Solana metering was **unconfigurable**, and no file anywhere could have
 * turned it off. A capability that cannot be configured is not a capability.
 *
 * So a numeric key still resolves by chain id out of `contracts/config`, and a non-numeric key
 * resolves by name out of `config/networks`. Nothing about the EVM path changed, including its
 * defaults and its `source` strings, which several tests match on.
 *
 * ## The default is still ENABLED, on both paths
 *
 * An absent block, an unknown key, a missing directory: all of them mean enabled. x402 is a payment
 * gate, and a gate must not come off because a lookup could not read its source. Disabling stays
 * opt-in, per network, and visible in a config diff.
 *
 * @param {number|string|null|undefined} key  an EVM chain id, or a network name such as `solana-mainnet`
 * @param {{dir?:string, networkDir?:string}} [opts]
 * @returns {X402Capability}
 */
export function x402Capability(key, { dir = DEFAULT_CONFIG_DIR, networkDir = DEFAULT_NETWORK_DIR } = {}) {
  if (key === null || key === undefined || (typeof key === 'string' && key.trim() === ''))
    return { chainId: null, network: null, chainName: null, enabled: true, source: 'no chain id or network configured — x402 metering left on (default)' };

  const id = Number(key);
  if (Number.isFinite(id)) {
    const entry = loadChainCapabilities({ dir }).get(id);
    if (!entry)
      return { chainId: id, network: null, chainName: null, enabled: true, source: `no chain config for chain ${id} — x402 metering left on (default)` };
    if (!entry.x402)
      return { chainId: id, network: null, chainName: entry.chainName, enabled: true, source: `${entry.file} declares no x402 block — metering left on (default)` };

    return {
      chainId: id,
      network: null,
      chainName: entry.chainName,
      enabled: entry.x402.enabled,
      source: `${entry.file} sets x402.enabled = ${entry.x402.enabled}`,
      ...(entry.x402.note ? { note: entry.x402.note } : {}),
    };
  }

  const name = String(key).trim();
  const entry = loadNetworkCapabilities({ dir: networkDir }).get(name.toLowerCase());
  if (!entry)
    return { chainId: null, network: name, chainName: null, enabled: true, source: `no network config for ${name} — x402 metering left on (default)` };
  if (!entry.x402)
    return {
      chainId: null, network: entry.network, chainName: entry.chainName, enabled: true,
      source: `${entry.file} declares no x402 block — metering left on (default)`,
      ...(entry.scheme ? { scheme: entry.scheme } : {}),
    };

  return {
    chainId: null,
    network: entry.network,
    chainName: entry.chainName,
    enabled: entry.x402.enabled,
    source: `${entry.file} sets x402.enabled = ${entry.x402.enabled}`,
    ...(entry.x402.note ? { note: entry.x402.note } : {}),
    ...(entry.scheme ? { scheme: entry.scheme } : {}),
  };
}
