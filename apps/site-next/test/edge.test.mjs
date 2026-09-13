// @ts-check
/**
 * EDGE BEHAVIOUR: what Cloudflare Pages does with a path, as opposed to what a
 * page says. Two artefacts decide it, and neither is JavaScript this suite can
 * call:
 *
 *   `dist/404.html`        the file Pages serves, with a 404 status, for a path
 *                          matching no asset and no redirect rule
 *   `public/_redirects`    the static rule table, copied to `dist/_redirects`
 *
 * WHY A SECOND FILE RATHER THAN MORE OF `site.test.mjs`. That suite iterates
 * `PAGES`, the two documents the site is navigated to, and nearly every guard in
 * it is written as `for (const p of PAGES)`. Neither artefact here is one of
 * those pages: the 404 document is deliberately outside `PAGE_IDS` (see
 * `NOT_FOUND_ID` in `src/shell/pinned.ts`), and `_redirects` is not a page at
 * all. Adding them to `PAGES` would put a link to the 404 document in both real
 * pages' navs, because that suite asserts every page links to every other.
 *
 * =========================================================================
 * THE DEFECT THIS FILE EXISTS FOR, measured against the live site 2026-09-09
 * =========================================================================
 *
 *     /nonsense.html     200   13167 bytes
 *     /vision.html       200   13167 bytes   (identical bytes to /)
 *     /                  200   13167 bytes
 *     /disclaimers.html  308   -> /disclaimers   (correct)
 *     /vision            301   -> /              (correct)
 *     /faq               301   -> /              (correct)
 *
 * `curl -s https://rwally.com/nonsense.html | grep -o "<title>[^<]*</title>"`
 * returned the HOMEPAGE title. The redirect table was never the defect — the
 * three correct lines above are its work. The defect was the fallback for paths
 * the table does not name: the Pages asset server walks up from the requested
 * path looking for a `404.html`, and finding none serves `/index.html` with a
 * 200. So every mistyped or stale path was an indexable duplicate of the
 * homepage, and a broken internal link announced itself in no log and no crawl.
 *
 * =========================================================================
 * WHAT THESE TESTS DO NOT DO, AND WHY THAT IS A DECISION
 * =========================================================================
 *
 * THEY DO NOT SIMULATE PAGES. Writing a resolver here that walks `dist` and
 * `_redirects` and returns `{status, location}` would let this file assert
 * "/nonsense.html -> 404" in one line, and the line would be worthless: it
 * would test a model of Cloudflare written in this repository, pass whether or
 * not the real edge agrees, and go on passing after a Pages behaviour change is
 * exactly what broke the site. There is no wrangler in this repository and
 * publishing is the owner's call, so the real thing cannot be exercised here at
 * all.
 *
 * SO THEY PIN THE PRECONDITIONS INSTEAD — the things that are true in this
 * repository, that the fix depends on, and that a later change could quietly
 * remove:
 *
 *   1. `dist/404.html` exists at the TOP LEVEL of the output. Its absence is
 *      the whole defect, and nothing else in the build fails without it.
 *   2. It went through the prerender, so it carries the site's chrome as
 *      markup rather than as an empty root div a blocked script never fills.
 *   3. It is `noindex` and carries NO canonical — the half of the fix that is
 *      about what a crawler is told, rather than about the status code.
 *   4. Its in-site links are ROOT-ABSOLUTE, because Pages renders this document
 *      at whatever path was asked for and a relative link would resolve against
 *      that failed path.
 *   5. Every rule in `_redirects` still parses, and every destination is a
 *      place that exists — the currently-working behaviour this change must not
 *      disturb.
 *
 * ONE MECHANISM, NOT TWO. There is deliberately no `/*  /404.html  404`
 * catch-all in `_redirects`: a catch-all source would sit in front of
 * `/assets/*` and `/media/*`, and it is untestable here for the same reason
 * everything else about the live edge is. Test 5's rule-shape check is what
 * keeps one from being added without a reader of this file noticing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(APP, 'dist');

/** The one filename this whole file is about. Pages recognises no other. */
const NOT_FOUND = '404.html';

/** The two real pages, for the "a destination exists" check on the rule table. */
const PAGES = ['index.html', 'disclaimers.html'];

/**
 * The hosts this site may point a reader at, NAVIGATION ONLY — nothing on this
 * origin loads a byte from any of them. Copied from `site.test.mjs`'s
 * `ALLOWED_HOSTS`, and it has to be copied rather than imported: that file is a
 * test module, not a fixture, and importing it would run all forty-five of its
 * checks a second time inside this one.
 *
 * WHY THIS SET IS HERE AT ALL. `site.test.mjs`'s external-host guard is keyed on
 * `PAGES`, and the 404 document is deliberately not one of them — so the site's
 * headline technical claim about itself, the one `public/_headers` spends its
 * whole length establishing, would have been unenforced on a page that IS
 * published. It is enforced below instead, on the same set.
 */
const ALLOWED_HOSTS = new Set(['github.com', 'app.rwally.com', 'x.com']);

const BUILT = existsSync(SITE);
const SKIP = 'apps/site-next/dist is not built, run `npm run build` in apps/site-next first';
const t = (name, fn) => test(name, BUILT ? {} : { skip: SKIP }, fn);

const notFoundHtml = () => readFileSync(path.join(SITE, NOT_FOUND), 'utf8');

/**
 * The document with its HTML COMMENTS REMOVED.
 *
 * WRITTEN BECAUSE IT BIT IMMEDIATELY. `404.html` explains at its top, where
 * somebody about to delete the file will read it, that the file carries no
 * canonical and why. That explanation names the attribute, the comment survives
 * the build into `dist/404.html`, and the first version of the canonical check
 * below matched it and reported the page as carrying the thing its comment says
 * it must not. `index.html` carries a note about the same trap for the
 * heading-count guard and works around it by not writing the tag in prose.
 *
 * The general fix is better than that workaround: these checks are about
 * MARKUP, and a comment is not markup. Stripping first means a file may
 * document its own constraints in the words that describe them.
 */
const withoutComments = (html) => html.replace(/<!--[\s\S]*?-->/g, ' ');

/* ===========================================================================
   1. THE FILE
   ======================================================================== */

t('the build emits a top-level 404.html, without which Pages serves a soft-404', () => {
  assert.ok(
    existsSync(path.join(SITE, NOT_FOUND)),
    `dist/${NOT_FOUND} is missing. With no top-level ${NOT_FOUND} in the output, the Cloudflare\n` +
      'Pages asset server falls back to serving /index.html WITH A 200 for every path that\n' +
      'matches no asset — the soft-404 measured on the live site on 2026-09-09, where\n' +
      '/nonsense.html returned 200 and bytes identical to /. Nothing else in this build fails\n' +
      'when the file goes, which is why this check is the one that has to.\n' +
      "Restore it: `notFound: entry('404.html')` in vite.config.ts, and the splice at the end\n" +
      'of scripts/prerender.mjs.',
  );
});

/* ===========================================================================
   2. IT CARRIES THE SITE'S CHROME, AS MARKUP
   ======================================================================== */

t('the 404 document is prerendered with the shell, not shipped as an empty root', () => {
  const html = notFoundHtml();

  assert.ok(
    !html.includes('<div id="root"></div>'),
    `${NOT_FOUND} still holds the EMPTY root div, so the prerender did not write it. A reader\n` +
      'whose module script is blocked, slow or refused by the CSP gets a blank page telling them\n' +
      'nothing — on the one document that exists to tell somebody their link is broken.',
  );

  // The shell, in the order PageShell renders it. Each of these is a separate
  // assertion rather than one regex, so a failure names which part went.
  assert.ok(html.includes('href="#main"'), `${NOT_FOUND}: no skip link`);
  assert.ok(html.includes('<main id="main">'), `${NOT_FOUND}: no <main id="main">`);
  assert.ok(html.includes('<header'), `${NOT_FOUND}: no masthead`);
  assert.ok(html.includes('<footer'), `${NOT_FOUND}: no footer`);

  // Exactly one h1, the same obligation every page of this site carries.
  assert.equal(html.split('<h1').length - 1, 1, `${NOT_FOUND}: expected exactly one h1`);
});

/* ===========================================================================
   3. WHAT IT TELLS A CRAWLER
   ======================================================================== */

t('the 404 document is noindex and claims no canonical URL', () => {
  const html = withoutComments(notFoundHtml());

  assert.match(
    html,
    /<meta\s+name="robots"\s+content="noindex">/,
    `${NOT_FOUND} must carry <meta name="robots" content="noindex">. The 404 STATUS is the\n` +
      'primary signal; this is the one a crawler that reads meta but not status still sees.',
  );

  // A canonical here would name a URL — index.html's, if copied from it — and
  // declare every address that does not exist a duplicate of that page, which
  // is the exact signal the 404 status withdraws. `og:url` is the same claim
  // spelled differently, so neither is permitted.
  assert.ok(
    !/rel="canonical"/.test(html),
    `${NOT_FOUND} carries a canonical link. This document is served at EVERY address that does\n` +
      'not exist, so there is no URL it can name that is true of the request that produced it.',
  );
  assert.ok(
    !/property="og:url"/.test(html),
    `${NOT_FOUND} carries og:url, which is a canonical claim under another name.`,
  );
});

/* ===========================================================================
   4. ITS LINKS SURVIVE BEING SERVED AT ANY DEPTH
   ======================================================================== */

t('every link on the 404 document is root-absolute, or a permitted off-site host', () => {
  const html = withoutComments(notFoundHtml());
  let checked = 0;

  for (const m of html.matchAll(/(?:href|src)\s*=\s*"([^"]*)"/gi)) {
    const v = m[1];
    if (v === '' || v.startsWith('#')) continue; // in-page anchor: correct as-is

    // OFF-SITE: held to the same rule as the two real pages rather than waved
    // through. `no external requests` in site.test.mjs iterates PAGES, which
    // this document is not in, so without this line the one page nothing else
    // guards would be the one page free to reach off this origin.
    if (/^(?:https?:)?\/\//i.test(v)) {
      checked++;
      const host = v.replace(/^(?:https?:)?\/\//i, '').split('/')[0].toLowerCase();
      assert.ok(
        ALLOWED_HOSTS.has(host),
        `${NOT_FOUND}: external host ${host} is not permitted. This origin makes no external\n` +
          'request, and the CSP in public/_headers is what enforces it — a stylesheet, font or\n' +
          'image from anywhere else is refused by the browser, so it would fail silently here.',
      );
      continue;
    }

    checked++;
    assert.ok(
      v.startsWith('/'),
      `${NOT_FOUND}: relative link "${v}". Pages serves this document AT THE PATH THAT WAS\n` +
        'ASKED FOR rather than redirecting, so /a/b/c renders it and "index.html" here resolves\n' +
        'to /a/b/index.html — a second 404, on the page a lost reader landed on. Route it\n' +
        'through `siteHref` from src/shell/pinned.ts.',
    );
  }

  // NON-VACUITY. The chrome alone is a dozen links; near zero means the regex
  // stopped matching the markup and this passed over nothing.
  assert.ok(checked >= 8, `only ${checked} in-site links were read on ${NOT_FOUND}`);
});

t('the skip link is the ONE fragment left alone, because it targets this document', () => {
  // `#main` is not a homepage section — it is the 404 document's own <main>.
  // Rewriting it to /#main the way `#how` is rewritten would send a keyboard
  // reader to the homepage instead of past the masthead.
  assert.ok(notFoundHtml().includes('href="#main"'), `${NOT_FOUND}: the skip link was rewritten`);
});

/* ===========================================================================
   5. THE RULE TABLE THIS CHANGE MUST NOT DISTURB
   ======================================================================== */

/**
 * Parse `_redirects` the way Pages documents it: comments at column 0, and
 * otherwise `from  to  status` separated by whitespace. Read from `dist`, not
 * from `public`, because `dist/_redirects` is the copy that is uploaded.
 */
const redirectRules = () =>
  readFileSync(path.join(SITE, '_redirects'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      const [from, to, status] = line.split(/\s+/);
      return { line, from, to, status };
    });

t('every redirect rule is well formed, and none of them is a catch-all', () => {
  const rules = redirectRules();

  // NON-VACUITY, and a count with a reason: /risks plus the seven pages the v3
  // brief of 2026-09-05 retired. A file that parsed to nothing would pass every
  // assertion in the loop below.
  assert.equal(rules.length, 8, `expected 8 redirect rules, parsed ${rules.length}`);

  for (const { line, from, to, status } of rules) {
    assert.ok(from.startsWith('/'), `rule source is not a path: ${line}`);
    assert.match(status, /^30[128]$/, `rule has no usable status: ${line}`);
    assert.ok(to.startsWith('/'), `rule destination is not a path: ${line}`);

    // A SOURCE CONTAINING `*` IS THE THING TO REFUSE. `_redirects` matches on
    // path only, so a catch-all here sits in front of /assets/ and /media/ and
    // can shadow the hashed bundles the pages load — and unlike everything
    // else in this file, its effect cannot be checked anywhere in this
    // repository. The 404 document is the one mechanism; see this file's
    // header.
    assert.ok(
      !from.includes('*'),
      `rule source is a wildcard: ${line}\n` +
        'Unmatched paths are handled by dist/404.html, not by a catch-all rule. A wildcard\n' +
        'source here can shadow /assets/ and /media/, and nothing in this repository can test\n' +
        'that it does not.',
    );
  }
});

t('every redirect lands somewhere that exists', () => {
  for (const { line, to } of redirectRules()) {
    if (to === '/') continue; // the homepage, which index.html is
    // Destinations are written extensionless, the form Pages serves.
    const file = `${to.replace(/^\//, '')}.html`;
    assert.ok(
      PAGES.includes(file) && existsSync(path.join(SITE, file)),
      `redirect points at a page that is not in the build: ${line} -> ${file}`,
    );
  }
});
