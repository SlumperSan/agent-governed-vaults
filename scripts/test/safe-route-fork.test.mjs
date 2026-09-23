// @ts-check
/**
 * REAL-BYTECODE proof for card 208: routes `VaultFactory.createVault` through a real, deployed
 * `SafeL2` v1.4.1 Safe on a local anvil fork of Base Sepolia — the pattern PR #373 established
 * (fork, not a bare chain, because `ChainlinkOracle` caches `decimals()` from real feed addresses
 * at construction; see scripts/test/lib/safe-fork-chain.mjs's own header). Every write after the
 * fork starts is local; nothing is broadcast to a public endpoint; every key is a throwaway
 * `cast wallet new` keypair, funded only on the fork via `anvil_setBalance`/`anvil_setStorageAt`.
 *
 * WHAT THIS PROVES. The REAL, UNMODIFIED `scripts/smoke-test.mjs` — spawned as a genuine child
 * `node` process, never reimplemented — building and sending a real Safe `execTransaction` whose
 * inner call is `createVault`, against real deployed bytecode: the real Safe's own
 * `getTransactionHash`/`checkNSignatures`/`execute` accept it, `msg.sender` inside `createVault`
 * really is the Safe, and the vault's own `creator()` reads back the Safe's address. Both 1-of-1 and
 * 2-of-3 thresholds. Two layers are distinguished deliberately (see the mutation groups below): this
 * repository's OWN pre-broadcast guard (`requireIntendedCreator`/`safeRoutingPlanRefusal`,
 * scripts/smoke-preflight.mjs) refusing before a signature is ever collected, and the Safe's OWN
 * deployed bytecode refusing independently of that guard — proven by calling
 * scripts/lib/safe-exec.mjs's low-level functions directly, bypassing the guard on purpose, exactly
 * so a deleted guard could not hide behind "the chain would have caught it anyway" without that
 * claim being checked.
 *
 * WHAT THIS DOES NOT PROVE. Arc mainnet execution, the real Arc Safe's actual owner keys, a public
 * broadcast, or Ledger-based signing (a Ledger cannot blind-sign a raw hash the way
 * `cast wallet sign --no-hash` does here — a real run against the Arc Safe needs a signer that can
 * sign an already-computed digest). `Governance.registerVault`'s own access control is NOT exercised
 * here — card 208 is createVault only; whether registerVault is creator-gated and would need routing
 * TOO is a separate, unresolved question, flagged in this PR's findings rather than assumed either
 * way.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requireBin, startFork, generateThrowawayAccount, setEthBalance, dealErc20, deployProtocol,
  deploySafe, readSafe, cast, clean, topicToAddress, CONTRACTS_DIR,
} from './lib/safe-fork-chain.mjs';
import {
  readSafeState, buildPlan, safeTransactionHash, signAsOwner, packSignatures, execTransactionArgs,
  SAFE_EXEC_TRANSACTION_SIG,
} from '../lib/safe-exec.mjs';

const ROOT = path.resolve(CONTRACTS_DIR, '..');
const SMOKE_TEST = path.join(ROOT, 'scripts', 'smoke-test.mjs');
const REAL_CONFIG = path.join(ROOT, 'contracts', 'config', 'base-sepolia.json');
const smokeCfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));

const PORT = 8940 + (process.pid % 500); // spread across concurrent gate runs on the same machine
let fork, broadcaster, ownerA, ownerB, ownerC, dep, dep2, factory2, safe1, safe2;

before(async () => {
  for (const bin of ['anvil', 'forge', 'cast']) requireBin(bin);
  fork = await startFork({ port: PORT });

  broadcaster = generateThrowawayAccount();
  ownerA = generateThrowawayAccount();
  ownerB = generateThrowawayAccount();
  ownerC = generateThrowawayAccount();
  for (const acct of [broadcaster, ownerA, ownerB, ownerC]) {
    setEthBalance(fork.rpcUrl, acct.address, '0x56BC75E2D63100000'); // 100 ETH
  }
  dealErc20(fork.rpcUrl, smokeCfg.usdc, broadcaster.address, BigInt(smokeCfg.smoke.depositUsdc));

  dep = deployProtocol(fork.rpcUrl, broadcaster.privateKey);
  // `deployProtocol` writes to a FIXED path (contracts/broadcast/.../run-latest.json), so a second
  // real deployment run below would overwrite it out from under `dep` -- snapshot it to a private
  // path first and point `dep.deployJsonPath` at the copy, which the second run cannot touch.
  const dep1Snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-route-fork-dep1-')), 'run-latest.json');
  fs.copyFileSync(dep.deployJsonPath, dep1Snapshot);
  dep.deployJsonPath = dep1Snapshot;

  // A SECOND, fully independent, correctly-wired real deployment -- its OWN registry/feeEngine, not
  // a bare VaultFactory pointed at the FIRST deployment's registry. OperatorRegistry.wire() is a
  // one-shot lock (scripts/smoke-preflight.mjs's own wiringImmutabilityFailure exists for exactly
  // this), so a factory sharing someone else's registry could never attest a vault at all -- it
  // would revert (Safe's own GS013, "inner call failed with safeTxGas/gasPrice both 0") before
  // VaultCreated could ever be emitted, which would prove nothing about the wrong-factory mutation
  // below. A full second deployment is genuinely a different, valid, self-consistent factory.
  dep2 = deployProtocol(fork.rpcUrl, broadcaster.privateKey);
  factory2 = dep2.factory;
  assert.notEqual(factory2.toLowerCase(), dep.factory.toLowerCase(), 'the wrong-factory mutation needs a GENUINELY different address');

  safe1 = deploySafe(fork.rpcUrl, broadcaster.privateKey, [ownerA.address], 1); // 1-of-1, the Arc shape
  safe2 = deploySafe(fork.rpcUrl, broadcaster.privateKey, [ownerA.address, ownerB.address, ownerC.address], 2); // 2-of-3
});

after(() => { fork?.stop(); });

// ─────────────────────────────────────── helpers ───────────────────────────────────────

function writeDeploymentRecord(safeAddr) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-route-fork-')), 'deployment.json');
  fs.writeFileSync(p, JSON.stringify({
    chainId: smokeCfg.chainId, intendedCreator: safeAddr, intendedCreatorKind: 'contract',
  }));
  return p;
}

/**
 * Spawns the REAL, unmodified scripts/smoke-test.mjs against the fork. It will hang at
 * stepActivate's real 4h wait once createVault succeeds — this file only needs createVault's own
 * outcome, so `untilMatch` (given) lets the caller kill the child the moment that outcome appears
 * in stdout instead of waiting out a fixed timeout; a refusal exits the process on its own quickly,
 * so `untilMatch` is irrelevant there and the process end race resolves first either way.
 */
async function runSmokeAgainstFork({ safeAddr, ownerSignerKeys, untilMatch, maxWaitMs = 30_000 }) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-route-fork-run-'));
  const env = {
    ...process.env,
    BASE_SEPOLIA_RPC: fork.rpcUrl,
    SMOKE_SIGNER_ARGS: `--private-key ${broadcaster.privateKey}`,
    DEPLOY_JSON: dep.deployJsonPath,
    SMOKE_CONFIG: REAL_CONFIG,
    SMOKE_DEPLOYMENT: writeDeploymentRecord(safeAddr),
    SMOKE_STATE: path.join(runDir, 'state.json'),
    SMOKE_RESET: '1',
    ...(ownerSignerKeys !== undefined
      ? { SMOKE_SAFE_OWNER_SIGNERS: ownerSignerKeys.map((k) => `--private-key ${k}`).join(';') }
      : {}),
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SMOKE_TEST], { cwd: ROOT, env });
    let stdout = '', stderr = '', settled = false;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve({ status, stdout, stderr });
    };
    child.stdout.on('data', (d) => {
      stdout += String(d);
      if (untilMatch && untilMatch.test(stdout)) finish(0);
    });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('exit', (code) => finish(code));
    const timer = setTimeout(() => finish(null), maxWaitMs);
  });
}

// ═══════════════════════════════ happy path, real bytecode ═══════════════════════════════

test('1-of-1 (the Arc shape): the real runner routes createVault through a real Safe, and the vault\'s own creator() reads the Safe', async () => {
  const before1 = readSafe(fork.rpcUrl, safe1);
  const r = await runSmokeAgainstFork({ safeAddr: safe1, ownerSignerKeys: [ownerA.privateKey], untilMatch: /created via Safe/ });
  assert.match(r.stdout, /created via Safe/, `expected the routed success line in stdout:\n${r.stdout}\n---stderr---\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /ExecutionFailure/);

  const after1 = readSafe(fork.rpcUrl, safe1);
  assert.equal(after1.nonce, before1.nonce + 1n, 'exactly one execTransaction should have landed');

  const m = /vault (0x[0-9a-fA-F]{40}) created via Safe/.exec(r.stdout);
  assert.ok(m, 'could not find the created vault address in stdout');
  const vault = m[1];
  const onChainCreator = clean(cast(['call', vault, 'creator()(address)', '--rpc-url', fork.rpcUrl]));
  assert.equal(onChainCreator.toLowerCase(), safe1.toLowerCase(), "the vault's own creator() must read the Safe, not the broadcaster EOA");
});

test('2-of-3: the real runner collects exactly the required threshold and the real Safe accepts it', async () => {
  const before2 = readSafe(fork.rpcUrl, safe2);
  const r = await runSmokeAgainstFork({ safeAddr: safe2, ownerSignerKeys: [ownerA.privateKey, ownerB.privateKey], untilMatch: /created via Safe/ });
  assert.match(r.stdout, /created via Safe/, `expected the routed success line in stdout:\n${r.stdout}\n---stderr---\n${r.stderr}`);
  const after2 = readSafe(fork.rpcUrl, safe2);
  assert.equal(after2.nonce, before2.nonce + 1n);
  const m = /vault (0x[0-9a-fA-F]{40}) created via Safe/.exec(r.stdout);
  const onChainCreator = clean(cast(['call', m[1], 'creator()(address)', '--rpc-url', fork.rpcUrl]));
  assert.equal(onChainCreator.toLowerCase(), safe2.toLowerCase());
});

// ═══════════════════ mutations, layer 1: this repository's OWN guard, before broadcast ═══════════════════

test('too few signatures for a 2-of-3 Safe: the runner\'s OWN check refuses before broadcast, nonce unchanged', async () => {
  const before2 = readSafe(fork.rpcUrl, safe2);
  const r = await runSmokeAgainstFork({ safeAddr: safe2, ownerSignerKeys: [ownerA.privateKey] }); // only 1 of 2 required
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /requires 2 signature\(s\) but SMOKE_SAFE_OWNER_SIGNERS supplies only 1/, r.stderr);
  const after2 = readSafe(fork.rpcUrl, safe2);
  assert.equal(after2.nonce, before2.nonce, 'a refused plan must never reach the chain');
});

test('a non-owner signer: the runner\'s OWN check refuses before broadcast, nonce unchanged', async () => {
  const stranger = generateThrowawayAccount();
  const before1 = readSafe(fork.rpcUrl, safe1);
  const r = await runSmokeAgainstFork({ safeAddr: safe1, ownerSignerKeys: [stranger.privateKey] });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /is not among Safe .* own getOwners\(\)/, r.stderr);
  const after1 = readSafe(fork.rpcUrl, safe1);
  assert.equal(after1.nonce, before1.nonce);
});

test('no SMOKE_SAFE_OWNER_SIGNERS at all against a live contract-kind Safe: refuses before broadcast, nonce unchanged', async () => {
  const before1 = readSafe(fork.rpcUrl, safe1);
  const r = await runSmokeAgainstFork({ safeAddr: safe1, ownerSignerKeys: undefined });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /SMOKE_SAFE_OWNER_SIGNERS is required/, r.stderr);
  const after1 = readSafe(fork.rpcUrl, safe1);
  assert.equal(after1.nonce, before1.nonce);
});

// ═══════ mutations, layer 2: the real Safe's OWN bytecode, called directly, bypassing this repo's guard ═══════
// These prove the chain itself is not a rubber stamp -- independent of whether this repository's
// own JS guard (above) is present, deleted, or wrong. safe-exec.mjs's low-level functions are called
// directly here, on purpose, skipping stepCreateVaultRouted's owner/threshold pre-checks.

function callHelper(to, sig, ...args) { return cast(['call', to, sig, ...args.map(String), '--rpc-url', fork.rpcUrl]).split('\n').map(clean); }
function callU(to, sig, ...args) { return BigInt(callHelper(to, sig, ...args)[0]); }
function createVaultCalldata(depRecord = dep) {
  const tokens = smokeCfg.assets.map((a) => a.token);
  const params = `(${smokeCfg.usdc},[${tokens.join(',')}],${depRecord.aggregator},${smokeCfg.smoke.capacityCapUsdc},${smokeCfg.smoke.minDepositUsdc},${smokeCfg.smoke.exitFeeMaxBps},${smokeCfg.smoke.exitFeeDecayPeriod},[${depRecord.adapter}])`;
  return cast(['calldata', 'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', params]);
}
function sendExecTransaction(safeAddr, plan, packedSigs, broadcasterKey) {
  const args = execTransactionArgs(plan, packedSigs);
  const out = cast(['send', safeAddr, SAFE_EXEC_TRANSACTION_SIG, ...args.map(String), '--rpc-url', fork.rpcUrl, '--private-key', broadcasterKey, '--json']);
  return JSON.parse(out.slice(out.indexOf('{')));
}

test('the real Safe rejects too few signatures for its own threshold, independent of this repo\'s guard', () => {
  const { nonce } = readSafeState({ call: callHelper, callU, safe: safe2 });
  const plan = buildPlan({ safe: safe2, to: dep.factory, data: createVaultCalldata(), nonce });
  const hash = safeTransactionHash({ call: callHelper, plan });
  const oneSig = packSignatures([signAsOwner({ cast, hash, signerArgs: ['--private-key', ownerA.privateKey] })]); // threshold is 2
  assert.throws(() => sendExecTransaction(safe2, plan, oneSig, broadcaster.privateKey), /GS0|revert|invalid|signatures/i);
});

test('the real Safe rejects a signature from a non-owner, independent of this repo\'s guard', () => {
  const stranger = generateThrowawayAccount();
  const { nonce } = readSafeState({ call: callHelper, callU, safe: safe1 });
  const plan = buildPlan({ safe: safe1, to: dep.factory, data: createVaultCalldata(), nonce });
  const hash = safeTransactionHash({ call: callHelper, plan });
  const badSig = packSignatures([signAsOwner({ cast, hash, signerArgs: ['--private-key', stranger.privateKey] })]);
  assert.throws(() => sendExecTransaction(safe1, plan, badSig, broadcaster.privateKey), /GS0|revert|invalid|signatures/i);
});

test('RESTORE TO GREEN: after both real-Safe rejections above, the SAME safes still accept a correctly-signed execTransaction', () => {
  // Proves the two rejections above were about the bad input, not about the Safe (or the fork)
  // having become unusable -- the same nonce values from before those attempts are still current,
  // since a reverted transaction consumes no nonce, and a correct signature over that same nonce
  // still succeeds.
  const { nonce: nonce2 } = readSafeState({ call: callHelper, callU, safe: safe2 });
  const plan2 = buildPlan({ safe: safe2, to: dep.factory, data: createVaultCalldata(), nonce: nonce2 });
  const hash2 = safeTransactionHash({ call: callHelper, plan: plan2 });
  const goodSigs2 = packSignatures([
    signAsOwner({ cast, hash: hash2, signerArgs: ['--private-key', ownerB.privateKey] }),
    signAsOwner({ cast, hash: hash2, signerArgs: ['--private-key', ownerC.privateKey] }),
  ]);
  const r2 = sendExecTransaction(safe2, plan2, goodSigs2, broadcaster.privateKey);
  assert.ok(r2.status === '0x1' || r2.status === 1, 'a correctly-signed 2-of-3 execTransaction must still succeed');
});

// ═══════════════════════ post-check layer: emitter must be the DECLARED factory ═══════════════════════

test('wrong factory: the real Safe happily routes createVault at a genuinely different, real VaultFactory -- and only checking the emitter address catches it', () => {
  // Deliberately bypasses safeRoutingPlanRefusal (which would refuse `to !== dep.factory` before a
  // signature is ever collected, per scripts/test/safe-routing-plan.test.mjs) to answer the
  // question that check's ABSENCE would raise: does the Safe care which contract it calls? It does
  // not -- Safe.execTransaction is generic by design. What must catch this instead is the
  // POST-broadcast check on the emitting address, which stepCreateVaultRouted (scripts/smoke-test.mjs)
  // applies and smoke-test.mjs's older direct-send path (pre-card-208) does not.
  const { nonce } = readSafeState({ call: callHelper, callU, safe: safe1 });
  // dep2's OWN aggregator/adapter -- factory2's oracle allowlist was seeded from ITS OWN deployment,
  // not dep's, so calldata built from dep's addresses would fail factory2's allowlist check for a
  // reason that has nothing to do with the mutation this test exists to prove.
  const plan = buildPlan({ safe: safe1, to: factory2, data: createVaultCalldata(dep2), nonce }); // <-- wrong factory, on purpose
  const hash = safeTransactionHash({ call: callHelper, plan });
  const sig = packSignatures([signAsOwner({ cast, hash, signerArgs: ['--private-key', ownerA.privateKey] })]);
  const receipt = sendExecTransaction(safe1, plan, sig, broadcaster.privateKey);
  assert.ok(receipt.status === '0x1' || receipt.status === 1, 'the Safe executes a call to ANY contract; it enforces nothing about which one');

  const T_VAULT_CREATED = cast(['keccak', 'VaultCreated(address,address,address,uint256)']);
  const fromWrongFactory = receipt.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED && l.address?.toLowerCase() === factory2.toLowerCase());
  assert.ok(fromWrongFactory, 'the WRONG factory really did emit a real VaultCreated -- this is what makes the mutation meaningful, not a revert that proves nothing');
  assert.equal(topicToAddress(fromWrongFactory.topics[2]).toLowerCase(), safe1.toLowerCase(), 'and it names the Safe as creator, exactly as a correctly-routed one would -- topic-only matching cannot tell these apart');

  // The check stepCreateVaultRouted actually applies: emitter === the DECLARED factory. It correctly
  // finds NOTHING here, because the event came from factory2, not dep.factory.
  const fromDeclaredFactory = receipt.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED && l.address?.toLowerCase() === dep.factory.toLowerCase());
  assert.equal(fromDeclaredFactory, undefined, 'checking only topics[0] (not the emitter) would have wrongly accepted this vault as belonging to the declared deployment');
});
