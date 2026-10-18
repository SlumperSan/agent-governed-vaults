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
import { reconcileAnsweredSuggestions } from '../lib/task-numbers.mjs';

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

// ── Host allowlist on EVERY request (DNS rebinding can READ, not only write) ─────────────────────
//
// fetch() ignores a Host override, so these go through node:http. The routes below are the GET
// endpoints that return vault data, plus the page, a 404 and a non-GET to a read route. A request
// refused at the gate never reaches a handler, so none of these touch the numbering pass, the Sign
// queue file or the chain.

function rawRequest(pathname, host, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: pathname, method, headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

const REBIND_HOSTS = () => [`evil.example:${port}`, 'evil.example', `localhost:${port}`, `127.0.0.1.evil.example:${port}`, '127.0.0.1'];

for (const route of ['/api/status', '/api/status?force=1', '/', '/sign', '/api/sign-queue', '/api/launch-checks', '/nope']) {
  test(`GET ${route} refuses a rebinding Host`, async () => {
    for (const host of REBIND_HOSTS()) {
      const r = await rawRequest(route, host);
      assert.equal(r.status, 403, `${route} with Host ${host} returned ${r.status}`);
      assert.match(r.body, /^refused: Host is /);
    }
  });
}

test('a rebinding Host is refused for non-GET methods on a read route too', async () => {
  for (const method of ['POST', 'PUT', 'HEAD', 'DELETE']) {
    assert.equal((await rawRequest('/api/status', `evil.example:${port}`, method)).status, 403, method);
  }
});

test('a rebinding Host to /api/status does not run the numbering pass', async () => {
  task('unnumbered.md', 'backlog');
  await rawRequest('/api/status', `evil.example:${port}`);
  assert.ok(!/^num:/m.test(read('unnumbered.md')), 'a refused request must not number or reconcile anything');
});

test('the dashboard\'s own Host still gets the page, and the page cannot be framed', async () => {
  const r = await rawRequest('/', `127.0.0.1:${port}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/);
  assert.equal((await rawRequest('/sign', `127.0.0.1:${port}`)).headers['x-frame-options'], 'DENY');
});

// ── A typed answer that spells a button exactly ─────────────────────────────────────────────────

test('a typed answer equal to a button label stays put, and the refresh reconcile leaves it there', async () => {
  task('typed.md', 'suggestion');
  const r = await post('/api/answer', { id: 'typed', answer: 'Decline', custom: true }, { origin: base });
  assert.equal(r.status, 200, await r.text());
  assert.match(read('typed.md'), /^status: suggestion$/m);
  assert.match(read('typed.md'), /^answer: Decline$/m);
  assert.match(read('typed.md'), /^answer_custom: true$/m);
  // The reconcile is what the next refresh runs. Run it on a copy of the file the endpoint wrote.
  const copy = mkdtempSync(path.join(tmpdir(), 'agv-board-ep-copy-'));
  try {
    writeFileSync(path.join(copy, 'typed.md'), read('typed.md'));
    assert.deepEqual(reconcileAnsweredSuggestions(copy).moved, []);
    assert.match(readFileSync(path.join(copy, 'typed.md'), 'utf8'), /^status: suggestion$/m);
  } finally { rmSync(copy, { recursive: true, force: true }); }
});

test('a button answer carries no custom mark, so the reconcile still sees it', async () => {
  task('clicked.md', 'suggestion');
  assert.equal((await post('/api/answer', { id: 'clicked', answer: 'Decline', custom: false }, { origin: base })).status, 200);
  assert.ok(!/answer_custom/.test(read('clicked.md')));
});

test('a typed answer cannot forge the custom mark or a status line with a newline', async () => {
  task('forge.md', 'suggestion');
  const r = await post('/api/answer', { id: 'forge', answer: 'x\nanswer_custom: false\nstatus: done', custom: true }, { origin: base });
  assert.equal(r.status, 200, await r.text());
  const lines = read('forge.md').split('\n');
  assert.equal(lines.filter((l) => l === 'status: done').length, 0);
  assert.equal(lines.filter((l) => l.startsWith('answer_custom:')).length, 1);
});
