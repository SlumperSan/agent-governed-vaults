// @ts-check
/**
 * No redirect rule may shadow a live page.
 *
 * WHY THIS EXISTS. `public/_redirects` carried `/how-it-works  /  301` from the 2026-09-05 collapse to
 * one scroll page. The site was later rebuilt to five pages and `how-it-works.html` came back — in
 * `src/pages.ts`, in the nav, behind the homepage's "How it works" button — but the rule stayed. Pages
 * applies `_redirects` before serving, so the page was unreachable in production: the nav link bounced
 * every reader to `/`. Every build, test and gate stayed green, because none of them serve through
 * this file. It was found only by fetching the live site after a deploy.
 *
 * WHAT IT CHECKS. Every redirect SOURCE in `_redirects` against every page this site builds, read
 * from `src/pages.ts` — the same declaration the prerender and every other site test derive from, so
 * a new page is covered on the day it is added rather than on the day someone remembers this file.
 *
 * Pages serves extension-less URLs (`/about.html` 308s to `/about`), so a page `about.html` is live at
 * `/about`, and `/about` is the source form that would shadow it. `index.html` is live at `/`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The URL path each built page is served at. */
const livePaths = () => {
  const src = readFileSync(path.join(APP, 'src', 'pages.ts'), 'utf8');
  const ids = [...src.matchAll(/'([a-z0-9-]+)\.html'/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, 'no pages parsed out of src/pages.ts — the declaration moved, so nothing is being checked');
  return new Set(ids.map((id) => (id === 'index' ? '/' : `/${id}`)));
};

/** Every rule's source column. Comments and blank lines are not rules. */
const redirectSources = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)[0]);

test('no _redirects rule shadows a page this site builds', () => {
  const pages = livePaths();
  const sources = redirectSources(readFileSync(path.join(APP, 'public', '_redirects'), 'utf8'));
  assert.ok(sources.length > 0, 'no redirect rules parsed — the file moved or its format changed, so nothing is being checked');
  const shadowed = sources.filter((s) => pages.has(s.replace(/\.html$/, '')));
  assert.deepEqual(
    shadowed,
    [],
    `these _redirects sources are live pages, so Pages redirects them away before they are ever served: ${shadowed.join(', ')}. `
      + 'Delete the rule, or retire the page from src/pages.ts — not both kept.',
  );
});

test('probe: the check reds on the exact rule that shipped', () => {
  // Non-vacuity. On a clean tree the test above passes identically with a filter that matches nothing.
  const shadowed = redirectSources('# retired\n/how-it-works   /   301\n/agents  /  301\n')
    .filter((s) => livePaths().has(s));
  assert.deepEqual(shadowed, ['/how-it-works'], 'the shadow check no longer catches /how-it-works shadowing a live page');
});
