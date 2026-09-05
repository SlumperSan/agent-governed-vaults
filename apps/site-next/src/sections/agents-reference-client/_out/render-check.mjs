/**
 * Render this section the way the real build renders it — `renderToString`
 * over an SSR bundle produced by vite — and assert on the markup.
 *
 * WHY THIS AND NOT A SCREENSHOT. `src/pages/AgentsPage.tsx` is Integrate's and
 * does not exist yet, so the section is on no built page; and the Browser pane
 * in this session is at its tab cap with tabs belonging to other sessions.
 * This is the part of the verify loop that can be run today: it proves what
 * the prerenderer would write into `dist/agents.html` for this section — the
 * element order, the class attributes, the two hrefs, and, most importantly,
 * that the pinned sentences arrive as source bytes rather than as escaped
 * entities.
 *
 * IT LEAVES NOTHING BEHIND IN THE SOURCE TREE. The SSR bundle is written to
 * ./ssr-dist and deleted again on the way out. An earlier draft of this script
 * kept a hand-written preview page and its built output under `src/`; a loose
 * `.html` inside the source tree is a file the repository-wide claims walk
 * would pick up, and one that carries neither banner sentence. The check does
 * not need it, so it does not exist.
 *
 * Run: node src/sections/agents-reference-client/_out/render-check.mjs   (from apps/site-next)
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'ssr-dist');

await build({
  configFile: false,
  root: path.join(here, '..'),
  logLevel: 'warn',
  plugins: [react()],
  build: {
    ssr: path.join(here, '..', 'AgentsReferenceClient.tsx'),
    outDir,
    emptyOutDir: true,
  },
});

const mod = await import(pathToFileURL(path.join(outDir, 'AgentsReferenceClient.js')).href);
const html = renderToString(createElement(mod.default));

console.log('--- rendered markup ---');
console.log(html);
console.log('--- end ---\n');

const source = readFileSync(path.resolve(here, '../../../../../site/agents.html'), 'utf8');
const failures = [];

const expect = (label, cond) => {
  console.log((cond ? 'OK   ' : 'FAIL ') + label);
  if (!cond) failures.push(label);
};

/* The four carried strings must appear in the rendered markup as the exact
   bytes the source page carries — not as &#x27; and not as &mdash;. */
for (const [label, re] of [
  ['eyebrow', /<p class="eyebrow">([^<]+)<\/p>/],
  ['heading', /<h2>([^<]+)<\/h2>/],
  ['first paragraph', /<p>([^<]+)<\/p>/],
  ['second paragraph', /<p class="tight">([^<]+)<\/p>/],
]) {
  const start = source.indexOf('<p class="eyebrow">Reference client</p>');
  const section = source.slice(start, source.indexOf('</section>', start));
  const value = section.match(re)[1];
  expect(`${label} renders as source bytes`, html.includes(value));
}

expect('the em dash survived renderToString', html.includes('bugs in it — one gate'));
expect('no escaped em dash', !html.includes('&mdash;'));
expect('exactly one h2', (html.match(/<h2/g) || []).length === 1);
expect('no h1 (the page h1 belongs to the hero)', !/<h1/.test(html));
expect('the landmark is named by its own heading', html.includes('aria-labelledby="reference-client"'));
expect('the heading carries that id', html.includes('id="reference-client"'));
expect('the shell reading column is used as-is', html.includes('class="wrap"'));
expect(
  'document link',
  html.includes(
    'href="https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/REFERENCE-AGENT.md"',
  ),
);
expect('repository link', html.includes('href="https://github.com/SlumperSan/agent-governed-vaults"'));
expect('two links and no more', (html.match(/<a /g) || []).length === 2);
expect('nothing is hidden at rest', !/opacity:\s*0/.test(html) && !/hidden/.test(html));
expect('no inline style attribute (the CSP refuses one)', !/ style="/.test(html));

rmSync(outDir, { recursive: true, force: true });

if (failures.length) {
  console.error('\n' + failures.length + ' FAILURE(S)');
  process.exit(1);
}
console.log('\nall render checks passed');
