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

/** JSX comments (`{/* ... *\/}`) removed. They are balanced braces carrying arbitrary prose — the
 *  disclosure's own comment explains the rule, so leaving them in means the reachability check
 *  below is partly reading English rather than JSX. */
const stripJsxComments = (s) => s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

/**
 * Everything between the enclosing component's `return (` and the disclosure element's `<p`.
 *
 * THIS IS THE SPAN THAT DECIDES REACHABILITY, and the first version of this guard did not look at
 * it. That version isolated the `<p>...</p>` slice and checked THAT for `?`/`&&` — so wrapping the
 * whole element in an external `{fetched.kind === 'ready' && <p ...>...</p>}` passed clean, because
 * the conditional sits one token to the LEFT of the `<p` the isolation starts at. Security
 * reproduced exactly that against the real file and the test stayed green. The property claimed
 * ("it must render every time") and the property asserted ("this element's own markup has no
 * conditional in it") differ precisely at that boundary.
 */
function prefixToDisclosure() {
  const src = stripJsxComments(APP_TSX);
  const textIdx = src.indexOf(MASTHEAD_TEXT);
  assert.ok(textIdx >= 0, 'disclosure text not found');
  const pStart = src.lastIndexOf('<p', textIdx);
  assert.ok(pStart >= 0, 'could not find the disclosure element');
  const returnIdx = src.lastIndexOf('return (', pStart);
  assert.ok(returnIdx >= 0, "could not find the enclosing component's return");
  return src.slice(returnIdx + 'return ('.length, pStart);
}

test('the testnet disclosure is NOT wrapped in any conditional -- it must render every time', () => {
  // Every `{` opened on the path from the component's return down to this element must also close
  // before it. An unclosed one IS an enclosing JSX expression container — `{cond && `, `{cond ? ` —
  // which is the only way this element can fail to render. Balance, rather than a blanket ban on
  // `?`/`&&` in the prefix, because a SIBLING conditional earlier in the masthead is balanced and
  // entirely legitimate; it is the unclosed one that gates this element.
  const prefix = prefixToDisclosure();
  let depth = 0;
  for (const c of prefix) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  assert.equal(
    depth,
    0,
    'an unclosed JSX expression container encloses the disclosure, so it renders only when that ' +
      `expression is truthy. Prefix under test:\n${prefix}`,
  );

  // And the element's own markup stays a plain string too — the narrower property the first version
  // of this guard checked. Kept, because it is still one of the two ways this can break.
  const src = stripJsxComments(APP_TSX);
  const textIdx = src.indexOf(MASTHEAD_TEXT);
  const pStart = src.lastIndexOf('<p', textIdx);
  const para = src.slice(pStart, src.indexOf('</p>', textIdx) + '</p>'.length);
  assert.doesNotMatch(para, /\{[\s\S]*\?[\s\S]*:[\s\S]*\}/, 'the disclosure paragraph contains a ternary');
  assert.doesNotMatch(para, /&&/, 'the disclosure paragraph is short-circuited on a condition');
});

test('MUTATION: an EXTERNAL conditional wrapper around the whole element is caught', () => {
  // Security's exact reproduction: the shape the first version of this guard passed clean on.
  const wrapped = APP_TSX.replace(
    `<p className="note tag-warn">${MASTHEAD_TEXT}</p>`,
    `{fetched.kind === 'ready' && <p className="note tag-warn">${MASTHEAD_TEXT}</p>}`,
  );
  assert.notEqual(wrapped, APP_TSX, 'mutation target not found -- update this test if the line moved');

  const src = stripJsxComments(wrapped);
  const textIdx = src.indexOf(MASTHEAD_TEXT);
  const pStart = src.lastIndexOf('<p', textIdx);
  const returnIdx = src.lastIndexOf('return (', pStart);
  const prefix = src.slice(returnIdx + 'return ('.length, pStart);
  let depth = 0;
  for (const c of prefix) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  assert.ok(depth > 0, 'RED: an external conditional wrapper must leave an unclosed brace in the prefix');
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
