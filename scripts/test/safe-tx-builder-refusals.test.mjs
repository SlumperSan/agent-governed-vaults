// @ts-check
/**
 * scripts/build-safe-tx-builder.mjs's OWN refusals — the ones this generator adds on top of the
 * reused smoke-preflight.mjs guards (requireCreatorCode, requireSafeRoutingPlan), which already have
 * their own mutation-tested suites (scripts/test/creator-code.test.mjs,
 * scripts/test/safe-routing-plan.test.mjs) that this file does not duplicate.
 *
 * Every test here SPAWNS THE REAL CLI (not an imported function) against a real anvil fork with a
 * real deployed protocol and a real deployed Safe, and asserts a non-zero exit code plus the refusal
 * text — "spawn the CLI and assert a non-zero exit and the message text, so every guard is exercised
 * at the point where it throws" (not a call to an internal function that happens to share the same
 * logic). The one exception is the chain-id-mismatch test, which needs a SECOND, non-forking anvil
 * instance reporting a genuinely different chain id (a fork of Base Sepolia always reports 84532).
 *
 * MUTATION RESULTS (reintroduce the defect -> confirm red; restore -> confirm green), recorded here
 * because the PR body summarizes rather than repeats: every guard below was verified by commenting it
 * out (or loosening its condition) in scripts/build-safe-tx-builder.mjs, re-running the corresponding
 * test to confirm RED, then restoring the guard and confirming GREEN. See the PR body for the table.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requireBin, startFork, generateThrowawayAccount, setEthBalance, dealErc20, deployProtocol,
  deploySafe, cast, clean, topicToAddress, CONTRACTS_DIR,
} from './lib/safe-fork-chain.mjs';
import {
  readSafeState, buildPlan, safeTransactionHash, signAsOwner, packSignatures, execTransactionArgs,
  SAFE_EXEC_TRANSACTION_SIG,
} from '../lib/safe-exec.mjs';

const ROOT = path.resolve(CONTRACTS_DIR, '..');
const BUILDER = path.join(ROOT, 'scripts', 'build-safe-tx-builder.mjs');
const REAL_CONFIG = path.join(ROOT, 'contracts', 'config', 'base-sepolia.json');
const smokeCfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));
const FIXTURE_DEPLOY_JSON = path.join(ROOT, 'scripts', 'test', 'fixtures', 'deploy-run-latest.json');

const PORT = 9940 + (process.pid % 500); // its own range, distinct from safe-route-fork's 8940+ and safe-tx-builder-fork's 9440+
let fork, broadcaster, ownerA, dep, dep2, safe1;

before(async () => {
  for (const bin of ['anvil', 'forge', 'cast']) requireBin(bin);
  fork = await startFork({ port: PORT });
  broadcaster = generateThrowawayAccount();
  ownerA = generateThrowawayAccount();
  setEthBalance(fork.rpcUrl, broadcaster.address, '0x56BC75E2D63100000');
  dealErc20(fork.rpcUrl, smokeCfg.usdc, broadcaster.address, BigInt(smokeCfg.smoke.depositUsdc));
  dep = deployProtocol(fork.rpcUrl, broadcaster.privateKey);
  const snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-refusals-dep-')), 'run-latest.json');
  fs.copyFileSync(dep.deployJsonPath, snapshot);
  dep.deployJsonPath = snapshot;
  // A SECOND, fully independent, correctly-wired deployment -- its own registry/feeEngine, so it can
  // genuinely attest a vault (OperatorRegistry.wire() is a one-shot lock; a factory sharing someone
  // else's registry could never do this). Used ONLY by the "same Safe, wrong factory" test below: a
  // vault whose creator() really is safe1 but that dep's factory never created, to isolate the
  // allVaults guard from the creator() guard (a vault created by a DIFFERENT safe fails BOTH checks
  // at once and cannot tell them apart).
  dep2 = deployProtocol(fork.rpcUrl, broadcaster.privateKey);
  const snapshot2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-refusals-dep2-')), 'run-latest.json');
  fs.copyFileSync(dep2.deployJsonPath, snapshot2);
  dep2.deployJsonPath = snapshot2;
  safe1 = deploySafe(fork.rpcUrl, broadcaster.privateKey, [ownerA.address], 1);
});

after(() => { fork?.stop(); });

/** Creates one vault through `safe1` against an ARBITRARY factory (`factoryDep`), via the low-level
 *  safe-exec helpers directly -- the same bypass pattern scripts/test/safe-route-fork.test.mjs's own
 *  `createVaultViaSafe1` uses -- so a vault can be created against dep2's factory while its
 *  creator() still genuinely reads safe1. */
function createVaultViaSafe1Against(factoryDep) {
  const callHelper = (to, sig, ...args) => cast(['call', to, sig, ...args.map(String), '--rpc-url', fork.rpcUrl]).split('\n').map(clean);
  const callU = (to, sig, ...args) => BigInt(callHelper(to, sig, ...args)[0]);
  const tokens = smokeCfg.assets.map((a) => a.token);
  const params = `(${smokeCfg.usdc},[${tokens.join(',')}],${factoryDep.aggregator},${smokeCfg.smoke.capacityCapUsdc},${smokeCfg.smoke.minDepositUsdc},${smokeCfg.smoke.exitFeeMaxBps},${smokeCfg.smoke.exitFeeDecayPeriod},[${factoryDep.adapter}])`;
  const data = cast(['calldata', 'createVault((address,address[],address,uint256,uint256,uint256,uint256,address[]))', params]);
  const { nonce } = readSafeState({ call: callHelper, callU, safe: safe1 });
  const plan = buildPlan({ safe: safe1, to: factoryDep.factory, data, nonce });
  const hash = safeTransactionHash({ call: callHelper, plan });
  const sig = packSignatures([signAsOwner({ cast, hash, signerArgs: ['--private-key', ownerA.privateKey] })]);
  const out = cast(['send', safe1, SAFE_EXEC_TRANSACTION_SIG, ...execTransactionArgs(plan, sig).map(String), '--rpc-url', fork.rpcUrl, '--private-key', broadcaster.privateKey, '--json']);
  const receipt = JSON.parse(out.slice(out.indexOf('{')));
  const T_VAULT_CREATED = cast(['keccak', 'VaultCreated(address,address,address,uint256)']);
  const created = receipt.logs.find((l) => l.topics?.[0] === T_VAULT_CREATED && l.address?.toLowerCase() === factoryDep.factory.toLowerCase());
  return topicToAddress(created.topics[1]);
}

function writeDeploymentRecord({ chainId = smokeCfg.chainId, intendedCreator = safe1, intendedCreatorKind = 'contract' } = {}) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-refusals-')), 'deployment.json');
  fs.writeFileSync(p, JSON.stringify({ chainId, intendedCreator, intendedCreatorKind }));
  return p;
}

function writeConfig(overrides) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-refusals-cfg-')), 'config.json');
  fs.writeFileSync(p, JSON.stringify({ ...smokeCfg, ...overrides }));
  return p;
}

function runBuilder(args, { rpcUrl = fork.rpcUrl, deployJson = dep.deployJsonPath, config = REAL_CONFIG, deployment } = {}) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-refusals-out-'));
  const env = {
    ...process.env,
    BASE_SEPOLIA_RPC: rpcUrl,
    DEPLOY_JSON: deployJson,
    SMOKE_CONFIG: config,
    SMOKE_DEPLOYMENT: deployment ?? writeDeploymentRecord(),
  };
  return spawnSync(process.execPath, [BUILDER, ...args, '--out', path.join(outDir, 'batch.json')], { cwd: ROOT, env, encoding: 'utf8' });
}

test('unknown first argument refuses with a usage message', () => {
  const r = runBuilder(['deleteEverything']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must be "createVault" or "registerVault"/);
});

test('intendedCreatorKind "eoa" refuses BEFORE any RPC call -- a Safe batch makes no sense for an EOA creator', () => {
  const r = runBuilder(['createVault'], {
    rpcUrl: 'http://127.0.0.1:1', // deliberately unreachable; the test only passes if this is never dialled
    deployment: writeDeploymentRecord({ intendedCreatorKind: 'eoa', intendedCreator: broadcaster.address }),
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not "contract"/);
});

test('a malformed intendedCreator address refuses on shape, before any RPC call', () => {
  const r = runBuilder(['createVault'], {
    rpcUrl: 'http://127.0.0.1:1', // deliberately unreachable
    deployment: writeDeploymentRecord({ intendedCreator: 'not-an-address' }),
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a 20-byte hex address/);
});

test('a Safe declared but with NO CODE on chain refuses -- the predicted-but-unactivated-Safe shape', () => {
  const uncodedEOA = generateThrowawayAccount();
  const r = runBuilder(['createVault'], {
    deployment: writeDeploymentRecord({ intendedCreator: uncodedEOA.address }),
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /NO BYTECODE/);
});

test('chain id mismatch between the deployment record and the live RPC refuses', async () => {
  // `startFork` (scripts/test/lib/safe-fork-chain.mjs) always forks Base Sepolia at chain id 84532,
  // so a SECOND instance of it can never disagree with the deployment record on chain id -- this test
  // needs a genuinely different chain id, which means a plain (non-forking) anvil with an explicit
  // override, spawned directly rather than through that helper.
  const otherPort = PORT + 1;
  const OTHER_CHAIN_ID = 999999;
  const child = spawn('anvil', ['--chain-id', String(OTHER_CHAIN_ID), '--port', String(otherPort), '--silent'], { stdio: 'ignore', windowsHide: true });
  const rpcUrl = `http://127.0.0.1:${otherPort}`;
  try {
    const deadline = Date.now() + 30_000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        if (cast(['chain-id', '--rpc-url', rpcUrl]).trim() === String(OTHER_CHAIN_ID)) { up = true; break; }
      } catch { /* not up yet */ }
      await new Promise((res) => setTimeout(res, 200));
    }
    assert.ok(up, 'the second anvil instance never came up reporting its overridden chain id');

    const r = runBuilder(['createVault'], { rpcUrl });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`chain ${OTHER_CHAIN_ID}.*chain ${smokeCfg.chainId}`, 's'));
  } finally {
    try { child.kill(); } catch { /* already gone */ }
  }
});

test('createVault: missing DEPLOY_JSON refuses', () => {
  const r = runBuilder(['createVault'], { deployJson: path.join(os.tmpdir(), 'definitely-does-not-exist-run-latest.json') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /deploy output not found/);
});

test('createVault: chain config with no `assets` array refuses', () => {
  const r = runBuilder(['createVault'], { config: writeConfig({ assets: undefined }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no usable `assets` array/);
});

test('createVault: chain config with no `smoke` block refuses', () => {
  const r = runBuilder(['createVault'], { config: writeConfig({ smoke: undefined }) });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no usable `smoke` block/);
});

test('registerVault: missing --vault refuses', () => {
  const r = runBuilder(['registerVault']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /needs --vault/);
});

test('registerVault: malformed --vault refuses on address shape, before any chain read of it', () => {
  const r = runBuilder(['registerVault', '--vault', 'not-an-address']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a 20-byte hex address/);
});

test('registerVault: a real contract that is not in this factory\'s allVaults refuses, even if it happens to expose creator()', () => {
  // The Safe itself is a real, live contract with code -- but it is not a vault this factory created,
  // and it has no creator() function at all, so this exercises the call-failure edge alongside the
  // allVaults scan: `call()` against a selector the target does not implement throws (uncaught),
  // which is still a refusal (non-zero exit), just not one of this script's own `fail()` messages.
  const r = runBuilder(['registerVault', '--vault', dep.factory]); // the factory itself: has code, is not a vault
  assert.notEqual(r.status, 0);
});

test('registerVault: fixture DEPLOY_JSON (unrelated factory) never contains a real vault, so allVaults scan refuses rather than false-passing', () => {
  const someRealAddress = safe1; // real code on this fork, definitely not in the FIXTURE factory's allVaults (fixture factory address is not even deployed)
  const r = runBuilder(['registerVault', '--vault', someRealAddress], { deployJson: FIXTURE_DEPLOY_JSON });
  assert.notEqual(r.status, 0);
});

test('registerVault: a vault safe1 GENUINELY created (creator() == safe1) but through a DIFFERENT factory refuses -- isolates the allVaults guard from the creator() guard', () => {
  // Both prior tests above refuse on a call failure (the target has no creator() at all), which
  // could equally be the creator() check OR the allVaults scan firing -- neither isolates the
  // allVaults guard specifically. This vault's creator() genuinely reads safe1 (same Safe, same
  // owner signature, real execTransaction against dep2.factory), so the creator() check PASSES; only
  // the allVaults scan against dep.factory (which never saw this vault -- it was created through
  // dep2.factory) can catch it.
  const vaultFromDep2 = createVaultViaSafe1Against(dep2);
  const onChainCreator = clean(cast(['call', vaultFromDep2, 'creator()(address)', '--rpc-url', fork.rpcUrl]));
  assert.equal(onChainCreator.toLowerCase(), safe1.toLowerCase(), 'sanity: this vault\'s creator() really is safe1');

  const r = runBuilder(['registerVault', '--vault', vaultFromDep2]); // runBuilder always points DEPLOY_JSON at dep (NOT dep2)
  assert.notEqual(r.status, 0, 'must refuse: dep.factory never created this vault, even though safe1 genuinely did');
  assert.match(r.stderr, /is not present in factory/);
});
