// @ts-check
/**
 * Real-bytecode fork plumbing for card 208's routed-createVault proof
 * (scripts/test/safe-route-fork.test.mjs). Forks Base Sepolia with anvil, runs the UNMODIFIED
 * `contracts/script/DeployTestnet.s.sol` onto it, and deploys a Safe through the REAL canonical
 * `SafeProxyFactory`/`SafeL2` v1.4.1 bytecode that is already live on Base Sepolia (and therefore
 * present in the forked state) — the same mastercopy the Arc mainnet creator Safe
 * (`0x99e805294F1f1465C96f68e36264E99991Ef9E82`) points at, confirmed by reading that Safe's own
 * storage slot 0 on `rpc.mainnet.arc.io` and finding real bytecode at the SAME address on Base
 * Sepolia. Nothing here is a mock of a Safe: it is the real, audited contract.
 *
 * PRIOR ART. `apps/vaults-ui/test/lib/ui-smoke-chain.mjs` (PR #373, open, not on `protocol/main`)
 * established the fork-a-testnet-and-deploy-for-real pattern this file follows (same reasoning for
 * WHY A FORK rather than a bare anvil chain: `ChainlinkOracle` caches `decimals()` from real feed
 * addresses at construction, which only exist with real state behind them). That PR is unmerged, so
 * this file does not import it — these are this file's own, minimal helpers, scoped to what card
 * 208 needs (no viem dependency: `scripts/` is zero-npm-dependency by smoke-test.mjs's own header,
 * so key generation and signing go through `cast wallet` exactly as the rest of this directory does).
 *
 * KEY HANDLING. Every key `generateThrowawayAccount()` returns is `cast wallet new`'s own CSPRNG
 * output, discarded when the process exits. Nothing here reads an environment variable, a keystore
 * path or a password file that could carry the owner's key. Funding is `anvil_setBalance` /
 * `anvil_setStorageAt` against the LOCAL FORK ONLY — never a broadcast to a public endpoint; the
 * fork reads Base Sepolia's state once, read-only, at startup, and touches it never again.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..', '..');
export const CONTRACTS_DIR = path.join(REPO, 'contracts');
export const BASE_SEPOLIA_CHAIN_ID = 84532;
// Fork source: the Tenderly public gateway, not sepolia.base.org. anvil fetches fork state lazily, one
// eth_getStorageAt/getCode per slot, and sepolia.base.org rate-limits under that load (measured
// 2026-09-23; CI flakes "transaction was not confirmed within the timeout" and whole fork suites
// red, card 215). BASE_SEPOLIA_RPC still overrides it. FORK_RESILIENCE_ARGS retries a throttled
// fetch instead of stalling the transaction that needed it.
export const BASE_SEPOLIA_RPC = process.env.BASE_SEPOLIA_RPC ?? 'https://base-sepolia.gateway.tenderly.co';
export const FORK_RESILIENCE_ARGS = ['--retries', '10', '--fork-retry-backoff', '1000', '--timeout', '60000'];

// Real, canonical Safe v1.4.1 deployment addresses -- IDENTICAL across every chain that has had them
// deployed, because they are created via a deterministic CREATE2 factory. Confirmed live on Base
// Sepolia (`cast codesize`, 2026-09-23): mastercopy 24421 bytes, factory 3054 bytes, fallback handler
// 5637 bytes -- all nonzero, so forking Base Sepolia carries this bytecode for real, not as a fixture.
// The mastercopy address was cross-checked against `eth_getStorageAt` slot 0 of the LIVE Arc mainnet
// creator Safe (0x99e805294F1f1465C96f68e36264E99991Ef9E82 on rpc.mainnet.arc.io), which points at
// this exact address -- so this is the SAME contract the real Safe runs, not merely the same version.
export const SAFE_MASTERCOPY_1_4_1 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
export const SAFE_PROXY_FACTORY_1_4_1 = '0x4e1DCF7AD4e460CfD30791CCC4F9c8a4f820ec67';
export const SAFE_FALLBACK_HANDLER_1_4_1 = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ─────────────────────────────────────── process plumbing ───────────────────────────────────────

const binCache = new Map();
/** Resolve a bare binary name once, THROWING rather than skipping — a guard that can skip is a
 *  guard that will (this repository's own standard). Mirrors gate.mjs's `resolveBin`. */
export function requireBin(name) {
  if (binCache.has(name)) return binCache.get(name);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [name], { encoding: 'utf8' });
  const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!first) throw new Error(`safe-fork-chain: '${name}' is not on PATH. Install Foundry before running this suite.`);
  binCache.set(name, first);
  return first;
}

function run(bin, args, opts = {}) {
  const r = spawnSync(requireBin(bin), args, { encoding: 'utf8', cwd: opts.cwd, windowsHide: true, timeout: opts.timeout });
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.slice(0, 6).join(' ')}… failed (exit ${r.status}, signal ${r.signal}):\n${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? '').trim();
}
export const cast = (args, opts) => run('cast', args, opts);
export const castJson = (args, opts) => JSON.parse(cast(args, opts));
/** cast's " [1.23e45]" scientific-notation annotation, stripped -- same transform scripts/smoke-test.mjs's own `clean()` applies. */
export const clean = (line) => line.replace(/\s+\[[^\]]*\]$/, '').trim();
export const topicToAddress = (t) => '0x' + t.slice(26);

// ─────────────────────────────────────────── anvil fork ───────────────────────────────────────────

/** Starts `anvil --fork-url <BASE_SEPOLIA_RPC> --chain-id 84532` and waits for it to answer.
 *  Returns `{ rpcUrl, stop() }`; `stop()` is idempotent. */
export async function startFork({ port }) {
  const bin = requireBin('anvil');
  const child = spawn(bin, [
    '--fork-url', BASE_SEPOLIA_RPC, '--chain-id', String(BASE_SEPOLIA_CHAIN_ID),
    '--port', String(port), '--silent', ...FORK_RESILIENCE_ARGS,
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30_000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited before it came up (code ${child.exitCode}):\n${stderr}`);
    try {
      if (cast(['chain-id', '--rpc-url', rpcUrl]).trim() === String(BASE_SEPOLIA_CHAIN_ID)) {
        return { rpcUrl, stop() { if (!child.killed) child.kill(); } };
      }
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`anvil fork never answered chain-id ${BASE_SEPOLIA_CHAIN_ID} on ${rpcUrl}: ${lastErr}`);
}

// ─────────────────────────────────────────── throwaway keys ───────────────────────────────────────────

/** A fresh secp256k1 key from `cast wallet new`'s own CSPRNG — never persisted, never the owner's. */
export function generateThrowawayAccount() {
  const [kp] = castJson(['wallet', 'new', '--json']);
  return { privateKey: kp.private_key, address: kp.address };
}

// ─────────────────────────────────────────── funding ───────────────────────────────────────────

export function setEthBalance(rpcUrl, address, weiHex) {
  cast(['rpc', 'anvil_setBalance', address, weiHex, '--rpc-url', rpcUrl]);
}

const toHex32 = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/** Gives `address` an ERC-20 `balanceOf` of `amount` on `token` by writing the storage slot
 *  directly — Base Sepolia's real Circle test USDC has no public mint. The slot is FOUND, not
 *  assumed: brute-forced against the real deployed bytecode with a distinctive probe value, so a
 *  wrong assumption about storage layout throws rather than silently reporting a fund that was
 *  never granted. (Technique verified independently in this session's own spike, not merely
 *  copied: probing 32 candidate `mapping(address => uint256)` slots and reading `balanceOf` back.) */
export function dealErc20(rpcUrl, token, address, amount) {
  const probe = 0x1234n;
  for (let slot = 0; slot < 32; slot++) {
    const key = cast(['index', 'address', address, String(slot)]);
    const prev = cast(['storage', token, key, '--rpc-url', rpcUrl]);
    cast(['rpc', 'anvil_setStorageAt', token, key, toHex32(probe), '--rpc-url', rpcUrl]);
    const bal = BigInt(clean(cast(['call', token, 'balanceOf(address)(uint256)', address, '--rpc-url', rpcUrl])));
    if (bal === probe) {
      cast(['rpc', 'anvil_setStorageAt', token, key, toHex32(amount), '--rpc-url', rpcUrl]);
      const finalBal = BigInt(clean(cast(['call', token, 'balanceOf(address)(uint256)', address, '--rpc-url', rpcUrl])));
      if (finalBal !== amount) throw new Error(`dealErc20: slot ${slot} accepted the probe but not the real amount (got ${finalBal}, wanted ${amount})`);
      return slot;
    }
    cast(['rpc', 'anvil_setStorageAt', token, key, prev, '--rpc-url', rpcUrl]); // not the slot: restore it
  }
  throw new Error(`dealErc20: could not find the balanceOf storage slot for ${token} after 32 candidates`);
}

// ─────────────────────────────────────────── deploy ───────────────────────────────────────────

/**
 * A cross-process mutex around `deployProtocol`, added when scripts/test/safe-tx-builder-fork.test.mjs
 * and scripts/test/safe-tx-builder-refusals.test.mjs started calling this function alongside
 * scripts/test/safe-route-fork.test.mjs's own calls. `node --test` runs separate test FILES as
 * separate processes, and `forge script --broadcast` always writes to the SAME fixed path
 * (`contracts/broadcast/DeployTestnet.s.sol/84532/run-latest.json`) regardless of which process
 * invoked it -- with a single caller this was safe (this function's own snapshot-immediately-after
 * comment already documents the ONE-caller race it guards against), but two DIFFERENT processes
 * running `forge script --broadcast` at overlapping times can interleave their writes to that one
 * path, and the reader here has no way to tell a torn/foreign write from its own. Measured directly:
 * running safe-route-fork.test.mjs together with the two files above reproduced
 * "registry.wire() did NOT revert" and "Cannot read properties of undefined (reading 'topics')" --
 * failures with no connection to what either file's own logic does, which is what a cross-process
 * write race on a shared fixed path looks like. A simple exclusive-create lock file, retried with
 * backoff, serializes every `deployProtocol` call machine-wide for the duration of the deploy +
 * read, which is the only window that matters -- callers still snapshot their own copy immediately
 * after, exactly as before, so nothing DOWNSTREAM of this function needs to change.
 */
const DEPLOY_LOCK_PATH = path.join(os.tmpdir(), 'agv-safe-fork-chain-deploy-protocol.lock');

function withDeployLock(fn) {
  const deadline = Date.now() + 90_000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(DEPLOY_LOCK_PATH, 'wx'); // atomic exclusive create; throws EEXIST if held
      break;
    } catch (e) {
      if (/** @type {any} */ (e).code !== 'EEXIST') throw e;
      if (Date.now() > deadline) {
        throw new Error(`withDeployLock: timed out waiting for ${DEPLOY_LOCK_PATH} -- a previous holder may have crashed without releasing it; delete the file by hand if so.`);
      }
      // Synchronous backoff: this runs inside a `before()` hook, not inside the event loop's own
      // async work, so a busy-wait via Atomics.wait (the same primitive scripts/smoke-test.mjs's own
      // sleepSync uses) is simpler here than threading a real async retry through every caller.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      continue;
    }
  }
  try {
    fs.closeSync(fd);
    return fn();
  } finally {
    try { fs.unlinkSync(DEPLOY_LOCK_PATH); } catch { /* already gone, or never fully created */ }
  }
}

/** `forge script DeployTestnet.s.sol --broadcast`, UNMODIFIED, against the local fork. Returns the
 *  singleton addresses parsed from its own broadcast receipt. Serialized machine-wide by
 *  `withDeployLock` (see its own doc) against every other concurrent caller of this function. */
export function deployProtocol(rpcUrl, privateKey) {
  return withDeployLock(() => {
    run('forge', [
      'script', 'script/DeployTestnet.s.sol:DeployTestnet',
      '--rpc-url', rpcUrl, '--private-key', privateKey, '--broadcast', '--non-interactive',
    ], { cwd: CONTRACTS_DIR, timeout: 120_000 });
    const deployJson = path.join(CONTRACTS_DIR, 'broadcast', 'DeployTestnet.s.sol', String(BASE_SEPOLIA_CHAIN_ID), 'run-latest.json');
    if (!fs.existsSync(deployJson)) throw new Error(`deployProtocol: expected forge to write ${deployJson}`);
    const j = JSON.parse(fs.readFileSync(deployJson, 'utf8'));
    const byName = {};
    for (const tx of j.transactions ?? []) if (tx.transactionType === 'CREATE' && tx.contractName) (byName[tx.contractName] ??= []).push(tx.contractAddress);
    const one = (name) => {
      const a = byName[name] ?? [];
      if (a.length !== 1) throw new Error(`deployProtocol: expected exactly one ${name}, found ${a.length}`);
      return a[0];
    };
    return {
      registry: one('OperatorRegistry'),
      governance: one('Governance'),
      feeEngine: one('FeeEngine'),
      subVaultRegistry: one('SubVaultRegistry'),
      vaultDeployer: one('VaultDeployer'),
      factory: one('VaultFactory'),
      aggregator: one('ChainlinkOracle'),
      adapter: one('AggregationRouterAdapter'),
      deployJsonPath: deployJson,
    };
  });
}

// ─────────────────────────────────────────── Safe deployment ───────────────────────────────────────────

/**
 * Deploys a real `SafeL2` v1.4.1 proxy via the real canonical `SafeProxyFactory`, with `owners` and
 * `threshold` the caller supplies. Returns the new Safe's address, read from `ProxyCreation`'s
 * INDEXED `proxy` argument (topics[1]) -- found empirically in this session's own spike: the naive
 * assumption that `proxy` rides in `data` (unindexed) silently decoded the MASTERCOPY address
 * instead, because `singleton` is what `data` actually carries.
 */
export function deploySafe(rpcUrl, broadcasterKey, owners, threshold) {
  const setupCalldata = cast(['calldata',
    'setup(address[],uint256,address,bytes,address,address,uint256,address)',
    `[${owners.join(',')}]`, String(threshold), ZERO_ADDRESS, '0x',
    SAFE_FALLBACK_HANDLER_1_4_1, ZERO_ADDRESS, '0', ZERO_ADDRESS]);
  const saltNonce = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  const out = cast(['send', SAFE_PROXY_FACTORY_1_4_1, 'createProxyWithNonce(address,bytes,uint256)',
    SAFE_MASTERCOPY_1_4_1, setupCalldata, saltNonce, '--rpc-url', rpcUrl, '--private-key', broadcasterKey, '--json']);
  const receipt = JSON.parse(out.slice(out.indexOf('{')));
  if (receipt.status !== '0x1' && receipt.status !== 1) throw new Error(`deploySafe: createProxyWithNonce reverted (${receipt.transactionHash})`);
  const T_PROXY_CREATION = cast(['keccak', 'ProxyCreation(address,address)']);
  const proxyLog = receipt.logs.find((l) => l.topics?.[0] === T_PROXY_CREATION);
  if (!proxyLog) throw new Error('deploySafe: ProxyCreation event not found in receipt');
  return topicToAddress(proxyLog.topics[1]);
}

export function readSafe(rpcUrl, safe) {
  return {
    threshold: BigInt(clean(cast(['call', safe, 'getThreshold()(uint256)', '--rpc-url', rpcUrl]))),
    owners: cast(['call', safe, 'getOwners()(address[])', '--rpc-url', rpcUrl])
      .replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean),
    nonce: BigInt(clean(cast(['call', safe, 'nonce()(uint256)', '--rpc-url', rpcUrl]))),
  };
}

export function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}
