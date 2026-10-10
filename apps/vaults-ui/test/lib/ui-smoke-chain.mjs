// @ts-check
/**
 * All the OUT-OF-BAND setup card 176's three UI flows need but do not themselves cover: a local
 * anvil fork of Base Sepolia, a real `DeployTestnet.s.sol` deployment onto it, a throwaway signer
 * funded on that fork alone, vault creation/registration, and the operator-side governance steps
 * (activate, propose, finalize, execute) that `apps/vaults-ui` has no button for. Every one of
 * these mirrors a step `scripts/smoke-test.mjs` already performs against the real network — this
 * file does not reinvent that lifecycle, it runs the identical calls against a local fork so the
 * MEMBER-signed steps (deposit, commit, reveal, exit) can be driven separately, through the real
 * `apps/vaults-ui/src/lib/chain-actions.ts`, by `ui-smoke.ts`.
 *
 * WHY A FORK, NOT A BARE ANVIL CHAIN. `contracts/config/base-sepolia.json` prices its basket
 * through REAL Chainlink feed contracts at fixed Base Sepolia addresses (WETH/LINK proxies).
 * `ChainlinkOracle` caches `decimals()` from those addresses AT CONSTRUCTION — on a bare, unforked
 * anvil chain there is no code at those addresses, so standing up a working oracle would mean
 * authoring mock feeds this file does not have and the real deployment does not use. Forking Base
 * Sepolia (`anvil --fork-url ... --chain-id 84532`) makes those addresses real contracts with real
 * state, so `DeployTestnet.s.sol` — UNMODIFIED, the same script `docs/TESTNET-CHECKLIST.md` uses for
 * the real deployment — runs here exactly as it would there.
 *
 * WHY THIS IS NOT "DEPENDING ON BASE SEPOLIA'S LIVENESS" THE WAY THE TASK WARNS AGAINST. Forking
 * reads state ONCE, read-only, at anvil startup, with no key and no funded account. Every write
 * after that point — the deploy, every `cast send`, every `evm_increaseTime` — runs entirely
 * against the local fork and touches the public network never again. If `sepolia.base.org` is
 * briefly unreachable when a run starts, the run fails to start; it can never fail mid-flow the way
 * a 4-hour wait against the real chain can, and it broadcasts nothing to a public chain.
 *
 * KEY HANDLING. `generateThrowawayKey()` uses viem's own CSPRNG — nothing here reads
 * `C:\Users\Micha\.soak.pw`, a keystore, or any environment variable that could carry the owner's
 * key. Every `cast`/`forge` invocation below takes `--private-key <throwaway>` directly; none uses
 * `--account`/`--keystore`. The deploy broadcasts with `--broadcast`, but the RPC it broadcasts TO
 * is the local anvil fork this module started, never a public endpoint.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { PROPOSAL_SIG, decodeProposal } from '../../../../scripts/lib/proposal-decode.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..', '..', '..');
export const CONTRACTS_DIR = path.join(REPO, 'contracts');
export const BASE_SEPOLIA_CHAIN_ID = 84532;

// ─────────────────────────────────────── process plumbing ───────────────────────────────────────

/** Resolve a bare binary name once, the way `scripts/gate.mjs`'s `resolveBin` does — but this
 * THROWS rather than returning null. A guard that can skip is a guard that will: a missing
 * `anvil`/`forge`/`cast` here must fail the test loudly, not silently report a pass over nothing. */
const binCache = new Map();
export function requireBin(name) {
  if (binCache.has(name)) return binCache.get(name);
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [name], { encoding: 'utf8' });
  const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (!first) {
    throw new Error(
      `ui-smoke-chain: '${name}' is not on PATH. Install Foundry (the version scripts/gate.mjs and ` +
        `ci.yml pin) before running this suite — it is a hard dependency, not an optional one.`,
    );
  }
  binCache.set(name, first);
  return first;
}

/** Run a Foundry binary and return trimmed stdout, throwing with stderr on a nonzero exit. Never
 * shell:true — these are real executables, not npm .cmd wrappers (see scripts/gate.mjs's own note
 * on why that distinction matters on Windows). */
function run(bin, args, opts = {}) {
  const r = spawnSync(requireBin(bin), args, { encoding: 'utf8', cwd: opts.cwd, windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`${bin} ${args.slice(0, 4).join(' ')}\u2026 failed (exit ${r.status}):\n${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? '').trim();
}

const cast = (args) => run('cast', args);
const castJson = (args) => JSON.parse(cast(args));

/** Strip cast's " [1.23e45]" scientific-notation annotation from a decimal output line — the same
 * transform scripts/smoke-test.mjs's own `clean()` applies before handing lines to
 * `decodeProposal`. Without it, `BigInt("5000000000000000000 [5e18]")` throws. */
const clean = (line) => line.replace(/\s+\[[^\]]*\]$/, '').trim();

// ────────────────────────────────────────── anvil fork ──────────────────────────────────────────

/**
 * Starts `anvil --fork-url <BASE_SEPOLIA_RPC> --chain-id 84532` in the background and waits for it
 * to answer. Returns `{ rpcUrl, stop() }`. `stop()` is idempotent and kills the whole process tree.
 */
// Same fork source and retry settings as scripts/test/lib/safe-fork-chain.mjs (card 215): sepolia.base.org
// rate-limits anvil's lazy state fetches under CI load.
export async function startFork({ port, forkUrl = process.env.BASE_SEPOLIA_RPC ?? 'https://base-sepolia.gateway.tenderly.co' } = {}) {
  const bin = requireBin('anvil');
  const { spawn } = await import('node:child_process');
  const child = spawn(
    bin,
    ['--fork-url', forkUrl, '--chain-id', String(BASE_SEPOLIA_CHAIN_ID), '--port', String(port), '--silent',
      '--retries', '10', '--fork-retry-backoff', '1000', '--timeout', '60000'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  );
  let stderr = '';
  child.stderr?.on('data', (d) => { stderr += String(d); });
  const rpcUrl = `http://127.0.0.1:${port}`;

  const deadline = Date.now() + 30_000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`anvil exited before it came up (code ${child.exitCode}):\n${stderr}`);
    }
    try {
      const id = cast(['chain-id', '--rpc-url', rpcUrl]);
      if (id.trim() === String(BASE_SEPOLIA_CHAIN_ID)) {
        return {
          rpcUrl,
          stop() {
            if (!child.killed) child.kill();
          },
        };
      }
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  child.kill();
  throw new Error(`anvil fork never answered chain-id ${BASE_SEPOLIA_CHAIN_ID} on ${rpcUrl}: ${lastErr}`);
}

// ────────────────────────────────────────── throwaway key ──────────────────────────────────────────

/** A fresh secp256k1 key from viem's own CSPRNG. Never persisted beyond this process's memory and
 * whatever env vars the caller chooses to pass a CHILD process — never written to disk. */
export function generateThrowawayAccount() {
  const privateKey = generatePrivateKey();
  return { privateKey, account: privateKeyToAccount(privateKey) };
}

// ────────────────────────────────────────── funding ──────────────────────────────────────────

export function setEthBalance(rpcUrl, address, weiHex) {
  cast(['rpc', 'anvil_setBalance', address, weiHex, '--rpc-url', rpcUrl]);
}

/**
 * Gives `address` an ERC-20 balance of `amount` on `token` by writing the storage slot directly —
 * the standard local-fork technique for a token (Base Sepolia's real Circle test USDC) that has no
 * public mint function. The slot is FOUND, not assumed: brute-forced against the real deployed
 * bytecode by writing a distinctive probe value to each candidate `mapping(address => uint256)`
 * slot and reading `balanceOf` back, so a wrong assumption about USDC's storage layout cannot pass
 * silently — it throws if none of the first 32 slots work, rather than fabricating a fund that was
 * never actually granted.
 */
export function dealErc20(rpcUrl, token, address, amount) {
  const probe = 0x1234n;
  for (let slot = 0; slot < 32; slot++) {
    const key = cast(['index', 'address', address, String(slot)]);
    const prev = cast(['storage', token, key, '--rpc-url', rpcUrl]);
    cast(['rpc', 'anvil_setStorageAt', token, key, toHex32(probe), '--rpc-url', rpcUrl]);
    const bal = BigInt(cast(['call', token, 'balanceOf(address)(uint256)', address, '--rpc-url', rpcUrl]).split(' ')[0]);
    if (bal === probe) {
      cast(['rpc', 'anvil_setStorageAt', token, key, toHex32(amount), '--rpc-url', rpcUrl]);
      const finalBal = BigInt(cast(['call', token, 'balanceOf(address)(uint256)', address, '--rpc-url', rpcUrl]).split(' ')[0]);
      if (finalBal !== amount) {
        throw new Error(`dealErc20: slot ${slot} accepted the probe but not the real amount (got ${finalBal}, wanted ${amount})`);
      }
      return slot;
    }
    // Not the balance slot — put back whatever was there before probing it.
    cast(['rpc', 'anvil_setStorageAt', token, key, prev, '--rpc-url', rpcUrl]);
  }
  throw new Error(`dealErc20: could not find the balanceOf storage slot for ${token} after 32 candidates — refusing to report a fund that was never granted`);
}

const toHex32 = (n) => `0x${n.toString(16).padStart(64, '0')}`;

// ────────────────────────────────────────── time travel ──────────────────────────────────────────

/** Collapses a real wall-clock wait (the 4h deposit observation window, the 1h commit/reveal
 * windows) to milliseconds — the property that makes "green in CI" possible at all for a lifecycle
 * `scripts/smoke-test.mjs` takes 6-7 real hours to run, while still executing against the SAME
 * contract bytecode and the SAME time-gated `require`s. */
export function fastForward(rpcUrl, seconds) {
  cast(['rpc', 'evm_increaseTime', String(seconds), '--rpc-url', rpcUrl]);
  cast(['rpc', 'evm_mine', '--rpc-url', rpcUrl]);
}

export function chainNow(rpcUrl) {
  return Number(cast(['block', 'latest', '-f', 'timestamp', '--rpc-url', rpcUrl]));
}

// ────────────────────────────────────────── deploy + lifecycle ──────────────────────────────────────────

/** `forge script DeployTestnet.s.sol --broadcast`, UNMODIFIED, against the local fork — never a
 * public RPC (see this file's header). Returns the singleton addresses parsed from its own
 * broadcast receipt, the same way `scripts/smoke-test.mjs`'s `loadDeployment()` does. */
export function deployProtocol(rpcUrl, privateKey) {
  run(
    'forge',
    [
      'script', 'script/DeployTestnet.s.sol:DeployTestnet',
      '--rpc-url', rpcUrl,
      '--private-key', privateKey,
      '--broadcast',
      '--non-interactive',
    ],
    { cwd: CONTRACTS_DIR },
  );
  const deployJson = path.join(CONTRACTS_DIR, 'broadcast', 'DeployTestnet.s.sol', String(BASE_SEPOLIA_CHAIN_ID), 'run-latest.json');
  if (!existsSync(deployJson)) {
    throw new Error(`deployProtocol: expected forge to write ${deployJson}, but it is not there`);
  }
  const j = JSON.parse(readFileSync(deployJson, 'utf8'));
  const byName = {};
  for (const tx of j.transactions ?? []) {
    if (tx.transactionType === 'CREATE' && tx.contractName) (byName[tx.contractName] ??= []).push(tx.contractAddress);
  }
  const one = (name) => {
    const a = byName[name] ?? [];
    if (a.length !== 1) throw new Error(`deployProtocol: expected exactly one ${name}, found ${a.length}`);
    return a[0];
  };
  return {
    registry: one('OperatorRegistry'),
    factory: one('VaultFactory'),
    governance: one('Governance'),
    aggregator: one('ChainlinkOracle'),
    adapter: one('AggregationRouterAdapter'),
  };
}

const T_VAULT_CREATED = cast(['keccak', 'VaultCreated(address,address,address,uint256)']);
const topicToAddress = (t) => '0x' + t.slice(26);

/** `factory.createVault(...)` from the throwaway signer, who becomes the vault's creator AND its
 * sole member for the whole run — the same sole-holder shape `scripts/smoke-test.mjs` relies on for
 * its exact-round-trip exit assertion, chosen here for the same reason. Returns the vault address. */
export function createVault(rpcUrl, privateKey, { factory, usdc, tokens, aggregator, adapter, smoke }) {
  const params = `(${usdc},[${tokens.join(',')}],${aggregator},${smoke.capacityCapUsdc},${smoke.minDepositUsdc},${smoke.exitFeeMaxBps},${smoke.exitFeeDecayPeriod},[${adapter}])`;
  const receipt = sendJson(rpcUrl, privateKey, factory, 'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', [params]);
  const created = receipt.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED);
  if (!created) throw new Error('createVault: VaultCreated event not found in receipt');
  return topicToAddress(created.topics[1]);
}

export function registerVault(rpcUrl, privateKey, governance, vault, gov) {
  const tuple = `(${gov.commitDuration},${gov.revealDuration},${gov.timelockDuration},${gov.executionWindow},${gov.quorumBps},${gov.proposalThresholdBps},${gov.concentrationCapBps},${gov.proposalCooldown})`;
  sendJson(rpcUrl, privateKey, governance, 'registerVault(address,(uint32,uint32,uint32,uint32,uint16,uint16,uint16,uint32))', [vault, tuple]);
}

export function activateVault(rpcUrl, privateKey, vault, member) {
  sendJson(rpcUrl, privateKey, vault, 'activate(address)', [member]);
}

/**
 * A no-op rebalance payload: the allow-listed adapter, zero slippage tolerance, zero orders.
 * Returns `{ pid, commitDeadline, revealDeadline }`. Decodes the proposal via the REAL
 * `PROPOSAL_SIG`/`decodeProposal` from `scripts/lib/proposal-decode.mjs` (issue #196's own
 * extraction) rather than a hand-rolled signature — see that module's header for why a re-derived
 * field order here would be exactly the untested arithmetic it exists to avoid.
 *
 * NOTE ON THE ENCODE SIGNATURE — a real finding from building this harness, not a style choice.
 * `Governance.execute`'s Rebalance branch (contracts/src/Governance.sol) decodes payload as
 * `(address adapter, uint256 maxSlippageBps, IExecutionAdapter.SwapOrder[] orders)` — THREE
 * fields. `scripts/smoke-test.mjs`'s own `buildPayload()` encodes only TWO
 * (`f(address,(address,address,uint256,uint256,uint256,bytes)[])`, no `maxSlippageBps`), which
 * decodes on the current contract as garbage (the array's offset word is read as
 * `maxSlippageBps`, and everything downstream shifts) — this harness's `execute()` mutation
 * reproduced that exact failure as a real `Panic(0x41)` memory-allocation revert against real
 * bytecode before this three-field form was used instead. Flagged separately (this PR does not
 * touch scripts/smoke-test.mjs — a different entrypoint, its own review) rather than fixed here.
 */
export function proposeNoOpRebalance(rpcUrl, privateKey, governance, vault, adapter) {
  // maxSlippageBps = 100 (1%), not 0: VaultCore.sol:909 rejects zero outright (BadSlippageBound —
  // "a bound of zero would demand exact oracle parity and make every real swap unexecutable"), and
  // the ceiling is MAX_REBALANCE_SLIPPAGE_BPS = 200 (2%). Orders stays empty either way, so no swap
  // is actually attempted — this bound only has to be IN RANGE for execute() to accept the payload.
  const payload = cast(['abi-encode', 'f(address,uint256,(address,address,uint256,uint256,uint256,bytes)[])', adapter, '100', '[]']);
  sendJson(rpcUrl, privateKey, governance, 'propose(address,uint8,bytes32)', [vault, '0', cast(['keccak', payload])]);
  const pid = cast(['call', governance, 'activeProposalOf(address)(uint256)', vault, '--rpc-url', rpcUrl]).split(' ')[0];
  const lines = cast(['call', governance, PROPOSAL_SIG, pid, '--rpc-url', rpcUrl]).split('\n').map(clean).filter(Boolean);
  const p = decodeProposal(lines);
  return { pid, payload, commitDeadline: p.commitDeadline, revealDeadline: p.revealDeadline };
}

export function finalizeAndExecute(rpcUrl, privateKey, governance, pid, payload) {
  sendJson(rpcUrl, privateKey, governance, 'finalize(uint256)', [pid]);
  sendJson(rpcUrl, privateKey, governance, 'execute(uint256,bytes)', [pid, payload]);
}

function sendJson(rpcUrl, privateKey, to, sig, args) {
  const out = cast(['send', to, sig, ...args, '--rpc-url', rpcUrl, '--private-key', privateKey, '--json']);
  const receipt = JSON.parse(out.slice(out.indexOf('{')));
  if (receipt.status !== '0x1' && receipt.status !== 1) {
    throw new Error(`${sig}: transaction reverted (${receipt.transactionHash})`);
  }
  return receipt;
}

export function readVaultAddressesRaw(rpcUrl, vault) {
  const usdc = cast(['call', vault, 'usdc()(address)', '--rpc-url', rpcUrl]).trim();
  const governance = cast(['call', vault, 'governance()(address)', '--rpc-url', rpcUrl]).trim();
  return { usdc, governance };
}

export function rmDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
}
