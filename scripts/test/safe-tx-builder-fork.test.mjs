// @ts-check
/**
 * REAL-BYTECODE byte-identity proof for scripts/build-safe-tx-builder.mjs, on the SAME local anvil
 * Base Sepolia fork pattern scripts/test/safe-route-fork.test.mjs already established (real deployed
 * SafeL2 1.4.1, real deployed protocol, nothing broadcast to a public endpoint).
 *
 * WHY A "PURE" COMPARISON CANNOT PROVE THIS. `scripts/build-safe-tx-builder.mjs` and
 * `scripts/smoke-test.mjs`'s Safe-routed path already share the SAME tuple constructors
 * (`createVaultParamsTuple`/`registerVaultConfigTuple`, scripts/smoke-preflight.mjs) and the SAME
 * `cast calldata` call — a test that only checks the two call sites invoke the same shared function
 * is tautological, since it would pass even if that shared function itself drifted from what the
 * Safe accepts. The proof that matters is external to both: run the REAL, UNMODIFIED
 * `scripts/smoke-test.mjs` end to end against a real Safe on a real fork, read back the ACTUAL
 * `execTransaction` calldata it broadcast (`cast tx <hash> input`, decoded), and compare that against
 * what `scripts/build-safe-tx-builder.mjs` emits for the SAME `DEPLOY_JSON`/config/vault — for BOTH
 * `createVault` and `registerVault`. This also covers the builder's own forge-broadcast address
 * extraction (`loadBroadcastDeployment` in build-safe-tx-builder.mjs), which is not shared code with
 * smoke-test.mjs's `loadDeployment`: if either read the wrong factory/governance/aggregator/adapter,
 * the emitted `to`/`data` would not match the real transaction's and this test would catch it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  requireBin, startFork, generateThrowawayAccount, setEthBalance, dealErc20, deployProtocol,
  deploySafe, cast, clean, CONTRACTS_DIR,
} from './lib/safe-fork-chain.mjs';
import { SAFE_EXEC_TRANSACTION_SIG } from '../lib/safe-exec.mjs';

const ROOT = path.resolve(CONTRACTS_DIR, '..');
const SMOKE_TEST = path.join(ROOT, 'scripts', 'smoke-test.mjs');
const BUILDER = path.join(ROOT, 'scripts', 'build-safe-tx-builder.mjs');
const REAL_CONFIG = path.join(ROOT, 'contracts', 'config', 'base-sepolia.json');
const smokeCfg = JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8'));

const PORT = 9440 + (process.pid % 500); // a different range from safe-route-fork.test.mjs's 8940+, so concurrent gate runs don't collide
let fork, broadcaster, ownerA, dep, safe1;

before(async () => {
  for (const bin of ['anvil', 'forge', 'cast']) requireBin(bin);
  fork = await startFork({ port: PORT });

  broadcaster = generateThrowawayAccount();
  ownerA = generateThrowawayAccount();
  setEthBalance(fork.rpcUrl, broadcaster.address, '0x56BC75E2D63100000'); // 100 ETH
  setEthBalance(fork.rpcUrl, ownerA.address, '0x56BC75E2D63100000');
  dealErc20(fork.rpcUrl, smokeCfg.usdc, broadcaster.address, BigInt(smokeCfg.smoke.depositUsdc));

  dep = deployProtocol(fork.rpcUrl, broadcaster.privateKey);
  // deployProtocol writes to a FIXED broadcast path; snapshot it so nothing else on the machine can
  // overwrite it out from under this test (same defence safe-route-fork.test.mjs applies).
  const snapshot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-fork-dep-')), 'run-latest.json');
  fs.copyFileSync(dep.deployJsonPath, snapshot);
  dep.deployJsonPath = snapshot;

  safe1 = deploySafe(fork.rpcUrl, broadcaster.privateKey, [ownerA.address], 1); // 1-of-1, the Arc shape
});

after(() => { fork?.stop(); });

function writeDeploymentRecord(safeAddr) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-fork-')), 'deployment.json');
  fs.writeFileSync(p, JSON.stringify({
    chainId: smokeCfg.chainId, intendedCreator: safeAddr, intendedCreatorKind: 'contract',
  }));
  return p;
}

/** Spawns the REAL, unmodified scripts/smoke-test.mjs against the fork, through the FULL
 *  create-then-register sequence, exactly as safe-route-fork.test.mjs's own "end to end" test does. */
async function runSmokeAgainstFork({ untilMatch, maxWaitMs = 45_000 }) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-fork-run-'));
  const env = {
    ...process.env,
    BASE_SEPOLIA_RPC: fork.rpcUrl,
    SMOKE_SIGNER_ARGS: `--private-key ${broadcaster.privateKey}`,
    DEPLOY_JSON: dep.deployJsonPath,
    SMOKE_CONFIG: REAL_CONFIG,
    SMOKE_DEPLOYMENT: writeDeploymentRecord(safe1),
    SMOKE_STATE: path.join(runDir, 'state.json'),
    SMOKE_RESET: '1',
    SMOKE_SAFE_OWNER_SIGNERS: `--private-key ${ownerA.privateKey}`,
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

/** The inner `data` field of a Safe `execTransaction`, read back off the REAL mined transaction. */
function realInnerData(txHash) {
  const input = clean(cast(['tx', txHash, 'input', '--rpc-url', fork.rpcUrl]));
  const decoded = cast(['decode-calldata', SAFE_EXEC_TRANSACTION_SIG, input]).split('\n').map(clean);
  // execTransaction(to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures)
  return { to: decoded[0], data: decoded[2] };
}

function runBuilder(args) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-out-'));
  const outPath = path.join(outDir, 'batch.json');
  const env = {
    ...process.env,
    BASE_SEPOLIA_RPC: fork.rpcUrl,
    DEPLOY_JSON: dep.deployJsonPath,
    SMOKE_CONFIG: REAL_CONFIG,
    SMOKE_DEPLOYMENT: writeDeploymentRecord(safe1),
  };
  const r = spawnSync(process.execPath, [BUILDER, ...args, '--out', outPath], { cwd: ROOT, env, encoding: 'utf8' });
  return { ...r, outPath, batch: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : undefined };
}

test('createVault: build-safe-tx-builder.mjs emits to/data byte-identical to the REAL execTransaction a live Safe-routed smoke-test.mjs run broadcast', async () => {
  const r = await runSmokeAgainstFork({ untilMatch: /registered via Safe/ });
  assert.match(r.stdout, /created via Safe/, `smoke-test did not reach createVault:\n${r.stdout}\n---stderr---\n${r.stderr}`);
  assert.match(r.stdout, /registered via Safe/, `smoke-test did not reach registerVault:\n${r.stdout}\n---stderr---\n${r.stderr}`);

  const createMatch = /tx: safe\.execTransaction\(createVault\)[\s\S]*?mined (0x[0-9a-fA-F]{64})/.exec(r.stdout);
  assert.ok(createMatch, `could not find createVault's execTransaction hash in stdout:\n${r.stdout}`);
  const real = realInnerData(createMatch[1]);

  const built = runBuilder(['createVault']);
  assert.equal(built.status, 0, `builder failed:\n${built.stdout}\n${built.stderr}`);
  const tx = built.batch.transactions[0];
  assert.equal(tx.data.toLowerCase(), real.data.toLowerCase(), 'emitted createVault data must be byte-identical to the real broadcast execTransaction\'s inner data');
  assert.equal(tx.to.toLowerCase(), real.to.toLowerCase());
  assert.equal(tx.to.toLowerCase(), dep.factory.toLowerCase());

  const vaultMatch = /vault (0x[0-9a-fA-F]{40}) created via Safe/.exec(r.stdout);
  assert.ok(vaultMatch, 'could not find the created vault address in stdout');
  const vault = vaultMatch[1];

  const registerMatch = /tx: safe\.execTransaction\(registerVault\)[\s\S]*?mined (0x[0-9a-fA-F]{64})/.exec(r.stdout);
  assert.ok(registerMatch, `could not find registerVault's execTransaction hash in stdout:\n${r.stdout}`);
  const realRegister = realInnerData(registerMatch[1]);

  const builtRegister = runBuilder(['registerVault', '--vault', vault]);
  assert.equal(builtRegister.status, 0, `builder failed:\n${builtRegister.stdout}\n${builtRegister.stderr}`);
  const regTx = builtRegister.batch.transactions[0];
  assert.equal(regTx.data.toLowerCase(), realRegister.data.toLowerCase(), 'emitted registerVault data must be byte-identical to the real broadcast execTransaction\'s inner data');
  assert.equal(regTx.to.toLowerCase(), realRegister.to.toLowerCase());
  assert.equal(regTx.to.toLowerCase(), dep.governance.toLowerCase());
});

test('registerVault refuses --vault for a vault this Safe did not create, even though the vault is real (a second, independent Safe\'s vault)', async () => {
  const safeOther = deploySafe(fork.rpcUrl, broadcaster.privateKey, [ownerA.address], 1);
  const rOther = await runSmokeAgainstFork.call(null, { untilMatch: /created via Safe/ });
  // runSmokeAgainstFork always targets safe1 (writeDeploymentRecord(safe1) is baked into it above),
  // so build a bespoke run against safeOther here instead of reusing the helper.
  void rOther; // not used; see the dedicated run below
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-tx-builder-fork-other-'));
  const env = {
    ...process.env,
    BASE_SEPOLIA_RPC: fork.rpcUrl,
    SMOKE_SIGNER_ARGS: `--private-key ${broadcaster.privateKey}`,
    DEPLOY_JSON: dep.deployJsonPath,
    SMOKE_CONFIG: REAL_CONFIG,
    SMOKE_DEPLOYMENT: writeDeploymentRecord(safeOther),
    SMOKE_STATE: path.join(runDir, 'state.json'),
    SMOKE_RESET: '1',
    SMOKE_SAFE_OWNER_SIGNERS: `--private-key ${ownerA.privateKey}`,
  };
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SMOKE_TEST], { cwd: ROOT, env });
    let stdout = '', settled = false;
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); try { child.kill(); } catch { /* gone */ } resolve({ stdout }); };
    child.stdout.on('data', (d) => { stdout += String(d); if (/created via Safe/.test(stdout)) finish(); });
    child.on('exit', finish);
    const timer = setTimeout(finish, 30_000);
  });
  const m = /vault (0x[0-9a-fA-F]{40}) created via Safe/.exec(r.stdout);
  assert.ok(m, `could not find safeOther's created vault address:\n${r.stdout}`);
  const vaultFromOtherSafe = m[1];

  // Ask the builder to register THIS vault against safe1 (writeDeploymentRecord(safe1) is baked into
  // runBuilder) — a real, on-chain vault, but not one safe1 created.
  const built = runBuilder(['registerVault', '--vault', vaultFromOtherSafe]);
  assert.notEqual(built.status, 0, 'must refuse rather than emit a batch for a vault this Safe did not create');
  assert.match(built.stderr, /creator\(\) reads/i);
});
