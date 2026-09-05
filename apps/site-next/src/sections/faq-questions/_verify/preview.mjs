/**
 * Transient. Assembles a look-at-able faq.html inside this directory, so the
 * section can be seen in the real shell before src/pages/FaqPage.tsx lands.
 *
 * Takes the built dist/faq.html (which carries the banner, masthead and footer
 * and nothing else), splices this section's rendered markup into <main>, links
 * a stylesheet, and drops the hydration script — with no FaqPage on the client,
 * hydrating would replace the spliced markup with the shell-only tree.
 *
 * THE STYLESHEET. An SSR build keeps only the CSS-module class-name map, so
 * there is no emitted stylesheet to copy. The harness exports that map, and the
 * source .module.css is rewritten through it — every local selector replaced by
 * the generated name that is actually in the markup. Nothing is guessed, and a
 * class in the markup with no rule behind it is an error rather than a silently
 * unstyled block.
 *
 * Run AFTER verify.mjs, from apps/site-next:
 *   node src/sections/faq-questions/_verify/preview.mjs
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..'); // apps/site-next
const DIST = path.join(ROOT, 'dist');
const LIVE = path.join(HERE, 'live');

if (!existsSync(path.join(HERE, 'section.html'))) throw new Error('run verify.mjs first');

const { classMap } = await import(pathToFileURL(path.join(HERE, 'build', 'harness.js')).href);

let css = readFileSync(path.join(HERE, '..', 'FaqQuestions.module.css'), 'utf8');
for (const [local, generated] of Object.entries(classMap)) {
  css = css.split(`.${local}`).join(`.${generated}`);
}

mkdirSync(LIVE, { recursive: true });
cpSync(path.join(DIST, 'assets'), path.join(LIVE, 'assets'), { recursive: true });
writeFileSync(path.join(LIVE, 'assets', 'faq-questions.css'), css, 'utf8');

const section = readFileSync(path.join(HERE, 'section.html'), 'utf8');

// Every class in the markup must have a rule behind it, or the preview shows
// unstyled copy and says nothing about the design.
const used = new Set([...section.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
for (const cls of used) {
  if (cls === 'wrap') continue; // global, from src/index.css
  if (!css.includes(`.${cls}`)) throw new Error(`class ${cls} is in the markup but not in the stylesheet`);
}

let html = readFileSync(path.join(DIST, 'faq.html'), 'utf8');
html = html
  .replace(/<script\b[^>]*><\/script>/g, '')
  .replace(/\/assets\//g, 'assets/')
  .replace('</head>', '<link rel="stylesheet" href="assets/faq-questions.css">\n</head>')
  .replace('</main>', `${section}</main>`);

writeFileSync(path.join(LIVE, 'faq.html'), html, 'utf8');
console.log(`classes styled: ${[...used].length}`);
console.log(`wrote ${path.join(LIVE, 'faq.html')}`);
