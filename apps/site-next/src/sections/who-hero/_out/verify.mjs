/**
 * who-hero — the local proof that this section renders the source bytes.
 *
 * WHY IT EXISTS. `src/pages/WhoItsForPage.tsx` belongs to Integrate and does not
 * exist yet, so `npm run build` writes dist/who-its-for.html with the shell only
 * and this section reaches no built page. That makes "the build is green" a
 * weaker claim than it looks: it proves the section typechecks and compiles, not
 * that its markup is right. This script closes that gap without creating a file
 * outside this directory.
 *
 * WHAT IT DOES. Builds an SSR bundle of WhoHero alone, through vite's
 * programmatic API with an inline config — vite.config.ts is Shell's file and is
 * neither read nor written here — renders it with renderToString, and compares
 * the result against the `.hero--plain` block of apps/site/who-its-for.html.
 *
 * WHAT IT ASSERTS
 *   1. all three lines survive renderToString as the source bytes, including the
 *      straight double-quote pair in the lede that React would otherwise emit as
 *      `&quot;` — the failure this section's <Pinned> usage exists to prevent;
 *   2. exactly one <h1>, carrying the source headline;
 *   3. no banned vocabulary in the rendered markup;
 *
 * Run: node src/sections/who-hero/_out/verify.mjs   (cwd = apps/site-next)
 * Output goes to this directory, which is gitignored build noise wherever the
 * section lands; nothing outside src/sections/who-hero/ is written.
 */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SECTION = path.resolve(HERE, '..');
const SITE_NEXT = path.resolve(SECTION, '..', '..', '..');
const SOURCE_PAGE = path.resolve(SITE_NEXT, '..', 'site', 'who-its-for.html');
const OUT = path.join(HERE, 'ssr');

/** The three lines, taken from the source page rather than retyped. */
function sourceLines() {
  const html = readFileSync(SOURCE_PAGE, 'utf8');
  const block = html.match(/<div class="hero hero--plain">[\s\S]*?\n  <\/div>/);
  if (!block) throw new Error('who-its-for.html: .hero--plain block not found');
  const pick = (re, what) => {
    const m = block[0].match(re);
    if (!m) throw new Error(`who-its-for.html: ${what} not found in .hero--plain`);
    return m[1];
  };
  return {
    eyebrow: pick(/<p class="eyebrow">([\s\S]*?)<\/p>/, 'eyebrow'),
    title: pick(/<h1>([\s\S]*?)<\/h1>/, 'h1'),
    lede: pick(/<p class="lede">([\s\S]*?)<\/p>/, 'lede'),
  };
}

/** The BANNED array of apps/site/test/site.test.mjs, plus the footer-only three. */
const BANNED = [
  /\bAPY\b/i, /\bguarantee(?:s|d|ing)?\b/i, /\brisk-?free\b/i, /\bprojected returns?\b/i,
  /\bexpected returns?\b/i, /\bhigh yield\b/i, /\bzero capital cost\b/i, /\bour fund\b/i,
  /\bwe manage\b/i, /\bpassive income\b/i, /\bwaitlist\b/i, /\bearly access\b/i, /\bcbETH\b/i,
  /\baudit(?:s|ed|or|ors)\b/i, /\bsafe\b/i, /\bguarantees? (?:a|the) return\b/i, /\bAPR\b/,
  /\bROI\b/, /annuali[sz]ed/i, /\btarget return/i, /\bestimated return/i, /\boutperform\w*/i,
  /\balpha\b/i, /\bconnect wallet\b/i, /\bsign up\b/i, /\bget started\b/i, /\bwe run\b/i,
  /\bwe rebalance\b/i, /\byour portfolio\b/i, /\bmanaged\b/i, /\bour vault\b/i,
  /\bairdrop\b/i, /\bpresale\b/i, /\bopen source\b/i,
];

const results = [];
const check = (ok, label) => {
  results.push({ ok, label });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
};

rmSync(OUT, { recursive: true, force: true });

await build({
  root: SITE_NEXT,
  configFile: false,
  logLevel: 'warn',
  plugins: [react()],
  build: {
    ssr: path.join(SECTION, 'WhoHero.tsx'),
    outDir: OUT,
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'WhoHero.js' } },
  },
});

const { default: WhoHero } = await import(pathToFileURL(path.join(OUT, 'WhoHero.js')).href);
const html = renderToString(createElement(WhoHero));
const src = sourceLines();

console.log('\n--- rendered ---\n' + html + '\n----------------\n');

check(html.includes(`>${src.eyebrow}</p>`), `eyebrow verbatim: ${JSON.stringify(src.eyebrow)}`);
check(html.includes(`>${src.title}</h1>`), 'h1 verbatim');
check(html.includes(src.lede), 'lede verbatim, straight quotes unescaped');
check(!html.includes('&quot;'), 'no &quot; in the output — <Pinned> did its job');
check((html.match(/<h1[\s>]/g) ?? []).length === 1, 'exactly one <h1>');
check(!/<canvas|<script/i.test(html), 'no canvas and no script — deep-page hero');
const hits = BANNED.filter((re) => re.test(html));
check(hits.length === 0, `no banned vocabulary${hits.length ? ': ' + hits.join(', ') : ''}`);

rmSync(OUT, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
