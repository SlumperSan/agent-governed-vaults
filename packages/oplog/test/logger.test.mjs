// @ts-check
/**
 * The logger's contract: one JSON object per line in production, a readable line on a TTY, the
 * same record either way, warn/error split to stderr, and a log call that can never throw.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, formatJson, formatPretty, resolveLogOptions, loggerFromEnv } from '../src/logger.mjs';

/** A logger writing into two arrays instead of the real streams. */
function harness(opts = {}) {
  const out = [];
  const err = [];
  let t = Date.UTC(2026, 7, 20, 12, 3, 22, 123);
  const log = createLogger({
    service: 'indexer', write: (l) => out.push(l), errorWrite: (l) => err.push(l),
    now: () => new Date(t), ...opts,
  });
  return { log, out, err, advance: (ms) => { t += ms; } };
}

test('json mode emits one parseable line per call with ts/level/service/event', () => {
  const { log, out } = harness();
  log.info('batch.indexed', { from: 1, to: 99, events: 3 });
  assert.equal(out.length, 1);
  const rec = JSON.parse(out[0]);
  assert.equal(rec.ts, '2026-08-20T12:03:22.123Z');
  assert.equal(rec.level, 'info');
  assert.equal(rec.service, 'indexer');
  assert.equal(rec.event, 'batch.indexed');
  assert.deepEqual([rec.from, rec.to, rec.events], [1, 99, 3]);
  assert.ok(!out[0].includes('\n'), 'exactly one line');
});

test('warn and error go to stderr, info and debug to stdout', () => {
  const { log, out, err } = harness({ level: 'debug' });
  log.debug('d');
  log.info('i');
  log.warn('w');
  log.error('e');
  assert.deepEqual(out.map((l) => JSON.parse(l).event), ['d', 'i']);
  assert.deepEqual(err.map((l) => JSON.parse(l).event), ['w', 'e']);
});

test('level threshold drops quieter records entirely', () => {
  const { log, out, err } = harness({ level: 'warn' });
  assert.equal(log.info('nope'), null);
  log.error('yep');
  assert.equal(out.length, 0);
  assert.equal(err.length, 1);
});

test('bigints serialize as decimal strings (projection state is full of them)', () => {
  const { log, out } = harness();
  log.info('vault.seen', { totalShares: 123456789012345678901234567890n });
  assert.equal(JSON.parse(out[0]).totalShares, '123456789012345678901234567890');
});

test('a circular field cannot take the process down — the line degrades instead', () => {
  const { log, out } = harness();
  const loop = { name: 'x' };
  loop.self = loop;
  assert.doesNotThrow(() => log.info('weird', { loop }));
  const rec = JSON.parse(out[0]);
  assert.equal(rec.event, 'weird');
  assert.match(rec.logError, /circular|convert/i);
});

test('pretty mode renders a human line carrying the same fields', () => {
  const { log, out } = harness({ pretty: true });
  log.info('batch.indexed', { from: 1, to: 99 });
  assert.equal(out[0], '12:03:22.123 INFO  indexer batch.indexed  from=1 to=99');
});

test('pretty mode quotes values containing whitespace so k=v stays parseable by eye', () => {
  assert.match(formatPretty({ ts: '2026-08-20T00:00:00.000Z', level: 'warn', service: 'api', event: 'x', msg: 'two words' }), /msg="two words"/);
});

test('child() carries base fields onto every later record', () => {
  const { log, out } = harness();
  const vaultLog = log.child({ vault: '0xabc' });
  vaultLog.info('signal.checked', { signal: 'nav-backing' });
  const rec = JSON.parse(out[0]);
  assert.equal(rec.vault, '0xabc');
  assert.equal(rec.signal, 'nav-backing');
  log.info('unrelated');
  assert.equal(JSON.parse(out[1]).vault, undefined, 'parent is unaffected');
});

test('text() adapts the pre-existing log(msg) string callbacks', () => {
  const { log, out, err } = harness();
  log.text('indexer.progress')('indexed [1..99] — 3 events');
  assert.equal(JSON.parse(out[0]).msg, 'indexed [1..99] — 3 events');
  log.text('indexer.progress', 'warn')('heads up');
  assert.equal(JSON.parse(err[0]).level, 'warn');
});

test('resolveLogOptions: TTY picks pretty, no TTY picks json, LOG_FORMAT overrides both', () => {
  assert.deepEqual(resolveLogOptions({}, { isTTY: true }), { pretty: true, level: 'info' });
  assert.deepEqual(resolveLogOptions({}, { isTTY: false }), { pretty: false, level: 'info' });
  assert.equal(resolveLogOptions({ LOG_FORMAT: 'json' }, { isTTY: true }).pretty, false);
  assert.equal(resolveLogOptions({ LOG_FORMAT: 'pretty' }, { isTTY: false }).pretty, true);
  assert.equal(resolveLogOptions({ LOG_LEVEL: 'debug' }).level, 'debug');
});

test('resolveLogOptions rejects a typo instead of silently logging in the wrong mode', () => {
  assert.throws(() => resolveLogOptions({ LOG_FORMAT: 'jsonl' }), /LOG_FORMAT must be/);
  assert.throws(() => resolveLogOptions({ LOG_LEVEL: 'verbose' }), /LOG_LEVEL must be/);
});

test('loggerFromEnv wires service + env through', () => {
  const out = [];
  const log = loggerFromEnv('api', { LOG_FORMAT: 'json' }, { isTTY: true, write: (l) => out.push(l) });
  log.info('listening', { port: 8402 });
  assert.equal(JSON.parse(out[0]).service, 'api');
});

test('formatJson never throws on an unserializable record', () => {
  const bad = { ts: 'x', level: 'info', service: 's', event: 'e', fn: () => {} };
  assert.doesNotThrow(() => formatJson(bad));
});
