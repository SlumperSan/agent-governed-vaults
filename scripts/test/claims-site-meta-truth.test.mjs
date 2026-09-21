/**
 * Claims truth over `apps/site`'s HTML WRAPPER STRINGS — `<title>`, `og:*`, `twitter:*`,
 * `<meta name="description">`, any JSON-LD, and `apps/site/public/llms.txt`.
 *
 * ## The gap this closes
 *
 * `claims-lede-truth.test.mjs`'s `PUBLIC_EXT` is `.md`, `.html`, `.txt`, `.json` — `apps/site`'s
 * six HTML files ARE inside that extension set, so a naive reading says they are already covered.
 * They are not, for a narrower reason than an extension gap: that guard's own shapes match
 * SENTENCES (an agent pooling, a universal weighted-vote claim, an unqualified "stake-weighted").
 * `<title>RWAlly — the AI agent trading index</title>` and an `og:title` meta `content` attribute
 * are not sentences a claims-shape regex is built to parse out of raw markup — nothing walks this
 * repo today that extracts `<title>`/`<meta content="...">`/`<script type="application/ld+json">`
 * text specifically and matches banned shapes against JUST that text. A future edit to any of
 * these three strings, in any wording, by anyone, has been invisible to every guard in this repo.
 *
 * That gap is not hypothetical scope-padding: `<title>`, `og:title`/`og:description` and
 * `llms.txt`'s lede are the browser tab, every link-preview card, and the file this site hands to
 * AI crawlers specifically to be read out of context — the three places a false claim travels
 * furthest with the least surrounding correction in view.
 *
 * `PRODUCT_PHRASES` in `scripts/lib/claims-shapes.mjs` already permits "AI agent trading index"
 * BY NAME (the owner's positioning phrase, 2026-09-05, with its own probe in
 * `claims-lede-truth.test.mjs`) — this guard imports the same shape set, so that phrase is exempt
 * here too, the same way it is everywhere else. This guard does not relitigate that exemption; it
 * closes the gap AROUND it, so a DIFFERENT false claim landing in a `<title>` or `llms.txt` line
 * is no longer invisible.
 *
 * ## Why a separate file, not an added `PUBLIC_EXT` entry or an extension of #351
 *
 * Widening `PUBLIC_EXT` to catch this would sweep every `.html`/`.txt`/`.json` in the repository
 * that is ALREADY covered — no gap there to close, and the actual gap (matching banned shapes
 * against ONLY the wrapper-tag text, not a whole HTML file's markup) is not an extension problem.
 * `claims-vaults-ui-prose-truth.test.mjs` (#351) solves a structurally different extraction
 * problem — JSX text children and string literals inside `.tsx` component source — and depends on
 * the `typescript` compiler's AST for it. This file's extraction is six small, static HTML
 * documents and one plain-text file with no JSX, no build step, and no dependency #351 needs; a
 * shared abstraction across the two would be gluing together two unrelated tokenizers for one
 * shared `test()` structure, not a real simplification.
 *
 * ## Coverage tripwires — a guard that can skip is a guard that will
 *
 * 1. `apps/site` must yield at least the known HTML entry files. A count that drops below the
 *    floor set from what exists today (not asserted as an exact number, so a new page does not
 *    break this test) throws rather than passing over a shrunk surface.
 * 2. `apps/site/public/llms.txt` must exist and be non-empty.
 * 3. Every HTML file walked must yield at least one extracted string (a `<title>` is universal
 *    across all six today) — a file extracting to nothing is an extractor bug, not a clean file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  flat,
  sentencesOf,
  AGENT_ACTS,
  maskProductPhrases,
  UNIVERSAL_WEIGHTED,
  STAKE_WEIGHTED,
  SUB_FIVE_QUALIFIER,
  STAKE_BLIND,
  REMEDIATION_STATUS,
  DENIED,
  ONCHAIN_MEMBER_GATE,
  POWER_CLAIM,
  ENUMERATION_FOLLOWS,
  RWLY_ATTRIBUTION,
  RWLY_BACKED_BY_VAULT,
} from '../lib/claims-shapes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE_DIR = 'apps/site';
const LLMS_TXT = 'apps/site/public/llms.txt';

/**
 * `<title>`, `<meta name="description"|"twitter:*">`, `<meta property="og:*">`, and any
 * `<script type="application/ld+json">` body — the wrapper strings around a page, never the
 * page's own rendered body content (a different surface, not this guard's job). Deliberately NOT
 * a full HTML parse: these six files are static and small, and a targeted regex extraction is the
 * same complexity trade `extract-string-literals.mjs` makes for plain `.mjs` (see that file), one
 * notch simpler because there is no JSX nesting to be AST-aware of here.
 */
export function extractHtmlMeta(html) {
  const out = [];
  const titleM = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (titleM) out.push(titleM[1]);
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = tag[0];
    if (!/\b(?:name|property)\s*=\s*"(?:description|og:[\w:]+|twitter:[\w:]+)"/i.test(t)) continue;
    const contentM = /\bcontent\s*=\s*"([^"]*)"/i.exec(t);
    if (contentM) out.push(contentM[1]);
  }
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    out.push(m[1]);
  }
  return out;
}

const MIN_HTML_FILES = 6;

/** Every `.html` file directly inside `apps/site` (not recursive — `dist/` and `node_modules` are
 *  not under this path; the six pages this guard exists for all sit at this one level). */
const siteHtmlFiles = () => {
  const dir = path.join(REPO, SITE_DIR);
  const found = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.html'))
    .map((e) => `${SITE_DIR}/${e.name}`);
  assert.ok(
    found.length >= MIN_HTML_FILES,
    `${SITE_DIR} yielded only ${found.length} .html files, fewer than the ${MIN_HTML_FILES} floor ` +
      '-- either a page went missing or this guard\'s path is wrong, either way this must FAIL ' +
      'rather than report a silent pass over shrunk coverage.',
  );
  return found;
};

const htmlFilesWithExtractedText = () =>
  siteHtmlFiles().map((file) => {
    const html = readFileSync(path.join(REPO, file), 'utf8');
    const strings = extractHtmlMeta(html);
    assert.ok(
      strings.length > 0,
      `${file}: extracted ZERO wrapper strings. Every page here has at least a <title> -- a zero ` +
        'extraction means the regex above failed to match this file\'s markup, and treating that ' +
        'as "nothing to check" is exactly the silent skip this guard exists to refuse.',
    );
    return { file, text: flat(strings.join(' ')) };
  });

/** `llms.txt` alongside every HTML file's extracted text, one list of {file, text} both guards
 *  below walk uniformly. */
const allSources = () => {
  assert.ok(existsSync(path.join(REPO, LLMS_TXT)), `${LLMS_TXT} does not exist -- did it move?`);
  const llms = readFileSync(path.join(REPO, LLMS_TXT), 'utf8');
  assert.ok(llms.trim().length > 0, `${LLMS_TXT} is empty`);
  return [...htmlFilesWithExtractedText(), { file: LLMS_TXT, text: flat(llms) }];
};

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

test('apps/site has at least the known HTML entry files, and llms.txt exists', () => {
  assert.ok(siteHtmlFiles().length >= MIN_HTML_FILES);
  assert.ok(existsSync(path.join(REPO, LLMS_TXT)));
});

test('no title/meta/JSON-LD/llms.txt string says an AI agent pools capital or governs a vault', () => {
  const hits = [];
  for (const { file, text } of allSources()) {
    const hay = maskProductPhrases(text);
    for (const re of AGENT_ACTS) {
      for (const m of hay.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'Members pool and vote; an AI operator does neither on-chain (claims-lede-truth.test.mjs\n' +
      `guard 1). "AI agent trading index" is exempt by name, everything else is not.\nOffending text:\n${report(hits)}`,
  );
});

test('no title/meta/JSON-LD/llms.txt string claims a single universal weighted-vote regime', () => {
  const hits = [];
  for (const { file, text } of allSources()) {
    for (const re of UNIVERSAL_WEIGHTED) {
      for (const m of text.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    `Governance.finalize has THREE quorum regimes, not one (claims-lede-truth.test.mjs guard 2).\nOffending text:\n${report(hits)}`,
  );
});

test('every "stake-weighted" string in these sources carries its sub-five-member qualifier', () => {
  const offenders = [];
  for (const { file, text } of allSources()) {
    if (STAKE_WEIGHTED.test(text) && !SUB_FIVE_QUALIFIER.test(text)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    `Stake weighting is the regime only at FIVE OR MORE members (claims-lede-truth.test.mjs guard 3).\nOffending files:\n  ${offenders.join('\n  ')}`,
  );
});

test('no title/meta/JSON-LD/llms.txt string describes the sub-five regime as stake-blind', () => {
  const hits = [];
  for (const { file, text } of allSources()) {
    for (const re of STAKE_BLIND) {
      for (const m of text.matchAll(re)) {
        const i = m.index ?? 0;
        if (REMEDIATION_STATUS.test(text.slice(Math.max(0, i - 200), i + 200))) continue;
        if (DENIED.test(text.slice(Math.max(0, i - 60), i))) continue;
        hits.push({ file, quote: m[0] });
      }
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    `The sub-five regime weighs stake in BOTH branches, H-8/CM-7 (claims-lede-truth.test.mjs guard 4).\nOffending text:\n${report(hits)}`,
  );
});

test('no title/meta/JSON-LD/llms.txt string claims the contracts screen who may deposit', () => {
  const hits = [];
  for (const { file, text } of allSources()) {
    for (const m of text.matchAll(ONCHAIN_MEMBER_GATE)) {
      if (/\b(?:adapter|oracle|venue|target|selector|factory|token|asset)s?\s+(?:allowlist|allow-list|whitelist)/i.test(m[0])) {
        continue;
      }
      hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    `The only allowlists in contracts/src are for ADAPTERS and ORACLES (claims-lede-truth.test.mjs guard 5).\nOffending text:\n${report(hits)}`,
  );
});

test("the operator's lack of power is enumerated, never claimed as a universal, in these sources", () => {
  const hits = [];
  for (const { file, text } of allSources()) {
    for (const m of text.matchAll(POWER_CLAIM)) {
      const after = text.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 120);
      if (ENUMERATION_FOLLOWS.test(after)) continue;
      hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    `A universal negative about operator power is falsifiable in one transaction (claims-lede-truth.test.mjs guard 6).\nOffending text:\n${report(hits)}`,
  );
});

test('no title/meta/JSON-LD/llms.txt string attributes protocol fees, governance or entitlement to RWLY', () => {
  const hits = [];
  for (const { file, text } of allSources()) {
    for (const re of RWLY_ATTRIBUTION) {
      for (const m of text.matchAll(re)) hits.push({ file, quote: m[0] });
    }
    for (const s of sentencesOf(text)) {
      if (/\bRWLY\b/.test(s) && RWLY_BACKED_BY_VAULT.test(s)) hits.push({ file, quote: s.trim().slice(0, 160) });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    `RWLY is design intent only (claims-lede-truth.test.mjs guard 7).\nOffending text:\n${report(hits)}`,
  );
});

test('probe: extraction reads title/meta/JSON-LD content, not an HTML comment describing a banned shape', () => {
  const commented = [
    '<!doctype html><html><head>',
    '<!-- AI agents pool USDC into spot crypto index baskets and govern rebalances by weighted vote. -->',
    '<title>RWAlly</title>',
    '</head><body></body></html>',
  ].join('\n');
  const strings = extractHtmlMeta(commented);
  const hay = flat(maskProductPhrases(strings.join(' ')));
  const hit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(hay);
  });
  assert.equal(hit, false, `An HTML comment reddened this guard, not extracted wrapper text. Extracted: ${JSON.stringify(strings)}`);
});

test('probe: the same banned shape inside <title> IS caught', () => {
  const bad = '<!doctype html><html><head><title>AI agents pool USDC into spot crypto index baskets.</title></head></html>';
  const strings = extractHtmlMeta(bad);
  const hay = flat(maskProductPhrases(strings.join(' ')));
  const hit = AGENT_ACTS.some((re) => {
    re.lastIndex = 0;
    return re.test(hay);
  });
  assert.equal(hit, true, `The guard failed to catch a banned shape sitting in an actual <title>. Extracted: ${JSON.stringify(strings)}`);
});

test('probe: an og:title meta content attribute is extracted and checked', () => {
  const bad =
    '<!doctype html><html><head><meta property="og:title" content="AI agents govern this vault." /></head></html>';
  const strings = extractHtmlMeta(bad);
  assert.ok(strings.includes('AI agents govern this vault.'), `og:title content was not extracted. Extracted: ${JSON.stringify(strings)}`);
});

test('probe: a JSON-LD script body is extracted and checked', () => {
  const bad =
    '<!doctype html><html><head><script type="application/ld+json">{"description":"AI agents govern this vault."}</script></head></html>';
  const strings = extractHtmlMeta(bad);
  assert.ok(
    strings.some((s) => s.includes('AI agents govern this vault.')),
    `JSON-LD body was not extracted. Extracted: ${JSON.stringify(strings)}`,
  );
});

test('probe: this guard reds rather than passes if apps/site yields no HTML files at all', () => {
  const emptyDir = path.join(REPO, SITE_DIR, '__does-not-exist__');
  assert.throws(() => readdirSync(emptyDir, { withFileTypes: true }), /ENOENT/, 'sanity check on the probe itself');
  const assertFloor = (found) => {
    assert.ok(found.length >= MIN_HTML_FILES, `apps/site yielded only ${found.length} .html files`);
  };
  assert.throws(() => assertFloor([]), /yielded only 0/);
  assertFloor(new Array(MIN_HTML_FILES).fill('apps/site/index.html')); // does not throw
});
