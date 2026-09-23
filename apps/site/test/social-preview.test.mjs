/**
 * A shared link to this site has a preview image and a tab icon, and the icon is not the retired
 * comic mark's wrong casing baked into pixels.
 *
 * WHY THIS IS A TEST. Until 2026-09-21, `apps/site` had NO `og:image` tag anywhere and NO
 * `<link rel="icon">` anywhere, on any page. `og-card.png` and `favicon.svg` were both built,
 * committed, and never linked — every shared link rendered with no preview image, silently, and
 * `favicon.ico` still shipped the retired comic mark, which spells the brand "Rwally" in its drawn
 * vector paths even though its `aria-label` (fixed by #319) correctly says "RWAlly". Nothing in this
 * repository guarded a tag's ABSENCE the way `scripts/test/claims-lede-truth.test.mjs` guards a
 * false claim's PRESENCE — a page with no og:image tag at all passed every existing check.
 *
 * IT READS `dist/`, NOT THE SOURCE, same reason `site.test.mjs` does: a build step can silently drop
 * a tag from the prerendered output even when the source `.html` template carries it.
 * `npm run build --workspace apps/site` must run first — `scripts/gate.mjs` orders it that way.
 *
 * PAGE LIST FROM `src/pages.ts`, not repeated here — same convention as `site.test.mjs`, for the
 * same reason: a page added there is covered here the same day. `404.html` is excluded: it is
 * `noindex` and nothing navigates to it, so it carries the icon but not a social-preview image.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(APP, 'dist');
const PUBLIC = path.join(APP, 'public');

before(() => {
  assert.ok(
    existsSync(path.join(DIST, 'index.html')),
    'dist/index.html is missing — run `npm run build --workspace apps/site` first',
  );
});

const PAGE_IDS = [...readFileSync(path.join(APP, 'src', 'pages.ts'), 'utf8').matchAll(/'([a-z0-9-]+\.html)'/g)]
  .map((m) => m[1])
  .filter((id) => id !== '404.html');

/**
 * THE WORDS THE CARD ACTUALLY DRAWS, read out of the generator that draws them.
 *
 * `og:image:alt` describes an image whose text lives in `scripts/build-og-card.mjs`. Asserting the
 * attribute is merely NON-EMPTY leaves the two pinned to each other by eye — change `STRAPLINE`
 * there and five alt attributes keep describing a card that no longer exists, on the surface read
 * by exactly the people who cannot see the image. That drift is invisible to every other guard.
 *
 * READ BY REGEX RATHER THAN IMPORTED, deliberately: `build-og-card.mjs` executes at module top
 * level — it launches headless Chrome and writes the PNG — so importing it from a test would run a
 * browser. Parsing its source keeps the single source of truth without the side effect.
 *
 * A FAILED PARSE THROWS. If either constant is renamed or reshaped this must go red, never quietly
 * skip the comparison: a guard that cannot find what it compares against has stopped comparing.
 */
const cardWords = () => {
  const src = readFileSync(path.join(path.dirname(path.dirname(APP)), 'scripts', 'build-og-card.mjs'), 'utf8');
  const wordmark = /^const WORDMARK = '([^']+)';$/m.exec(src);
  const strapline = /^const STRAPLINE = '([^']+)';$/m.exec(src);
  assert.ok(
    wordmark && strapline,
    'could not parse WORDMARK/STRAPLINE out of scripts/build-og-card.mjs — the declarations moved, '
      + 'so the alt text can no longer be checked against the words the card draws. Fix the parse; '
      + 'do not delete the check.',
  );
  return `${wordmark[1]} — ${strapline[1]}`;
};

test('every real page links the favicon, both forms', () => {
  assert.ok(PAGE_IDS.length > 0, 'no pages found in src/pages.ts — the derivation is broken');
  for (const page of [...PAGE_IDS, '404.html']) {
    const html = readFileSync(path.join(DIST, page), 'utf8');
    assert.match(
      html,
      /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"\s*\/?>/,
      `${page}: no SVG icon link`,
    );
    assert.match(
      html,
      /<link rel="alternate icon" href="\/favicon\.ico"\s*\/?>/,
      `${page}: no .ico fallback link, so a browser or crawler that ignores <link rel="icon"> gets nothing`,
    );
  }
});

test('every real page carries an og:image, sized and described, plus a twitter:image', () => {
  for (const page of PAGE_IDS) {
    const html = readFileSync(path.join(DIST, page), 'utf8');
    const img = /<meta property="og:image" content="(https:\/\/rwally\.com\/og-card\.png)"\s*\/?>/.exec(html);
    assert.ok(img, `${page}: no og:image tag`);
    assert.match(html, /<meta property="og:image:width" content="1200"\s*\/?>/, `${page}: og:image:width missing or wrong`);
    assert.match(html, /<meta property="og:image:height" content="630"\s*\/?>/, `${page}: og:image:height missing or wrong`);
    const alt = /<meta property="og:image:alt" content="([^"]+)"\s*\/?>/.exec(html);
    assert.ok(alt, `${page}: og:image:alt missing`);
    // Equality, not non-emptiness — see `cardWords` above. This is what makes changing the card's
    // words a two-file commit the gate enforces, rather than one kept in step by eye.
    assert.equal(
      alt[1],
      cardWords(),
      `${page}: og:image:alt describes different words than the card draws. Update this attribute `
        + 'on every page, or change the card back — a shared link that names a strapline the image '
        + 'does not show misleads the readers who cannot see it.',
    );
    assert.match(
      html,
      new RegExp(`<meta name="twitter:image" content="${img[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\s*/?>`),
      `${page}: twitter:image missing or does not match og:image`,
    );
  }
});

test('404.html carries no social-preview image — it is noindex and nothing shares it', () => {
  const html = readFileSync(path.join(DIST, '404.html'), 'utf8');
  assert.doesNotMatch(html, /og:image/, '404.html now carries og:image — was that deliberate?');
});

test('favicon.ico and og-card.png actually reached dist/, not just public/', () => {
  for (const name of ['favicon.svg', 'favicon.ico', 'og-card.png']) {
    const p = path.join(DIST, name);
    assert.ok(existsSync(p), `dist/${name} missing — public/ did not copy through the build`);
    assert.ok(readFileSync(p).length > 0, `dist/${name} is empty`);
  }
});

test('og-card.png is actually 1200x630 — the claim in the meta tags, verified against the file', () => {
  // PNG signature (8 bytes) + IHDR chunk length (4) + "IHDR" (4) = 16 bytes in, then width (4 BE)
  // and height (4 BE). Reading the real header rather than trusting the meta tags' own numbers is
  // the whole point: those numbers could be wrong even when the tags are present.
  const buf = readFileSync(path.join(DIST, 'og-card.png'));
  assert.equal(buf.toString('ascii', 12, 16), 'IHDR', 'og-card.png has no IHDR chunk where expected — not a valid PNG');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  assert.equal(width, 1200, `og-card.png is ${width}px wide, the meta tags claim 1200`);
  assert.equal(height, 630, `og-card.png is ${height}px tall, the meta tags claim 630`);
});

test('favicon.svg is a geometric mark, not the retired comic illustration', () => {
  // WHY THIS CHECKS SHAPE, NOT TEXT. The retired comic mark's `aria-label` was already fixed to say
  // "RWAlly" by #319 — that string is correct and this test must not flag it. What was still wrong
  // is that the DRAWN PATHS spelled the word visually, in coordinate geometry a grep can never read:
  // `d="M216.00 349.42 L207.50 349.75 ..."` contains no letters as text, only numbers that render as
  // letter-shaped strokes. So "no letterforms" is not a string this file can assert — the honest,
  // checkable proxy is COMPLEXITY: an illustrated word needs dozens of `<path>` elements with
  // hundreds of coordinate pairs each (the retired file had four, one per fill colour, each with a
  // `d` attribute several kilobytes long); the current non-pictorial mark
  // (`apps/vaults-ui/src/chrome.css`'s `.brand-mark`, matched here) is two shapes: a background rect
  // and one rounded-square fill. A <text> element would be the same category of regression even
  // though it never existed here.
  const svg = readFileSync(path.join(PUBLIC, 'favicon.svg'), 'utf8');
  assert.doesNotMatch(svg, /<text\b/, 'favicon.svg now contains a <text> element');
  const pathCount = (svg.match(/<path\b/g) ?? []).length;
  assert.ok(pathCount <= 2, `favicon.svg has ${pathCount} <path> elements — looks like illustration, not the geometric mark`);
  const totalPathDataLength = [...svg.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].reduce((n, m) => n + m[1].length, 0);
  assert.ok(
    totalPathDataLength < 500,
    `favicon.svg's <path> d= data totals ${totalPathDataLength} chars — the retired comic mark's four paths totalled over 20,000`,
  );
});

test('mutation: the shape check fails against the actual retired comic-mark SVG', () => {
  // A real, complete excerpt of the file this replaced (apps/site/public/favicon.svg before this
  // change, first ~100 chars of each of its four real `d=` attributes, verbatim). Its `aria-label`
  // is "RWAlly" here DELIBERATELY, matching what the real prior file actually had post-#319 — this
  // fixture must not claim the old file was wrong about the string it was already right about; it
  // is wrong about the shape underneath, which is what this mutation proves the check catches.
  const oldFavicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" role="img" aria-label="RWAlly">
  <rect width="1024" height="1024" fill="#07070b"/>
  <g transform="translate(-163.27 -330.02) scale(1.7370)">
  <path fill="#0b0b12" fill-rule="evenodd" d="M216.00 349.42 L207.50 349.75 L206.25 351.00 L206.25 619.50 L206.88 620.50 L216.00 620.75 L217.50 620.25 L224.00 620.25 L228.00 620.75 L229.50 620.25 L256.00 620.25 L257.50 620.75 L297.00 620.75 L299.00 620.25 L300.50 620.75 L348.00 620.75 L351.00 620.25 L355.00 620.75 L356.50 620.25 Z"/>
  <path fill="#fdf9ef" fill-rule="evenodd" d="M213.50 350.42 L208.00 350.75 L207.25 351.50 L207.25 619.00 L207.62 619.50 L361.00 619.58 L361.75 618.50 L361.25 582.50 L361.58 581.50 L362.50 580.92 L394.25 619.00 L395.50 619.75 L567.50 619.75 L570.00 619.25 Z"/>
  <path fill="#7b6fbd" fill-rule="evenodd" d="M328.00 376.42 L283.50 376.75 L282.75 377.00 L282.75 377.50 L297.50 377.75 L306.50 378.75 L319.50 378.75 L321.00 379.25 L325.50 378.75 L328.50 380.25 L335.00 380.25 L335.75 381.00 L335.00 382.25 Z"/>
  <path fill="#51497c" fill-rule="evenodd" d="M242.00 377.42 L234.00 377.58 L233.25 378.00 L233.25 378.50 L234.00 378.75 L298.25 378.50 L298.25 378.00 L297.50 377.75 L292.50 377.58 L242.00 377.42 Z"/>
  </g>
</svg>`;
  assert.match(oldFavicon, /aria-label="RWAlly"/, 'the fixture no longer says the label was already correct — fixture is stale');
  const pathCount = (oldFavicon.match(/<path\b/g) ?? []).length;
  assert.ok(pathCount > 2, 'the old-favicon fixture has too few <path> elements — fixture is stale');
  const totalPathDataLength = [...oldFavicon.matchAll(/<path\b[^>]*\bd="([^"]*)"/g)].reduce((n, m) => n + m[1].length, 0);
  assert.ok(totalPathDataLength >= 500, 'the old-favicon fixture no longer trips the path-data-length check — fixture is stale');
});

test('mutation: these checks fail against the pre-fix pages, which had none of this', () => {
  const preFixHead = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>RWAlly — the AI agent trading index</title>
    <meta name="theme-color" content="#05060a" />
    <meta property="og:title" content="RWAlly — the AI agent trading index" />
    <meta property="og:type" content="website" />
    <meta name="twitter:card" content="summary_large_image" />
  </head>
  <body></body>
</html>`;
  assert.doesNotMatch(
    preFixHead,
    /<link rel="icon" href="\/favicon\.svg"/,
    'the pre-fix fixture unexpectedly has an icon link — fixture is stale',
  );
  assert.doesNotMatch(
    preFixHead,
    /og:image/,
    'the pre-fix fixture unexpectedly has og:image — fixture is stale',
  );
});
