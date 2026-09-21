#!/usr/bin/env node
// @ts-check
/**
 * Regenerate apps/site/public/favicon.ico from apps/site/public/favicon.svg.
 *
 * WHY THIS EXISTS. `favicon.ico` is the one asset a browser requests by convention even when no
 * page links it — the auto-probe at the origin root that predates the `<link rel="icon">` tag by
 * decades. So a browser or crawler that ignores `<link>` entirely still gets the OLD FAVICON, no
 * matter how correct the SVG is or how many pages link it. `favicon.svg` is the single source of
 * this icon's design; this script rasterizes it rather than a second, hand-maintained description
 * of the same rounded gradient square drifting from the first.
 *
 * WHY HEADLESS CHROME, SAME PATTERN AS build-og-card.mjs. No npm dependency: the browser already on
 * the machine renders the actual SVG file, at the actual sizes a browser tab needs, so what ships
 * is a screenshot of the real asset rather than a from-scratch reimplementation of its geometry in
 * a second language. See that script's own header for why this repository prefers that over an
 * `ico`-writing npm package for a four-line shape.
 *
 * WHY THIS SCRIPT STILL HAND-WRITES THE .ico CONTAINER. Chrome can rasterize SVG to PNG; it cannot
 * write the ICO format. The container is a 6-byte directory, one 16-byte entry per size, then the
 * raw PNG bytes for each size concatenated — PNG-in-ICO has been valid since Windows Vista and every
 * current browser and OS reads it, so no BMP encoding is needed, only the directory around PNGs
 * Chrome already produced.
 *
 * Run:  node scripts/build-favicon.mjs
 * Then: git add apps/site/public/favicon.ico
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(REPO, 'apps', 'site', 'public', 'favicon.svg');
const OUT = path.join(REPO, 'apps', 'site', 'public', 'favicon.ico');

// Standard favicon sizes: 16 and 32 for the tab, 48 for Windows shortcuts/bookmarks.
const SIZES = [16, 32, 48];

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

if (!/** @type {string} */ (readFileSync(SVG, 'utf8')).includes('<svg')) {
  throw new Error(`build-favicon: ${SVG} does not look like an SVG`);
}

const work = mkdtempSync(path.join(tmpdir(), 'favicon-'));
try {
  // One HTML page per size, the SVG scaled to fill the viewport exactly — a crisp screenshot at
  // that pixel size, not a downscale of one large render, which is what a browser tab actually does
  // with an SVG favicon at each size it needs.
  const svgMarkup = readFileSync(SVG, 'utf8');

  /** @type {Buffer[]} */
  const pngBuffers = [];

  for (const size of SIZES) {
    const html = path.join(work, `f-${size}.html`);
    writeFileSync(
      html,
      `<!doctype html><html><head><meta charset="utf-8"><style>` +
        `html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}` +
        `svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svgMarkup}</body></html>`,
    );
    const pngPath = path.join(work, `f-${size}.png`);

    let rendered = false;
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
            '--default-background-color=00000000',
            `--window-size=${size},${size}`,
            `--screenshot=${pngPath}`,
            `--user-data-dir=${path.join(work, `profile-${size}`)}`,
            html,
          ],
          { stdio: 'ignore', timeout: 60000 },
        );
        rendered = true;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!rendered) {
      throw new Error(
        `build-favicon: no working Chrome found to render ${size}px. Set CHROME_PATH. Last error: ${lastError}`,
      );
    }
    pngBuffers.push(readFileSync(pngPath));
  }

  // ---- Hand-built ICO container: ICONDIR + one ICONDIRENTRY per size + the PNG bytes. ----
  const ICONDIR = Buffer.alloc(6);
  ICONDIR.writeUInt16LE(0, 0); // reserved
  ICONDIR.writeUInt16LE(1, 2); // type: 1 = icon
  ICONDIR.writeUInt16LE(SIZES.length, 4); // image count

  const entries = [];
  let offset = 6 + 16 * SIZES.length;
  for (let i = 0; i < SIZES.length; i++) {
    const size = SIZES[i];
    const png = pngBuffers[i];
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width, 0 means 256
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height, 0 means 256
    entry.writeUInt8(0, 2); // color count (0 = no palette, true color)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8); // size of the PNG data
    entry.writeUInt32LE(offset, 12); // offset of the PNG data from file start
    entries.push(entry);
    offset += png.length;
  }

  const ico = Buffer.concat([ICONDIR, ...entries, ...pngBuffers]);
  writeFileSync(OUT, ico);
  console.log(`build-favicon: wrote ${OUT} (${ico.length} bytes, sizes ${SIZES.join('/')})`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
