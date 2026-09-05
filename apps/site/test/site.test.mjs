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
 * The numeric checks now read the reference mainnet configuration named by CONFIG_PATH below and
 * compare it to the site's reference-configuration table, so a config edit turns the gate red
 * instead of silently desynchronizing the site; the deployment-status check is sentence-scoped
 * rather than page-scoped; and the security-attestation qualifier must sit in the same block as
 * the claim it qualifies.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolve from this module, not process.cwd(): apps/site deliberately has no package.json (apps/*
// is a workspace glob), so the suite is always run from the repo root by `npm run test:backend`.
const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SITE, '..', '..');
// REPOINTED 2026-09-05 by owner decision ("Remove the language for base. Just do robinhood for
// now."). The site's stated target chain is Robinhood Chain mainnet, chain id 4663, so the
// reference configuration the pages are checked against is that chain's file rather than Base's.
//
// The repoint is small because the two files are numerically identical for EVERY value this suite
// renders except one. smoke.gov (3600/3600/0/86400, 2500/500/4000/21600), smoke.minDepositUsdc
// (100000000), exitFeeMaxBps (50), exitFeeDecayPeriod (604800) and both sane-price bands match
// value for value. The only divergences are chainlinkOracle.assets[].heartbeatSeconds (3600 ->
// 86400, which is ChainlinkOracle.MAX_HEARTBEAT exactly) and chainlinkOracle.sequencerUptimeFeed
// (a Base address -> empty, because Chainlink publishes no L2 Sequencer Uptime Feed for 4663).
// So the entire numeric blast radius of this line is ONE table row on how-it-works.html and one
// prose figure on disclaimers.html, both of which move from 3,600 seconds to 86,400.
//
// base-mainnet.json is NOT deleted and must not be: scripts/test/config-doc-truth.test.mjs reads
// it directly and asserts its sequencer uptime feed is still a real address.
const CONFIG_PATH = path.join(REPO, 'contracts', 'config', 'robinhood-mainnet.json');
const CONFIG_NAME = 'contracts/config/robinhood-mainnet.json';

// Still eight. `risks.html` was RETIRED on 2026-09-05 and `disclaimers.html` took its slot: the
// owner's instruction is that every negative statement on this site lives on one page, so the
// fifteen risks, the legal position and every caveat lifted out of the other seven pages are all
// there. The page count did not change and neither did the parser -- the risk articles keep their
// `<article class="risk" id="rN">` shape, and every leg below that used to read risks.html now
// reads disclaimers.html.
//
// TWO of these eight are NOT in the header nav -- status.html since 2026-09-04 and
// disclaimers.html since 2026-09-05 -- and both are reached from the footer of every page. They are
// public pages and every guard in this file walks them, which is why they are members of this array
// rather than special cases.
const PAGES = ['index.html', 'how-it-works.html', 'agents.html', 'who-its-for.html', 'operators.html', 'disclaimers.html', 'faq.html', 'status.html'];

/** The one page every negative claim lives on, and the one every footer must link to. */
const DISCLAIMERS_PAGE = 'disclaimers.html';

/** Everything else the banned-phrase list must also cover: the README and both stylesheets. */
const PROSE_FILES = ['README.md', 'assets/tokens.css', 'assets/site.css'];

// The exact strings the spec pins. Any drift in punctuation or dashes is a failure, by design.
//
// BANNER_STATUS -- 'Not deployed to mainnet. The only deployment is a testnet trial with no real
// value at stake.' -- was RETIRED on 2026-09-05 rather than reworded, because it is false: the
// protocol is on Robinhood Chain mainnet. An absolute is what breaks the day it stops being true,
// so its replacement states the deployment and can be checked against the committed record rather
// than against nothing. What the old constant protected -- that every page tells a reader where the
// code is -- is carried by DEPLOYED_LINE below plus the mandatory footer link to the Disclaimers.
const DEPLOYED_LINE = 'Deployed on Robinhood Chain mainnet, chain id 4663.';
const BANNER_OFFER = 'Nothing on this site is an offer, a solicitation, or financial advice.';
const FOOTER_TOKEN = 'No token. No points. No airdrop. No presale.';
const FOOTER_LICENSE = 'Source-available under BUSL-1.1 — not open source.';
// Owner decision 2026-09-05: the domain is rwally.com, the positioning sentence names Rwally, and
// the masthead follows. "Agent-Governed Vaults" survives as the descriptor and the repository name,
// which is why it still appears in prose and in og:site_name-adjacent copy -- it is no longer the
// site's title.
const TITLE_SUFFIX = ' — Rwally';

// The only external host any page may reference.
const ALLOWED_HOST = 'github.com';

// The site's own public host, and the ONE exemption to the rule above -- see isExemptCanonical().
const CANONICAL_HOST = 'rwally.com';

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
  // lede's unhedged no-outcome sentence, and the invariant/parameter split on how-it-works.
  //
  // TWO ENTRIES WERE DELETED HERE ON 2026-09-04, and the deletion is the point rather than
  // collateral. `may be presented anywhere as a protocol-level guarantee` and `described as a
  // guarantee of anything` were exemptions for text that existed ONLY inside the review-marker
  // comments -- how-it-works.html and operators.html respectively -- so when the eighty markers
  // went, both became standing exemptions covering nothing. The "every permitted negation is
  // actually in use" test below caught them on the first run and named the remedy it was written
  // for: delete the entry, do not leave a blanket hole for a banned word to walk through later.
  'a good-faith measure and not a guarantee',
  'no guarantee of any outcome',
  'treating a parameter as a guarantee is how people get hurt',
  // "sign up" -- every occurrence denies that there is anything to sign up for.
  //
  // 'There is nothing to sign up for.' WAS DELETED HERE ON 2026-09-05, and the deletion is the
  // remedy this list's rot test asks for rather than collateral. It was the index page's "Next"
  // heading; that heading is now 'There is nothing to claim here.', so the entry covered nothing
  // and would have been a standing hole for a banned phrase to walk through later. The remaining
  // entry is still in use, on who-its-for.html.
  'nothing on this site to sign up for',
];

/**
 * How many times each exact standing sentence may appear on a given page.
 *
 * OWNER DECISION, 2026-09-05: every disclaimer lives on one page. Both of these sentences moved off
 * the eight footers and onto disclaimers.html, where each appears once, and every page's footer
 * carries a link to that page instead. So the default is now ZERO rather than one, and that is a
 * TIGHTENING, not a relaxation: with a permitted count of zero, scrub() strips nothing on the other
 * seven pages, so "airdrop", "presale" and "open source" are banned outright everywhere except
 * inside the two sentences on disclaimers.html. The old shape permitted one copy of each on every
 * page and therefore permitted those three words on every page.
 */
const FOOTER_SENTENCE_COUNTS = {
  [FOOTER_TOKEN]: { default: 0, [DISCLAIMERS_PAGE]: 1 },
  [FOOTER_LICENSE]: { default: 0, [DISCLAIMERS_PAGE]: 1 },
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

test('all eight pages exist', () => {
  assert.equal(PAGES.length, 8, 'PAGES must list all eight public pages');
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

/**
 * THE DISCLOSURE MOVED TWICE, AND THESE TESTS SAY EXACTLY WHERE IT IS NOW.
 *
 * Owner decision, 2026-09-04: "Claims should not be a header page, it should be a link in the
 * footer." The `.pre-launch` band that sat above the nav on all seven pages moved to status.html.
 *
 * Owner decision, 2026-09-05: every disclaimer lives on ONE page. `risks.html` is retired,
 * `disclaimers.html` takes its slot, and the four sentences that used to be repeated in eight
 * footers -- not-an-offer, deployment status, no-token, the licence -- are stated once, there.
 *
 * WHY THAT IS NOT A WEAKENING, stated rather than assumed, because "we consolidated the
 * disclaimers" is exactly how a disclosure gets quietly deleted:
 *
 *   - The reader protection the per-page footer count gave -- the disclosure is never more than one
 *     scroll away -- is carried by a MANDATORY footer link on every page, asserted below with the
 *     link text pinned, in the same shape the status link has been pinned since 2026-09-04.
 *   - The count-and-position discipline itself survives, on the two pages that now carry the
 *     sentences. Exactly one occurrence each, inside `<main>`, not buried in a footer.
 *   - FOOTER_SENTENCE_COUNTS defaulting to zero makes "airdrop", "presale" and "open source" banned
 *     OUTRIGHT on the other seven pages, where before one copy of each was permitted per page.
 *
 * The deployment-status sentence is the one that changed content as well as place. It used to be an
 * absolute -- "Not deployed to mainnet." -- and the protocol is now on Robinhood Chain mainnet, so
 * the absolute is false. DEPLOYED_LINE replaces it and names the chain id, which is what makes it
 * checkable: `scripts/test/claims-robinhood-deployment.test.mjs` binds every surface that cites the
 * deployment to the committed record at contracts/config/deployments/robinhood-mainnet.json.
 */
const STATUS_PAGE = 'status.html';

/**
 * Where each pinned sentence may appear, and how often. Zero everywhere it is not named: a stray
 * copy on a seventh page is as much a drift as a missing one.
 */
const PINNED_SENTENCE_COUNTS = {
  [DEPLOYED_LINE]: { default: 0, [STATUS_PAGE]: 1, [DISCLAIMERS_PAGE]: 1 },
  [BANNER_OFFER]: { default: 0, [DISCLAIMERS_PAGE]: 1 },
};

/**
 * The status band of a page, markup and all, or null when the page has none.
 *
 * The class name is still `pre-launch` and that is deliberate rather than left over: `site.css`
 * styles that class, and the "cannot be hidden by the stylesheet" test below reads those rules by
 * name. Renaming the class to match the copy would move a styling contract and a guard in the same
 * commit for a cosmetic gain. The class is a selector; the copy inside it is the claim.
 */
const statusBand = (html) => (html.match(/<div class="pre-launch">[\s\S]*?<\/div>\s*<\/div>/) ?? [null])[0];

test('the status band lives only on the status page', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const bands = (html.match(/class="pre-launch"/g) ?? []).length;
    if (p === STATUS_PAGE) {
      assert.equal(bands, 1, `${p}: the status page must carry exactly one status band, found ${bands}`);
      continue;
    }
    assert.equal(
      bands,
      0,
      `${p}: the top status band was moved to ${STATUS_PAGE} by owner decision 2026-09-04 — link to it from the footer instead of restoring it here`,
    );
  }
});

test('each pinned sentence appears exactly where it is pinned, and inside main', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    const mainAt = html.indexOf('<main id="main"');
    const footerAt = html.indexOf('<footer');
    assert.ok(footerAt !== -1, `${p}: missing <footer>`);
    for (const [sentence, allowed] of Object.entries(PINNED_SENTENCE_COUNTS)) {
      const want = /** @type {Record<string, number>} */ (allowed)[p] ?? allowed.default;
      const got = count(html, sentence);
      assert.equal(
        got,
        want,
        `${p}: expected ${want} occurrence(s) of ${JSON.stringify(sentence)}, found ${got}. Both pinned sentences live on ${DISCLAIMERS_PAGE} since 2026-09-05, and every other page links there rather than repeating them.`,
      );
      if (want === 0) continue;
      const at = html.indexOf(sentence);
      assert.ok(at > mainAt && at < footerAt, `${p}: ${JSON.stringify(sentence.slice(0, 40))}… must sit inside <main>, not in the footer or above the nav`);
    }
  }
});

test('status.html carries the full status block, inside main rather than above the nav', () => {
  const html = raw.get(STATUS_PAGE) ?? '';
  const band = statusBand(html);
  assert.ok(band, `${STATUS_PAGE}: the status band is missing entirely`);
  assert.ok(band.includes(DEPLOYED_LINE), `${STATUS_PAGE}: the band is missing the exact deployment string`);
  assert.ok(
    band.includes('contracts/config/deployments/robinhood-mainnet.json'),
    `${STATUS_PAGE}: the band must name the record the deployment claim is checked against — a deployment sentence with no source is the shape this page exists to refuse`,
  );
  const at = html.indexOf(band);
  assert.ok(at > html.indexOf('<main id="main"'), `${STATUS_PAGE}: the band must sit inside <main>, not above the nav`);
  assert.ok(at < html.indexOf('<footer'), `${STATUS_PAGE}: the band must sit inside <main>, not in the footer`);
  // The page exists to be reachable without being in the header nav, so both halves are pinned.
  assert.ok(!/<nav[\s\S]*?status\.html[\s\S]*?<\/nav>/.test(html), `${STATUS_PAGE}: the status page is deliberately not in the header nav`);
  // Attribute-tolerant on purpose. The footer Pages list omits the page you are on, everywhere
  // except here: the status link is the ONLY route to this page, so it stays in the list on the
  // status page too, and carries aria-current="page" -- the same treatment the header nav gives a
  // self-link -- rather than being silently dropped where a reader is most likely to look for it.
  for (const p of PAGES) {
    assert.ok(
      /href="status\.html"[^>]*>Status and claims<\/a>/.test(raw.get(p) ?? ''),
      `${p}: the footer must link to the status page — that link is the only route to it`,
    );
  }
  assert.ok(
    /href="status\.html" aria-current="page"/.test(html),
    `${STATUS_PAGE}: its own footer link must carry aria-current="page"`,
  );
});

/**
 * THE LINK THAT REPLACES THE REPEATED DISCLAIMER.
 *
 * This is the assertion that makes the 2026-09-05 consolidation safe. Every page used to state the
 * not-an-offer sentence and the deployment status in its own footer; now one page states them and
 * the other seven point at it. If that pointer is ever dropped from a page, the reader on that page
 * has no route to any of it, so the link text is pinned exactly as the status link's is -- a link
 * labelled "more" or "legal" is a link a reader does not follow.
 */
test('every page links to the Disclaimers, with the link text pinned', () => {
  for (const p of PAGES) {
    assert.ok(
      /href="disclaimers\.html"[^>]*>Disclaimers<\/a>/.test(raw.get(p) ?? ''),
      `${p}: the footer must carry a link reading exactly "Disclaimers" — since 2026-09-05 that link is the only route from this page to the risks, the legal position and the licence`,
    );
  }
  assert.ok(
    /href="disclaimers\.html" aria-current="page"/.test(raw.get(DISCLAIMERS_PAGE) ?? ''),
    `${DISCLAIMERS_PAGE}: its own footer link must carry aria-current="page" — it is not in the header nav, so the footer list is where a reader locates the page they are on`,
  );
  assert.ok(
    !/<nav[\s\S]*?disclaimers\.html[\s\S]*?<\/nav>/.test(raw.get(DISCLAIMERS_PAGE) ?? ''),
    `${DISCLAIMERS_PAGE}: like status.html it is deliberately footer-only, not in the header nav`,
  );
});

test('the two standing sentences are stated once each, on the Disclaimers page', () => {
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  assert.ok(html.includes(FOOTER_TOKEN), `${DISCLAIMERS_PAGE}: missing exact no-token sentence`);
  assert.ok(html.includes(FOOTER_LICENSE), `${DISCLAIMERS_PAGE}: missing exact licence sentence`);
});

// The "banner precedes the nav on every page" test was deleted on 2026-09-04 rather than adapted.
// It asserted the ONE property the owner's decision reverses -- that the status block sits above
// the nav -- so there is nothing left of it to keep. What it was protecting, that the disclosure is
// not buried, is now carried by the footer-position assertion two tests above, which is strictly
// stronger: it pins the count as well as the position.

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

/**
 * THE REVIEW MARKERS ARE GONE, AND THIS IS THE GUARD THAT KEEPS THEM GONE.
 *
 * Owner decision, 2026-09-04: "The audit counsel is now becoming an issue with repetitiveness.
 * Remove them entirely so that we can work faster." Eighty `<!-- COUNSEL: … -->` comments were
 * deleted from the seven pages, and the rendered prose of every page was byte-identical before and
 * after -- only the comments went, never the copy they annotated.
 *
 * The assertion INVERTS rather than disappears. A deleted check protects nothing, and this habit
 * was spread across seven files: without a guard it comes back one page at a time and nobody
 * notices until there are eighty again. It walks every file under apps/site rather than only
 * PAGES, because the review-queue instruction lived in the README as well as in the markup.
 *
 * TWO ASSERTIONS, AND THE SPLIT IS THE WHOLE DESIGN. The marker token was ALL CAPS by convention
 * in every one of the eighty, so the first check bans `COUNSEL` case-SENSITIVELY and catches it in
 * any spelling of container -- a comment, an attribute, a class name, a heading. A single
 * case-insensitive ban would have been simpler and is what this file tried first; it reds on
 * `apps/site/README.md`, which quotes the owner's decision in the owner's own lower-case words,
 * and a guard that forbids recording the reason for itself is a guard that gets deleted. So the
 * second check takes the case-insensitive half and scopes it to HTML COMMENTS, which is the shape
 * the markers actually had and the shape prose cannot accidentally take. Between them a lower-case
 * marker is caught, an upper-case one is caught, and quoting the decision stays legal.
 *
 * `test/` is the one directory excluded, and the reason is unavoidable rather than convenient: a
 * guard has to name the string it bans, so this file contains the word and would match itself.
 */
function siteFiles(dir = '') {
  /** @type {string[]} */
  const out = [];
  for (const e of readdirSync(path.join(SITE, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (rel === 'test') continue; // see above: this file names the banned string
    if (e.isDirectory()) out.push(...siteFiles(rel));
    else if (!/\.(?:png|ico)$/i.test(e.name)) out.push(rel);
  }
  return out;
}

test('no COUNSEL review marker survives anywhere under apps/site', () => {
  const files = siteFiles();
  assert.ok(files.length >= 14, `expected the walk to reach at least fourteen files, found ${files.length}`);
  for (const f of files) {
    const text = readFileSync(path.join(SITE, f), 'utf8');
    assert.equal(
      text.match(/COUNSEL/),
      null,
      `${f}: the per-claim review markers were removed by owner decision 2026-09-04 — do not reintroduce them`,
    );
    for (const c of text.match(/<!--[\s\S]*?-->/g) ?? []) {
      assert.equal(
        c.match(/counsel/i),
        null,
        `${f}: an HTML comment reintroduces a per-claim review marker — ${JSON.stringify(c.replace(/\s+/g, ' ').slice(0, 120))}`,
      );
    }
  }
});

test('zero JavaScript: no script tags, no event handler attributes', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(!/<script/i.test(html), `${p}: contains a <script tag`);
    assert.equal(html.match(/\son[a-z]+\s*=/i), null, `${p}: contains an inline event handler attribute`);
  }
});

/**
 * The href values exempted from the host rule below: `rel="canonical"` links pointing at this
 * site's own public host. This is the ONLY exemption, and it exists for a reason worth writing
 * down rather than leaving to be reconstructed.
 *
 * The invariant the host rule protects is that a page LOADS nothing from anywhere and NAVIGATES
 * off-site only to the project repository. A canonical link does neither: it fetches no resource,
 * and it is not a link a reader can follow -- it is metadata that happens to be spelled with an
 * `href` rather than a `content` attribute, which is why `og:url` needs no exemption and this does.
 *
 * It also cannot be written any other way. A RELATIVE canonical would pass this check untouched
 * and is worse than having none at all, because it cannot do the one job canonicals exist for:
 * collapsing www/non-www, http/https and trailing-slash duplicates of a page onto one URL. An
 * exemption that lets the correct form ship beats a check that only permits the useless form.
 *
 * Both halves of the exemption are load-bearing and deliberately narrow. `rel="canonical"` ONLY --
 * any other `rel` (stylesheet, preload, icon) still fails, because those DO load. And
 * CANONICAL_HOST ONLY -- a canonical pointing anywhere else is not exempt and still fails.
 *
 * TWO WAYS THIS WAS WRONG WHEN FIRST WRITTEN, BOTH FOUND IN REVIEW, BOTH WORTH RECORDING:
 *
 * It matched the host with `startsWith('https://rwally.com')`, so `https://rwally.com.attacker.
 * example/x` prefixed it and was exempt. The host is now parsed with `new URL` and compared for
 * EQUALITY. Never re-narrow this to a string prefix: a prefix of a hostname is a different
 * hostname, and the attacker picks the suffix.
 *
 * It exempted href VALUES rather than the tags carrying them, so any `src` or `href` anywhere on
 * the page that happened to equal an exempted value inherited the exemption -- including a
 * `rel="stylesheet"`, which does load. Composed with the prefix bug, a stylesheet pulling from a
 * foreign host passed this gate green. The exempt canonical tags are now REMOVED from the markup
 * before the scan, so the exemption cannot spread past the tag it was written for.
 *
 * The shape of the mistake, since it will recur: an exemption narrowed by describing it in a
 * comment rather than by encoding it. Both sentences above were in the file, and both were false
 * as implemented. Test the exemption's edges with a probe, not with prose.
 */
const isExemptCanonical = (tag) => {
  if (!/\brel\s*=\s*"canonical"/i.test(tag)) return false;
  const href = tag.match(/\bhref\s*=\s*"([^"]*)"/i)?.[1];
  if (!href) return false;
  let u;
  try {
    u = new URL(href);
  } catch {
    return false; // relative or malformed: not exempt, and the host rule ignores it anyway
  }
  return u.protocol === 'https:' && u.host.toLowerCase() === CANONICAL_HOST;
};

/** The markup with the exempt canonical tags removed, so the scan below never sees them. */
const withoutExemptCanonicals = (html) =>
  html.replace(/<link\b[^>]*>/gi, (tag) => (isExemptCanonical(tag) ? ' ' : tag));

test('no external requests: the only permitted remote host is the project repository', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    assert.ok(!/fonts\.googleapis\.com/i.test(html), `${p}: references fonts.googleapis.com`);
    assert.ok(!/fonts\.gstatic\.com/i.test(html), `${p}: references fonts.gstatic.com`);
    // Scan the markup with the exempt canonical tags removed, rather than skipping matching
    // href VALUES: a value-scoped skip leaks the exemption to any other tag carrying the same URL.
    for (const m of withoutExemptCanonicals(html).matchAll(/(?:src|href)\s*=\s*"([^"]*)"/gi)) {
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

test('every page links to all eight pages', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    for (const other of PAGES) {
      assert.ok(html.includes(`href="${other}"`), `${p}: is missing a link to ${other}`);
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
  assert.ok(ops.includes('2,500 USDG'), 'operators.html must state the 2,500 USDG figure');
  assert.ok(ops.includes('5%'), 'operators.html must state the 5% figure');
  assert.ok(!/zero capital cost/i.test(ops), 'operators.html must never claim zero capital cost');
  // The two distinct 5% mechanisms must both be named; conflating them is the documented failure mode.
  assert.ok(/proposal threshold/i.test(ops), 'operators.html must name the proposal threshold');
  assert.ok(/withdrawal gate/i.test(ops), 'operators.html must name the creator withdrawal gate');
});

/**
 * THIS TEST TURNED AROUND ON 2026-09-05, AND THE RESIDUE IS THE HALF WORTH KEEPING.
 *
 * It used to ban "is live", "mainnet is live", "launched on", "now trading" and "goes live", on the
 * reasoning that nothing was deployed and a page implying otherwise was false. The protocol is now
 * on Robinhood Chain mainnet, so that ban is backwards: the pages must be ABLE to say where the code
 * is, and the leg below this one is what holds those sentences to the record.
 *
 * What was always useful in it, and is still useful, is the TIMING-AND-HYPE half. "Launching soon",
 * "coming soon", "any day now" are the sentences that manufacture urgency around a thing nobody can
 * check yet -- and they were never about deployment status, which is why they survive the reversal.
 * Retiring the whole test would have left that gap open, so the list is replaced rather than deleted.
 */
test('no page manufactures urgency or a price expectation', () => {
  for (const p of PAGES) {
    const html = raw.get(p) ?? '';
    // `\bhurry\b` is deliberately NOT here: who-its-for.html says the small first vault "is not a
    // signal to hurry", which is the correct sentence and which a bare word ban would red. Ban
    // phrases, never bare words -- the rule this file opens with.
    for (const re of [/\blaunch(?:ing)? soon\b/i, /\bcoming soon\b/i, /\bnext week\b/i, /\bany day now\b/i, /\bto the moon\b/i, /\bdon'?t miss out\b/i]) {
      const hit = html.match(re);
      assert.equal(hit, null, `${p}: ${JSON.stringify(hit?.[0])} sets a clock or a price expectation this site has no business setting`);
    }
  }
});

/**
 * The published prose of a page: HTML comments dropped (a comment is a note to the next editor,
 * not copy a reader ever sees), tags flattened, and the meta description put back in front
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

/**
 * The chain a deployment sentence must name, or the record it must cite, to be checkable. Same two
 * tokens `scripts/test/claims-robinhood-deployment.test.mjs` uses, so the two guards converge rather
 * than drift: naming 4663 or the record path is what lets that file bind the sentence to the
 * committed address book.
 */
const DEPLOY_CITED = /\brobinhood\b|\b4663\b|contracts\/config\/deployments\/robinhood-mainnet\.json/i;

test('every "deployed" either negates itself or names the chain and the record', () => {
  // Sentence-scoped, not page-scoped. A page-wide check is what let "Whatever gets deployed is
  // what runs" ship next to a banner three thousand characters away that said "Not deployed."
  //
  // THE RULE CHANGED SHAPE ON 2026-09-05 RATHER THAN LOOSENING, and the distinction is the whole
  // point. Requiring a NEGATION was only ever a proxy for requiring TRUTH, and it worked while
  // nothing was deployed. Now that the protocol is on Robinhood Chain mainnet, "the protocol is
  // deployed on Robinhood Chain mainnet, chain id 4663" is both true and unnegatable, so the proxy
  // would red the one sentence the site most needs to state plainly.
  //
  // The successor requirement is stricter than a negation, not weaker: a sentence that says
  // "deployed" must say WHERE, in the same sentence, in a token another guard can bind to the
  // committed record. A vague "it is deployed" now fails where before it only had to avoid the word
  // "not". Do not replace this with a page-scoped check, and do not drop the record token: without
  // it, "deployed on mainnet" passes and names nothing a reader can open.
  for (const p of PAGES) {
    for (const s of sentencesOf(publishedProse(raw.get(p) ?? ''))) {
      if (!/\bdeployed\b/i.test(s)) continue;
      if (NEGATED.test(s)) continue;
      assert.ok(
        DEPLOY_CITED.test(s),
        `${p}: "deployed" in a sentence that neither negates it nor says where — name Robinhood Chain, the chain id 4663, or contracts/config/deployments/robinhood-mainnet.json in the same sentence — ${JSON.stringify(s.trim())}`,
      );
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
// is read out of the reference mainnet configuration named by CONFIG_PATH above and compared to
// what the page renders. Before
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

// The settlement asset LABEL, not just the number. The reference configuration is now chain
// 4663's, whose settlement token under the `usdc` key is USDG (Global Dollar) rather than Circle
// USDC — see robinhood-mainnet.json `usdcNote`. The FIELD NAMES stay `usdc`/`minDepositUsdc`
// because the config keeps them (it is a verbatim copy of base-mainnet.json's smoke block, and
// nothing in contracts/ reads a symbol: VaultCore identifies the settlement token by address and
// measures it with decimals()). Only the rendered label moves, and the numbers do not move at all.
//
// Three site figures hang off this label and had to change together: the "Minimum deposit" table
// row on how-it-works.html, and risks.html's "reference 100 USDG minimum deposit" and "about 400
// USDG". The third of those is spelled out INLINE below rather than through this helper, which is
// exactly how a rename gets half-done — so it is named here.
const usdg = (units) => `${(Number(BigInt(units)) / 1e6).toLocaleString('en-US')} USDG`;
const wadDollars = (wad) => `$${(Number(BigInt(wad)) / 1e18).toLocaleString('en-US')}`;

test(`the reference-configuration table matches ${CONFIG_NAME} row for row`, () => {
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
    ['Minimum deposit', [usdg(config.smoke.minDepositUsdc)]],
    ['Exit fee maximum', percents(config.smoke.exitFeeMaxBps)],
    ['Exit fee decay period', durations(config.smoke.exitFeeDecayPeriod)],
    ['Oracle staleness bound', durations(staleness[0])],
  ];

  for (const [label, accepted] of expected) {
    const cell = rows.get(label);
    assert.ok(cell !== undefined, `how-it-works.html is stale: its reference-configuration table has no "${label}" row, but ${CONFIG_NAME} sets one`);
    assert.ok(
      accepted.some((v) => cell.includes(v)),
      `how-it-works.html is stale relative to ${CONFIG_NAME}: "${label}" renders ${JSON.stringify(cell)}, and the config value renders as one of ${JSON.stringify(accepted)}`,
    );
  }
});

test('the sane-price bands on the site match the config', () => {
  // These live in prose rather than in the table, so they are checked page-wide.
  for (const asset of config.chainlinkOracle.assets) {
    const lo = wadDollars(asset.minPriceWad);
    const hi = wadDollars(asset.maxPriceWad);
    for (const p of ['how-it-works.html', DISCLAIMERS_PAGE]) {
      const html = raw.get(p) ?? '';
      assert.ok(html.includes(lo), `${p} is stale relative to ${CONFIG_NAME}: the ${asset.symbol} band floor renders as ${lo} in the config and does not appear on the page`);
      assert.ok(html.includes(hi), `${p} is stale relative to ${CONFIG_NAME}: the ${asset.symbol} band ceiling renders as ${hi} in the config and does not appear on the page`);
    }
  }
});

test('the figures the site DERIVES from the config are pinned to it as well', () => {
  // These do not appear in the reference table, so the row-by-row check above cannot see them.
  // They are arithmetic on config values, which is exactly the class of number that goes stale
  // silently: a config edit changes the true answer and leaves the sentence standing.
  const gov = config.smoke.gov;
  const modeFHours = (gov.timelockDuration + gov.executionWindow) / 3600;
  for (const p of ['how-it-works.html', DISCLAIMERS_PAGE]) {
    assert.ok(
      (raw.get(p) ?? '').includes(`${modeFHours} hours in the reference configuration`),
      `${p} is stale relative to ${CONFIG_NAME}: the Mode-F window is timelockDuration + executionWindow = ${modeFHours} hours`,
    );
  }
  // What four seats BUY changed with the H-8/CM-7 remediation, while the arithmetic did not.
  // Before it, four dust seats passed a proposal outright, because the sub-five regime was a pure
  // head count. Now both sub-five branches weigh stake (`headMajorityWithStake` carries a stake
  // quorum term and `forStakeMajority` is stake alone), so dust cannot pass anything on numbers.
  // What four seats still buy is the REGIME: taking a single-member vault to five members moves it
  // out of the signer-count branch into the pure stake rule — H-8(a), which `Governance.finalize`
  // documents as unfixed by design and mitigated at the config layer by a meaningful minimum
  // deposit. So the seat price is still the minimum deposit and still moves with the config; the
  // sentence it pins had to change, and this comment is the record of why.
  const SEATS = 4;
  const capture = (SEATS * Number(BigInt(config.smoke.minDepositUsdc))) / 1e6;
  const disclaimers = raw.get(DISCLAIMERS_PAGE) ?? '';
  assert.ok(
    disclaimers.includes(`reference ${usdg(config.smoke.minDepositUsdc)} minimum deposit`),
    `${DISCLAIMERS_PAGE} is stale relative to ${CONFIG_NAME}: the minimum deposit renders as ${usdg(config.smoke.minDepositUsdc)}`,
  );
  assert.ok(
    disclaimers.includes(`about ${capture.toLocaleString('en-US')} USDG`),
    `${DISCLAIMERS_PAGE} is stale relative to ${CONFIG_NAME}: ${SEATS} seats at ${usdg(config.smoke.minDepositUsdc)} is about ${capture.toLocaleString('en-US')} USDG`,
  );
});

/**
 * THE BASKET IS WRITTEN IN THE WORDS PEOPLE USE, AND ANCHORED TO THE TOKENS ACTUALLY HELD.
 *
 * Owner decision, 2026-09-05: "users dont say WETH or cbBTC, they say ETH/Ethereum or BTC/Bitcoin."
 * So the page prose says ETH and BTC. That is a simplification, and a simplification about what a
 * vault holds is exactly the kind that turns into a false claim if it is ever the ONLY thing the
 * site says: the vault holds wrapped ERC-20s at specific addresses, not ether and not bitcoin.
 *
 * This leg ties the two together. If any page names the basket in the short form, then status.html
 * AND disclaimers.html must each carry a single sentence naming both tokens by their contract
 * symbol and their address as `contracts/config/robinhood-mainnet.json` records them. One sentence,
 * not two facts scattered down a page, because the reader has to be able to see which word maps to
 * which token in one read.
 *
 * The addresses are read from the config rather than typed here, on the same rule as every other
 * numeric leg in this file: the config is the source of truth and the page is the copy of it.
 */
const BASKET_SHORT_FORM = /\bETH\b|\bBTC\b|\bEthereum\b|\bBitcoin\b/;
/** The tokens the launch oracle prices, symbol and address, straight out of the config. */
const basketTokens = config.chainlinkOracle.assets.map((/** @type {any} */ a) => ({ symbol: String(a.symbol), address: String(a.asset) }));

test('every short-form basket mention is anchored to the tokens actually held', () => {
  const short = PAGES.filter((p) => BASKET_SHORT_FORM.test(publishedProse(raw.get(p) ?? '')));
  assert.ok(
    short.length > 0,
    'no page names the basket at all. This leg exists to keep the short form honest, not to make it optional — if the short form is gone, say so in the commit rather than letting the anchor requirement pass by absence',
  );
  assert.ok(basketTokens.length >= 2, `${CONFIG_NAME}: expected at least two priced assets, found ${basketTokens.length}`);
  for (const anchor of [STATUS_PAGE, DISCLAIMERS_PAGE]) {
    const prose = publishedProse(raw.get(anchor) ?? '');
    const naming = sentencesOf(prose).find((s) =>
      basketTokens.every((t) => s.includes(t.symbol) && s.toLowerCase().includes(t.address.toLowerCase())),
    );
    assert.ok(
      naming,
      `${anchor}: pages say "${short.join('", "')}" name the basket as ETH and BTC, so this page must carry ONE sentence naming every token it is actually held as — ` +
        basketTokens.map((t) => `${t.symbol} (${t.address})`).join(' and ') +
        ` — read from ${CONFIG_NAME}. Without it the short form is an unanchored claim about what the vault holds.`,
    );
  }
});

// ────────────────────────────── the 2026-08-29 corrections ──────────────────────────────

/**
 * The "What is done" cells of the Disclaimers page, as plain text, in document order.
 *
 * REPOINTED 2026-09-05 from risks.html, which is retired. The parser is unchanged because the
 * markup is: the fifteen risk articles moved page intact, `<article class="risk" id="rN">` and all,
 * so the count-derivation below still reads the entries themselves rather than a number somebody
 * typed. That derivation is the leg that stops the lede drifting from the entries, and it is the
 * reason the move is a repoint rather than a rewrite.
 */
function whatIsDoneCells() {
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  return [...html.matchAll(/<dt>What is done<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => m[1].replace(/<[^>]*>/g, '').trim());
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen'];

/**
 * The who-its-for half of this assertion was DROPPED on 2026-09-05, not lost. That page used to
 * repeat the count ("including the seven where the honest answer is that nothing is done") and now
 * sends the reader to the Disclaimers instead of restating a number it does not own. A cross-page
 * count that nothing derives is a number that goes stale silently — which is what this whole test
 * exists to prevent — so the second copy went with the second page.
 */
test('the Disclaimers page states the true number of unmitigated risks', () => {
  const cells = whatIsDoneCells();
  assert.ok(cells.length >= 15, `${DISCLAIMERS_PAGE}: expected at least fifteen risk entries, parsed ${cells.length}`);
  const unmitigated = cells.filter((c) => c.startsWith('Nothing')).length;
  const word = NUMBER_WORDS[unmitigated];
  assert.ok(word, `${DISCLAIMERS_PAGE}: ${unmitigated} unmitigated risks is off the end of NUMBER_WORDS`);
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  assert.ok(
    html.includes(`${word.charAt(0).toUpperCase()}${word.slice(1)} of these have no mitigation`),
    `${DISCLAIMERS_PAGE}: ${unmitigated} "What is done" cells begin with "Nothing", so the lede must say "${word.charAt(0).toUpperCase()}${word.slice(1)} of these have no mitigation"`,
  );
});

test('every named risk has an anchor and a contents entry, including r15', () => {
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  const ids = [...html.matchAll(/<article class="risk" id="(r\d+)">/g)].map((m) => m[1]);
  assert.ok(ids.includes('r15'), `${DISCLAIMERS_PAGE} must carry the oracle-rotation risk at #r15`);
  for (const id of ids) assert.ok(html.includes(`href="#${id}"`), `${DISCLAIMERS_PAGE}: #${id} has no contents entry`);
  const word = NUMBER_WORDS[ids.length];
  assert.ok(html.includes(`All ${word}.`), `${DISCLAIMERS_PAGE}: ${ids.length} risks, so the contents heading must read "All ${word}."`);
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
    assert.ok(!/set lower by many vaults/i.test(html), `${p}: there is no population of vaults to generalise from`);
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
  const html = raw.get(DISCLAIMERS_PAGE) ?? '';
  const r5 = html.slice(html.indexOf('id="r5"'), html.indexOf('id="r6"'));
  assert.ok(!/severity--mitigated/.test(r5), `${DISCLAIMERS_PAGE}: risk 5 must not carry the green mitigated chip — the guard has never run against a real uptime feed`);
  assert.ok(/never (?:run|executed) against a real/i.test(r5), `${DISCLAIMERS_PAGE}: risk 5 must say the sequencer path has never executed against a real feed`);
});

/**
 * RWLY DOES NOT EXIST, AND EVERY MENTION OF IT HAS TO SAY SO.
 *
 * Owner decision, 2026-09-05: the lede now names the next iteration -- "The next iteration, RWLY,
 * is designed to accrue the protocol's fees into official Robinhood Stock Tokens." -- and the
 * standing rule from 2026-09-04 is that this site keeps saying no token exists until one does. A
 * named future token is the single easiest thing on these pages to quote out of context into a
 * claim that something is buyable, so the qualifier travels with the name rather than sitting in a
 * disclaimer further down the page.
 *
 * WINDOW-SCOPED, not sentence-scoped, and the reason is the copy this guard has to permit. The
 * approved lede is TWO sentences: the first names RWLY and the second says it does not exist yet.
 * A sentence-scoped rule reds the exact wording the owner directed, which is a guard failing its
 * own copy. Block scoping (the shape used by the security-review check above) does not work either,
 * because three of the twelve occurrences are inside `content="…"` meta attributes, which sit in no
 * <p>, <dd> or <li> at all. A character window handles markup and prose with one rule.
 *
 * 160 CHARACTERS, chosen against the copy rather than picked round. Measured over the site as it
 * stands, the widest gap between an "RWLY" and its nearest "does not exist" is 108 characters (the
 * lede, whose first sentence carries the whole Stock Tokens clause). 160 leaves room for a modest
 * rewrite and still refuses a qualifier parked a paragraph away.
 *
 * The floor is the other half. A window rule alone is satisfiable by deleting every mention, which
 * would silently drop a fact the owner put on the page; the count assertion means the only way to
 * pass is to keep the mentions and keep them qualified. Same reasoning as the open-High check.
 */
const RWLY_WINDOW = 160;
const RWLY_QUALIFIER = /does not exist/i;

test('every mention of RWLY on this site sits beside the fact that it does not exist', () => {
  const files = siteFiles();
  let seen = 0;
  for (const f of files) {
    // Flattened, so a mention and its qualifier split across a line break still count as adjacent.
    const text = readFileSync(path.join(SITE, f), 'utf8').replace(/\s+/g, ' ');
    for (const m of text.matchAll(/RWLY/g)) {
      seen++;
      const at = m.index ?? 0;
      const window = text.slice(Math.max(0, at - RWLY_WINDOW), at + RWLY_WINDOW);
      assert.ok(
        RWLY_QUALIFIER.test(window),
        `${f}: names RWLY without "does not exist" within ${RWLY_WINDOW} characters. RWLY is the ` +
          'NEXT ITERATION and is design intent only — there is no such token, no presale and nothing ' +
          `to hold. — ${JSON.stringify(window.trim().slice(0, 200))}`,
      );
    }
  }
  assert.ok(
    seen >= 6,
    `expected RWLY to be named on at least six surfaces, found ${seen} — if the mentions were deleted ` +
      'rather than qualified, say so in the commit rather than letting this guard pass by absence',
  );
  // And the exact sentence the owner's wording turns on, verbatim, on the page that carries the lede.
  assert.ok(
    (raw.get('index.html') ?? '').includes('RWLY does not exist yet.'),
    'index.html: the lede must end on the exact sentence "RWLY does not exist yet."',
  );
});

/**
 * The `.pre-launch` rules now style ONE block on ONE page -- the status band on status.html -- and
 * this check follows it there rather than being retired with the sitewide band. The reasoning is
 * unchanged and is now sharper: a status block that exists in the markup and renders at zero height
 * is worse than no status block, because it passes every presence assertion above while showing a
 * reader nothing. That was true when the band was on seven pages and it is true when it is on one.
 */
test('the status band cannot be hidden by the stylesheet', () => {
  const site = decls(readFileSync(path.join(SITE, 'assets/site.css'), 'utf8'));
  const blocks = site.match(/\.pre-launch[^{]*\{[^}]*\}/g) ?? [];
  assert.ok(blocks.length >= 1, 'site.css no longer styles the status band at all');
  for (const block of blocks) {
    assert.ok(!/display\s*:\s*none/i.test(block), `site.css hides the status band: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/visibility\s*:\s*hidden/i.test(block), `site.css hides the status band: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/(?:^|[;{])\s*height\s*:\s*0/i.test(block), `site.css collapses the status band: ${block.replace(/\s+/g, ' ')}`);
    assert.ok(!/font-size\s*:\s*0/i.test(block), `site.css collapses the status band: ${block.replace(/\s+/g, ' ')}`);
  }
});

/**
 * EVERY ADDRESS THE SITE PUBLISHES MUST BE IN A REPOSITORY RECORD.
 *
 * status.html is the only page that publishes contract addresses, deliberately, and thirteen of
 * them are twenty-byte hex strings a reader cannot check by eye. The failure mode is transcription:
 * one wrong nibble in a singleton nobody reads twice, and the page sends a reader to a contract that
 * is not this protocol. Nothing above catches that — the numeric legs read the CONFIG, and an
 * address is not a number they render.
 *
 * So this leg reads it the other way round: every `0x…` on the page must appear in one of the two
 * files the page cites as its source — the deployment record and the chain configuration. It cannot
 * prove the record is right; it proves the PAGE agrees with the record, which is the half the site
 * is responsible for.
 *
 * IT DOES NOT SKIP WHEN THE RECORD IS ABSENT, and that branch matters as much as the other. The
 * deployment record lands with its own pull request; until it does, the addresses on the page can
 * only be checked against the chain configuration, and the leg still asserts that the page publishes
 * addresses at all — a status page that quietly stopped listing them would otherwise pass this test
 * by having nothing to check.
 */
const ADDRESS_SOURCES = [
  path.join(REPO, 'contracts', 'config', 'deployments', 'robinhood-mainnet.json'),
  CONFIG_PATH,
];

test('every address the status page publishes appears in a repository record', () => {
  const html = raw.get(STATUS_PAGE) ?? '';
  const addresses = [...html.matchAll(/0x[0-9a-fA-F]{40}/g)].map((m) => m[0]);
  assert.ok(
    addresses.length >= 3,
    `${STATUS_PAGE}: publishes ${addresses.length} contract addresses. It is the one page that carries them, so an empty address book here is a page that has quietly stopped doing its job`,
  );
  const haystack = ADDRESS_SOURCES.filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8').toLowerCase())
    .join('\n');
  for (const a of addresses) {
    assert.ok(
      haystack.includes(a.toLowerCase()),
      `${STATUS_PAGE}: publishes ${a}, which appears in neither contracts/config/deployments/robinhood-mainnet.json nor ${CONFIG_NAME}. Addresses are transcribed from a record or they are not published — there is no third option`,
    );
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

// ═══════════════ the claim surface OUTSIDE apps/site — added by the 2026-09-01 audit ═══════════════
//
// WHY THIS SECTION EXISTS. Everything above stops at the six marketing pages. The 2026-09-01 claims
// audit found the same claims — one of them the *identical* claim this file already bans — alive
// and false in the repository's own member- and agent-facing prose, which publishes on the same day
// the site does. The rule that produced the gap is worth stating so it is not re-learned: a claims
// test protects the FILES IT READS and nothing else. Where a claim travels, the check must travel.
//
// Scope is per-rule and narrow rather than "run BANNED over the whole repo": the engineering docs
// legitimately say "audit", "safe" and "returns", and a blanket list over them would be neutered by
// its first false positive — the exact failure mode this file's header warns about.

/** Repository prose a non-developer or an integrating agent reads. Paths are repo-relative. */
const REPO_PROSE = ['README.md', 'llms.txt', 'docs/AGENT-QUICKSTART.md'];
const repoProse = new Map(REPO_PROSE.map((f) => [f, readFileSync(path.join(REPO, f), 'utf8')]));

/**
 * Mode F opens when a live proposal reaches its REVEAL phase, not when a proposal passes:
 * `VaultCore.requestExit` queues on `Governance.hasPendingExecution`, which returns true from
 * `p.commitDeadline` onward (`Governance.sol:648-659`). Every phrasing below puts the trigger at
 * passage instead, which understates the window in which a member's exit can be trapped, and hides
 * that a DEFEATED proposal still queued the exits requested while it was live.
 *
 * The site-page ban on one phrasing of this has existed since 2026-08-29 (correction A1 above). It
 * did not stop README.md, llms.txt and docs/AGENT-QUICKSTART.md shipping the same claim in three
 * other phrasings, because nothing read those files. Both halves now run over both surfaces.
 */
const MODE_F_MISSTATEMENTS = [
  /\bpassed[-\s]but[-\s]pending\b/i,
  /\bpassed[-\s]but[-\s]unexecuted\b/i,
  /\bbetween a vote passing\b/i,
  /\bvote passing and execut/i,
  /\brebalance has passed but has not yet executed\b/i,
];

test('no surface places the Mode-F trigger at proposal passage instead of reveal', () => {
  for (const [f, text] of repoProse) {
    for (const re of MODE_F_MISSTATEMENTS) {
      const hit = text.match(re);
      assert.equal(
        hit,
        null,
        `${f}: ${JSON.stringify(hit?.[0])} places the Mode-F trigger at passage. It opens at the reveal phase — Governance.hasPendingExecution is true from p.commitDeadline (Governance.sol:653)`,
      );
    }
  }
  for (const p of PAGES) {
    const prose = publishedProse(raw.get(p) ?? '');
    for (const re of MODE_F_MISSTATEMENTS) {
      const hit = prose.match(re);
      assert.equal(hit, null, `${p}: ${JSON.stringify(hit?.[0])} places the Mode-F trigger at passage, not at the reveal phase`);
    }
  }
});

test('every surface that describes Mode F names the reveal phase as its trigger', () => {
  // The negative check alone is satisfiable by deleting the sentence. This is the positive half:
  // each of these files explains the exit modes, so each must say WHEN the window opens.
  for (const [f, text] of repoProse) {
    assert.ok(
      /reveal phase/i.test(text),
      `${f} describes forward settlement but never names the reveal phase as the trigger — state when the window opens, do not merely avoid stating when it does not`,
    );
  }
});

/**
 * The open High must be NAMED wherever it is claimed, never left as an anonymous severity.
 *
 * At the launch configuration (`Deploy.s.sol` hardcodes `allowSubVaults = false`) exactly one High
 * is reachable: **H-8**, the stake-blind `<5`-member quorum regime — partially fixed in code, with
 * its regime-flip (attack (a)) mitigated only by a meaningful `minDepositUsdc`. H-5/H-6/H-7/H-9 are
 * NOT open-but-unfixed at launch; they are unreachable, because each requires a funded child vault
 * (AI-AUDIT-REPORT: "Dormant at launch — all require a funded child"). Their deferral is dormancy,
 * not EIP-170 headroom: PR #90 reclaimed VaultCore to 4,095 B of margin on 2026-09-01.
 *
 * risks.html carried this claim anonymously ("A High-severity pre-audit finding remains open…")
 * while index.html and faq.html named it in the same words two screens away. An unnamed severity is
 * the one form of this sentence a reader cannot check, and it reads as a larger admission than the
 * truth — so the check is that the class travels with the claim.
 */
const OPEN_HIGH_CLAIM = /remains open at the launch configuration/i;
// The class used to be spelled "stake-blind". That descriptor is now FALSE — the H-8/CM-7
// remediation put a stake term in both sub-five branches — so pinning it here would have required
// every surface to keep naming the finding by behaviour the contracts no longer have. What is
// still open, and what the sentence must name, is the purchasable member count (H-8(a)). Accept
// the finding id too: "H-8" is the most checkable name a reader can carry to the audit report.
const OPEN_HIGH_CLASS = /purchasable member count|\bH-8\b/i;

test('the "open High at the launch configuration" claim always names the finding', () => {
  /** @type {[string, string][]} */
  const surfaces = [
    ...PAGES.map((p) => /** @type {[string, string]} */ ([p, publishedProse(raw.get(p) ?? '')])),
    ...REPO_PROSE.map((f) => /** @type {[string, string]} */ ([f, repoProse.get(f) ?? ''])),
  ];
  let seen = 0;
  for (const [where, text] of surfaces) {
    for (const s of sentencesOf(text)) {
      if (!OPEN_HIGH_CLAIM.test(s)) continue;
      seen++;
      assert.ok(
        OPEN_HIGH_CLASS.test(s),
        `${where}: claims a High "remains open at the launch configuration" without naming it. It is H-8, the purchasable member count in the <5-member quorum regime — name it in the same sentence — ${JSON.stringify(s.trim().slice(0, 160))}`,
      );
    }
  }
  assert.ok(seen >= 3, `expected the open-High claim on at least three surfaces, found ${seen} — if it was deleted rather than qualified, say so in the commit`);
});

/**
 * Demo vault and operator names in the allocator app.
 *
 * `apps/web` had no claims coverage at all, which is how "AlphaSeek Index" survived the rename of
 * "Stable Yield Micro" — the fixture that reached a legal review as a screenshot. A fixture name is
 * product copy: it renders as an `<h1>`. The line this draws, stated so it can be applied
 * consistently: a name may describe what a vault HOLDS or how it is BUILT ("cbBTC Micro",
 * "Base Blue-Chip 5", "Momentum Majors" are strategy descriptors, not outcome claims); it may never
 * describe or imply what it EARNS. Substring matching rather than word boundaries, because the
 * failure case was a compound ("AlphaSeek") and a proper noun has no legitimate use for any of these.
 */
const NAME_OUTCOME_WORDS = [/alpha/i, /yield/i, /\bstable/i, /\bapy\b/i, /\bapr\b/i, /profit/i, /\breturn/i, /guarantee/i, /\bsafe/i, /outperform/i, /passive/i, /\bgains?\b/i];

test('no demo vault or operator name implies an outcome', async () => {
  const fixtures = await import(pathToFileURL(path.join(REPO, 'apps', 'web', 'src', 'fixtures.mjs')).href);
  /** @type {string[]} */
  const names = [
    ...fixtures.VAULTS.flatMap((/** @type {any} */ v) => [v.name, v.operatorName].filter(Boolean)),
    ...fixtures.LEADERBOARD.map((/** @type {any} */ r) => r.name).filter(Boolean),
  ];
  assert.ok(names.length >= 8, `expected the fixture set to carry at least eight names, found ${names.length}`);
  for (const n of names) {
    for (const re of NAME_OUTCOME_WORDS) {
      assert.equal(
        n.match(re),
        null,
        `apps/web/src/fixtures.mjs: the demo name ${JSON.stringify(n)} implies an outcome (${re}). A name may say what a vault holds, never what it earns`,
      );
    }
  }
});

/**
 * `llms.txt` is the file written to orient autonomous agents, and it lives at the repository root.
 * Cloudflare Pages serves `apps/site`, so the root copy is not reachable at the public origin --
 * `https://rwally.com/llms.txt` would 404, which is the one URL an agent is most likely to try.
 *
 * The site therefore carries a copy. Two copies of a claim-bearing file is a drift hazard, so this
 * pins them byte-identical rather than trusting anyone to update both. Edit the root file; this
 * test tells you to copy it across.
 */
test('apps/site/llms.txt is byte-identical to the repository root copy', () => {
  const site = readFileSync(path.join(SITE, 'llms.txt'), 'utf8');
  const root = readFileSync(path.join(REPO, 'llms.txt'), 'utf8');
  assert.equal(
    site,
    root,
    'apps/site/llms.txt has drifted from the root llms.txt. The root file is the source: ' +
      'copy it across rather than editing the site copy — cp llms.txt apps/site/llms.txt',
  );
});
