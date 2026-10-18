/**
 * The same-address CREATE2 manifest (`contracts/config/create2-manifest.json`) against the compiled
 * artifacts, recomputed here with viem (`scripts/lib/create2-manifest.mjs`) and then once more by hand
 * with nothing but keccak256, so the address formula is not trusted to a library either.
 *
 * `contracts/test/Create2Determinism.t.sol` is the other reader, on the Solidity side. This file needs
 * `forge build` to have run first (scripts/gate.mjs and ci.yml both build before the backend suite) and
 * FAILS, rather than skips, when `contracts/out` is absent: a guard that can skip is a guard that will.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { concatHex, getAddress, keccak256, toBytes } from 'viem';
import {
  CONTRACTS,
  MANIFEST_PATH,
  ROOT,
  buildManifest,
  creationCode,
  readFixedFromSource,
} from '../lib/create2-manifest.mjs';

// Written out here, not read from the sources under test.
const ARACHNID_PROXY = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
const INITIALIZER = '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35';

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
const toml = readFileSync(path.join(ROOT, 'contracts', 'foundry.toml'), 'utf8');

test('the committed manifest equals a fresh computation from contracts/out', () => {
  assert.deepEqual(
    manifest,
    buildManifest(),
    'create2-manifest.json is stale. Run `node scripts/update-create2-manifest.mjs` and review which address moved.',
  );
});

test('the proxy and the initializer are the literals the owner approved', () => {
  assert.equal(manifest.proxy, ARACHNID_PROXY);
  assert.equal(manifest.initializer, INITIALIZER);
  assert.deepEqual(readFixedFromSource(), { proxy: ARACHNID_PROXY, initializer: INITIALIZER });
});

test('each address is keccak256(0xff ++ proxy ++ salt ++ initcodeHash)[12:], computed by hand', () => {
  assert.deepEqual(Object.keys(manifest.contracts), CONTRACTS);
  for (const [name, c] of Object.entries(manifest.contracts)) {
    const digest = keccak256(concatHex(['0xff', manifest.proxy, c.salt, c.initcodeHash]));
    assert.equal(getAddress(`0x${digest.slice(26)}`), c.address, `${name}: address does not follow the CREATE2 formula`);
    assert.equal(c.salt, keccak256(toBytes(c.saltPreimage)), `${name}: salt is not keccak256 of its preimage`);
    assert.ok(!/chain/i.test(c.saltPreimage), `${name}: a chain id in the salt would give a different address per chain`);
  }
});

test('six distinct addresses, six distinct salts', () => {
  const c = Object.values(manifest.contracts);
  assert.equal(c.length, 6);
  assert.equal(new Set(c.map((x) => x.address)).size, 6);
  assert.equal(new Set(c.map((x) => x.salt)).size, 6);
});

test('foundry.toml carries the metadata settings the manifest depends on, and says so in the manifest', () => {
  assert.match(toml, /^bytecode_hash = "none"$/m, 'bytecode_hash is not "none": a comment edit would move an address');
  assert.match(toml, /^cbor_metadata = false$/m, 'cbor_metadata is not false: a comment edit would move an address');
  assert.equal(manifest.build.bytecodeHash, 'none');
  assert.equal(manifest.build.cborMetadata, false);
  assert.match(toml, new RegExp(`^solc_version = "${manifest.build.solc.replace(/\./g, '\\.')}"$`, 'm'));
  assert.match(toml, new RegExp(`^evm_version = "${manifest.build.evmVersion}"$`, 'm'));
  assert.match(toml, /^via_ir = true$/m);
  assert.match(toml, new RegExp(`^optimizer_runs = ${manifest.build.optimizerRuns}$`, 'm'));
});

test('no singleton creation code carries a metadata trailer', () => {
  // solc's CBOR trailer starts a2 64 'ipfs' 58 22 (ipfs) or a1 65 'bzzr0' 58 20 (swarm). With the
  // settings above neither is emitted; seeing one means the build ignored foundry.toml.
  for (const name of CONTRACTS) {
    const code = creationCode(name).toLowerCase();
    assert.ok(!code.includes('a2646970667358'), `${name}: ipfs metadata trailer present`);
    assert.ok(!code.includes('a165627a7a72305820'), `${name}: bzzr0 metadata trailer present`);
    assert.ok(!code.includes('64736f6c63'), `${name}: solc version marker present`);
  }
});

test('the launch-chain deployment record for v1 is untouched by this manifest', () => {
  // The v1 Arc singletons were made by plain CREATE and cannot move; none of the v2 addresses may
  // equal one of them, or "v2 beside v1" would be a lie.
  const v1 = JSON.parse(readFileSync(path.join(ROOT, 'contracts', 'config', 'deployments', 'arc-mainnet.json'), 'utf8')).singletons;
  const v1Addresses = new Set(Object.values(v1).map((a) => String(a).toLowerCase()));
  for (const [name, c] of Object.entries(manifest.contracts)) {
    assert.ok(!v1Addresses.has(c.address.toLowerCase()), `${name} v2 address equals a v1 Arc singleton`);
  }
});
