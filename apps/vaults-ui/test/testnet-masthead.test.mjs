// @ts-check
/**
 * Chairman directive: `app.rwally.com`'s cutover to `apps/vaults-ui` on Base Sepolia is
 * conditioned on the masthead carrying, verbatim, "Reading Base Sepolia testnet. No vault holds
 * real funds yet." — the one thing standing between this app and going live.
 *
 * UNCONDITIONAL, ON PURPOSE. `App.tsx`'s masthead already had one line gated on
 * `fetched.kind === 'ready' && fetched.freshness['rpcUrl']` — the exact disclosure-that-vanishes
 * shape this repo has found five times this week (`Rules/a-disclosure-that-vanishes-is-a-claim.md`):
 * a read that can fail is a disclosure that can vanish, and its absence reads as "this is
 * mainnet". This guard asserts the string is present in the masthead's own JSX source with NO
 * conditional wrapping it — not behind `fetched.kind`, not behind a ternary, not behind any prop.
 *
 * SOURCE GUARD, same reason as every sibling wiring test in this file: no JSX/TSX loader in
 * `node --test`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const APP = fileURLToPath(new URL('..', import.meta.url));
const APP_TSX = readFileSync(join(APP, 'src/App.tsx'), 'utf8');

const MASTHEAD_TEXT = 'Reading Base Sepolia testnet. No vault holds real funds yet.';

/** The masthead <header> block, isolated so a match elsewhere in the file cannot pass this. */
function mastheadSource() {
  const start = APP_TSX.indexOf('<header className="masthead">');
  assert.ok(start >= 0, 'the masthead header is gone from App.tsx -- did it move or get renamed?');
  const end = APP_TSX.indexOf('</header>', start);
  assert.ok(end > start, 'could not find the end of the masthead header');
  return APP_TSX.slice(start, end);
}

test('the masthead carries the testnet disclosure verbatim', () => {
  assert.ok(
    mastheadSource().includes(MASTHEAD_TEXT),
    'the exact Chairman-directed testnet string is missing from the masthead',
  );
});

test('the testnet disclosure is NOT wrapped in any conditional -- it must render every time', () => {
  const header = mastheadSource();
  const idx = header.indexOf(MASTHEAD_TEXT);
  assert.ok(idx >= 0, 'string not found (see the test above)');
  // The paragraph carrying this string, isolated by its own <p ...> ... </p> boundaries.
  const pStart = header.lastIndexOf('<p', idx);
  const pEnd = header.indexOf('</p>', idx) + '</p>'.length;
  assert.ok(pStart >= 0 && pEnd > pStart, 'could not isolate the paragraph carrying the disclosure');
  const para = header.slice(pStart, pEnd);
  assert.doesNotMatch(
    para,
    /\{[\s\S]*\?[\s\S]*:[\s\S]*\}/,
    'the disclosure paragraph contains a ternary -- it must be a plain, unconditional string, ' +
      'never gated on fetched.kind, freshness, or any other read that can fail',
  );
  assert.doesNotMatch(para, /&&/, 'the disclosure paragraph is short-circuited on a condition -- it must always render');
});

test('MUTATION: removing the testnet disclosure line is caught', () => {
  const withoutLine = APP_TSX.replace(
    /\s*<p className="note tag-warn">Reading Base Sepolia testnet\. No vault holds real funds yet\.<\/p>\n/,
    '\n',
  );
  assert.notEqual(withoutLine, APP_TSX, 'mutation target not found -- update this test if the line moved');
  assert.doesNotMatch(withoutLine, /Reading Base Sepolia testnet\. No vault holds real funds yet\./, 'RED: with the line removed, the guard above must fail');
});

test('MUTATION: paraphrasing the disclosure is caught (verbatim text required)', () => {
  const paraphrased = APP_TSX.replace(MASTHEAD_TEXT, 'This app reads Base Sepolia testnet data. No real funds are involved.');
  assert.notEqual(paraphrased, APP_TSX, 'mutation target not found');
  assert.doesNotMatch(paraphrased, new RegExp(MASTHEAD_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'RED: a paraphrase must not satisfy the verbatim-text guard');
});

test('MUTATION: re-gating the disclosure on fetched.kind is caught', () => {
  const reGated = APP_TSX.replace(
    `<p className="note tag-warn">${MASTHEAD_TEXT}</p>`,
    `<p className="note tag-warn">{fetched.kind === 'ready' ? '${MASTHEAD_TEXT}' : null}</p>`,
  );
  assert.notEqual(reGated, APP_TSX, 'mutation target not found');
  // Re-run the unconditional check against the mutated source directly.
  const start = reGated.indexOf('<header className="masthead">');
  const end = reGated.indexOf('</header>', start);
  const header = reGated.slice(start, end);
  const idx = header.indexOf(MASTHEAD_TEXT);
  const pStart = header.lastIndexOf('<p', idx);
  const pEnd = header.indexOf('</p>', idx) + '</p>'.length;
  const para = header.slice(pStart, pEnd);
  assert.match(para, /\?/, 'RED: the mutated version must trip the no-conditional guard');
});
