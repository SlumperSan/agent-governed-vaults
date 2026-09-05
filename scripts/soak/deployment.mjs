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
 *
 * WHICH CHAIN A SOAK RUN TARGETS IS DECIDED HERE, ONCE. Every soak entrypoint used to name the
 * address book and repeat `{ expectChainId: 84532 }` at its own `loadDeployment` call, so eight
 * files had to agree before a run could point anywhere else. `deploymentPath` picks the record and
 * `assertLiveChainId` proves the RPC is the chain that record describes; the expected chain id is
 * the record's own `chainId` field and is not written down a second time.
 */
import fs from 'node:fs';
import path from 'node:path';

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
    // C-6 launch model (ChainlinkOracle): ONE genuine Chainlink feed per asset. Accept a single
    // `feed` as a one-element source set; still accept the legacy `sources` array (the retired
    // custom OracleAggregator) so old address books keep parsing.
    const sources =
      Array.isArray(cfg.sources) && cfg.sources.length ? cfg.sources : cfg.feed ? [cfg.feed] : [];
    if (sources.length === 0) throw new Error(`deployment: asset ${symbol} lists no oracle feed/sources`);
    return {
      symbol,
      token: need(`asset ${symbol} token`, cfg.token),
      quorum: Number(cfg.quorum ?? 1), // ChainlinkOracle is single-feed => quorum 1
      sources: sources.map((x, i) => need(`asset ${symbol} source ${i}`, x)),
      underlyingFeed: need(`asset ${symbol} underlyingFeed`, cfg.underlyingFeed ?? cfg.feed),
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
    // C-6: launch oracle is ChainlinkOracle; accept the legacy OracleAggregator key too. Kept under
    // the field name `aggregator` (ChainlinkOracle is an IOracleAggregator) so drills are unchanged.
    aggregator: need('oracle (ChainlinkOracle/OracleAggregator)', oracle.ChainlinkOracle ?? oracle.OracleAggregator),
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

/** Repo-relative location of the address book a soak run loads when nothing overrides it. */
export const DEFAULT_DEPLOYMENT = ['contracts', 'config', 'deployments', 'base-sepolia.json'];

/**
 * The address book a soak entrypoint should load.
 *
 * `SOAK_DEPLOYMENT` overrides it — absolute, or relative to the repo root. The documented default
 * is `contracts/config/deployments/base-sepolia.json`, which is the only address book committed
 * under that directory. Callers pass no `expectChainId`: the record carries `chainId`, so handing
 * that same number back to the parser is a comparison that cannot fail.
 *
 * @param {string} root repo root
 * @param {Record<string, string|undefined>} [env]
 */
export function deploymentPath(root, env = process.env) {
  const override = env.SOAK_DEPLOYMENT;
  if (override) return path.isAbsolute(override) ? override : path.join(root, override);
  return path.join(root, ...DEFAULT_DEPLOYMENT);
}

/**
 * Refuse a run whose RPC is not the chain the address book describes.
 *
 * The message names BOTH numbers on purpose. Which half is wrong — the record or the endpoint — is
 * the only thing the operator has to decide, and a bare "chain id mismatch" makes them guess.
 *
 * @param {{chainId: number, chainName: string}} dep
 * @param {number} liveChainId chain id read from the RPC
 * @returns {number} the record's chain id, once the live one has matched it
 */
export function assertLiveChainId(dep, liveChainId) {
  const live = Number(liveChainId);
  if (live !== dep.chainId) {
    throw new Error(
      `deployment: address book ${dep.chainName || '(unnamed)'} is chain ${dep.chainId}, `
      + `but the RPC answers chain ${live} — point SOAK_DEPLOYMENT and SOAK_RPC at the same chain`,
    );
  }
  return dep.chainId;
}
