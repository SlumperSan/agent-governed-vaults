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

test('the v1 builder is RETIRED: build() refuses, so it can never emit items against the CREATE2 contracts', async () => {
  // Why this replaces the three tests that used to mirror Deploy.s.sol's CREATE order into this
  // builder. Deploy.s.sol is now the CREATE2 recipe and VaultFactory's constructor no longer takes
  // the oracle list, so a rebuilt queue would deploy a factory with its allowlist never set and then
  // wire the registry to it. The builder describes the completed Arc v1 deploy and must not run again.
  const mod = await import('../sign-queue/arc-deploy.mjs');
  assert.throws(() => mod.build(), /RETIRED/, 'arc-deploy.mjs build() no longer refuses');
});

const createSrc = readFileSync(path.join(ROOT, 'contracts', 'script', 'lib', 'ProtocolCreate2.sol'), 'utf8');

test("Deploy.s.sol brings the seven singletons up through ProtocolCreate2, pinned to PROTOCOL_INITIALIZER", () => {
  const body = deploySrc.slice(deploySrc.indexOf('function run()'));
  assert.match(body, /vm\.startBroadcast\(PROTOCOL_INITIALIZER\)/, 'the broadcast must be pinned to PROTOCOL_INITIALIZER');
  assert.doesNotMatch(body, /vm\.startBroadcast\(\)/, 'an unpinned broadcast would let any signer start the script');
  assert.match(body, /ProtocolCreate2\.createAll\(\)/);
  assert.doesNotMatch(body, /=\s*new\s+(OperatorRegistry|SubVaultRegistry|FeeEngine|Governance|VaultDeployer|AgentVaultDeployer|VaultFactory)\(/, 'a plain CREATE would not land at the CREATE2 address');
});

test('ProtocolCreate2.createAll deploys the seven in this EXACT order', () => {
  const fn = createSrc.slice(createSrc.indexOf('function createAll()'));
  const order = [...fn.matchAll(/create\(SALT_(\w+),/g)].map((m) => m[1]);
  assert.deepEqual(order, ['OPERATOR_REGISTRY', 'SUB_VAULT_REGISTRY', 'FEE_ENGINE', 'GOVERNANCE', 'VAULT_DEPLOYER', 'AGENT_VAULT_DEPLOYER', 'VAULT_FACTORY']);
});

test("the factory is initialised (oracles, then the agent path) BEFORE the registry is wired to it, then the three wires run in order", () => {
  const body = deploySrc.slice(deploySrc.indexOf('function run()'));
  const calls = [...body.matchAll(/(factory\.initialize|factory\.initializeAgentPath|registry\.wire|subReg\.wire|governance\.wireSubVaultRegistry)\(/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['factory.initialize', 'factory.initializeAgentPath', 'registry.wire', 'subReg.wire', 'governance.wireSubVaultRegistry'],
    'an uninitialised factory (oracle allowlist off) must never be the one a registry is wired to');
});

test('the CREATE2 factory is built root-only: ALLOW_SUB_VAULTS is false in the recipe, and the retired v1 builder still passes false', () => {
  assert.match(createSrc, /bool internal constant ALLOW_SUB_VAULTS = false;/);
  assert.match(createSrc, /ALLOW_SUB_VAULTS\s*\n?\s*\)/, 'the recipe must pass ALLOW_SUB_VAULTS into the factory initcode');
  assert.match(arcDeploySrc, /subReg[Ii]tem\.predictedAddress,\s*vaultDeployerItem\.predictedAddress,\s*false,/,
    "arc-deploy.mjs's VaultFactory constructor args must pass false for allowSubVaults");
});

test("Deploy.s.sol refuses an EMPTY BLESSED_ORACLES allowlist off the local chain", () => {
  assert.match(deploySrc, /blessedOracles\.length > 0/);
  assert.match(deploySrc, /factory\.initialize\(blessedOracles\)/);
});

test("Deploy.s.sol takes the agent registry from its recorded address and refuses before broadcasting when it has no code", () => {
  const body = deploySrc.slice(deploySrc.indexOf('function run()'));
  assert.match(body, /config\/agent-registry-create2\.json/);
  assert.match(body, /agentRegistry\.code\.length > 0/);
  assert.ok(
    body.indexOf('agentRegistry.code.length > 0') < body.indexOf('vm.startBroadcast('),
    'the registry code check must run before anything is broadcast',
  );
  assert.match(body, /factory\.initializeAgentPath\(agentRegistry,/);
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
