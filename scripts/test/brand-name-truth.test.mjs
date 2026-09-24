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
 * WHAT THIS DOES **NOT** COVER, stated so the green is not over-read: the DRAWN letterforms. A
 * traced logo's casing lives in its vector paths, not in text, and this guard reads only text.
 * The site's traced wordmark, lockup and comic mark drew "Rwally" and were referenced by nothing;
 * they were deleted on 2026-09-23 rather than redrawn, because pictorial marks and letterforms are
 * banned (Design/mark-elimination-record-2026-09-18). The same comic artwork survives only in
 * `apps/app`, which is retiring into `apps/vaults-ui` and is not what app.rwally.com serves. This
 * guard is about the string, and nothing here should be taken as evidence about the picture.
 *
 * SECOND GUARD, ADDED 2026-09-21: the SVG allowlist above is an ADJACENT property, not the whole
 * one. It caught a retired name ("Vault Atlas") in a favicon's `aria-label` while the SAME string
 * sat live in `apps/vaults-ui/index.html`'s `<title>` and `src/App.tsx`'s masthead `<h1>` —
 * unlabelled SVG attributes, not member-facing markup text, so the first guard never looked there.
 * `app.rwally.com` served that `<title>`/`<h1>` to every visitor; the SVG guard was fully green
 * throughout.
 *
 * Enumerated from `git ls-files -- apps/vaults-ui` for the same reason as `trackedSvgs()` above —
 * a hand-named list of files stops covering things the moment somebody adds one, and this repo has
 * shipped that exact defect twice (#349, #351).
 *
 * WHAT THIS SECOND GUARD DOES **NOT** COVER: headings whose text is a JS expression rather than a
 * literal string (`<h2>{vault.name || ...}</h2>`, `<h2>Proposal #{p.pid}</h2>` in App.tsx and
 * ProposalPanel.tsx) — regexing rendered output would need an actual render, which this file does
 * not do. Those are unchecked, not confirmed clean. It also only walks `apps/vaults-ui`, matching
 * this task's scope — `apps/web` and the docs under `docs/design/` still name "Vault Atlas" and are
 * an open, separately-carded item, not a regression this guard is meant to catch.
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

/** Retired product names that must never reach member-facing markup again. */
const RETIRED_NAMES = ['Vault Atlas'];

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

  // THE FLOOR IS A WALK CHECK, NOT A QUOTA. Six SVGs carried a label when this was written; on
  // 2026-09-23 three of them — the site's traced wordmark, lockup and comic mark — were deleted as
  // retired, unreferenced artwork (see the header), leaving four: two favicons in apps/app and
  // apps/site, the vaults-ui favicon, and apps/app's comic mark. Lower it again only by deleting an
  // SVG, and say which.
  assert.ok(
    labelled.length >= 4,
    `only ${labelled.length} SVG(s) carry an aria-label — four did after the 2026-09-23 deletions, so ` +
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

/**
 * Every tracked `.html` and `.tsx` file under `apps/vaults-ui`, enumerated from git rather than
 * named by hand — see the file header for why a typed list is the defect this repo has shipped
 * twice.
 */
function vaultsUiTextFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'apps/vaults-ui'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const files = out.split('\0').filter(Boolean);
  assert.ok(
    files.length > 0,
    'git ls-files returned nothing under apps/vaults-ui — the walk is broken, not clean',
  );
  return files.filter((f) => /\.(html|tsx)$/.test(f));
}

test('apps/vaults-ui titles and headings do not carry a retired product name', () => {
  // <title> and <h1>-<h6> with a plain-text child only — no JS expression inside, see the file
  // header's WHAT THIS SECOND GUARD DOES NOT COVER.
  const TAG = /<(title|h[1-6])(?:\s[^>]*)?>([^<{]*)<\/\1>/g;

  const checked = [];
  const wrong = [];

  for (const rel of vaultsUiTextFiles()) {
    const src = readFileSync(path.join(REPO, rel), 'utf8');
    for (const m of src.matchAll(TAG)) {
      checked.push(rel);
      const text = m[2];
      for (const retired of RETIRED_NAMES) {
        if (text.includes(retired)) {
          wrong.push(`${rel} carries "${retired}" in <${m[1]}>${text}</${m[1]}>`);
        }
      }
    }
  }

  assert.ok(
    checked.length >= 4,
    `only ${checked.length} static <title>/<h#> match(es) found under apps/vaults-ui — at least 4 ` +
      '(index.html, public/404.html, App.tsx\'s masthead, plus a component heading) existed when ' +
      'this guard was written, so either the markup changed shape or the walk stopped working',
  );
  assert.deepEqual(
    wrong,
    [],
    `a retired product name shipped to a member-facing tab title or heading:\n  ${wrong.join('\n  ')}`,
  );
});

test('mutation: the vaults-ui text guard fails on the string that actually shipped', () => {
  // "Not found — Vault Atlas" is what apps/vaults-ui/public/404.html's <title> carried. If this
  // substring check ever reads as false, the test above is asserting nothing.
  assert.ok('Not found — Vault Atlas'.includes(RETIRED_NAMES[0]));
  assert.ok(!'RWAlly'.includes(RETIRED_NAMES[0]));
});
