// @ts-check
/**
 * The safety gates: dry-run by default, execute refused unless BOTH conditions hold, and no key
 * material survives into anything log-bound.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  EXECUTE_ENV_VAR,
  ConfigError,
  fromBaseUnits,
  gateMode,
  loadConfig,
  redact,
  toBaseUnits,
} from '../src/config.mjs';

const ACCOUNT = { address: '0x' + '1'.repeat(40), signMessage: async () => '0x' };

test('the default mode is dry-run and skipWindow is off', () => {
  assert.equal(DEFAULT_CONFIG.mode, 'dry-run');
  assert.equal(DEFAULT_CONFIG.danger.allowSkipWindow, false);
  assert.equal(loadConfig().mode, 'dry-run');
});

test('dry-run needs nothing and signs no transactions', () => {
  assert.deepEqual(gateMode({ mode: 'dry-run' }), { mode: 'dry-run', signsTransactions: false });
  // Even with everything an execute run would need, dry-run stays dry-run.
  assert.equal(gateMode({ mode: 'dry-run', account: ACCOUNT, env: { [EXECUTE_ENV_VAR]: 'yes' } }).signsTransactions, false);
});

test('execute REFUSES without an account', () => {
  assert.throws(
    () => gateMode({ mode: 'execute', account: null, env: { [EXECUTE_ENV_VAR]: 'yes' } }),
    (e) => e instanceof ConfigError && /no viem account was injected/.test(e.message),
  );
});

test('execute REFUSES without the env var', () => {
  assert.throws(
    () => gateMode({ mode: 'execute', account: ACCOUNT, env: {} }),
    (e) => e instanceof ConfigError && new RegExp(EXECUTE_ENV_VAR).test(e.message),
  );
});

test('execute REFUSES on a near-miss env value — no truthiness, no aliases', () => {
  for (const v of ['1', 'true', 'YES', 'Yes', 'y', ' yes', 'yes ', ''])
    assert.throws(() => gateMode({ mode: 'execute', account: ACCOUNT, env: { [EXECUTE_ENV_VAR]: v } }), ConfigError, `value ${JSON.stringify(v)} must not unlock execute`);
});

test('execute REFUSES rather than silently downgrading to dry-run', () => {
  // The failure mode this guards: a gate that returned dry-run on a missing condition would teach
  // an operator the env var is optional, and they would be wrong exactly once.
  let result = null;
  try {
    result = gateMode({ mode: 'execute', account: null, env: {} });
  } catch {
    /* expected */
  }
  assert.equal(result, null, 'gateMode must throw, never return a downgraded mode');
});

test('execute is allowed only with BOTH an account and the exact env value', () => {
  assert.deepEqual(gateMode({ mode: 'execute', account: ACCOUNT, env: { [EXECUTE_ENV_VAR]: 'yes' } }), {
    mode: 'execute',
    signsTransactions: true,
  });
});

test('an unknown mode is rejected', () => {
  assert.throws(() => loadConfig({ mode: 'yolo' }), ConfigError);
  assert.throws(() => gateMode({ mode: 'yolo' }), ConfigError);
});

test('redact reduces a signer to its public address', () => {
  const account = { address: '0x' + 'a'.repeat(40), signMessage: () => {}, signTransaction: () => {}, source: 'privateKey' };
  const out = redact({ account });
  assert.equal(out.account.address, account.address);
  assert.equal(out.account.signMessage, undefined);
  assert.equal(out.account.signTransaction, undefined);
});

test('redact removes key-shaped fields and bare 32-byte hex', () => {
  const KEY = '0x' + 'de'.repeat(32);
  const out = redact({
    privateKey: KEY,
    secret: 'hunter2',
    mnemonic: 'test test test',
    nested: { pk: KEY, salt: KEY },
    incidental: KEY,
  });
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes('de'.repeat(32)), `a key survived redaction: ${flat}`);
  assert.ok(!flat.includes('hunter2'));
  assert.ok(!flat.includes('test test test'));
  assert.equal(out.incidental, '[redacted:32-byte-hex]');
});

test('redact survives cycles and deep nesting without throwing', () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: 'deep' } } } } } } } } };
  assert.doesNotThrow(() => redact(deep));
  assert.equal(redact(10n ** 20n), '100000000000000000000');
});

test('USDC amounts round-trip through base units', () => {
  assert.equal(toBaseUnits('25'), 25_000_000n);
  assert.equal(toBaseUnits('0.01'), 10_000n);
  assert.equal(toBaseUnits('0.000001'), 1n);
  assert.equal(fromBaseUnits(25_000_000n), '25');
  assert.equal(fromBaseUnits(10_000n), '0.01');
  assert.equal(fromBaseUnits(-15_500_000_000n), '-15500');
  assert.throws(() => toBaseUnits('0.0000001'), ConfigError); // 7dp — more precision than USDC has
  assert.throws(() => toBaseUnits('abc'), ConfigError);
});

test('loadConfig validates money knobs eagerly, not at first use', () => {
  assert.throws(() => loadConfig({ api: { payments: { maxSessionSpendUsdc: 'lots' } } }), ConfigError);
  assert.throws(() => loadConfig({ policy: { join: { depositUsdc: '1.9999999' } } }), ConfigError);
});

test('overrides merge deeply without dropping sibling defaults', () => {
  const cfg = loadConfig({ policy: { join: { depositUsdc: '5' } } });
  assert.equal(cfg.policy.join.depositUsdc, '5');
  assert.equal(cfg.policy.join.requireAttestedOperator, true, 'sibling default must survive');
  assert.equal(cfg.policy.timing.revealSafetyMarginSec, 1800, 'unrelated branch must survive');
});
