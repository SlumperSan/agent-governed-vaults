/**
 * Every shipped brand SVG announces the brand's actual name.
 *
 * `aria-label` on a `role="img"` element is the ACCESSIBLE NAME — the string a screen reader
 * speaks in place of the artwork. It is text, and it is the only part of a logo a machine reads.
 * On 2026-09-19 six shipped SVGs across two apps announced **"Rwally"**: the favicon, the lockup,
 * the wordmark and the comic mark, in both `apps/site` and `apps/app`.
 *
 * THE CAPITALS CARRY THE WHOLE NAME. RWA is real-world assets, and RWAlly reads as "rally".
 * Lowercasing the W and the A loses both at once, which is the entire point of the word.
 *
 * WHY IT WALKS THE TREE INSTEAD OF LISTING PATHS. The first version of this check lived in
 * `apps/site/test/` and named four files. It covered four of the six, because the other two are
 * under `apps/app`, which that suite cannot see — so the fix shipped with a guard over two thirds
 * of it. A typed list of paths is a guard that stops covering things the moment somebody adds one.
 * This enumerates from git, so a seventh SVG is covered on the commit that adds it.
 *
 * WHAT THIS DOES **NOT** COVER, stated so the green is not over-read: the DRAWN letterforms. The
 * casing in `rwally-wordmark.svg` lives in its vector paths and still reads "Rwally"; correcting
 * that means redrawing the artwork, which is held behind an open owner decision about whether
 * letterforms may be used at all. This guard is about the string, and nothing here should be taken
 * as evidence about the picture.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));

/** The canonical spelling. RWA capitalised, the rest lowercase. */
const BRAND = 'RWAlly';

function trackedSvgs() {
  const out = execFileSync('git', ['ls-files', '-z', '--', '*.svg'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = out.split('\0').filter(Boolean);
  // A REFUSAL, NOT A SKIP. If git returns nothing the walk found nothing to check, and a guard
  // that reports success over an empty set is the shape this repository has already found four of.
  assert.ok(files.length > 0, 'git ls-files returned no SVG at all — the walk is broken, not clean');
  return files;
}

test('every tracked SVG that names itself announces RWAlly', () => {
  const labelled = [];
  const wrong = [];

  for (const rel of trackedSvgs()) {
    const svg = readFileSync(path.join(REPO, rel), 'utf8');
    const m = /\saria-label="([^"]*)"/.exec(svg);
    if (!m) continue;
    labelled.push(rel);
    // Case-sensitive on purpose: "Rwally" and "RWALLY" are both wrong, and both would pass a
    // case-insensitive compare.
    if (m[1] !== BRAND) wrong.push(`${rel} announces "${m[1]}"`);
  }

  assert.ok(
    labelled.length >= 6,
    `only ${labelled.length} SVG(s) carry an aria-label — six did when this guard was written, so ` +
      'either labels were removed (an accessibility regression of its own) or the walk stopped working',
  );
  assert.deepEqual(wrong, [], `the capitals are RWA, real-world assets:\n  ${wrong.join('\n  ')}`);
});

test('an SVG that presents itself as an image is not left unnamed', () => {
  // role="img" with no accessible name is announced as "image" or skipped entirely. This is the
  // reason the label exists at all, and it is asserted so a future edit cannot "fix" a wrong name
  // by deleting it.
  const unnamed = trackedSvgs().filter((rel) => {
    const svg = readFileSync(path.join(REPO, rel), 'utf8');
    return /role="img"/.test(svg) && !/\saria-label="/.test(svg);
  });
  assert.deepEqual(unnamed, [], 'role="img" with no aria-label announces nothing useful');
});

test('mutation: the check fails on the string that actually shipped', () => {
  // "Rwally" is what six files carried. If this compare ever reads as equal, the test above is
  // asserting nothing.
  assert.notEqual('Rwally', BRAND);
  assert.notEqual('RWALLY', BRAND);
  assert.notEqual('rwally', BRAND);
});
