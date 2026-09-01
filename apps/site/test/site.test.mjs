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
 *   2. Some banned words have exactly one legitimate use on this site, always in a NEGATION
 *      ("not a guarantee", "nothing to sign up for", "not open source"). Those exact sentence
 *      fragments are enumerated in PERMITTED below and stripped BEFORE the absence checks run;
 *      the presence checks run against the unstripped source. Order matters. Every entry in
 *      PERMITTED is itself asserted to be in use, so the list cannot rot into a blanket exemption.
 *
 * WHAT THE 2026-08-29 ADVERSARIAL REVIEW CHANGED. Two independent reviewers demonstrated that
 * this file was partly cosmetic: it passed 18/18 over a page that contradicted the repository.
 * The numeric checks now read `contracts/config/base-mainnet.json` and compare it to the site's
 * reference-configuration table, so a config edit turns the gate red instead of silently
 * desynchronizing the site; the deployment-status check is sentence-scoped rather than page-scoped;
 * and the security-attestation qualifier must sit in the same block as the claim it qualifies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve from this module, not process.cwd(): apps/site deliberately has no package.json (apps/*
// is a workspace glob), so the suite is always run from the repo root by `npm run test:backend`.
const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..', '..');
const CONFIG_PATH = path.join(REPO, 'contracts', 'config', 'base-mainnet.json');

const PAGES = ['index.html', 'how-it-works.html', 'who-its-for.html', 'operators.html', 'risks.html', 'faq.html'];

/** Everything else the banned-phrase list must also cover: the README and both stylesheets. */
const PROSE_FILES = ['README.md', 'assets/tokens.css', 'assets/site.css'];

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
  // Widened 2026-08-29: /\bguaranteed\b/ missed "guarantee", "guarantees", "guaranteeing".
  /\bguarantee(?:s|d|ing)?\b/i,
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
  // Widened 2026-08-29: /\baudited\b/ missed "audits" and "auditor". The suffix group is NOT
  // optional, deliberately: "pre-audit", "AI pre-audit" and the docs/audit/ path are legitimate
  // and ship on this site, and making the suffix optional turns every one of them red.
  /\baudit(?:s|ed|or|ors)\b/i,
  // Not in the spec's minimum list, added here deliberately: "safe" is an outcome word with no
  // legitimate use in this copy, and the fail-closed oracle must be described by its mechanism
  // ("every read reverts") rather than by a reassurance.
  /\bsafe\b/i,
  /\bguarantees? (?:a|the) return\b/i,
  // Return-implying vocabulary. None of these has a legitimate use in copy that must not imply
  // an outcome, and each is a phrase a well-meaning editor reaches for first.
  /\bAPR\b/,
  /\bROI\b/,
  /annuali[sz]ed/i,
  /\btarget return/i,
  /\bestimated return/i,
  /\boutperform\w*/i,
  /\balpha\b/i,
  // Conversion-surface vocabulary. This site has no form, no wallet connection and no funnel;
  // the moment one of these appears, it has one.
  /\bconnect wallet\b/i,
  /\bsign up\b/i,
  /\bget started\b/i,
  // Discretionary-manager vocabulary. The whole collective-investment-scheme argument turns on
  // the site never describing anyone as running the vault for a depositor.
  /\bwe run\b/i,
  /\bwe rebalance\b/i,
  /\byour portfolio\b/i,
  /\bmanaged\b/i,
  /\bour vault\b/i,
];

/** Phrases banned everywhere EXCEPT inside the two exact footer sentences, where they are negated. */
const BANNED_OUTSIDE_FOOTER = [/\bairdrop\b/i, /\bpresale\b/i, /\bopen source\b/i];

/**
 * Exact fragments where a banned word is used in a NEGATION and is therefore permitted. Stripped
 * before the BANNED checks run. Every entry must be a full clause, never a bare word, and every
 * entry is asserted below to be in actual use somewhere on the site.
 */
const PERMITTED = [
  // "guarantee" -- the geofencing sentence in every footer and in three page bodies, the hero
  // lede's unhedged no-outcome sentence, and two statements of the invariant/parameter split.
  'a good-faith measure and not a guarantee',
  'no guarantee of any outcome',
  'treating a parameter as a guarantee is how people get hurt',
  'may be presented anywhere as a protocol-level guarantee',
  'described as a guarantee of anything',
  // "sign up" -- both occurrences deny that there is anything to sign up for.
  'There is nothing to sign up for.',
  'nothing on this site to sign up for',
];

/**
 * How many times each exact footer sentence may appear on a given page. The footer carries one.
 * faq.html deliberately repeats BOTH in its body -- the no-token sentence answers "Is there a
 * token?" and the licence sentence answers "What licence is the code under?", and those are the
 * two answers people quote. Counted rather than blanket-stripped: the old scrub() removed every
 * occurrence, so a stray copy anywhere on a page went unnoticed.
 */
const FOOTER_SENTENCE_COUNTS = {
  [FOOTER_TOKEN]: { default: 1, 'faq.html': 2 },
  [FOOTER_LICENSE]: { default: 1, 'faq.html': 2 },
};

/** @type {Map<string, string>} */
const raw = new Map();
for (const p of PAGES) raw.set(p, readFileSync(path.join(SITE, p), 'utf8'));

/**
 * The page with the PERMITTED NUMBER of footer sentences removed -- not all of them. The old
 * scrub() used split().join() and stripped every occurrence, so a third copy of the licence
 * sentence anywhere on a page took its "open source" exemption with it.
 * @param {string} html
 * @param {string} page
 */
function scrub(html, page) {
  let out = html;
  for (const [sentence, allowed] of Object.entries(FOOTER_SENTENCE_COUNTS)) {
    const want = /** @type {Record<string, number>} */ (allowed)[page] ?? allowed.default;
    for (let i = 0; i < want; i++) out = out.replace(sentence, ' '); // replace() strips one
  }
  return out;
}

/** The text with every PERMITTED negation removed, so its banned words do not count. */
function scrubPermitted(text) {
  let out = text;
  for (const phrase of PERMITTED) out = out.split(phrase).join(' ');
  return out;
}

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('all six pages exist', () => {
  for (const p of PAGES) assert.ok(existsSync(path.join(SITE, p)), `missing page: ${p}`);
});

test('no banned claim appears on any page', () => {
  for (const p of PAGES) {
    const html = scrubPermitted(raw.get(p) ?? '');
    for (const re of BANNED) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: banned phrase ${re} matched ${JSON.stringify(hit?.[0])}`);
    }
  }
});

test('no banned claim appears in the README or either stylesheet either', () => {
  // Only BANNED, never BANNED_OUTSIDE_FOOTER: the README quotes the negated licence sentence when
  // it documents the exception, which is exactly the use that sentence exists for.
  for (const f of PROSE_FILES) {
    const text = scrubPermitted(readFileSync(path.join(SITE, f), 'utf8'));
    for (const re of BANNED) {
      const hit = text.match(re);
      assert.equal(hit, null, `${f}: banned phrase ${re} matched ${JSON.stringify(hit?.[0])}`);
    }
  }
});

test('every permitted negation is actually in use, so the exemption list cannot rot', () => {
  const all = [...PAGES.map((p) => raw.get(p) ?? ''), ...PROSE_FILES.map((f) => readFileSync(path.join(SITE, f), 'utf8'))].join('\n');
  for (const phrase of PERMITTED) {
    assert.ok(all.includes(phrase), `PERMITTED carries a phrase no page uses: ${JSON.stringify(phrase)} — delete it rather than leaving a standing exemption`);
  }
});

test('"open source", "airdrop" and "presale" appear only inside the exact footer sentences', () => {
  for (const p of PAGES) {
    const html = scrub(raw.get(p) ?? '', p);
    for (const re of BANNED_OUTSIDE_FOOTER) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: ${re} appears outside the permitted footer sentence (${JSON.stringify(hit?.[0])})`);
    }
  }
});

test('each footer sentence appears exactly the number of times it is permitted to', () => {
  for (const [sentence, allowed] of Object.entries(FOOTER_SENTENCE_COUNTS)) {
    for (const p of PAGES) {
      const want = /** @type {Record<string, number>} */ (allowed)[p] ?? allowed.default;
      const got = count(raw.get(p) ?? '', sentence);
      assert.equal(got, want, `${p}: expected ${want} occurrence(s) of ${JSON.stringify(sentence)}, found ${got}. Update FOOTER_SENTENCE_COUNTS and the README in the same commit if the repetition is deliberate.`);
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

test('no page implies a live deployment', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.equal(html.match(/\bis (?:now )?live\b/i), null, `${p}: implies a live deployment`);
    assert.equal(html.match(/\bmainnet is (?:live|up)\b/i), null, `${p}: implies a live deployment`);
    assert.equal(html.match(/\blaunched on\b/i), null, `${p}: implies a live deployment`);
    assert.equal(html.match(/\bnow trading\b/i), null, `${p}: implies a live deployment`);
    assert.equal(html.match(/\bgo(?:es)? live\b/i), null, `${p}: implies a live deployment`);
  }
});

/**
 * The published prose of a page: HTML comments dropped (COUNSEL markers are the internal review
 * queue, not copy a reader ever sees), tags flattened, and the meta description put back in front
 * because it is the string that travels into a link preview.
 */
function publishedProse(html) {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, ' ');
  const metas = [...noComments.matchAll(/<meta[^>]*name="description"[^>]*content="([^"]*)"/gi)].map((m) => m[1]);
  const body = noComments.replace(/<[^>]*>/g, ' ');
  return [...metas, body].join(' . ');
}

const sentencesOf = (text) => text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);

// Genuine negations only. "whatever" and friends are deliberately absent: widening this list to
// swallow an unqualified sentence is gaming the check rather than fixing the sentence.
const NEGATED = /\bnot\b|\bno\b|\bnever\b|\bnothing\b|\bnone\b|\bnor\b|\bcannot\b|\bsuperseded\b|\bwould be\b/i;

test('every "deployed" sits inside a sentence that negates it', () => {
  // Sentence-scoped, not page-scoped. A page-wide check is what let "Whatever gets deployed is
  // what runs" ship next to a banner three thousand characters away that said "Not deployed."
  for (const p of PAGES) {
    for (const s of sentencesOf(publishedProse(raw.get(p) ?? ''))) {
      if (!/\bdeployed\b/i.test(s)) continue;
      assert.ok(NEGATED.test(s), `${p}: "deployed" in a sentence that does not negate it — ${JSON.stringify(s.trim())}`);
    }
  }
});

test('the security-review attestation carries its qualifier in the same block', () => {
  // Block-scoped, not page-scoped: the old check was satisfied by a footer thousands of characters
  // away, so the claim could be excerpted without the fact that nobody can check it.
  const PHRASE = /external security review/gi;
  const BLOCK = /<(p|dd|li)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const p of PAGES) {
    const html = (raw.get(p) ?? '').replace(/<!--[\s\S]*?-->/g, ' ');
    const blocks = [...html.matchAll(BLOCK)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length, text: m[0] }));
    for (const hit of html.matchAll(PHRASE)) {
      const at = hit.index ?? 0;
      const enclosing = blocks
        .filter((b) => b.start <= at && at < b.end)
        .sort((a, b) => a.text.length - b.text.length)[0];
      assert.ok(enclosing, `${p}: "external security review" appears outside any paragraph or list item`);
      assert.ok(
        /no public report/i.test(enclosing.text),
        `${p}: names the external security review without the "no public report" qualifier in the same block — ${JSON.stringify(enclosing.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 160))}`,
      );
    }
  }
});

// ─────────────────────────── the site against the repository ───────────────────────────
//
// THE SINGLE HIGHEST-VALUE CHECK IN THIS FILE. Every number in the reference-configuration table
// is read out of contracts/config/base-mainnet.json and compared to what the page renders. Before
// this existed the table was pinned only to itself, so a config edit silently desynchronized the
// site and the gate stayed green. Every failure message here says the SITE is stale, never the
// config: the config is the source of truth and the page is the copy of it.

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

/** Every rendering of a duration this site would accept, derived from the raw seconds. */
function durations(seconds) {
  const out = [];
  if (seconds % 86400 === 0) out.push(`${seconds / 86400} day${seconds === 86400 ? '' : 's'}`);
  if (seconds % 3600 === 0) out.push(`${seconds / 3600} hour${seconds === 3600 ? '' : 's'}`);
  if (seconds % 60 === 0) out.push(`${seconds / 60} minute${seconds === 60 ? '' : 's'}`);
  out.push(`${seconds.toLocaleString('en-US')} second${seconds === 1 ? '' : 's'}`);
  return out;
}

/** Every rendering of a basis-point figure this site would accept. */
function percents(bps) {
  const pct = bps / 100;
  return [`${pct}%`, `${pct.toFixed(2)}%`, `${bps} bps`];
}

const usdc = (units) => `${(Number(BigInt(units)) / 1e6).toLocaleString('en-US')} USDC`;
const wadDollars = (wad) => `$${(Number(BigInt(wad)) / 1e18).toLocaleString('en-US')}`;

test('the reference-configuration table matches contracts/config/base-mainnet.json row for row', () => {
  const html = raw.get('how-it-works.html') ?? '';
  /** @type {Map<string, string>} */
  const rows = new Map();
  for (const m of html.matchAll(/<tr><th scope="row">([^<]+)<\/th><td>([^<]+)<\/td><\/tr>/g)) {
    rows.set(m[1].trim(), m[2].trim());
  }

  const gov = config.smoke.gov;
  const staleness = config.chainlinkOracle.assets.map((/** @type {any} */ a) => a.heartbeatSeconds);
  assert.ok(new Set(staleness).size === 1, `the config now sets different staleness bounds per asset (${staleness.join(', ')}); how-it-works.html states a single figure and is stale`);

  /** @type {[string, string[]][]} */
  const expected = [
    ['Commit duration', durations(gov.commitDuration)],
    ['Reveal duration', durations(gov.revealDuration)],
    ['Timelock', durations(gov.timelockDuration)],
    ['Execution window', durations(gov.executionWindow)],
    ['Quorum', percents(gov.quorumBps)],
    ['Proposal threshold', percents(gov.proposalThresholdBps)],
    ['Delegate concentration cap', percents(gov.concentrationCapBps)],
    ['Proposal cooldown', durations(gov.proposalCooldown)],
    ['Minimum deposit', [usdc(config.smoke.minDepositUsdc)]],
    ['Exit fee maximum', percents(config.smoke.exitFeeMaxBps)],
    ['Exit fee decay period', durations(config.smoke.exitFeeDecayPeriod)],
    ['Oracle staleness bound', durations(staleness[0])],
  ];

  for (const [label, accepted] of expected) {
    const cell = rows.get(label);
    assert.ok(cell !== undefined, `how-it-works.html is stale: its reference-configuration table has no "${label}" row, but base-mainnet.json sets one`);
    assert.ok(
      accepted.some((v) => cell.includes(v)),
      `how-it-works.html is stale relative to contracts/config/base-mainnet.json: "${label}" renders ${JSON.stringify(cell)}, and the config value renders as one of ${JSON.stringify(accepted)}`,
    );
  }
});

test('the sane-price bands on the site match the config', () => {
  // These live in prose rather than in the table, so they are checked page-wide.
  for (const asset of config.chainlinkOracle.assets) {
    const lo = wadDollars(asset.minPriceWad);
    const hi = wadDollars(asset.maxPriceWad);
    for (const p of ['how-it-works.html', 'risks.html']) {
      const html = raw.get(p) ?? '';
      assert.ok(html.includes(lo), `${p} is stale relative to base-mainnet.json: the ${asset.symbol} band floor renders as ${lo} in the config and does not appear on the page`);
      assert.ok(html.includes(hi), `${p} is stale relative to base-mainnet.json: the ${asset.symbol} band ceiling renders as ${hi} in the config and does not appear on the page`);
    }
  }
});

test('the figures the site DERIVES from the config are pinned to it as well', () => {
  // These do not appear in the reference table, so the row-by-row check above cannot see them.
  // They are arithmetic on config values, which is exactly the class of number that goes stale
  // silently: a config edit changes the true answer and leaves the sentence standing.
  const gov = config.smoke.gov;
  const modeFHours = (gov.timelockDuration + gov.executionWindow) / 3600;
  for (const p of ['how-it-works.html', 'risks.html']) {
    assert.ok(
      (raw.get(p) ?? '').includes(`${modeFHours} hours in the reference configuration`),
      `${p} is stale relative to base-mainnet.json: the Mode-F window is timelockDuration + executionWindow = ${modeFHours} hours`,
    );
  }
  // The small-member quorum regime flips at roughly four seats; the seat price is the minimum
  // deposit, so the cost of capture moves with the config.
  const SEATS = 4;
  const capture = (SEATS * Number(BigInt(config.smoke.minDepositUsdc))) / 1e6;
  const risks = raw.get('risks.html') ?? '';
  assert.ok(
    risks.includes(`reference ${usdc(config.smoke.minDepositUsdc)} minimum deposit`),
    `risks.html is stale relative to base-mainnet.json: the minimum deposit renders as ${usdc(config.smoke.minDepositUsdc)}`,
  );
  assert.ok(
    risks.includes(`about ${capture.toLocaleString('en-US')} USDC`),
    `risks.html is stale relative to base-mainnet.json: ${SEATS} seats at ${usdc(config.smoke.minDepositUsdc)} is about ${capture.toLocaleString('en-US')} USDC`,
  );
});

// ────────────────────────────── the 2026-08-29 corrections ──────────────────────────────

/** The "What is done" cells of the risks page, as plain text, in document order. */
function whatIsDoneCells() {
  const html = raw.get('risks.html') ?? '';
  return [...html.matchAll(/<dt>What is done<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];

test('the risks page states the true number of unmitigated risks, and so does who-its-for', () => {
  const cells = whatIsDoneCells();
  assert.ok(cells.length >= 15, `risks.html: expected at least fifteen risk entries, parsed ${cells.length}`);
  const unmitigated = cells.filter((c) => c.startsWith('Nothing')).length;
  const word = NUMBER_WORDS[unmitigated];
  assert.ok(word, `risks.html: ${unmitigated} unmitigated risks is off the end of NUMBER_WORDS`);
  const risks = raw.get('risks.html') ?? '';
  const who = raw.get('who-its-for.html') ?? '';
  assert.ok(
    risks.includes(`${word.charAt(0).toUpperCase()}${word.slice(1)} of these have no mitigation`),
    `risks.html: ${unmitigated} "What is done" cells begin with "Nothing", so the lede must say "${word.charAt(0).toUpperCase()}${word.slice(1)} of these have no mitigation"`,
  );
  assert.ok(
    who.includes(`the ${word} where the honest answer is that nothing is done`),
    `who-its-for.html: risks.html now has ${unmitigated} unmitigated risks, so this page must say "the ${word} where the honest answer is that nothing is done"`,
  );
});

test('every named risk has an anchor and a contents entry, including r15', () => {
  const html = raw.get('risks.html') ?? '';
  const ids = [...html.matchAll(/<article class="risk" id="(r\d+)">/g)].map((m) => m[1]);
  assert.ok(ids.includes('r15'), 'risks.html must carry the oracle-rotation risk at #r15');
  for (const id of ids) assert.ok(html.includes(`href="#${id}"`), `risks.html: #${id} has no contents entry`);
  const word = NUMBER_WORDS[ids.length];
  assert.ok(html.includes(`All ${word}.`), `risks.html: ${ids.length} risks, so the contents heading must read "All ${word}."`);
});

test('the corrections from the 2026-08-29 review have not been undone', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    // A3: the exit fee is not routed to the operator IDENTITY, but the operator holds shares and
    // the fee reaches them through share value. "No share of the exit fee" was simply false.
    assert.ok(!/no share of the exit fee/i.test(html), `${p}: "no share of the exit fee" is false — the operator's mandatory 5% collects it through share value`);
    // A7: the creator gate is a withdrawal gate, not a top-up obligation.
    assert.ok(!/must be topped up/i.test(html), `${p}: the creator gate is a withdrawal gate, not a top-up obligation`);
    // C7: there is no population of vaults to generalise from.
    assert.ok(!/set lower by many vaults/i.test(html), `${p}: there are no other vaults — nothing has been deployed`);
    // A1: Mode F opens at reveal start, not at passage.
    assert.ok(!/rebalance has passed but has not yet executed/i.test(html), `${p}: Mode F opens at reveal start, not when a proposal passes`);
    // A4: the pre-audit findings are not all closed.
    assert.ok(!/all of which are now resolved/i.test(html), `${p}: one High remains open at the launch configuration and a sub-vault class is dormant, not fixed`);
    // C8: the cap is a planned parameter of a vault that does not exist.
    if (html.includes('50,000')) {
      assert.ok(/\bplanned\b/i.test(html), `${p}: states the 50,000 figure without labelling it planned and undeployed`);
    }
  }
});

test('the sequencer guard is not presented as a proven mitigation', () => {
  const html = raw.get('risks.html') ?? '';
  const r5 = html.slice(html.indexOf('id="r5"'), html.indexOf('id="r6"'));
  assert.ok(!/severity--mitigated/.test(r5), 'risks.html: risk 5 must not carry the green mitigated chip — the guard has never run against a real uptime feed');
  assert.ok(/never (?:run|executed) against a real/i.test(r5), 'risks.html: risk 5 must say the sequencer path has never executed against a real feed');
});

test('the pre-launch banner cannot be hidden by the stylesheet', () => {
  const site = decls(readFileSync(path.join(SITE, 'assets/site.css'), 'utf8'));
  for (const block of site.match(/\.pre-launch[^{]*\{[^}]*\}/g) ?? []) {
    assert.ok(!/display\s*:\s*none/i.test(block), `site.css hides the pre-launch banner: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/visibility\s*:\s*hidden/i.test(block), `site.css hides the pre-launch banner: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/(?:^|[;{])\s*height\s*:\s*0/i.test(block), `site.css collapses the pre-launch banner: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/font-size\s*:\s*0/i.test(block), `site.css collapses the pre-launch banner: ${block.replace(/\s+/g, ' ')}`);
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
