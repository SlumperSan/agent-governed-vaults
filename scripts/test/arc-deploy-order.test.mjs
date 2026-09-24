// @ts-check
/**
 * `scripts/sign-queue/arc-deploy.mjs` claims to mirror `DeployChainlinkOracle.s.sol` then
 * `Deploy.s.sol` EXACTLY — same order, same constructor args. This file parses those TWO
 * SOLIDITY SOURCES (not the builder's own idea of itself) and asserts the builder's item order
 * and constructor argument lists agree, so a future edit to either script that the builder is not
 * updated for turns this red rather than silently drifting.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const deploySrc = readFileSync(path.join(ROOT, 'contracts', 'script', 'Deploy.s.sol'), 'utf8');
const oracleSrc = readFileSync(path.join(ROOT, 'contracts', 'script', 'DeployChainlinkOracle.s.sol'), 'utf8');
const arcDeploySrc = readFileSync(path.join(ROOT, 'scripts', 'sign-queue', 'arc-deploy.mjs'), 'utf8');

test('DeployChainlinkOracle.s.sol deploys exactly ONE `new ChainlinkOracle(...)`, and the builder deploys it FIRST', () => {
  const matches = oracleSrc.match(/new ChainlinkOracle\(/g) ?? [];
  assert.equal(matches.length, 1, 'DeployChainlinkOracle.s.sol should construct exactly one ChainlinkOracle');
  assert.match(arcDeploySrc, /id:\s*'arc-oracle',\s*order:\s*1\b/, "arc-deploy.mjs's ChainlinkOracle item must be order 1 (deployed before anything in Deploy.s.sol, matching the two-script sequence this builder claims to mirror)");
});

test("Deploy.s.sol's `run()` constructs the six singletons in this EXACT order — the builder's own order must match", () => {
  const body = deploySrc.slice(deploySrc.indexOf('function run()'));
  const ctorOrder = [];
  const re = /(\w+)\s*=\s*new\s+(OperatorRegistry|SubVaultRegistry|FeeEngine|Governance|VaultDeployer|VaultFactory)\(/g;
  let m;
  while ((m = re.exec(body))) ctorOrder.push(m[2]);
  assert.deepEqual(ctorOrder, ['OperatorRegistry', 'SubVaultRegistry', 'FeeEngine', 'Governance', 'VaultDeployer', 'VaultFactory'],
    'Deploy.s.sol changed its construction order — arc-deploy.mjs must be updated to match');

  const idOrderPairs = [
    ['arc-registry', 2], ['arc-subreg', 3], ['arc-feeengine', 4],
    ['arc-governance', 5], ['arc-vaultdeployer', 6], ['arc-factory', 7],
  ];
  for (const [id, order] of idOrderPairs) {
    assert.match(arcDeploySrc, new RegExp(`id:\\s*'${id}',\\s*order:\\s*${order}\\b`), `arc-deploy.mjs's ${id} item must be order ${order}`);
  }
});

test("Deploy.s.sol's three wiring calls, in order, are what the builder sends next — registry.wire, subReg.wire, gov.wireSubVaultRegistry", () => {
  const body = deploySrc.slice(deploySrc.indexOf('function run()'));
  const re = /(registry|subReg|governance)\.(wire|wireSubVaultRegistry)\(/g;
  const calls = [];
  let m;
  while ((m = re.exec(body))) calls.push(`${m[1]}.${m[2]}`);
  assert.deepEqual(calls, ['registry.wire', 'subReg.wire', 'governance.wireSubVaultRegistry'],
    "Deploy.s.sol's wiring call order changed — arc-deploy.mjs's arc-wire-* order must be updated");
  assert.match(arcDeploySrc, /id:\s*'arc-wire-registry',\s*order:\s*8\b/);
  assert.match(arcDeploySrc, /id:\s*'arc-wire-subreg',\s*order:\s*9\b/);
  assert.match(arcDeploySrc, /id:\s*'arc-wire-gov',\s*order:\s*10\b/);
});

test('VaultFactory is constructed with allowSubVaults=false on Deploy.s.sol (mainnet) — the builder must pass false, never DeployTestnet\'s true', () => {
  const body = deploySrc.slice(deploySrc.indexOf('function run()'));
  const factoryCallStart = body.indexOf('factory = new VaultFactory(');
  assert.ok(factoryCallStart >= 0);
  const factoryCall = body.slice(factoryCallStart, body.indexOf(');', factoryCallStart));
  assert.match(factoryCall, /false,\s*\/\/ C-1/, 'Deploy.s.sol should pass false for allowSubVaults with its C-1 comment');
  assert.match(arcDeploySrc, /subReg[Ii]tem\.predictedAddress,\s*vaultDeployerItem\.predictedAddress,\s*false,/,
    "arc-deploy.mjs's VaultFactory constructor args must pass false for allowSubVaults");
});

test("Deploy.s.sol refuses an EMPTY BLESSED_ORACLES allowlist off the local chain — the builder must never emit one for Arc (5042)", () => {
  assert.match(deploySrc, /blessedOracles\.length > 0/);
  assert.match(arcDeploySrc, /\[\$\{oracleAddr\}\]/, "arc-deploy.mjs's VaultFactory constructor must pass a single-element blessedOracles array (the deployed oracle), never an empty one");
});

test('DeployChainlinkOracle.s.sol\'s constructor arg order is (assets, feeds, heartbeats, minWad, maxWad, usdc, sequencer) — the builder\'s ChainlinkOracle initcode must encode the same order', () => {
  assert.match(oracleSrc, /new ChainlinkOracle\(assets, feeds, heartbeats, minWad, maxWad, usdc, sequencer\)/);
  assert.match(arcDeploySrc, /constructor\(address\[\],address\[\],uint32\[\],uint256\[\],uint256\[\],address,address\)/);
});

test('AggregationRouterAdapter is deployed LAST in this builder, after every wiring call, matching Deploy.s.sol\'s own note that adapters are per-vault/not a protocol singleton wired at bring-up', () => {
  assert.match(arcDeploySrc, /id:\s*'arc-adapter',\s*order:\s*11\b/);
});

test('the read-back item depends on EVERY signing item this builder produces, so it can never mark done before the full sequence has landed', () => {
  const ids = ['arc-oracle', 'arc-registry', 'arc-subreg', 'arc-feeengine', 'arc-governance', 'arc-vaultdeployer', 'arc-factory', 'arc-wire-registry', 'arc-wire-subreg', 'arc-wire-gov', 'arc-adapter'];
  const readbackBlock = arcDeploySrc.slice(arcDeploySrc.indexOf("id: 'arc-readback'"));
  const dependsOnLine = readbackBlock.slice(0, readbackBlock.indexOf('status:'));
  for (const id of ids) {
    assert.ok(dependsOnLine.includes(`'${id}'`), `arc-readback must dependsOn '${id}'`);
  }
});
