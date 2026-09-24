// @ts-check
/**
 * Tests for the dashboard's client-side Launch checks render path — `renderLaunchChecks` and the
 * `Check` button's click handler, both defined inline inside `scripts/dashboard.mjs`'s `<script>`
 * block (there is no bundler here; the client JS is a template string served as-is).
 *
 * THE PROPERTY UNDER TEST: a failed check must render UNKNOWN loudly, never blank, never green,
 * and never leave a PREVIOUS successful check's PASS pills on screen. That is PR #366's Product
 * REJECT, second finding ("Defect B") — the click handler's `catch` wrote only the stamp line and
 * never called `renderLaunchChecks`, so a later failed click left stale PASS pills untouched.
 *
 * This file extracts the actual shipped source (the exact line range covering `LC_ROWS` through
 * the `lc-check` click handler, plus the `esc()` helper it calls) and runs it in a `vm` context
 * against a minimal DOM stub — so a future edit to the real script is what gets tested, not a
 * hand-copied duplicate that could drift out of sync with it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_PATH = path.resolve(__dirname, '..', 'dashboard.mjs');
const SOURCE = readFileSync(DASHBOARD_PATH, 'utf8');

/** Pull `esc()` — one line, used by the launch-checks block below. */
function extractEsc() {
  const m = SOURCE.match(/^const esc = s => String\(s \?\? ''\)\.replace\(.*\);$/m);
  assert.ok(m, 'could not find the client-side esc() helper in scripts/dashboard.mjs — has it moved?');
  return m[0];
}

/**
 * Pull the launch-checks client block verbatim: from the `// ---- launch checks` comment through
 * the closing `});` of the `lc-check` click handler, stopping before the separate `lc-rows`
 * (copy-button) click handler, which this file does not exercise.
 */
function extractLaunchChecksBlock() {
  const startMarker = '// ---- launch checks ';
  const endMarker = "document.getElementById('lc-rows').addEventListener('click', async e => {";
  const start = SOURCE.indexOf(startMarker);
  const end = SOURCE.indexOf(endMarker);
  assert.ok(start !== -1, 'start marker not found — has the launch-checks block moved in scripts/dashboard.mjs?');
  assert.ok(end !== -1 && end > start, 'end marker not found — has the lc-rows copy handler moved?');
  return SOURCE.slice(start, end);
}

/** A DOM element stub sufficient for this block: innerHTML/textContent get+set, addEventListener
 * capturing the last handler registered per event (this script registers one 'click' handler on
 * 'lc-check', which is all this block needs). */
function makeEl() {
  const listeners = {};
  return {
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = v; },
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) { this._text = v; },
    disabled: false,
    addEventListener(evt, fn) { listeners[evt] = fn; },
    _listeners: listeners,
  };
}

/** Runs the extracted source in a fresh vm context against a fresh set of stub elements, keyed by
 * id, auto-created on first access (the block only ever touches 'lc-rows', 'lc-check', 'lc-stamp').
 * @param {typeof fetch} fetchImpl
 */
function loadLaunchChecksClient(fetchImpl) {
  /** @type {Record<string, ReturnType<typeof makeEl>>} */
  const els = {};
  const documentStub = {
    getElementById(id) {
      if (!els[id]) els[id] = makeEl();
      return els[id];
    },
  };
  const context = { document: documentStub, fetch: fetchImpl, AbortSignal, console };
  vm.createContext(context);
  const src = extractEsc() + '\n' + extractLaunchChecksBlock();
  vm.runInContext(src, context, { filename: 'dashboard-launch-checks-client.mjs' });
  return els;
}

const healthyRows = [
  { id: 'safe', name: 'Creator Safe live on Arc mainnet', state: 'green', detail: 'ok', remedy: null },
  { id: 'proposal', name: 'Stale governance proposal blocking the soak', state: 'green', detail: 'ok', remedy: null },
  { id: 'balance', name: 'Deployer balance margin', state: 'green', detail: 'ok', remedy: null },
  { id: 'arc-deploy', name: 'Arc deployment', state: 'red', detail: 'not deployed', remedy: null },
  { id: 'member-surface', name: 'What app.rwally.com and rwally.com are serving', state: 'green', detail: 'ok', remedy: null },
];
const okFetch = async () => ({ ok: true, json: async () => ({ at: new Date().toISOString(), rows: healthyRows }) });

// ─────────────────────────────── the non-firing branch: healthy rows ─────────────────────────────

test('renderLaunchChecks: a successful check renders PASS pills for green rows', async () => {
  const els = loadLaunchChecksClient(okFetch);
  await els['lc-check']._listeners.click();
  assert.match(els['lc-rows'].innerHTML, /class="pill lc-pill go">PASS/, 'a green row must render the PASS pill');
  assert.doesNotMatch(els['lc-rows'].innerHTML, /NOT CHECKED YET/, 'a row that was actually checked must not read as never-checked');
});

// ─────────── a row missing from an otherwise-200 response — same defect, third route in ──────────

test('renderLaunchChecks: a row absent from a SUCCESSFUL response (not thrown, not a failed fetch) still renders UNKNOWN, never NOT CHECKED YET', async () => {
  // A 200 response whose `rows` array is simply short one entry — no throw, no network failure —
  // is a third way to reach the same vanishing-disclosure shape: `byId['proposal']` is undefined,
  // so without the `attempted` guard the row would fall through to the "never checked" branch.
  const shortRows = healthyRows.filter((r) => r.id !== 'proposal');
  const shortFetch = async () => ({ ok: true, json: async () => ({ at: new Date().toISOString(), rows: shortRows }) });
  const els = loadLaunchChecksClient(shortFetch);
  await els['lc-check']._listeners.click();
  const html = els['lc-rows'].innerHTML;
  const rowMatch = html.match(/<div class="lcrow">[\s\S]*?Stale governance proposal blocking the soak[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(rowMatch, 'could not locate the "Stale governance proposal" row in the rendered output');
  const rowHtml = rowMatch[0];
  assert.match(rowHtml, /class="pill lc-pill idle">UNKNOWN/,
    'a row missing from an otherwise-successful response must render UNKNOWN');
  assert.doesNotMatch(rowHtml, /NOT CHECKED YET/,
    'must not read as never-checked — a check WAS attempted and this row just didn\'t come back');
});

// ───────────────────────────── Defect B: stale PASS pills on later failure ───────────────────────

test('click handler: a full check failure after a prior successful check replaces stale PASS pills with UNKNOWN pills', async () => {
  let call = 0;
  const flakyFetch = async () => {
    call += 1;
    if (call === 1) return okFetch();
    throw new Error('ECONNREFUSED (simulated)');
  };
  const els = loadLaunchChecksClient(flakyFetch);

  await els['lc-check']._listeners.click();
  assert.match(els['lc-rows'].innerHTML, /class="pill lc-pill go">PASS/, 'precondition: first click painted PASS pills');

  await els['lc-check']._listeners.click();
  const html = els['lc-rows'].innerHTML;
  assert.doesNotMatch(html, /class="pill lc-pill go">PASS/, 'a fully failed second click must NOT leave the prior PASS pills on screen');
  assert.match(html, /class="pill lc-pill idle">UNKNOWN/, 'a fully failed check must render every row UNKNOWN, loudly');
  assert.doesNotMatch(html, /NOT CHECKED YET/, 'a failed check must not read as merely never-checked — that is silence, not disclosure');
  assert.match(els['lc-stamp'].innerHTML, /check failed/);
});

test('mutation: reverting the catch handler to skip renderLaunchChecks (the rejected #366 shape) makes the stale-pill test fail', async () => {
  const mutatedBlock = extractLaunchChecksBlock().replace(
    /const byId = Object\.fromEntries\(LC_ROWS\.map\(meta =>\n\s*\[meta\.id, \{ id:meta\.id, state:'unknown', detail:'check failed — '\+e\.message, remedy:null \}\]\)\);\n\s*renderLaunchChecks\(byId\);\n/,
    ''
  );
  assert.notEqual(mutatedBlock, extractLaunchChecksBlock(), 'mutation must actually remove the renderLaunchChecks(byId) call — regex did not match the fix');

  let call = 0;
  const flakyFetch = async () => {
    call += 1;
    if (call === 1) return okFetch();
    throw new Error('ECONNREFUSED (simulated)');
  };
  /** @type {Record<string, ReturnType<typeof makeEl>>} */
  const els = {};
  const documentStub = { getElementById(id) { if (!els[id]) els[id] = makeEl(); return els[id]; } };
  const context = { document: documentStub, fetch: flakyFetch, AbortSignal, console };
  vm.createContext(context);
  vm.runInContext(extractEsc() + '\n' + mutatedBlock, context, { filename: 'mutated-client.mjs' });

  await els['lc-check']._listeners.click();
  await els['lc-check']._listeners.click();
  // With the REJECTED shape, the second (failing) click leaves the first click's PASS pills intact.
  assert.match(els['lc-rows'].innerHTML, /class="pill lc-pill go">PASS/,
    'the pre-fix shape is expected to (wrongly) leave stale PASS pills — if this fails, the mutation was not faithful to the rejected code');
});

// ───────────────────────── server-side: the real-id fallback, real reproduction ───────────────────

test('runLaunchChecks + client render: a thrown row (BigInt("0xzz")) is keyed by its real id end to end, so the panel shows UNKNOWN, not NOT CHECKED YET', async () => {
  const { runLaunchChecks } = await import('../lib/launch-checks.mjs');
  // Malformed-but-string block timestamp: passes the `typeof !== 'string'` guard inside
  // checkStaleProposal, then `BigInt('0xzz')` throws — the exact live reproduction from PR #366's
  // Product review.
  const throwingBlockFetch = async (_url, init) => {
    const parsed = JSON.parse(init.body);
    const reqs = Array.isArray(parsed) ? parsed : [parsed];
    const answer = (r) => {
      if (r.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: r.id, result: { timestamp: '0xzz' } };
      if (r.method === 'eth_call' && r.params[0].data.startsWith('0xda35c664')) {
        return { jsonrpc: '2.0', id: r.id, result: '0x' + (1n).toString(16).padStart(64, '0') };
      }
      return { jsonrpc: '2.0', id: r.id, error: { message: 'stub: no resolver' } };
    };
    const body = reqs.map(answer);
    return { ok: true, status: 200, json: async () => (Array.isArray(parsed) ? body : body[0]) };
  };

  const rows = await runLaunchChecks(throwingBlockFetch);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId['proposal'], 'the thrown "Stale governance proposal" row must be keyed under its real id "proposal"');
  assert.equal(byId['proposal'].state, 'unknown');
  assert.equal(byId['1'], undefined, 'must never fall back to the array index as the id');

  const els = loadLaunchChecksClient(async () => ({ ok: true, json: async () => ({ at: new Date().toISOString(), rows }) }));
  await els['lc-check']._listeners.click();
  assert.match(els['lc-rows'].innerHTML, /Stale governance proposal blocking the soak[\s\S]*?class="lcdetail">check threw/,
    'the panel must show the UNKNOWN detail for the named row');
  assert.doesNotMatch(els['lc-rows'].innerHTML, /Stale governance proposal blocking the soak<\/span><\/div>\s*<div class="lcdetail">Click Check to run this read\./,
    'the thrown row must not render as "Click Check to run this read" — that is the never-checked look, not a failure');
});
