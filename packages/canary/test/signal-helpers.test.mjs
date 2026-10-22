// @ts-check
/**
 * The small signal helpers in src/signal.mjs that the signal tests use only indirectly: the
 * transition key, the result builders, and the formatters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alert, bpsToPct, divergenceBps, ok, shortAddr, signalId, skipped } from '../src/signal.mjs';

const V = '0x1234567890abcdef1234567890abcdef12345678';

test('signalId: two parts without a key, three with one', () => {
  assert.equal(signalId('nav-backing', V), `nav-backing|${V}`);
  assert.equal(signalId('oracle-freshness', V, 'weth'), `oracle-freshness|${V}|weth`);
  // An empty key is no key, so a per-asset id cannot collide with the vault-wide one by accident.
  assert.equal(signalId('s', V, ''), `s|${V}`);
});

test('ok, alert and skipped stamp status and id from the fields', () => {
  for (const [fn, status] of [[ok, 'ok'], [alert, 'alert'], [skipped, 'skipped']]) {
    const r = fn({ signal: 'x', vault: V, key: 'k', message: 'm' });
    assert.equal(r.status, status);
    assert.equal(r.id, `x|${V}|k`);
    assert.equal(r.message, 'm');
  }
  assert.equal(ok({ signal: 'x', vault: V, message: 'm' }).id, `x|${V}`);
});

test('shortAddr shortens long strings and passes everything else through', () => {
  assert.equal(shortAddr(V), '0x1234…5678');
  assert.equal(shortAddr('0x12345678'), '0x12345678');
  assert.equal(shortAddr(undefined), 'undefined');
  assert.equal(shortAddr(null), 'null');
});

test('divergenceBps is symmetric, integer, and zero for two zeros', () => {
  assert.equal(divergenceBps(0n, 0n), 0n);
  assert.equal(divergenceBps(100n, 100n), 0n);
  assert.equal(divergenceBps(100n, 90n), 1000n);
  assert.equal(divergenceBps(90n, 100n), 1000n);
  assert.equal(divergenceBps(0n, 5n), 10000n);
  // Truncates rather than rounds: 1/3 of 10000 is 3333.33.
  assert.equal(divergenceBps(3n, 2n), 3333n);
});

test('bpsToPct keeps the sign on values whose whole part is zero', () => {
  assert.equal(bpsToPct(137n), '1.37%');
  assert.equal(bpsToPct(0n), '0.00%');
  assert.equal(bpsToPct(5n), '0.05%');
  assert.equal(bpsToPct(-50n), '-0.50%');
  assert.equal(bpsToPct(-1234n), '-12.34%');
  assert.equal(bpsToPct(10000), '100.00%');
});
