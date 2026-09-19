#!/usr/bin/env node
// @ts-check
/**
 * Regenerate apps/site/public/og-card.png — the 1200x630 link-preview card.
 *
 * WHY THIS FILE EXISTS AT ALL. Until 2026-09-05 the card had NO generator in the repository: it was
 * a committed binary whose strapline existed nowhere else, so it was the one claim on this site that
 * no guard could read and no copy edit could reach. When the owner directed the Base launch language
 * removed, the card had to be rebuilt from scratch because there was nothing to re-run. That is the
 * failure this script closes: the card's words now live in source, next to the pages that quote
 * them, and re-rendering is one command rather than a redraw. The deployment rewrite exercised that
 * immediately — the strapline changed again, from a status to a fact, and the card followed.
 *
 * WHY HEADLESS CHROME rather than a canvas or SVG library. The site takes no dependency it does not
 * need, and this needs none: the card is a plain HTML document rendered at exactly 1200x630 by the
 * browser that is already on the machine. No npm package, no font download, no build step in CI.
 *
 * The card is deliberately drawn from the site's own DARK tokens — --bg #070b18, --ink #f2f6ff and
 * --ink-dim #93a3c4, as authored in apps/site/src/tokens.css — so a token change is a one-line
 * change here too rather than a redesign. Dark, and carrying two lines of text and nothing else, is
 * the owner's direction of 2026-09-05; the card that preceded it was light, led with the heading
 * "Agent-Governed Vaults", and closed with a rwally.com host line.
 *
 * THESE VALUES ARE COPIES AND THEY WENT STALE ONCE. Until 2026-09-18 this file carried the previous
 * near-black/violet palette (#0e0e16 / #eaeaf3 / #9393ab) and cited `apps/site/assets/tokens.css`,
 * a path that does not exist — the site was repalette'd to blue and renamed to `src/`, and the card
 * did not follow. A generator whose comment names a file nobody can open is a generator nobody can
 * check. Headless Chrome cannot read a CSS custom property from another package, so these must stay
 * literals; when tokens.css changes, change them here in the same commit.
 *
 * Measured on the values above, this session: --ink on --bg is 18.13:1 and --ink-dim on --bg is
 * 7.73:1. Both clear AA at any size, and the card sets them at 132px and 38px.
 *
 * Run:  node scripts/build-og-card.mjs
 * Then: git add apps/site/public/og-card.png   (the PNG is committed; this script is not run in CI)
 *
 * Every alt text under apps/site describes this image. There are nine of them, one per page, and
 * they must be re-read whenever either constant below changes.
 *
 * apps/site-next NO LONGER EXISTS — it was renamed to apps/site, and this paragraph used to warn
 * about keeping two cards in step. There is one card now, written by this generator, and the alt
 * attributes under apps/site describe it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PATH FIXED 2026-09-18. This wrote to apps/site/assets/, which does not exist — the site's static
// root is public/. The generator therefore CRASHED with ENOENT on every run since the assets/ ->
// public/ move, which is why the committed PNG still carried the previous palette: nobody could
// re-render it. A generator that cannot run is the same as no generator, which is the exact
// failure the header above says this file exists to close.
const OUT = path.join(REPO, 'apps', 'site', 'public', 'og-card.png');

const WIDTH = 1200;
const HEIGHT = 630;

/**
 * EVERY WORD THE CARD CARRIES. Two lines: the wordmark, and the second line. Nothing else is drawn
 * — no glyph, no rule, no host line.
 *
 * NOTHING UNDER apps/site DESCRIBES THIS IMAGE. There is no `og:image` tag and no `og:image:alt`
 * attribute anywhere in the repository; the only two occurrences of that string are in this file,
 * talking about attributes that do not exist. Three paragraphs here used to instruct the reader to
 * keep "the nine `og:image:alt` attributes" in step, and a change was relayed on that basis on
 * 2026-09-18 before anyone grepped for them. Changing the strings below is a ONE-FILE commit.
 *
 * The second line deliberately carries NO DATE and no address. A date baked into a PNG is the one
 * copy no guard can read and no edit can reach, which is the whole reason this generator exists.
 *
 * PREFER POSITIONING OVER STATUS. Every status line this card has carried has gone false: it read
 * `Built for Robinhood Chain.` / `Not deployed.`, then `Deployed on Robinhood Chain.` — and chain
 * 4663 was abandoned on 2026-09-18 with the protocol deployed on no mainnet at all. A share card is
 * the slowest surface to correct, because it is a PNG and a cache. A line that describes what the
 * product IS cannot go stale the way a line about where it runs does.
 *
 * WHAT IT DOES NOT SAY, deliberately: nothing about a vault, and nothing about deployment. The
 * card cannot be re-rendered by the reader who needs a status claim to still be true, so it makes
 * none. The second line is the product's positioning line, which is also what `apps/site` leads
 * with — the two agree because they are the same sentence, not because someone kept them in step.
 */
// RECASED 2026-09-05 by the owner's rename: the site is RWAlly, and the capitals are the joke rather
// than a typo. The card is the last surface the rename could reach, because its wordmark is drawn
// into pixels and no claims guard can read a PNG. That is the whole reason this generator exists —
// a false sentence here survives every check in the repository and ships to every link preview.
const WORDMARK = 'RWAlly';
const STRAPLINE = 'Index funds that argue for themselves.';

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

const card = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; }
  body {
    width: ${WIDTH}px; height: ${HEIGHT}px;
    background: #070b18;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 92px; box-sizing: border-box;
  }
  h1 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 132px; line-height: 1.0; font-weight: 700; letter-spacing: -0.02em;
    color: #f2f6ff; margin: 0 0 40px;
  }
  .strap { font-size: 38px; line-height: 1.3; font-weight: 400; color: #93a3c4; margin: 0; }
</style></head><body>
  <h1>${WORDMARK}</h1>
  <p class="strap">${STRAPLINE}</p>
</body></html>
`;

const work = mkdtempSync(path.join(tmpdir(), 'og-card-'));
try {
  const html = path.join(work, 'card.html');
  writeFileSync(html, card);

  let rendered = null;
  let lastError = null;
  for (const chrome of CHROME_CANDIDATES) {
    try {
      execFileSync(
        /** @type {string} */ (chrome),
        [
          '--headless=new',
          '--disable-gpu',
          '--hide-scrollbars',
          '--force-device-scale-factor=1',
          `--window-size=${WIDTH},${HEIGHT}`,
          `--screenshot=${path.join(work, 'card.png')}`,
          `--user-data-dir=${path.join(work, 'profile')}`,
          html,
        ],
        { stdio: 'ignore', timeout: 120000 },
      );
      rendered = path.join(work, 'card.png');
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!rendered || !readdirSync(work).includes('card.png')) {
    throw new Error(`no usable Chrome found (set CHROME_PATH). Last error: ${lastError}`);
  }

  // Verify the PNG really is 1200x630 before overwriting the committed asset. A silently
  // device-scaled screenshot is the failure mode this catches: it renders fine and is 2400x1260.
  const png = readFileSync(rendered);
  if (png.subarray(1, 4).toString() !== 'PNG') throw new Error('output is not a PNG');
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (w !== WIDTH || h !== HEIGHT) throw new Error(`rendered ${w}x${h}, expected ${WIDTH}x${HEIGHT}`);

  copyFileSync(rendered, OUT);
  console.log(`wrote ${path.relative(REPO, OUT)} — ${w}x${h}, ${png.length} bytes`);
  console.log(`words on the card: "${WORDMARK}" / "${STRAPLINE}"`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
