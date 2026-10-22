// @ts-check
/**
 * The same-address CREATE2 manifest, computed from the compiled artifacts.
 *
 * `contracts/config/create2-manifest.json` records, for each protocol singleton whose address must
 * match across chains: its salt, its initcode hash and the address the Arachnid proxy gives it. This
 * module recomputes all of that from `contracts/out` with viem, a different implementation from the
 * Solidity one in `contracts/script/lib/ProtocolCreate2.sol`. `contracts/test/Create2Determinism.t.sol`
 * holds the manifest to the compiler; `scripts/test/create2-manifest.test.mjs` holds it to this module.
 * Two readers that share no code are the point: a manifest that only agrees with the code that wrote it
 * is evidence about that code.
 *
 * Regenerate with `node scripts/update-create2-manifest.mjs` after `forge build`, and read what moved.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeAbiParameters, getAddress, getCreate2Address, keccak256, toBytes } from 'viem';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MANIFEST_PATH = path.join(ROOT, 'contracts', 'config', 'create2-manifest.json');
export const SALT_PREFIX = 'rwally.protocol.v2.';
export const ALLOW_SUB_VAULTS = false;

/**
 * Deployment order is dependency order: FeeEngine embeds the registry, the factory embeds five.
 * AgentVaultDeployer embeds nothing and the factory does not embed it (it is wired through
 * `VaultFactory.initializeAgentPath`), so it sits beside VaultDeployer.
 */
export const CONTRACTS = [
  'OperatorRegistry',
  'SubVaultRegistry',
  'FeeEngine',
  'Governance',
  'VaultDeployer',
  'AgentVaultDeployer',
  'VaultFactory',
];

/** @param {string} name */
export function artifactPath(name) {
  return path.join(ROOT, 'contracts', 'out', `${name}.sol`, `${name}.json`);
}

/** Creation bytecode from the forge artifact. Throws if the build is absent: a guard that skips will. @param {string} name */
export function creationCode(name) {
  const p = artifactPath(name);
  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    throw new Error(`create2-manifest: ${p} is missing. Run \`forge build\` in contracts/ first.`);
  }
  const code = JSON.parse(raw).bytecode?.object;
  if (typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code) || code.length < 10) {
    throw new Error(`create2-manifest: no usable bytecode in ${p}`);
  }
  if (code.includes('__$')) throw new Error(`create2-manifest: ${p} has unlinked library placeholders`);
  return /** @type {`0x${string}`} */ (code);
}

/** @param {{proxy:string, initializer:string}} fixed */
export function computeManifest(fixed) {
  const proxy = getAddress(fixed.proxy);
  /** @type {Record<string, {salt:string, saltPreimage:string, initcodeBytes:number, initcodeHash:string, address:string}>} */
  const contracts = {};
  /** @type {Record<string, string>} */
  const addr = {};
  for (const name of CONTRACTS) {
    let ctor = '0x';
    if (name === 'FeeEngine') {
      ctor = encodeAbiParameters([{ type: 'address' }], [/** @type {`0x${string}`} */ (addr.OperatorRegistry)]);
    } else if (name === 'VaultFactory') {
      ctor = encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'bool' }],
        [
          /** @type {`0x${string}`} */ (addr.OperatorRegistry),
          /** @type {`0x${string}`} */ (addr.Governance),
          /** @type {`0x${string}`} */ (addr.FeeEngine),
          /** @type {`0x${string}`} */ (addr.SubVaultRegistry),
          /** @type {`0x${string}`} */ (addr.VaultDeployer),
          ALLOW_SUB_VAULTS,
        ],
      );
    }
    const initcode = /** @type {`0x${string}`} */ (creationCode(name) + ctor.slice(2));
    const saltPreimage = `${SALT_PREFIX}${name}`;
    const salt = keccak256(toBytes(saltPreimage));
    const initcodeHash = keccak256(initcode);
    const address = getCreate2Address({ from: proxy, salt, bytecodeHash: initcodeHash });
    addr[name] = address;
    contracts[name] = { salt, saltPreimage, initcodeBytes: (initcode.length - 2) / 2, initcodeHash, address };
  }
  return contracts;
}

/** Read the two fixed values out of source rather than restating them. */
export function readFixedFromSource() {
  const init = readFileSync(path.join(ROOT, 'contracts', 'src', 'lib', 'ProtocolInitializer.sol'), 'utf8');
  const initializer = /address constant PROTOCOL_INITIALIZER = (0x[0-9a-fA-F]{40});/.exec(init)?.[1];
  const lib = readFileSync(path.join(ROOT, 'contracts', 'script', 'lib', 'ProtocolCreate2.sol'), 'utf8');
  const proxy = /address internal constant PROXY = (0x[0-9a-fA-F]{40});/.exec(lib)?.[1];
  if (!initializer) throw new Error('create2-manifest: PROTOCOL_INITIALIZER literal not found in ProtocolInitializer.sol');
  if (!proxy) throw new Error('create2-manifest: PROXY literal not found in ProtocolCreate2.sol');
  return { initializer: getAddress(initializer), proxy: getAddress(proxy) };
}

export function buildManifest() {
  const fixed = readFixedFromSource();
  return {
    schema: 1,
    proxy: fixed.proxy,
    initializer: fixed.initializer,
    build: {
      solc: '0.8.26',
      evmVersion: 'cancun',
      viaIR: true,
      optimizerRuns: 800,
      bytecodeHash: 'none',
      cborMetadata: false,
    },
    contracts: computeManifest(fixed),
  };
}
