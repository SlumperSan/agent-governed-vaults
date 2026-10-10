// @ts-check
/**
 * The board server's state-changing endpoints, run for real against a temp vault
 * (AGV_DASHBOARD_VAULT_ROOT), never the real one.
 *
 *   1. Every POST endpoint refuses a foreign-origin request (CSRF), before reading the body and
 *      without touching the task. A foreign page can send these as CORS "simple" requests with no
 *      preflight, which is why the gate is on the server and not left to the browser.
 *   2. Only an explicit button moves a suggestion. Free text, even text starting "Decline", does not.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard.mjs');

let vault, tasks, child, port, base;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = /** @type {import('node:net').AddressInfo} */ (s.address()).port;
      s.close(() => resolve(p));
    });
    s.on('error', reject);
  });
}

const task = (name, status, extra = '') => writeFileSync(path.join(tasks, name), `---\ntitle: ${name}\nstatus: ${status}\n${extra}---\nbody\n`);
const read = (name) => readFileSync(path.join(tasks, name), 'utf8');

async function post(pathname, body, headers = {}) {
  return fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

before(async () => {
  vault = mkdtempSync(path.join(tmpdir(), 'agv-board-ep-'));
  tasks = path.join(vault, 'Tasks');
  mkdirSync(tasks);
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [DASHBOARD, '--port', String(port), '--no-gh'], {
    env: { ...process.env, AGV_DASHBOARD_VAULT_ROOT: vault },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await fetch(base + '/')).ok) break;
    } catch { /* not listening yet */ }
    assert.ok(Date.now() < deadline, 'dashboard did not start');
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(() => {
  if (child?.pid) child.kill();
  if (vault) rmSync(vault, { recursive: true, force: true });
});

const FOREIGN = { origin: 'https://evil.example' };

test('/api/delete refuses a foreign Origin and leaves the task in place', async () => {
  task('victim.md', 'backlog');
  const r = await post('/api/delete', { id: 'victim' }, FOREIGN);
  assert.equal(r.status, 403);
  assert.ok(existsSync(path.join(tasks, 'victim.md')));
  assert.ok(!existsSync(path.join(tasks, '_deleted')));
});

test('/api/delete refuses the CORS-simple form (text/plain) a foreign page can send without a preflight', async () => {
  task('victim2.md', 'backlog');
  const r = await fetch(base + '/api/delete', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ id: 'victim2' }),
  });
  assert.equal(r.status, 403);
  assert.ok(existsSync(path.join(tasks, 'victim2.md')));
  const noOrigin = await fetch(base + '/api/delete', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ id: 'victim2' }) });
  assert.equal(noOrigin.status, 403, 'wrong content type is refused even with no Origin');
  assert.ok(existsSync(path.join(tasks, 'victim2.md')));
});

test('/api/answer refuses a foreign Origin and records nothing', async () => {
  task('ask.md', 'suggestion');
  const r = await post('/api/answer', { id: 'ask', answer: 'Decline', custom: false }, FOREIGN);
  assert.equal(r.status, 403);
  assert.match(read('ask.md'), /^status: suggestion$/m);
  assert.ok(!/^answer:/m.test(read('ask.md')));
});

test('the Sign queue hash endpoint still refuses a foreign Origin', async () => {
  const r = await post('/api/sign-queue/x/hash', { hash: '0x' + 'ab'.repeat(32) }, FOREIGN);
  assert.equal(r.status, 403);
});

test('a wrong Host is refused on the board endpoints (DNS rebinding)', async () => {
  task('rebind.md', 'backlog');
  // fetch() ignores a Host override, so this goes through node:http.
  const status = await new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/api/delete', method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.example' } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ id: 'rebind' }));
  });
  assert.equal(status, 403);
  assert.ok(existsSync(path.join(tasks, 'rebind.md')));
});

test('the dashboard\'s own page origin still works: delete moves the file to _deleted/', async () => {
  task('mine.md', 'backlog');
  const r = await post('/api/delete', { id: 'mine' }, { origin: base });
  assert.equal(r.status, 200, await r.text());
  assert.ok(!existsSync(path.join(tasks, 'mine.md')));
  assert.ok(existsSync(path.join(tasks, '_deleted', 'mine.md')));
});

test('a typed answer that starts with "Decline" records the answer but does NOT move the card', async () => {
  task('free.md', 'suggestion');
  const text = 'Decline for now, revisit after launch';
  const r = await post('/api/answer', { id: 'free', answer: text, custom: true }, { origin: base });
  assert.equal(r.status, 200, await r.text());
  assert.match(read('free.md'), /^status: suggestion$/m);
  assert.ok(read('free.md').includes(`answer: ${text}`));
});

test('a typed answer cannot borrow a button by sending custom:false', async () => {
  task('sneak.md', 'suggestion');
  const r = await post('/api/answer', { id: 'sneak', answer: 'Decline for now', custom: false }, { origin: base });
  assert.equal(r.status, 400);
  assert.match(read('sneak.md'), /^status: suggestion$/m);
});

test('the Approve and Decline buttons still move the card', async () => {
  task('yes.md', 'suggestion');
  task('no.md', 'suggestion');
  assert.equal((await post('/api/answer', { id: 'yes', answer: 'Approve - move to To do', custom: false }, { origin: base })).status, 200);
  assert.equal((await post('/api/answer', { id: 'no', answer: 'Decline', custom: false }, { origin: base })).status, 200);
  assert.match(read('yes.md'), /^status: backlog$/m);
  assert.match(read('no.md'), /^status: done$/m);
});
