// @ts-check
/**
 * Pure helpers of the reference agent that no other test file exercised directly: the pluggable
 * evaluators, the log preview, the due/deferred split, the WAD formatter, the chain preset
 * fragment and the outside-record switch. Each one is called with plain values; nothing here
 * touches a network or a chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { alwaysAbstain, EVALUATORS, naiveDriftBand, resolveEvaluator } from '../src/evaluators.mjs';
import { hexPreview } from '../src/log.mjs';
import { partitionDue } from '../src/plan.mjs';
import { CRANK_EXECUTE_PTYPE, fmtWad } from '../src/policy.mjs';
import {
  CHAIN_PRESETS,
  ConfigError,
  UNPROVEN_OPERATOR_PROFILE,
  USDC_DECIMALS,
  USDC_UNIT,
  presetFragment,
} from '../src/config.mjs';
import { wantsOutsideRecord } from '../src/perceive.mjs';

const WAD = 10n ** 18n;
const HASH = '0x' + 'ab'.repeat(32);

// ── evaluators ────────────────────────────────────────────────────────────────

const drift = (idle, total, config = {}, proposal = { actionHash: HASH }) =>
  naiveDriftBand.evaluate({ proposal, chain: { idleUsdc: idle, totalAssetsUsdc: total }, config });

test('naiveDriftBand: drift inside the band votes against as churn', () => {
  const r = drift(400n, 10_000n); // 400 bps < default 500
  assert.equal(r.support, false);
  assert.match(r.reason, /inside the band 500bps/);
  assert.deepEqual(r.detail, { driftBps: 400, band: 500, maxBand: 5000 });
});

test('naiveDriftBand: drift between the band and the max votes for', () => {
  const r = drift(2_000n, 10_000n);
  assert.equal(r.support, true);
  assert.equal(r.detail.driftBps, 2000);
});

test('naiveDriftBand: drift above the max band votes against as a mandate change', () => {
  const r = drift(6_000n, 10_000n);
  assert.equal(r.support, false);
  assert.match(r.reason, /exceeds the max band 5000bps/);
});

test('naiveDriftBand: both band edges are inclusive on the "for" side', () => {
  assert.equal(drift(500n, 10_000n).support, true);
  assert.equal(drift(5_000n, 10_000n).support, true);
  assert.equal(drift(5_001n, 10_000n).support, false);
});

test('naiveDriftBand: config overrides the band and the max band', () => {
  const r = drift(300n, 10_000n, { driftBandBps: 200, maxDriftBandBps: 400 });
  assert.equal(r.support, true);
  assert.deepEqual(r.detail, { driftBps: 300, band: 200, maxBand: 400 });
});

test('naiveDriftBand: unreadable or zero balances abstain rather than vote', () => {
  for (const [idle, total] of [[null, 10_000n], [100n, null], [100n, 0n], [undefined, undefined]]) {
    const r = drift(idle, total);
    assert.equal(r.support, null, `idle=${idle} total=${total}`);
    assert.match(r.reason, /^abstain: cannot read/);
  }
});

test('naiveDriftBand: requireKnownAction abstains on an unknown hash, and names a known one', () => {
  const unknown = drift(2_000n, 10_000n, { requireKnownAction: true });
  assert.equal(unknown.support, null);
  assert.equal(unknown.detail.actionHash, HASH);

  // Keys are matched lowercased, so an upper case hash on the proposal still resolves.
  const known = drift(2_000n, 10_000n, { requireKnownAction: true, knownActions: { [HASH]: 'rotate to basket' } }, {
    actionHash: HASH.toUpperCase().replace('0X', '0x'),
  });
  assert.equal(known.support, true);
  assert.match(known.reason, /\(action: rotate to basket\)$/);
});

test('naiveDriftBand: an unverified payload says so in the reason', () => {
  assert.match(drift(2_000n, 10_000n).reason, /action payload NOT verified/);
});

test('naiveDriftBand: accepts decimal strings for balances', () => {
  const r = naiveDriftBand.evaluate({ proposal: {}, chain: { idleUsdc: '2000', totalAssetsUsdc: '10000' }, config: {} });
  assert.equal(r.detail.driftBps, 2000);
});

test('alwaysAbstain never forms a view', () => {
  const r = alwaysAbstain.evaluate();
  assert.equal(r.support, null);
  assert.match(r.reason, /^abstain:/);
});

test('EVALUATORS registry is frozen and keyed by name', () => {
  assert.ok(Object.isFrozen(EVALUATORS));
  assert.deepEqual(Object.keys(EVALUATORS).sort(), ['always-abstain', 'naive-drift-band']);
  for (const [k, v] of Object.entries(EVALUATORS)) assert.equal(v.name, k);
});

test('resolveEvaluator: by name, by object, and unknown names throw', () => {
  assert.equal(resolveEvaluator('naive-drift-band'), naiveDriftBand);
  assert.equal(resolveEvaluator('always-abstain'), alwaysAbstain);

  const evaluate = () => ({ support: true, reason: 'x', detail: {} });
  assert.deepEqual(resolveEvaluator({ name: 'mine', evaluate }), { name: 'mine', evaluate });
  assert.equal(resolveEvaluator({ evaluate }).name, 'custom');

  assert.throws(() => resolveEvaluator('nope'), /unknown evaluator "nope" — known: naive-drift-band, always-abstain/);
  assert.throws(() => resolveEvaluator(undefined), /unknown evaluator/);
  // An object without an evaluate function is not an implementation.
  assert.throws(() => resolveEvaluator(/** @type {any} */ ({ name: 'x' })), /unknown evaluator/);
});

// ── log.hexPreview ────────────────────────────────────────────────────────────

test('hexPreview keeps the first and last four bytes of a long hex value', () => {
  const v = '0x' + '11223344' + '00'.repeat(24) + 'aabbccdd';
  assert.equal(hexPreview(v), '0x11223344…aabbccdd');
});

test('hexPreview passes short or non-hex values through unchanged', () => {
  assert.equal(hexPreview('0x1234'), '0x1234');
  assert.equal(hexPreview('not hex at all, but long enough'), 'not hex at all, but long enough');
  assert.equal(hexPreview(null), '');
  assert.equal(hexPreview(undefined), '');
  assert.equal(hexPreview(42), '42');
});

// ── plan.partitionDue ─────────────────────────────────────────────────────────

test('partitionDue splits on dueAtSec <= now, preserving order', () => {
  const a = { id: 'a', dueAtSec: 10 };
  const b = { id: 'b', dueAtSec: 20 };
  const c = { id: 'c', dueAtSec: 5 };
  const d = { id: 'd', dueAtSec: 21 };
  const { due, deferred } = partitionDue([a, b, c, d], 20);
  assert.deepEqual(due, [a, b, c]);
  assert.deepEqual(deferred, [d]);
  assert.deepEqual(partitionDue([], 0), { due: [], deferred: [] });
});

// ── policy.fmtWad and CRANK_EXECUTE_PTYPE ─────────────────────────────────────

test('fmtWad truncates to four decimals', () => {
  assert.equal(fmtWad(WAD), '1.0000');
  assert.equal(fmtWad(0n), '0.0000');
  assert.equal(fmtWad((WAD * 3n) / 2n), '1.5000');
  assert.equal(fmtWad(12_345_678_900_000_000_000n), '12.3456');
  assert.equal(fmtWad(WAD / 10_000n), '0.0001');
  assert.equal(fmtWad(WAD / 10_000n - 1n), '0.0000');
  assert.equal(fmtWad('2000000000000000000'), '2.0000');
});

test('the crank executes only proposal type 0 (Rebalance)', () => {
  assert.equal(CRANK_EXECUTE_PTYPE, 0);
});

// ── config.presetFragment ─────────────────────────────────────────────────────

test('USDC constants are six decimals', () => {
  assert.equal(USDC_DECIMALS, 6n);
  assert.equal(USDC_UNIT, 1_000_000n);
});

test('presetFragment: every preset maps its JSON file, addresses lowercased', () => {
  assert.ok(CHAIN_PRESETS.length > 0);
  assert.ok(Object.isFrozen(CHAIN_PRESETS));
  for (const name of CHAIN_PRESETS) {
    const raw = JSON.parse(readFileSync(new URL(`../presets/${name}.json`, import.meta.url), 'utf8'));
    const f = presetFragment(name);
    assert.equal(f.chain.preset, name);
    assert.equal(f.chain.chainId, raw.chainId);
    assert.equal(f.chain.chainName, raw.chainName);
    assert.equal(f.chain.rpcUrl, raw.rpcUrls[0]);
    assert.deepEqual(f.chain.rpcUrls, raw.rpcUrls);
    assert.deepEqual(f.chain.nativeCurrency, raw.nativeCurrency);
    assert.equal(f.chain.governance, raw.contracts.governance.toLowerCase());
    assert.equal(f.chain.factory, raw.contracts.factory.toLowerCase());
    assert.equal(f.chain.operatorRegistry, raw.contracts.operatorRegistry.toLowerCase());
    assert.equal(f.chain.subvaultRegistry, raw.contracts.subvaultRegistry.toLowerCase());
    assert.equal(f.chain.usdc, raw.contracts.usdc.toLowerCase());
    assert.equal(f.chain.vaultList.contract, raw.vaultList.contract.toLowerCase());
    assert.equal(f.chain.usdcName, raw.usdcDomain.name);
    assert.equal(f.chain.usdcVersion, raw.usdcDomain.version);
    assert.equal(f.policy.join.depositUsdc, raw.depositUsdc);
  }
});

test('presetFragment refuses an unknown preset with a ConfigError', () => {
  assert.throws(
    () => presetFragment('base-mainnet'),
    (e) => e instanceof ConfigError && /unknown chain preset "base-mainnet"/.test(e.message),
  );
});

// ── perceive.wantsOutsideRecord ───────────────────────────────────────────────

test('wantsOutsideRecord: on for the unproven-operator profile or any disclosed address', () => {
  const cfg = (profile, disclosedAddresses) => ({ policy: { join: { profile, disclosedAddresses } } });
  assert.equal(wantsOutsideRecord(cfg(null, [])), false);
  assert.equal(wantsOutsideRecord(cfg(UNPROVEN_OPERATOR_PROFILE, [])), true);
  assert.equal(wantsOutsideRecord(cfg(null, ['0x' + '1'.repeat(40)])), true);
  assert.equal(wantsOutsideRecord(cfg('something-else', [])), false);
});
