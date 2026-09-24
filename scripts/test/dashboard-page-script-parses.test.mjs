// @ts-check
/**
 * The dashboard's whole page script must PARSE. On 2026-09-23 #382 shipped a second top-level
 * `const VIEW` into the inline <script>, which already declared `let VIEW` for the board's
 * department filter. That is an early SyntaxError, so the browser ran none of the script: no
 * Connect-MetaMask handler and no Sign items, and the board tab did not render either. Every test
 * passed, because none of them compiled the page as the browser does. This one does.
 *
 * `PAGE` is a template literal with no interpolations, so evaluating its source yields exactly the
 * string the server sends. Each inline <script> body is then compiled with vm.Script, which reports
 * the same early errors a browser does (duplicate lexical declarations, stray tokens), and runs
 * nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DASHBOARD = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboard.mjs');
const SOURCE = readFileSync(DASHBOARD, 'utf8');

function pageHtml() {
  const start = SOURCE.indexOf('const PAGE = `');
  const end = SOURCE.indexOf('</body></html>`;', start);
  assert.ok(start !== -1 && end !== -1, 'could not find the PAGE template in scripts/dashboard.mjs — fix this locator, do not delete the test');
  const literal = SOURCE.slice(start + 'const PAGE = '.length, end + '</body></html>`'.length);
  assert.ok(!literal.includes('${'), 'PAGE gained an interpolation; evaluate it with its real inputs instead');
  return vm.runInNewContext(literal);
}

test('every inline <script> on the dashboard page compiles, as the browser would parse it', () => {
  const html = pageHtml();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 1, 'no inline <script> found in PAGE');
  for (const [i, body] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(body, { filename: `dashboard-page-script-${i}.js` }),
      `inline <script> #${i} does not parse, so the browser runs none of it`);
  }
});

test('mutation: a duplicate top-level declaration (the #382 defect) is caught', () => {
  const body = [...pageHtml().matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1];
  assert.throws(() => new vm.Script(`${body}\nconst esc = 1;`), SyntaxError);
});
