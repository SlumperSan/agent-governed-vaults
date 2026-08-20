// @ts-check
/**
 * Alert sinks. The load-bearing property is that a paging OUTAGE never becomes a monitoring
 * outage: a sink that throws, times out, or returns 500 must be reported and stepped over, never
 * allowed to take the canary down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsoleSink, createWebhookSink, emitAll } from '../src/sinks.mjs';

const tr = (to = 'alert') => ({
  id: 'nav-backing|0xv', signal: 'nav-backing', vault: '0xv', key: undefined,
  from: 'ok', to, line: `${to.toUpperCase()} [nav-backing] diverged`,
  result: { measured: '1.20%', threshold: '0.50%', detail: { vault: '0xv', navWad: 7n } },
});

test('console sink sends alerts to stderr and recoveries to stdout', async () => {
  const out = [], err = [];
  const sink = createConsoleSink({ log: (m) => out.push(m), error: (m) => err.push(m) });
  await sink.emit(tr('alert'));
  await sink.emit(tr('skipped'));
  await sink.emit(tr('ok'));
  assert.equal(err.length, 2, 'alerts and degradations go to stderr so `2>` is a pure problem feed');
  assert.equal(out.length, 1);
});

test('webhook posts one JSON body per transition, with the structured detail', async () => {
  const calls = [];
  const sink = createWebhookSink({
    url: 'https://example.invalid/hook',
    fetchImpl: async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; },
  });
  await sink.emit(tr('alert'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.method, 'POST');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.status, 'alert');
  assert.equal(body.previousStatus, 'ok');
  assert.equal(body.signal, 'nav-backing');
  assert.equal(body.vault, '0xv');
  assert.equal(body.measured, '1.20%');
  assert.equal(body.detail.navWad, '7', 'bigints must survive JSON.stringify, not throw');
});

test('a webhook failure is reported but never propagates', async () => {
  const errs = [];
  const sink = createWebhookSink({
    url: 'https://example.invalid/hook',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    onError: (m) => errs.push(m),
  });
  await sink.emit(tr());
  assert.equal(errs.length, 1);
  assert.match(errs[0], /webhook delivery failed/);
});

test('a non-2xx webhook response is reported but never propagates', async () => {
  const errs = [];
  const sink = createWebhookSink({
    url: 'https://example.invalid/hook',
    fetchImpl: async () => ({ ok: false, status: 503 }),
    onError: (m) => errs.push(m),
  });
  await sink.emit(tr());
  assert.match(errs[0], /webhook returned 503/);
});

test('emitAll keeps going when one sink throws — a paging outage is not a monitoring outage', async () => {
  const delivered = [];
  const errs = [];
  const broken = { name: 'broken', emit: async () => { throw new Error('boom'); } };
  const good = { name: 'good', emit: async (t) => delivered.push(t.id) };
  await emitAll([broken, good], [tr(), tr()], { onError: (m) => errs.push(m) });
  assert.equal(delivered.length, 2, 'the working sink still received both transitions');
  assert.equal(errs.length, 2);
  assert.match(errs[0], /sink broken threw/);
});
