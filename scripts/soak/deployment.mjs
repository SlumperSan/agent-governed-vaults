// @ts-check
/**
 * Soak-run deployment loader.
 *
 * Sprint-9 drove `smoke-test.mjs` off forge's broadcast JSON. That is NOT safe to reuse here:
 * the Sprint-9 report (§6.3) records that forge's per-transaction console labels and the
 * broadcast JSON's contractName<->hash alignment were BOTH scrambled for the deploy run, and
 * taking them at face value would have swapped VaultFactory and VaultDeployer in the address
 * book. The addresses that survived scrutiny are the ones in
 * `contracts/config/deployments/base-sepolia.json`, each confirmed by direct on-chain reads
 * (codesize + wiring) rather than by the deploy log.
 *
 * This module therefore reads the VERIFIED ADDRESS BOOK, and — because a committed JSON file
 * can still drift from the chain — exposes `wiringExpectations()` so a caller can re-prove the
 * wiring live before spending a signature against it.
 *
 * Pure: parsing and validation do no I/O, so they are unit-testable. The one I/O entry point
 * (`loadDeployment`) is a thin fs wrapper over `parseDeployment`.
 */
import fs from 'node:fs';

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** The singletons every soak drill needs by name. */
const REQUIRED_SINGLETONS = [
  'OperatorRegistry', 'SubVaultRegistry', 'FeeEngine',
  'Governance', 'VaultDeployer', 'VaultFactory',
];

/**
 * Parse + validate a deployments address book.
 * @param {unknown} raw parsed JSON
 * @param {{expectChainId?: number}} [opts]
 * @returns {{
 *   chainId: number, chainName: string, rpc: string, explorer: string,
 *   startBlock: number, deployer: string,
 *   registry: string, subRegistry: string, feeEngine: string, governance: string,
 *   vaultDeployer: string, factory: string, aggregator: string, adapter: string,
 *   usdc: string, maxStalenessSeconds: number,
 *   assets: {symbol: string, token: string, quorum: number, sources: string[], underlyingFeed: string}[],
 * }}
 */
export function parseDeployment(raw, opts = {}) {
  if (!raw || typeof raw !== 'object') throw new Error('deployment: not a JSON object');
  const d = /** @type {any} */ (raw);

  const chainId = Number(d.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`deployment: bad chainId ${d.chainId}`);
  if (opts.expectChainId != null && chainId !== opts.expectChainId) {
    throw new Error(`deployment: chainId ${chainId} != expected ${opts.expectChainId}`);
  }

  const s = d.singletons ?? {};
  const missing = REQUIRED_SINGLETONS.filter((k) => !s[k]);
  if (missing.length) throw new Error(`deployment: missing singletons: ${missing.join(', ')}`);

  const need = (label, v) => {
    if (typeof v !== 'string' || !ADDR.test(v)) {
      throw new Error(`deployment: ${label} is not a 20-byte address: ${v}`);
    }
    return v;
  };

  const oracle = d.oracle ?? {};
  const assetsIn = oracle.assets ?? {};
  const assets = Object.entries(assetsIn).map(([symbol, a]) => {
    const cfg = /** @type {any} */ (a);
    const sources = Array.isArray(cfg.sources) ? cfg.sources : [];
    if (sources.length === 0) throw new Error(`deployment: asset ${symbol} lists no oracle sources`);
    return {
      symbol,
      token: need(`asset ${symbol} token`, cfg.token),
      quorum: Number(cfg.quorum),
      sources: sources.map((x, i) => need(`asset ${symbol} source ${i}`, x)),
      underlyingFeed: need(`asset ${symbol} underlyingFeed`, cfg.underlyingFeed),
    };
  });
  if (assets.length === 0) throw new Error('deployment: oracle lists no assets');

  return {
    chainId,
    chainName: String(d.chainName ?? ''),
    rpc: String(d.rpc ?? ''),
    explorer: String(d.explorer ?? ''),
    startBlock: Number(d.startBlock ?? d.deployBlock ?? 0),
    deployer: need('deployer', d.deployer),
    registry: need('OperatorRegistry', s.OperatorRegistry),
    subRegistry: need('SubVaultRegistry', s.SubVaultRegistry),
    feeEngine: need('FeeEngine', s.FeeEngine),
    governance: need('Governance', s.Governance),
    vaultDeployer: need('VaultDeployer', s.VaultDeployer),
    factory: need('VaultFactory', s.VaultFactory),
    aggregator: need('OracleAggregator', oracle.OracleAggregator),
    adapter: need('AggregationRouterAdapter', (d.execution ?? {}).AggregationRouterAdapter),
    usdc: need('usdc', (d.infrastructure ?? {}).usdc),
    maxStalenessSeconds: Number(oracle.maxStalenessSeconds ?? 0),
    assets,
  };
}

/**
 * The wiring reads a caller should re-prove on-chain before trusting the book.
 * Returned as [contract, signature, expectedAddress] so the caller drives its own RPC.
 * Mirrors the `verifiedWiring` block Sprint-9 confirmed, so a silent redeploy under the
 * same config file cannot go unnoticed.
 * @param {ReturnType<typeof parseDeployment>} dep
 * @returns {{to: string, sig: string, expect: string, label: string}[]}
 */
export function wiringExpectations(dep) {
  return [
    { to: dep.registry, sig: 'factory()(address)', expect: dep.factory, label: 'registry.factory()' },
    { to: dep.registry, sig: 'feeEngine()(address)', expect: dep.feeEngine, label: 'registry.feeEngine()' },
    { to: dep.subRegistry, sig: 'factory()(address)', expect: dep.factory, label: 'subReg.factory()' },
    { to: dep.governance, sig: 'subVaultRegistry()(address)', expect: dep.subRegistry, label: 'gov.subVaultRegistry()' },
    { to: dep.factory, sig: 'registry()(address)', expect: dep.registry, label: 'factory.registry()' },
    { to: dep.factory, sig: 'governance()(address)', expect: dep.governance, label: 'factory.governance()' },
    { to: dep.factory, sig: 'feeEngine()(address)', expect: dep.feeEngine, label: 'factory.feeEngine()' },
    { to: dep.factory, sig: 'subVaultRegistry()(address)', expect: dep.subRegistry, label: 'factory.subVaultRegistry()' },
    { to: dep.factory, sig: 'vaultDeployer()(address)', expect: dep.vaultDeployer, label: 'factory.vaultDeployer()' },
  ];
}

/**
 * @param {string} pathname path to the deployments JSON
 * @param {{expectChainId?: number}} [opts]
 */
export function loadDeployment(pathname, opts = {}) {
  if (!fs.existsSync(pathname)) throw new Error(`deployment: address book not found at ${pathname}`);
  return parseDeployment(JSON.parse(fs.readFileSync(pathname, 'utf8')), opts);
}
