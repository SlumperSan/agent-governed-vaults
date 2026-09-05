#!/usr/bin/env node
// @ts-check
/**
 * Regenerate apps/site/assets/og-card.png — the 1200x630 link-preview card.
 *
 * WHY THIS FILE EXISTS AT ALL. Until 2026-09-05 the card had NO generator in the repository: it was
 * a committed binary whose strapline ("Immutable index vaults on Base.  Not deployed.") existed
 * nowhere else, so it was the one claim on this site that no guard could read and no copy edit could
 * reach. When the owner directed the Base launch language removed, the card had to be rebuilt from
 * scratch because there was nothing to re-run. That is the failure this script closes: the card's
 * words now live in source, next to the pages that quote them.
 *
 * WHY HEADLESS CHROME rather than a canvas or SVG library. The site takes no dependency it does not
 * need, and this needs none: the card is a plain HTML document rendered at exactly 1200x630 by the
 * browser that is already on the machine. No npm package, no font download, no build step in CI.
 *
 * The card is deliberately drawn from the same tokens as the site — --ground #f2f2f7, --ink
 * #17171f, --muted #5f5f72, --line #dbdbe6, --accent #5a4ce0, and the --display / --sans system
 * stacks — so a token change is a one-line change here too rather than a redesign.
 *
 * Run:  node scripts/build-og-card.mjs
 * Then: git add apps/site/assets/og-card.png   (the PNG is committed; this script is not run in CI)
 *
 * Every alt text on the site describes this image. There are eight of them, one per page, and they
 * must be re-read whenever the strapline below changes.
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

/** The two halves of the status line. The muted half states the target, the ink half the status. */
const STRAPLINE_TARGET = 'Built for Robinhood Chain.';
const STRAPLINE_STATUS = 'Not deployed.';

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
    background: #f2f2f7;
    font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; justify-content: center;
    padding: 0 92px; box-sizing: border-box;
  }
  .mark {
    width: 88px; height: 88px; border-radius: 20px; background: #5a4ce0;
    display: flex; align-items: center; justify-content: center; margin-bottom: 76px;
  }
  .mark span { width: 48px; height: 48px; border-radius: 50%; border: 13px solid #fff; box-sizing: border-box; }
  h1 {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 78px; line-height: 1.05; font-weight: 700; letter-spacing: -0.015em;
    color: #17171f; margin: 0 0 42px;
  }
  hr { border: 0; border-top: 1px solid #dbdbe6; margin: 0 0 44px; }
  .strap { font-size: 29px; line-height: 1.3; color: #5f5f72; margin: 0 0 44px; }
  .strap strong { color: #17171f; font-weight: 600; margin-left: 14px; }
  .host { font-size: 23px; color: #6b6b80; margin: 0; }
</style></head><body>
  <div class="mark"><span></span></div>
  <h1>Agent-Governed Vaults</h1>
  <hr>
  <p class="strap">${STRAPLINE_TARGET}<strong>${STRAPLINE_STATUS}</strong></p>
  <p class="host">rwally.com</p>
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
  console.log(`strapline: "${STRAPLINE_TARGET}  ${STRAPLINE_STATUS}"`);
  console.log('re-check the eight og:image:alt attributes if that strapline changed.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
