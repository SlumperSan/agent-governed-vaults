// @ts-check
/**
 * `packages/reference-agent/presets/arc-mainnet.json` EQUALS the deployment record.
 *
 * The preset is a file inside the package because `Dockerfile` copies `packages` and an integrator
 * copies the agent out of the tree: neither carries `scripts/` or the deployment record. A second
 * copy of an address is a second place for it to be wrong, so this test regenerates the preset
 * from `contracts/config/deployments/arc-mainnet.json` with `scripts/build-agent-preset.mjs` and
 * demands the file on disk be byte-identical.
 *
 * What the generator cannot derive from the record is the USDC EIP-712 domain, so the test checks
 * that block a different way: offline, by hashing it. A name or version typed wrong no longer
 * hashes to the `DOMAIN_SEPARATOR()` that `scripts/verify-arc-usdc-domain.mjs` read from the token
 * on both Arc RPCs and recorded beside it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPreset, serialize, RECORD_PATH, CONFIG_PATH, PRESET_PATH } from '../build-agent-preset.mjs';
import { separatorOf } from '../verify-arc-usdc-domain.mjs';

const read = (p) => JSON.parse(readFileSync(p, 'utf8'));
const record = read(RECORD_PATH);
const config = read(CONFIG_PATH);
const onDisk = read(PRESET_PATH);

test('the preset on disk is byte-identical to what the generator builds from the deployment record', () => {
  const built = serialize(buildPreset(record, config, onDisk.usdcDomain));
  assert.equal(readFileSync(PRESET_PATH, 'utf8'), built, 'run `node scripts/build-agent-preset.mjs` to regenerate it');
});

test("every address in the preset is the record's, field by field", () => {
  assert.equal(onDisk.chainId, record.chainId);
  assert.equal(onDisk.chainName, record.chainName);
  assert.equal(onDisk.contracts.governance, record.singletons.Governance);
  assert.equal(onDisk.contracts.factory, record.singletons.VaultFactory);
  assert.equal(onDisk.contracts.operatorRegistry, record.singletons.OperatorRegistry);
  assert.equal(onDisk.contracts.subvaultRegistry, record.singletons.SubVaultRegistry);
  assert.equal(onDisk.contracts.usdc, record.infrastructure.usdc);
  assert.deepEqual(onDisk.rpcUrls, [record.rpc, record.crossCheckedOn]);
  assert.equal(onDisk.vaultList.contract, record.singletons.VaultFactory);
});

test("the deposit figures are the config's minimum, in whole USDC", () => {
  assert.equal(BigInt(config.smoke.minDepositUsdc), BigInt(onDisk.minDepositUsdc) * 1_000_000n);
  assert.equal(onDisk.minDepositUsdc, '100');
  assert.equal(onDisk.depositUsdc, '100');
});

test('the native currency is USDC at 18 decimals, the native view of the 6-decimal token', () => {
  assert.deepEqual(onDisk.nativeCurrency, { name: 'USDC', symbol: 'USDC', decimals: 18 });
});

test("the recorded USDC domain reproduces the recorded DOMAIN_SEPARATOR, and names the preset's own USDC", () => {
  const d = onDisk.usdcDomain;
  assert.equal(d.chainId, 5042);
  assert.equal(d.verifyingContract, onDisk.contracts.usdc);
  assert.match(d.separator, /^0x[0-9a-f]{64}$/);
  assert.equal(separatorOf(d), d.separator);
});

test('the generator refuses a record whose addresses are missing or whose chain is not 5042', () => {
  const d = onDisk.usdcDomain;
  const dropped = structuredClone(record);
  delete dropped.singletons.Governance;
  assert.throws(() => buildPreset(dropped, config, d), /no address for singletons.Governance/);
  assert.throws(() => buildPreset({ ...record, chainId: 8453 }, config, d), /chain 5042/);
  assert.throws(() => buildPreset(record, { ...config, smoke: { ...config.smoke, minDepositUsdc: '100500000' } }, d), /whole number of USDC/);
});
