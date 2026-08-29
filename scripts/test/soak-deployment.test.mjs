// @ts-check
/**
 * Tests for the soak run's deployment loader and freeze-safety classifier.
 *
 * Why these two are tested and the drill drivers are not: the drivers shell out to `cast` at
 * module scope and cannot be imported without a chain, exactly as `smoke-test.mjs` could not
 * (Sprint-9 §7.5 solved that by extracting the decision into a pure module — same move here).
 * What IS pure is (a) how we resolve addresses, and (b) how we score the freeze-safety probe.
 * Both are load-bearing: a mis-resolved address sends a real transaction to the wrong contract,
 * and a mis-scored probe writes a false claim into the report.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseDeployment, wiringExpectations, loadDeployment } from '../soak/deployment.mjs';
import { classifyCancelPending, SEL_NO_PENDING } from '../soak/oracle-sampler.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const BOOK = path.join(ROOT, 'contracts', 'config', 'deployments', 'base-sepolia.json');

/** A minimal well-formed address book. */
const good = () => ({
  chainId: 84532,
  chainName: 'base-sepolia',
  rpc: 'https://rpc.example',
  startBlock: 100,
  deployer: '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35',
  singletons: {
    OperatorRegistry: '0xC5F3A734618019C4abE512dD9BF3D5B852494bDB',
    SubVaultRegistry: '0x0C60b9a4C207dd622CcC0Ee3C51b5c274cb7B979',
    FeeEngine: '0xDEb08dCF5ceaf00c95E2C355CB63aC334C7e3fBc',
    Governance: '0x4AddcAc4834a8672edb4Aef25c33D7909865091c',
    VaultDeployer: '0x2c70858BA8796398CC7638389155d1Cc0426533D',
    VaultFactory: '0x79279FBa3b6F6736f07cbBFcB7Cf0559466D5bfB',
  },
  oracle: {
    OracleAggregator: '0xEc1976579Af27b3dF5fd103390acAb22E4b566F4',
    maxStalenessSeconds: 86400,
    assets: {
      WETH: {
        token: '0x4200000000000000000000000000000000000006',
        quorum: 2,
        sources: ['0x790A308f1ac06FeD4C79884BAD25d0C721C5B125'],
        underlyingFeed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
      },
    },
  },
  execution: { AggregationRouterAdapter: '0x1D8794279035CC04C9BCF939AB956845916998c1' },
  infrastructure: { usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' },
});

test('parseDeployment resolves every singleton the drills need', () => {
  const d = parseDeployment(good());
  assert.equal(d.factory, '0x79279FBa3b6F6736f07cbBFcB7Cf0559466D5bfB');
  assert.equal(d.vaultDeployer, '0x2c70858BA8796398CC7638389155d1Cc0426533D');
  assert.equal(d.governance, '0x4AddcAc4834a8672edb4Aef25c33D7909865091c');
  assert.equal(d.aggregator, '0xEc1976579Af27b3dF5fd103390acAb22E4b566F4');
  assert.equal(d.adapter, '0x1D8794279035CC04C9BCF939AB956845916998c1');
});

test('VaultFactory and VaultDeployer do not get swapped', () => {
  // The exact Sprint-9 §6.3 hazard: forge's own output had these two transposed, and the
  // address book is the artifact that corrected it. createVault against the VaultDeployer
  // would revert; worse, a transposition that happened to hit a real contract could spend a
  // signature somewhere unintended. Pin them apart.
  const d = parseDeployment(good());
  assert.notEqual(d.factory, d.vaultDeployer);
  assert.equal(d.factory, good().singletons.VaultFactory);
  assert.equal(d.vaultDeployer, good().singletons.VaultDeployer);
});

test('parseDeployment rejects a chainId mismatch', () => {
  // Guards against pointing a testnet drill at a mainnet book, which is the one config error
  // that cannot be undone.
  assert.throws(() => parseDeployment(good(), { expectChainId: 8453 }), /chainId 84532 != expected 8453/);
});

test('parseDeployment names every missing singleton at once', () => {
  const raw = good();
  delete raw.singletons.Governance;
  delete raw.singletons.VaultFactory;
  assert.throws(() => parseDeployment(raw), /missing singletons: Governance, VaultFactory/);
});

test('parseDeployment rejects a malformed address rather than passing it to cast', () => {
  const raw = good();
  raw.singletons.Governance = '0xdeadbeef';
  assert.throws(() => parseDeployment(raw), /Governance is not a 20-byte address/);
});

test('parseDeployment rejects an asset with no oracle sources', () => {
  const raw = good();
  raw.oracle.assets.WETH.sources = [];
  assert.throws(() => parseDeployment(raw), /asset WETH lists no oracle feed\/sources/);
});

test('parseDeployment accepts the C-6 ChainlinkOracle shape (single feed per asset)', () => {
  // The launch model: oracle.ChainlinkOracle + one `feed` per asset (no `sources`/`quorum`/
  // `underlyingFeed`). Exercises every fallback: aggregator key, sources=[feed], quorum=1,
  // underlyingFeed<-feed. Legacy books (above) must keep parsing too.
  const raw = good();
  delete raw.oracle.OracleAggregator;
  raw.oracle.ChainlinkOracle = '0xEc1976579Af27b3dF5fd103390acAb22E4b566F4';
  raw.oracle.assets.WETH = {
    token: '0x4200000000000000000000000000000000000006',
    feed: '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1',
  };
  const d = parseDeployment(raw);
  assert.equal(d.aggregator, '0xEc1976579Af27b3dF5fd103390acAb22E4b566F4');
  assert.equal(d.assets[0].quorum, 1, 'single feed => quorum 1');
  assert.deepEqual(d.assets[0].sources, ['0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1']);
  assert.equal(d.assets[0].underlyingFeed, '0x4aDC67696bA383F43DD60A9e78F2C97Fbbfc7cb1', 'underlyingFeed <- feed');
});

test('wiringExpectations covers every edge Sprint-9 verified', () => {
  const checks = wiringExpectations(parseDeployment(good()));
  assert.equal(checks.length, 9);
  const labels = checks.map((c) => c.label);
  for (const need of ['registry.factory()', 'gov.subVaultRegistry()', 'factory.vaultDeployer()']) {
    assert.ok(labels.includes(need), `missing wiring check ${need}`);
  }
  // Every expectation must be a concrete address, never undefined: an undefined `expect`
  // compares equal to an undefined read and would pass vacuously.
  for (const c of checks) assert.match(c.expect, /^0x[0-9a-fA-F]{40}$/);
});

test('the committed base-sepolia address book parses and is chain-84532', () => {
  const d = loadDeployment(BOOK, { expectChainId: 84532 });
  assert.equal(d.chainId, 84532);
  assert.equal(d.maxStalenessSeconds, 86400);
  assert.equal(d.assets.length, 2);
  // C-6 pivot: the committed book is now the Chainlink-direct stack — ONE genuine Chainlink feed
  // per asset (no multi-source median), so a single-element source set and quorum 1.
  for (const a of d.assets) {
    assert.equal(a.sources.length, 1, `${a.symbol} should list its single Chainlink feed`);
    assert.equal(a.quorum, 1, `${a.symbol} is single-feed => quorum 1`);
    assert.equal(a.sources[0], a.underlyingFeed, `${a.symbol} source === underlying feed`);
  }
  // The oracle resolves to the deployed ChainlinkOracle in the factory allowlist.
  assert.equal(d.aggregator, '0x6371E14C0682882e75E8382caf0216545B1f43C6');
});

// ── freeze-safety classifier (drill 4) ────────────────────────────────────────

test('cancelPending succeeding is the freeze-safety pass', () => {
  assert.equal(classifyCancelPending({ ok: true, out: '0x' }, '5000000'), 'callable');
});

test('a NoPending revert is scored n/a, never as a pass', () => {
  // The dangerous direction: scoring "there was nothing to cancel" as proof that cancelling
  // works would let the drill claim freeze-safety was demonstrated when nothing was probed.
  const r = { ok: false, err: 'execution reverted, data: "0xda7557bc"' };
  assert.equal(classifyCancelPending(r, '0'), 'n/a-no-pending');
  assert.notEqual(classifyCancelPending(r, '0'), 'callable');
});

test('a NoPending revert is n/a even when the pending amount could not be read', () => {
  const r = { ok: false, err: `reverted, data: "${SEL_NO_PENDING}"` };
  assert.equal(classifyCancelPending(r, null), 'n/a-no-pending');
});

test('a zero pending balance is n/a even if the RPC truncated the revert data', () => {
  assert.equal(classifyCancelPending({ ok: false, err: 'execution reverted' }, '0'), 'n/a-no-pending');
});

test('any other revert WITH a real pending deposit is the reportable finding', () => {
  // This is the case the drill exists to catch: a live pending deposit that cannot be
  // reclaimed. StaleOracle here would mean the escrow-return path consulted a price.
  const r = { ok: false, err: 'execution reverted, data: "0x88cce429"' }; // StaleOracle()
  assert.equal(classifyCancelPending(r, '5000000'), 'BLOCKED');
});

test('SEL_NO_PENDING matches the NoPending() selector cast computes', () => {
  // Pinned rather than derived, so renaming the error in VaultCore fails here instead of
  // silently reclassifying every BLOCKED result as n/a.
  assert.equal(SEL_NO_PENDING, '0xda7557bc');
});
