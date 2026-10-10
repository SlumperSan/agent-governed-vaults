// @ts-check
/**
 * Chairman directive: `app.rwally.com`'s masthead must carry a truthful, unconditional statement
 * of what chain it reads and whether real funds are at stake. On Base Sepolia that was, verbatim,
 * "Reading Base Sepolia testnet. No vault holds real funds yet." RWAlly's v1 vault (cirBTC Vault,
 * 0x4EAE5C6D753AAC0b4825d41c12e71f0a8bE579f6) went live on Arc mainnet (chain 5042) on 2026-09-24
 * (firstVault.createdAt, contracts/config/deployments/arc-mainnet.json),
 * so that sentence is now false — Base Sepolia is no longer what this app reads, and the vault
 * exists to hold real member funds the moment anyone deposits. The masthead was updated in the
 * same commit as the chain cutover (`.env.example`, `public/_headers`); its seeded clause was made
 * plain on 2026-09-24 (CEO: seeded deposits are said to be operator funds). It now reads, verbatim,
 * MASTHEAD_TEXT below — true both while the vault sits empty and once it is not, and it still
 * distinguishes genuine member activity from anything the RWAlly team seeds on it itself.
 *
 * UNCONDITIONAL, ON PURPOSE. `App.tsx`'s masthead already had one line gated on
 * `fetched.kind === 'ready' && fetched.freshness['rpcUrl']` — the exact disclosure-that-vanishes
 * shape this repo has found five times this week (`Rules/a-disclosure-that-vanishes-is-a-claim.md`):
 * a read that can fail is a disclosure that can vanish, and its absence reads as an unqualified,
 * unlabelled mainnet. This guard asserts the string is present in the masthead's own JSX source
 * with NO conditional wrapping it — not behind `fetched.kind`, not behind a ternary, not behind
 * any prop.
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
const ENV_EXAMPLE = join(APP, '.env.example');

const MASTHEAD_TEXT =
  'Live on Arc mainnet. Deposits here are real funds, not a test. Seeded deposits are RWAlly operator funds, not outside members, and are labelled as such.';

/** The masthead <header> block, isolated so a match elsewhere in the file cannot pass this. */
function mastheadSource() {
  const start = APP_TSX.indexOf('<header className="masthead">');
  assert.ok(start >= 0, 'the masthead header is gone from App.tsx -- did it move or get renamed?');
  const end = APP_TSX.indexOf('</header>', start);
  assert.ok(end > start, 'could not find the end of the masthead header');
  return APP_TSX.slice(start, end);
}

/** JSX comments (`{/* ... *\/}`) removed. They are balanced braces carrying arbitrary prose — the
 *  disclosure's own comment explains the rule, so leaving them in means a check that scans raw
 *  source is partly reading English rather than JSX. Defined ahead of every test that uses it. */
const stripJsxComments = (s) => s.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

/**
 * Pure check: does `headerSrc` (a `<header>...</header>` slice of App.tsx, comments included) make
 * a claim consistent with `chainId`? Throws with a descriptive message when it does not.
 *
 * ONE FUNCTION, USED BY BOTH THE REAL TEST AND ITS OWN MUTATION TEST -- the shape that keeps a
 * mutation test honest. A version that re-implemented the assertion inline in the mutation test
 * (as an earlier draft of this file did) could pass on a DIFFERENT check than the one it claims to
 * guard, e.g. asserting `/mainnet/i` matches the raw header block, which is also true of the
 * masthead's own JSX COMMENT ("Live on Arc mainnet since...") even with the rendered `<p>` deleted
 * entirely. Comments are stripped here first, and the 5042 branch requires the exact rendered
 * string, not a loose keyword, so a comment mentioning "mainnet" next to a missing or wrong
 * disclosure paragraph still throws.
 */
function checkChainClaim(headerSrc, chainId) {
  const stripped = stripJsxComments(headerSrc);
  if (chainId === '5042') {
    assert.ok(
      stripped.includes(MASTHEAD_TEXT),
      `VITE_CHAIN_ID is 5042 (Arc mainnet) but the rendered masthead text is missing or wrong (comments stripped):\n${stripped}`,
    );
    assert.doesNotMatch(
      stripped,
      /testnet/i,
      `VITE_CHAIN_ID is 5042 (Arc mainnet) but the rendered masthead still claims a testnet (comments stripped):\n${stripped}`,
    );
  } else {
    // Any OTHER configured chain id must not carry an unqualified "mainnet" claim it did not earn.
    assert.doesNotMatch(
      stripped,
      /\bmainnet\b/i,
      `VITE_CHAIN_ID is ${chainId}, not Arc mainnet (5042), but the rendered masthead claims mainnet (comments stripped):\n${stripped}`,
    );
  }
}

test('the masthead carries the mainnet disclosure verbatim', () => {
  assert.ok(
    mastheadSource().includes(MASTHEAD_TEXT),
    'the exact Chairman-directed mainnet string is missing from the masthead',
  );
});

/**
 * Security's requirement (2026-09-23), stated as a coupling rather than as a fixed string, the
 * same shape as `test/csp.test.mjs`'s connect-src/`VITE_RPC_URL` check: a mainnet build that still
 * says "testnet" is a MAJOR finding, and asserting only that the OLD string is gone (as the
 * mutation tests below do) does not catch a build whose `.env.example` points at chain 5042 while
 * the masthead source was hand-reverted, or never updated, to a testnet claim. This reads
 * `VITE_CHAIN_ID` out of `.env.example` — the config this repository actually builds against by
 * default — and ties the masthead's own claim to it directly, through `checkChainClaim`, so the
 * two cannot drift silently the way the Base Sepolia -> Arc cutover briefly risked.
 */
test("the masthead's chain claim matches .env.example's VITE_CHAIN_ID", () => {
  const env = readFileSync(ENV_EXAMPLE, 'utf8');
  const m = /^VITE_CHAIN_ID\s*=\s*(\S+)\s*$/m.exec(env);
  assert.ok(m, 'apps/vaults-ui/.env.example has no VITE_CHAIN_ID');
  checkChainClaim(mastheadSource(), m[1]);
});

test('MUTATION: the chain-claim coupling reds on a mainnet-configured build with a reverted testnet masthead', () => {
  // Reproduces exactly the hazard Security named: .env.example already points at chain 5042 (it
  // does, in this repository, as of the Arc cutover), but the masthead source was hand-reverted to
  // the old testnet string. Calls the SAME `checkChainClaim` the real test above calls, via
  // `assert.throws`, rather than re-deriving the assertion here.
  const reverted = APP_TSX.replace(
    `<p className="note tag-warn">${MASTHEAD_TEXT}</p>`,
    `<p className="note tag-warn">Reading Base Sepolia testnet. No vault holds real funds yet.</p>`,
  );
  assert.notEqual(reverted, APP_TSX, 'mutation target not found -- update this test if the line moved');

  const start = reverted.indexOf('<header className="masthead">');
  const end = reverted.indexOf('</header>', start);
  const header = reverted.slice(start, end);
  const env = readFileSync(ENV_EXAMPLE, 'utf8');
  const chainId = /^VITE_CHAIN_ID\s*=\s*(\S+)\s*$/m.exec(env)?.[1];
  assert.equal(chainId, '5042', 'sanity: .env.example must be configured for Arc mainnet for this mutation to prove anything');
  assert.throws(
    () => checkChainClaim(header, chainId),
    'RED: checkChainClaim must reject a reverted testnet masthead against a mainnet-configured chain id',
  );
});

test('MUTATION: the chain-claim coupling reds when the disclosure paragraph is deleted, even though a nearby comment still says "mainnet"', () => {
  // Closes the exact gap a looser check (raw source, `/mainnet/i`, no comment-stripping) would
  // miss: the JSX comment directly above the disclosure paragraph itself contains the word
  // "mainnet" ("Live on Arc mainnet since 2026-09-24..."), so a check that does not strip comments
  // and does not require the EXACT rendered string would still pass with the real paragraph gone.
  const header = mastheadSource();
  const escaped = MASTHEAD_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withParagraphGone = header.replace(new RegExp(`<p className="note tag-warn">${escaped}</p>`), '');
  assert.notEqual(withParagraphGone, header, 'mutation target not found -- update this test if the line moved');
  // Sanity: the comment must survive the paragraph's removal and still mention "mainnet", or this
  // mutation would not be exercising the gap it claims to.
  assert.match(withParagraphGone, /Live on Arc mainnet/i, 'sanity: the comment must still say "mainnet" with the paragraph gone, or this mutation proves nothing');
  assert.doesNotMatch(stripJsxComments(withParagraphGone), /mainnet/i, 'sanity: stripped of comments, the mutated header must carry no "mainnet" claim at all');
  assert.throws(
    () => checkChainClaim(withParagraphGone, '5042'),
    'RED: deleting the disclosure paragraph must still fail checkChainClaim even though a nearby comment says "mainnet"',
  );
});

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

test('the mainnet disclosure is NOT wrapped in any conditional -- it must render every time', () => {
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

test('MUTATION: removing the mainnet disclosure line is caught', () => {
  const escaped = MASTHEAD_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const withoutLine = APP_TSX.replace(
    new RegExp(`\\s*<p className="note tag-warn">${escaped}</p>\\n`),
    '\n',
  );
  assert.notEqual(withoutLine, APP_TSX, 'mutation target not found -- update this test if the line moved');
  assert.doesNotMatch(withoutLine, new RegExp(escaped), 'RED: with the line removed, the guard above must fail');
});

test('MUTATION: paraphrasing the disclosure is caught (verbatim text required)', () => {
  const paraphrased = APP_TSX.replace(MASTHEAD_TEXT, 'This app reads Arc mainnet data. Real funds may be involved.');
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
