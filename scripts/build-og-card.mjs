#!/usr/bin/env node
// @ts-check
/**
 * Regenerate apps/site/assets/og-card.png — the 1200x630 link-preview card.
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
 * The card is deliberately drawn from the site's own DARK tokens — --ground #0e0e16, --ink #eaeaf3,
 * --muted #9393ab, and the --display / --sans system stacks (apps/site/assets/tokens.css:83-101) —
 * so a token change is a one-line change here too rather than a redesign. Dark, and carrying two
 * lines of text and nothing else, is the owner's direction of 2026-09-05; the card that preceded it
 * was light, led with the heading "Agent-Governed Vaults", and closed with a rwally.com host line.
 *
 * Run:  node scripts/build-og-card.mjs
 * Then: git add apps/site/assets/og-card.png   (the PNG is committed; this script is not run in CI)
 *
 * Every alt text under apps/site describes this image. There are nine of them, one per page, and
 * they must be re-read whenever either constant below changes.
 *
 * THE ALT ON apps/site-next DESCRIBES A DIFFERENT CARD and must not be kept in step with these two
 * strings. That surface serves its own apps/site-next/public/og-card.png, which draws the brand's
 * comic wordmark rather than set text, and which this generator does not write. Two cards, two alt
 * strings; keeping them identical is what made the site-next one false in the first place.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(REPO, 'apps', 'site', 'assets', 'og-card.png');

const WIDTH = 1200;
const HEIGHT = 630;

/**
 * EVERY WORD THE CARD CARRIES. Two lines: the wordmark, and the status line. Nothing else is drawn
 * (no glyph, no rule, no host line) and the nine `og:image:alt` attributes under apps/site describe
 * exactly these two strings, so anything added here has to be added there in the same commit.
 *
 * The status line deliberately carries NO DATE, and no address either. The deploy date lives in one
 * place a reader can check — `contracts/config/deployments/robinhood-mainnet.json` — and every prose
 * surface that states it substitutes it from there. A date baked into a PNG is the one copy no guard
 * can read and no edit can reach, which is the whole reason this generator exists; putting a date in
 * it would recreate the problem it was written to close.
 *
 * The status line was `Built for Robinhood Chain.` / `Not deployed.` until the deployment, split
 * across a muted lead and an ink emphasis. It is one sentence now because the card is one sentence
 * long: the deployment is the whole claim, and there is no second half to skim past.
 *
 * WHAT IT DOES NOT SAY, deliberately: nothing about a vault. `factory.vaultCount()` was 0 at the
 * record's read block, and a card cannot be re-rendered by the reader who needs that to still be
 * true. "Deployed" is a fact about the singletons and stays true whatever vault #1 does.
 */
// RECASED 2026-09-05 by the owner's rename: the site is RWAlly, and the capitals are the joke rather
// than a typo. The card is the last surface the rename could reach, because its wordmark is drawn
// into pixels and no claims guard can read a PNG. That is the whole reason this generator exists,
// and it is why the rename could not simply edit the nine alt attributes and stop: the words on the
// card and the words describing it move in one commit or they disagree.
const WORDMARK = 'RWAlly';
const STRAPLINE = 'Deployed on Robinhood Chain.';

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
    background: #0e0e16;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 92px; box-sizing: border-box;
  }
  h1 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 132px; line-height: 1.0; font-weight: 700; letter-spacing: -0.02em;
    color: #eaeaf3; margin: 0 0 40px;
  }
  .strap { font-size: 38px; line-height: 1.3; font-weight: 400; color: #9393ab; margin: 0; }
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
  console.log('re-check the nine apps/site og:image:alt attributes if either of those changed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
