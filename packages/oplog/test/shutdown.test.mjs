// @ts-check
/**
 * Graceful shutdown, driven by a FAKE process emitter — real signals in a test runner are a way to
 * kill the runner. What matters: hooks run once, in order, a thrower does not block the rest, a
 * repeat signal exits immediately, and the watchdog fires when a hook wedges.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createShutdown } from '../src/shutdown.mjs';

/** Stand-in for `process`: `.on(sig)` registers, `.emit(sig)` delivers. */
function fakeProc() {
  const ee = new EventEmitter();
  return { on: (s, fn) => ee.on(s, fn), emit: (s) => ee.emit(s), ee };
}

function recorder() {
  const lines = [];
  const at = (lv) => (event, fields) => lines.push({ lv, event, ...fields });
  return { log: { info: at('info'), warn: at('warn'), error: at('error') }, lines };
}

test('SIGTERM runs every hook in registration order, then exits 0', async () => {
  const proc = fakeProc();
  const codes = [];
  const order = [];
  const sd = createShutdown({ proc, exit: (c) => codes.push(c) })
    .onShutdown('indexer.finish-batch', () => { order.push('batch'); })
    .onShutdown('indexer.snapshot', () => { order.push('snapshot'); })
    .install();

  proc.emit('SIGTERM');
  await sd.trigger('await');           // second call returns the in-flight promise
  assert.deepEqual(order, ['batch', 'snapshot']);
  assert.equal(sd.state, 'done');
  assert.ok(codes.includes(0));
});

test('hooks are awaited: an async hook completes before exit', async () => {
  const done = [];
  const codes = [];
  const sd = createShutdown({ proc: fakeProc(), exit: (c) => codes.push(c) })
    .onShutdown('slow', async () => { await new Promise((r) => setTimeout(r, 5)); done.push('slow'); })
    .onShutdown('after', () => { done.push('after'); });
  await sd.trigger('SIGTERM');
  assert.deepEqual(done, ['slow', 'after']);
  assert.deepEqual(codes, [0]);
});

test('a hook that throws is logged and the later hooks still run', async () => {
  const { log, lines } = recorder();
  const ran = [];
  const sd = createShutdown({ proc: fakeProc(), log, exit: () => {} })
    .onShutdown('snapshot', () => { throw new Error('disk full'); })
    .onShutdown('drain', () => { ran.push('drain'); });
  await sd.trigger('SIGTERM');
  assert.deepEqual(ran, ['drain'], 'a failed snapshot must not block the API drain');
  const bad = lines.find((l) => l.event === 'shutdown.step' && l.ok === false);
  assert.equal(bad.step, 'snapshot');
  assert.match(bad.error, /disk full/);
  assert.ok(lines.some((l) => l.event === 'shutdown.complete'));
});

test('hooks run exactly once even if the signal arrives twice', async () => {
  const proc = fakeProc();
  let runs = 0;
  const codes = [];
  const sd = createShutdown({ proc, exit: (c) => codes.push(c) })
    .onShutdown('once', async () => { runs += 1; await new Promise((r) => setTimeout(r, 5)); })
    .install();
  proc.emit('SIGTERM');
  proc.emit('SIGTERM');   // the "I meant it" second signal
  await sd.trigger('drain');
  assert.equal(runs, 1);
  assert.ok(codes.includes(1), 'the repeat signal force-exits nonzero');
});

test('the watchdog force-exits when a hook never finishes', async () => {
  const codes = [];
  const { log, lines } = recorder();
  const sd = createShutdown({ proc: fakeProc(), log, timeoutMs: 5, exit: (c) => codes.push(c) })
    .onShutdown('wedged', () => new Promise(() => {}));
  sd.trigger('SIGTERM');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(codes, [1]);
  assert.ok(lines.some((l) => l.event === 'shutdown.timeout'));
  assert.equal(sd.state, 'running', 'still wedged — the watchdog exits, it does not pretend to finish');
});

test('install() subscribes to every configured signal', async () => {
  const proc = fakeProc();
  const fired = [];
  const sd = createShutdown({ proc, signals: ['SIGTERM', 'SIGINT', 'SIGHUP'], exit: () => {} })
    .onShutdown('note', (reason) => { fired.push(reason); })
    .install();
  proc.emit('SIGHUP');
  await sd.trigger('drain');
  assert.deepEqual(fired, ['SIGHUP'], 'the hook is told which signal caused it');
  assert.deepEqual(sd.hooks, ['note']);
});
