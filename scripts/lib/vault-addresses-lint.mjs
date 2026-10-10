// @ts-check
/**
 * Pure logic behind `scripts/vault-addresses-lint.mjs` (card A2), split out so it is testable
 * against fixture files rather than the real repo state — same shape as `deployment-currency.mjs`
 * and `vault-lint.mjs` next to it.
 *
 * THE PROBLEM. `apps/vaults-ui/src/lib/live-vaults.ts`'s `readLiveConfig()` reads
 * `VITE_VAULT_ADDRESSES` (comma-separated, build-time via `import.meta.env`) with zero cross-check
 * against what is actually deployed. `contracts/config/deployments/*.json` is this repository's own
 * source of truth for real vault addresses (see `deployment-currency.mjs`'s header, which treats the
 * same directory the same way for a different question). On deploy day someone edits
 * `VITE_VAULT_ADDRESSES` by hand — a typo, a stale leftover address, or an address copied from the
 * wrong chain would silently ship, with the app either pointing at nothing or at garbage.
 *
 * TWO FAILURE MODES, KEPT DISTINCT ON PURPOSE. An address absent from every manifest is a typo or a
 * stale leftover — bad, but it fails obviously (the app points at nothing). An address that IS a
 * real, deployed vault, just on a DIFFERENT chain than the file's own `VITE_CHAIN_ID` declares, is
 * worse: `readLiveConfig` would build a client bound to the wrong chain and every read means
 * something different there. `evaluateAddresses` below reports these as `'unknown'` and
 * `'chain-mismatch'` respectively, and the CLI's message names which one fired.
 *
 * WHAT COUNTS AS A "VAULT ADDRESS" IN A MANIFEST. Not `/vault/i` — that also matches
 * `VaultFactory`, `VaultDeployer` and `SubVaultRegistry`, singleton infrastructure addresses that
 * are never a deployed vault instance (see `base-sepolia.json`'s `singletons` block). The rule here
 * is narrower: an object key ending in the literal suffix `Vault` (`smokeVault`, a future
 * `memberVault`) holding an `{address}` object, or a key named `vaults` (any case) holding an array
 * of `{address}` objects or bare address strings — the shape a manifest with many deployed vaults
 * would use. `collectManifestVaultAddresses` walks the whole manifest recursively so either shape is
 * picked up wherever it sits, not just at the top level.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** An object key that names a single deployed vault (`smokeVault`), never `VaultFactory`/`VaultDeployer`/`...Registry`. */
const VAULT_KEY_RE = /Vault$/;

/** A key holding an array of many deployed vaults — the shape a live multi-vault manifest would use. */
const VAULTS_ARRAY_KEY_RE = /^vaults$/i;

// ---------------------------------------------------------------------------- env-shaped text

/**
 * `KEY=value` parsing for `.env`-shaped files: `#` comments, blank lines skipped, a single matching
 * pair of surrounding quotes stripped (dotenv convention). Last assignment of a key wins, matching
 * shell semantics for a file that is sourced top to bottom.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

/**
 * A single `NAME=value` / `NAME: value` occurrence anywhere in a text file — the loose shape a CI
 * workflow (`env:` block, an inline `export NAME=value` inside a `run:` step) or a `wrangler.toml`
 * `[vars]` table would use. Unlike `parseEnvText`, this does not assume the whole file is
 * `.env`-shaped; it looks for one named assignment wherever it appears, first match wins.
 *
 * @param {string} text
 * @param {string} name
 * @returns {string | undefined}
 */
export function extractLooseVar(text, name) {
  const re = new RegExp(`${name}\\s*[:=]\\s*['"]?([^'"\\n#]+?)['"]?\\s*(?:#.*)?$`, 'm');
  const m = re.exec(text);
  return m ? m[1].trim() : undefined;
}

// ---------------------------------------------------------------------------- discovering config files

/**
 * Every `.env`-shaped file directly under `vaultsUiDir` — `.env`, `.env.example`,
 * `.env.production`, `.env.development.local`, whichever exist. Non-recursive: Vite env files live
 * at the workspace root, never nested (`apps/vaults-ui/.env.example` is the only one committed
 * today; the rest are gitignored and only appear on a machine that created them).
 *
 * @param {string} vaultsUiDir
 * @returns {string[]}
 */
export function findEnvFiles(vaultsUiDir) {
  if (!existsSync(vaultsUiDir)) return [];
  return readdirSync(vaultsUiDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith('.env'))
    .map((e) => path.join(vaultsUiDir, e.name))
    .sort();
}

/**
 * CI and deploy config that MIGHT set `VITE_VAULT_ADDRESSES` outside the `.env*` files: every
 * `.github/workflows/*.yml` (a deploy step could export it inline) and `apps/vaults-ui`'s own
 * `wrangler.toml` (a `[vars]` table could set it for the Pages build). Scoped to vaults-ui's own
 * wrangler config, not every `wrangler.toml` in the repo (`apps/site` has an unrelated one).
 *
 * @param {{ repoRoot: string, vaultsUiDir: string }} args
 * @returns {string[]}
 */
export function findDeployConfigCandidates({ repoRoot, vaultsUiDir }) {
  /** @type {string[]} */
  const out = [];
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  if (existsSync(workflowsDir)) {
    for (const e of readdirSync(workflowsDir, { withFileTypes: true })) {
      if (e.isFile() && /\.ya?ml$/.test(e.name)) out.push(path.join(workflowsDir, e.name));
    }
  }
  const wrangler = path.join(vaultsUiDir, 'wrangler.toml');
  if (existsSync(wrangler)) out.push(wrangler);
  return out.sort();
}

// ---------------------------------------------------------------------------- deployment manifests

/**
 * Every `contracts/config/deployments/*.json` record, parsed. This directory (not the sibling
 * `contracts/config/*.json` launch-parameter files, a different thing) is what
 * `scripts/lib/deployment-currency.mjs` already treats as the deployment source of truth.
 *
 * @param {string} deploymentsDir
 * @returns {{ file: string, basename: string, manifest: any }[]}
 */
export function readDeploymentManifests(deploymentsDir) {
  if (!existsSync(deploymentsDir)) return [];
  return readdirSync(deploymentsDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => {
      const file = path.join(deploymentsDir, e.name);
      const manifest = JSON.parse(readFileSync(file, 'utf8'));
      return { file, basename: e.name.replace(/\.json$/, ''), manifest };
    })
    .sort((a, b) => a.file.localeCompare(b.file));
}

/**
 * Recursively walks one manifest and collects every address it declares as belonging to a deployed
 * vault — see the module header for exactly which keys count and why `VaultFactory`/`VaultDeployer`
 * do not.
 *
 * @param {any} manifest
 * @param {string} fileLabel for the `source` field only, so a failure message can point somewhere
 * @returns {{ address: string, original: string, source: string }[]}
 */
export function collectManifestVaultAddresses(manifest, fileLabel) {
  /** @type {{ address: string, original: string, source: string }[]} */
  const found = [];

  const push = (/** @type {unknown} */ address, /** @type {string} */ source) => {
    if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return;
    found.push({ address: address.toLowerCase(), original: address, source });
  };

  (function walk(/** @type {any} */ node, /** @type {string[]} */ pathParts) {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const here = [...pathParts, key];
      if (VAULT_KEY_RE.test(key) && value && typeof value === 'object' && !Array.isArray(value)) {
        push(/** @type {any} */ (value).address, `${fileLabel}:${here.join('.')}.address`);
      }
      if (VAULTS_ARRAY_KEY_RE.test(key) && Array.isArray(value)) {
        value.forEach((item, i) => {
          if (typeof item === 'string') push(item, `${fileLabel}:${here.join('.')}[${i}]`);
          else if (item && typeof item === 'object') push(item.address, `${fileLabel}:${here.join('.')}[${i}].address`);
        });
      }
      if (value && typeof value === 'object') walk(value, here);
    }
  })(manifest, []);

  return found;
}

/**
 * Every manifest's vault addresses, indexed by lowercased address so a chain-mismatch check is a
 * map lookup. One address can legitimately appear under more than one manifest record (unlikely
 * today, possible once there is more than one live chain), so each entry is a list.
 *
 * @param {{ file: string, manifest: any }[]} manifestRecords
 * @returns {Map<string, { file: string, chainId: unknown, chainName: unknown, original: string, source: string }[]>}
 */
export function buildVaultAddressIndex(manifestRecords) {
  /** @type {Map<string, { file: string, chainId: unknown, chainName: unknown, original: string, source: string }[]>} */
  const index = new Map();
  for (const { file, manifest } of manifestRecords) {
    const chainId = manifest?.chainId;
    const chainName = manifest?.chainName ?? path.basename(file);
    for (const { address, original, source } of collectManifestVaultAddresses(manifest, path.basename(file))) {
      const list = index.get(address) ?? [];
      list.push({ file, chainId, chainName, original, source });
      index.set(address, list);
    }
  }
  return index;
}

// ---------------------------------------------------------------------------- the cross-check

/**
 * @typedef {object} AddressIssue
 * @property {string | null} address
 * @property {'malformed'|'empty'|'unknown'|'chain-mismatch'} status
 * @property {string} reason
 *
 * @typedef {object} FileResult
 * @property {string} file
 * @property {string} [chainIdRaw]
 * @property {{ address: string, status: 'ok'|'malformed'|'unknown'|'chain-mismatch' }[]} addresses
 * @property {AddressIssue[]} issues
 * @property {true} [skipped]
 */

/**
 * The shared check behind both `checkEnvFile` and `checkDeployConfigFile`: split
 * `VITE_VAULT_ADDRESSES` on commas, and for each address decide `ok` / `malformed` / `unknown` /
 * `chain-mismatch` against the index built from `contracts/config/deployments/*.json`.
 *
 * `chain-mismatch` also covers a MISSING or non-numeric `VITE_CHAIN_ID` in the same file — an
 * address this repo has deployed somewhere is not evidence it is deployed on whatever chain this
 * file does (or fails to) declare, so an unconfirmed chain is treated as a mismatch, not a pass.
 *
 * @param {string} file
 * @param {string} raw the VITE_VAULT_ADDRESSES value
 * @param {string | undefined} chainIdRaw the VITE_CHAIN_ID value from the SAME file
 * @param {ReturnType<typeof buildVaultAddressIndex>} index
 * @returns {FileResult}
 */
export function evaluateAddresses(file, raw, chainIdRaw, index) {
  const chainId = chainIdRaw !== undefined ? Number(chainIdRaw) : NaN;
  const chainIdOk = Number.isInteger(chainId) && chainId > 0;
  const declared = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  /** @type {FileResult['addresses']} */
  const addresses = [];
  /** @type {AddressIssue[]} */
  const issues = [];

  if (declared.length === 0) {
    issues.push({
      address: null,
      status: 'empty',
      reason: 'VITE_VAULT_ADDRESSES is set but empty after splitting on comma',
    });
    return { file, chainIdRaw, addresses, issues };
  }

  for (const original of declared) {
    if (!ADDRESS_RE.test(original)) {
      addresses.push({ address: original, status: 'malformed' });
      issues.push({
        address: original,
        status: 'malformed',
        reason: 'not a well-formed 0x-prefixed, 40-hex-character address',
      });
      continue;
    }

    const hits = index.get(original.toLowerCase()) ?? [];
    if (hits.length === 0) {
      addresses.push({ address: original, status: 'unknown' });
      issues.push({
        address: original,
        status: 'unknown',
        reason: 'unknown address -- not present in any contracts/config/deployments/*.json manifest',
      });
      continue;
    }

    const onDeclaredChain = chainIdOk && hits.some((h) => h.chainId === chainId);
    if (!onDeclaredChain) {
      const knownOn = [...new Set(hits.map((h) => `${h.chainName ?? h.file} (chainId ${h.chainId ?? 'unset'})`))].join(', ');
      addresses.push({ address: original, status: 'chain-mismatch' });
      issues.push({
        address: original,
        status: 'chain-mismatch',
        reason:
          `known vault address, but only on ${knownOn} -- this file declares ` +
          `VITE_CHAIN_ID=${chainIdRaw ?? '(unset)'}, a different chain`,
      });
      continue;
    }

    addresses.push({ address: original, status: 'ok' });
  }

  return { file, chainIdRaw, addresses, issues };
}

/**
 * @param {string} file
 * @param {string} text
 * @param {ReturnType<typeof buildVaultAddressIndex>} index
 * @returns {FileResult}
 */
export function checkEnvFile(file, text, index) {
  const vars = parseEnvText(text);
  const raw = vars.VITE_VAULT_ADDRESSES;
  if (raw === undefined) return { file, addresses: [], issues: [], skipped: true };
  return evaluateAddresses(file, raw, vars.VITE_CHAIN_ID, index);
}

/**
 * @param {string} file
 * @param {string} text
 * @param {ReturnType<typeof buildVaultAddressIndex>} index
 * @returns {FileResult}
 */
export function checkDeployConfigFile(file, text, index) {
  const raw = extractLooseVar(text, 'VITE_VAULT_ADDRESSES');
  if (raw === undefined) return { file, addresses: [], issues: [], skipped: true };
  const chainIdRaw = extractLooseVar(text, 'VITE_CHAIN_ID');
  return evaluateAddresses(file, raw, chainIdRaw, index);
}

/**
 * @param {AddressIssue} issue
 * @returns {string}
 */
export function formatIssue(issue) {
  return issue.address ? `${issue.address} -- ${issue.reason}` : issue.reason;
}

/**
 * @typedef {object} LintOutcome
 * @property {string | null} hardError set when the check could not run at all (see below); never
 *   set alongside `results`
 * @property {FileResult[]} results one entry per config source that actually declares
 *   VITE_VAULT_ADDRESSES
 * @property {number} [envFilesScanned]
 * @property {number} [manifestsScanned]
 */

/**
 * The whole cross-check, end to end, reading from real paths. THREE distinct "nothing was checked"
 * shapes are all `hardError` — never a silent pass — because a guard that can report 0 issues over 0
 * inputs is a guard that will:
 *
 *   1. No `.env`-shaped file at all under `vaultsUiDir` (`.env.example` is always committed, so this
 *      means the workspace itself is missing or moved).
 *   2. No `contracts/config/deployments/*.json` manifest at all (nothing to cross-check against).
 *   3. `.env`-shaped files exist, and deploy config was scanned, but NONE of them set
 *      `VITE_VAULT_ADDRESSES` — the check ran and found nothing to check, which is the same trap one
 *      level up.
 *
 * @param {{ vaultsUiDir: string, deploymentsDir: string, repoRoot?: string }} args
 * @returns {LintOutcome}
 */
export function lintVaultAddresses({ vaultsUiDir, deploymentsDir, repoRoot }) {
  const envFiles = findEnvFiles(vaultsUiDir);
  if (envFiles.length === 0) {
    return {
      hardError:
        `no .env-shaped file found under ${vaultsUiDir} -- expected at least .env.example, which is ` +
        'committed to this repository. Cannot check VITE_VAULT_ADDRESSES against anything.',
      results: [],
    };
  }

  const manifestRecords = readDeploymentManifests(deploymentsDir);
  if (manifestRecords.length === 0) {
    return {
      hardError: `no deployment manifest found under ${deploymentsDir} -- nothing to cross-check VITE_VAULT_ADDRESSES against.`,
      results: [],
    };
  }

  const index = buildVaultAddressIndex(manifestRecords);

  const envResults = envFiles.map((f) => checkEnvFile(f, readFileSync(f, 'utf8'), index)).filter((r) => !r.skipped);

  const deployCandidates = repoRoot ? findDeployConfigCandidates({ repoRoot, vaultsUiDir }) : [];
  const deployResults = deployCandidates
    .map((f) => checkDeployConfigFile(f, readFileSync(f, 'utf8'), index))
    .filter((r) => !r.skipped);

  if (envResults.length === 0 && deployResults.length === 0) {
    return {
      hardError:
        `${envFiles.length} .env-shaped file(s) found under ${vaultsUiDir}, but none set VITE_VAULT_ADDRESSES ` +
        `(checked: ${envFiles.map((f) => path.basename(f)).join(', ')}${
          deployCandidates.length ? `, and ${deployCandidates.length} deploy config file(s)` : ''
        }). Nothing was checked.`,
      results: [],
    };
  }

  return {
    hardError: null,
    results: [...envResults, ...deployResults],
    envFilesScanned: envFiles.length,
    manifestsScanned: manifestRecords.length,
  };
}
