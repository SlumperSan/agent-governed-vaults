// @ts-check
/**
 * `normalizeLog` and `sortEvents` (src/chain.mjs): the two functions every polled log passes
 * through before the fold. Covered here directly so the canonicalization rules and the fold order
 * are pinned independently of the daemon that calls them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLog, sortEvents } from '../src/chain.mjs';

const VAULT_CS = '0xAbCdEf0123456789abcdef0123456789ABCDEF01';
const VAULT = VAULT_CS.toLowerCase();
const EMITTER_CS = '0x00000000000000000000000000000000000000Aa';
const EMITTER = EMITTER_CS.toLowerCase();

const raw = (args, extra = {}) => ({ eventName: 'Thing', address: EMITTER_CS, blockNumber: 7n, logIndex: 3, args, ...extra });

test('normalizeLog lowercases address args and the emitter, and numbers the position', () => {
  const ev = normalizeLog(raw({ member: VAULT_CS, amount: 5n, note: 'Keep Case', hash: '0x' + 'AB'.repeat(32) }), VAULT_CS);
  assert.deepEqual(ev, {
    name: 'Thing',
    vault: VAULT,
    emitter: EMITTER,
    blockNumber: 7,
    logIndex: 3,
    args: { member: VAULT, amount: 5n, note: 'Keep Case', hash: '0x' + 'AB'.repeat(32) },
  });
  assert.equal(typeof ev.blockNumber, 'number');
});

test('normalizeLog: vault comes from the argument, then args.vault, then the emitter', () => {
  assert.equal(normalizeLog(raw({ vault: EMITTER_CS }), VAULT_CS).vault, VAULT);
  assert.equal(normalizeLog(raw({ vault: VAULT_CS })).vault, VAULT);
  assert.equal(normalizeLog(raw({})).vault, EMITTER);
});

test('normalizeLog with attributed:false never derives a vault, but keeps the claim in args', () => {
  const ev = normalizeLog(raw({ vault: VAULT_CS }), undefined, { attributed: false });
  assert.equal(ev.vault, null);
  assert.equal(ev.args.vault, VAULT);
  // Even an explicit vault argument is ignored for untrusted code.
  assert.equal(normalizeLog(raw({}), VAULT_CS, { attributed: false }).vault, null);
});

test('normalizeLog tolerates a log with no args', () => {
  const ev = normalizeLog({ eventName: 'Bare', address: EMITTER_CS, blockNumber: 1, logIndex: 0, args: undefined });
  assert.deepEqual(ev.args, {});
  assert.equal(ev.vault, EMITTER);
});

test('normalizeLog does not lowercase a string that only looks address-like', () => {
  const short = '0xABC';
  const long = '0x' + 'A'.repeat(41);
  const ev = normalizeLog(raw({ short, long }));
  assert.equal(ev.args.short, short);
  assert.equal(ev.args.long, long);
});

test('sortEvents orders by block then log index, without mutating its input', () => {
  const e = (b, i) => ({ blockNumber: b, logIndex: i });
  const input = [e(2, 1), e(1, 5), e(2, 0), e(1, 0)];
  const copy = input.map((x) => ({ ...x }));
  const out = sortEvents(input);
  assert.deepEqual(out, [e(1, 0), e(1, 5), e(2, 0), e(2, 1)]);
  assert.deepEqual(input, copy);
  assert.notEqual(out, input);
  assert.deepEqual(sortEvents([]), []);
});
