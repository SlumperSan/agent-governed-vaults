// @ts-check
/**
 * The one thing unit tests cannot reach: a REAL SIGTERM delivered to the REAL entrypoint.
 *
 * shutdown.test.mjs proves the hook machinery with a fake process emitter, and serve.test.mjs
 * proves the pieces the hooks call. What is left unverified is the wiring in between — that
 * `install()` on the actual `process` runs the actual hooks, that the listener drains rather than
 * hanging, and that the process exits 0 rather than being killed by the grace-period timer.
 *
 * SKIPPED ON WINDOWS, where `child.kill('SIGTERM')` is TerminateProcess: the handler cannot run, so
 * the test would assert a platform artifact rather than our behaviour. CI is ubuntu-latest and
 * production is a Linux container, which is where the signal is real and this runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, mkdtemp } from 'node:fs/promises';
import { applyAll } from '../../../packages/indexer/src/projections.mjs';
import { saveSnapshot } from '../../../packages/indexer/src/store.mjs';

const skipOnWindows = process.platform === 'win32'
  ? 'SIGTERM is not deliverable to a child on Windows (kill() is TerminateProcess)'
  : false;

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SERVE = join(HERE, '..', 'src', 'serve.mjs');
const V = '0x' + '1'.repeat(40);
const USDC = '0x' + 'c'.repeat(40);

/** Free-ish port: high and unlikely to collide with the other tests in this suite. */
const PORT = 8500 + (process.pid % 300);

function waitFor(child, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting; saw:\n${buf}`)), timeoutMs);
    const onData = (d) => {
      buf += d.toString('utf8');
      if (predicate(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

test('SIGTERM to the real API entrypoint drains and exits 0', { skip: skipOnWindows }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'api-signal-'));
  const statePath = join(dir, 'indexer-state.json');
  await saveSnapshot(statePath, applyAll([
    { name: 'VaultCreated', vault: V, blockNumber: 5, logIndex: 0, args: { vault: V, creator: V, usdc: USDC, capacityCapUsdc: 1n } },
  ]));

  const child = spawn(process.execPath, [SERVE], {
    env: {
      ...process.env,
      PRICE_ASSET: USDC, PRICE_PAYTO: '0x' + '9'.repeat(40),
      STATE_PATH: statePath, HEARTBEAT_DIR: dir, PORT: String(PORT),
      LOG_FORMAT: 'json', RELOAD_MS: '1000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const output = [];
  child.stdout.on('data', (d) => output.push(d.toString('utf8')));
  child.stderr.on('data', (d) => output.push(d.toString('utf8')));

  try {
    await waitFor(child, (b) => b.includes('"event":"listening"'));

    // It is actually serving before we stop it — otherwise "it drained" proves nothing.
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).lastBlock, 5);

    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const { code, signal } = await Promise.race([
      exited,
      new Promise((_, rej) => setTimeout(() => rej(new Error('did not exit within 10s of SIGTERM')), 10_000)),
    ]);

    assert.equal(signal, null, 'exited on its own rather than being killed');
    assert.equal(code, 0, 'clean exit code');

    const text = output.join('');
    assert.match(text, /"event":"shutdown\.begin"/);
    assert.match(text, /"event":"shutdown\.complete"/);
    assert.doesNotMatch(text, /"event":"shutdown\.timeout"/, 'the hooks finished inside the watchdog');
    // Every hook ran, in order, and none of them failed.
    for (const step of ['api.stop-reload', 'api.drain', 'api.final-metrics']) {
      assert.match(text, new RegExp(`"step":"${step.replace('.', '\\.')}","ok":true`), `${step} completed`);
    }
    // The final metrics line is the point of the last hook: it must carry real counters.
    assert.match(text, /"event":"metrics\.final"[\s\S]*vault_api_requests_total/);

    // And the port is genuinely released, not lingering in a half-closed listener.
    await assert.rejects(fetch(`http://127.0.0.1:${PORT}/health`));
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
