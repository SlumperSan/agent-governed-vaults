// @ts-check
/**
 * Claims test for the marketing site.
 *
 * WHY THIS EXISTS. The launch constraint on this project is legal, not engineering: interests in
 * these vaults could be recharacterized as securities or collective-investment-scheme interests,
 * and marketing copy that promises an outcome is the cheapest way to make that worse. Prose has no
 * compiler, so this file is the compiler. A banned claim cannot reach `main` without turning the
 * gate red.
 *
 * The two rules that keep it honest:
 *   1. Ban PHRASES, anchored on word boundaries -- never bare words. "returns" is legitimate in
 *      "the vault returns your pro-rata slice"; "projected returns" never is. A test that bans
 *      single words gets neutered by the first false positive and then protects nothing.
 *   2. The footer sentence "Source-available under BUSL-1.1 -- not open source." is the ONE place
 *      the phrase "open source" is allowed, because there it is negated. Same for the footer's
 *      no-token sentence. Those two exact sentences are stripped BEFORE the absence checks run,
 *      and the presence checks run against the unstripped source. Order matters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this module, not process.cwd(): apps/site deliberately has no package.json (apps/*
// is a workspace glob), so the suite is always run from the repo root by `npm run test:backend`.
const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = ['index.html', 'how-it-works.html', 'who-its-for.html', 'operators.html', 'risks.html', 'faq.html'];

// The exact strings the spec pins. Any drift in punctuation or dashes is a failure, by design.
const BANNER_STATUS = 'Not deployed. No mainnet or testnet deployment of the current code exists.';
const BANNER_OFFER = 'Nothing on this site is an offer, a solicitation, or financial advice.';
const FOOTER_TOKEN = 'No token. No points. No airdrop. No presale.';
const FOOTER_LICENSE = 'Source-available under BUSL-1.1 — not open source.';
const TITLE_SUFFIX = ' — Agent-Governed Vaults';

// The only external host any page may reference.
const ALLOWED_HOST = 'github.com';

/** Phrases banned on every page, everywhere, with no exception. */
const BANNED = [
  /\bAPY\b/i,
  /\bguaranteed\b/i,
  /\brisk-?free\b/i,
  /\bprojected returns?\b/i,
  /\bexpected returns?\b/i,
  /\bhigh yield\b/i,
  /\bzero capital cost\b/i,
  /\bour fund\b/i,
  /\bwe manage\b/i,
  /\bpassive income\b/i,
  /\bwaitlist\b/i,
  /\bearly access\b/i,
  /\bcbETH\b/i,
  /\baudited\b/i,
  // Not in the spec's minimum list, added here deliberately: "safe" is an outcome word with no
  // legitimate use in this copy, and the fail-closed oracle must be described by its mechanism
  // ("every read reverts") rather than by a reassurance.
  /\bsafe\b/i,
  /\bguarantees? (?:a|the) return\b/i,
];

/** Phrases banned everywhere EXCEPT inside the two exact footer sentences, where they are negated. */
const BANNED_OUTSIDE_FOOTER = [/\bairdrop\b/i, /\bpresale\b/i, /\bopen source\b/i];

/** @type {Map<string, string>} */
const raw = new Map();
for (const p of PAGES) raw.set(p, readFileSync(path.join(SITE, p), 'utf8'));

/** The page with the two exact footer sentences removed, so their negated phrases do not count. */
function scrub(html) {
  return html.split(FOOTER_TOKEN).join(' ').split(FOOTER_LICENSE).join(' ');
}

test('all six pages exist', () => {
  for (const p of PAGES) assert.ok(existsSync(path.join(SITE, p)), `missing page: ${p}`);
});

test('no banned claim appears on any page', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const re of BANNED) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: banned phrase ${re} matched ${JSON.stringify(hit?.[0])}`);
    }
  }
});

test('"open source", "airdrop" and "presale" appear only inside the exact footer sentences', () => {
  for (const p of PAGES) {
    const html = scrub(raw.get(p) ?? '');
    for (const re of BANNED_OUTSIDE_FOOTER) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: ${re} appears outside the permitted footer sentence (${JSON.stringify(hit?.[0])})`);
    }
  }
});

test('every page carries both pre-launch banner strings verbatim', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(html.includes(BANNER_STATUS), `${p}: missing exact deployment-status string`);
    assert.ok(html.includes(BANNER_OFFER), `${p}: missing exact not-an-offer string`);
  }
});

test('every page carries both footer strings verbatim', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(html.includes(FOOTER_TOKEN), `${p}: missing exact no-token footer sentence`);
    assert.ok(html.includes(FOOTER_LICENSE), `${p}: missing exact licence footer sentence`);
  }
});

test('the banner precedes the nav on every page', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(html.indexOf(BANNER_STATUS) < html.indexOf('<nav'), `${p}: banner must come before the nav`);
  }
});

test('document skeleton: doctype, lang, one h1, main, skip link, description, title', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(/^<!doctype html>/i.test(html.trimStart()), `${p}: missing doctype`);
    assert.ok(html.includes('lang="en"'), `${p}: missing lang="en"`);
    assert.equal(html.split('<h1').length - 1, 1, `${p}: must have exactly one <h1>`);
    assert.ok(html.includes('<main id="main"'), `${p}: missing <main id="main">`);
    assert.ok(html.includes('href="#main"'), `${p}: missing skip link targeting #main`);
    assert.ok(html.includes('<meta name="description"'), `${p}: missing meta description`);
    const title = html.match(/<title>([^<]*)<\/title>/);
    assert.ok(title, `${p}: missing <title>`);
    assert.ok(title[1].endsWith(TITLE_SUFFIX), `${p}: title must end in "${TITLE_SUFFIX}" (got ${JSON.stringify(title[1])})`);
    assert.ok(html.includes('<footer'), `${p}: missing <footer>`);
  }
});

test('the skip link is the first focusable element on every page', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const body = html.slice(html.indexOf('<body'));
    const firstAnchor = body.indexOf('<a ');
    const skip = body.indexOf('href="#main"');
    assert.ok(firstAnchor !== -1 && skip !== -1, `${p}: no anchors found in body`);
    assert.ok(skip - firstAnchor < 120, `${p}: the skip link must be the first anchor in <body>`);
  }
});

test('every page carries at least one COUNSEL marker', () => {
  for (const p of PAGES) {
    const n = (raw.get(p) ?? '').split('<!-- COUNSEL:').length - 1;
    assert.ok(n >= 1, `${p}: needs at least one <!-- COUNSEL: ... --> marker`);
  }
});

test('zero JavaScript: no script tags, no event handler attributes', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(!/<script/i.test(html), `${p}: contains a <script tag`);
    assert.equal(html.match(/\son[a-z]+\s*=/i), null, `${p}: contains an inline event handler attribute`);
  }
});

test('no external requests: the only permitted remote host is the project repository', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(!/fonts\.googleapis\.com/i.test(html), `${p}: references fonts.googleapis.com`);
    assert.ok(!/fonts\.gstatic\.com/i.test(html), `${p}: references fonts.gstatic.com`);
    for (const m of html.matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)) {
      const v = m[1];
      if (!/^(?:https?:)?\/\//i.test(v)) continue; // relative or fragment: fine
      const host = v.replace(/^(?:https?:)?\/\//i, '').split('/')[0].toLowerCase();
      assert.equal(host, ALLOWED_HOST, `${p}: external host ${host} is not permitted`);
    }
  }
});

test('every internal .html link resolves to a file on disk', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const m of html.matchAll(/href\s*=\s*"([^"]+\.html)(?:#[^"]*)?"/gi)) {
      const target = m[1];
      if (/^(?:https?:)?\/\//i.test(target)) continue;
      assert.ok(existsSync(path.join(SITE, target)), `${p}: dead internal link -> ${target}`);
    }
  }
});

test('every page links to all six pages', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const other of PAGES) {
      assert.ok(html.includes(`href="${other}"`), `${p}: nav is missing a link to ${other}`);
    }
  }
});

/** Strip CSS comments. Both stylesheets document the rules they follow IN those comments, so the
 *  declaration-level checks below have to look at declarations, not at prose about declarations. */
const decls = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');

test('stylesheets exist and site.css contains no raw hex colour literal', () => {
  const tokens = readFileSync(path.join(SITE, 'assets/tokens.css'), 'utf8');
  const site = readFileSync(path.join(SITE, 'assets/site.css'), 'utf8');
  const hex = site.match(/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/);
  assert.equal(hex, null, `site.css must reference tokens only, found raw colour ${JSON.stringify(hex?.[0])}`);
  // The host check stays on the RAW text: a font host has no business appearing in either file.
  assert.ok(!/fonts\.(?:googleapis|gstatic)\.com/i.test(tokens + site), 'stylesheets must not reference a webfont host');
  assert.ok(!/@import/i.test(decls(tokens) + decls(site)), 'stylesheets must not @import anything');
});

test('tokens.css defines the full inherited token set, so a real design system is a drop-in', () => {
  const tokens = readFileSync(path.join(SITE, 'assets/tokens.css'), 'utf8');
  const NAMES = [
    'ground', 'surface', 'surface-2', 'line', 'line-soft', 'ink', 'muted', 'faint',
    'accent', 'accent-soft', 'accent-ink', 'good', 'good-soft', 'warn', 'warn-soft',
    'crit', 'crit-soft', 'shadow-1', 'shadow-2', 'display', 'sans', 'mono',
    'r-sm', 'r-md', 'r-lg', 'maxw',
  ];
  const body = decls(tokens);
  for (const n of NAMES) assert.ok(body.includes(`--${n}:`), `tokens.css is missing --${n}`);
  // The three inherited values that fail WCAG AA must stay overridden.
  assert.ok(!/--faint:\s*#8a8a9e/i.test(body), 'light --faint #8a8a9e is 3.03:1 on --ground; keep the override');
  assert.ok(!/--faint:\s*#616178/i.test(body), 'dark --faint #616178 is 2.96:1 on --surface; keep the override');
  assert.ok(!/--good:\s*#178a4c/i.test(body), 'light --good #178a4c is 4.40:1 on white; keep the override');
  // No webfont NAME may survive in a declaration: the site makes zero external requests, so a font
  // family it cannot fetch is dead weight that only masks the fallback it actually renders.
  assert.ok(!/Newsreader|IBM Plex/i.test(body), 'tokens.css must use system font stacks only');
  // Both dark paths must carry the --faint override; fixing only the media query leaves the
  // forced-dark path at 2.96:1.
  assert.equal((body.match(/--faint:/g) ?? []).length, 3, 'tokens.css must set --faint in all three theme states');
});

test('the operator page states the capital obligation exactly, and never denies it', () => {
  const ops = raw.get('operators.html') ?? '';
  assert.ok(ops.includes('2,500 USDC'), 'operators.html must state the 2,500 USDC figure');
  assert.ok(ops.includes('5%'), 'operators.html must state the 5% figure');
  assert.ok(!/zero capital cost/i.test(ops), 'operators.html must never claim zero capital cost');
  // The two distinct 5% mechanisms must both be named; conflating them is the documented failure mode.
  assert.ok(/proposal threshold/i.test(ops), 'operators.html must name the proposal threshold');
  assert.ok(/withdrawal gate/i.test(ops), 'operators.html must name the creator withdrawal gate');
});

test('no page implies a live deployment or an unqualified security review', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.equal(html.match(/\bis (?:now )?live\b/i), null, `${p}: implies a live deployment`);
    assert.equal(html.match(/\bmainnet is (?:live|up)\b/i), null, `${p}: implies a live deployment`);
  }
  // The attestation must always carry the fact that no public report exists to check it against.
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    if (/external security review/i.test(html)) {
      assert.ok(/no public report/i.test(html), `${p}: names the security review without the "no public report" qualifier`);
    }
  }
});

test('tables carry a caption and scoped headers', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const t of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
      assert.ok(/<caption>/i.test(t), `${p}: a <table> is missing its <caption>`);
      assert.ok(/<th[^>]*\sscope="(?:col|row)"/i.test(t), `${p}: a <table> is missing scoped <th> cells`);
    }
  }
});
