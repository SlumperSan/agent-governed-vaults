/**
 * `docs/DISCLAIMERS.md` IS THE REPOSITORY'S ONE DISCLAIMER DOCUMENT, AND IT MAY NOT DRIFT FROM THE SITE.
 *
 * Owner decision, 2026-09-05: every GitHub-surface disclaimer lives in one document, linked once
 * from `README.md` and `llms.txt`, "like how we have it for the website". The website's disclaimers
 * are `apps/site/src/disclaimers-copy.ts`, and they are the reviewed text. So this file does not
 * carry a second, independently written set of warnings. It quotes the site's standing paragraphs
 * VERBATIM and indexes the site's risk register by heading, and this test fails the moment either
 * side changes without the other.
 *
 * Every extraction below THROWS on zero matches. A regex that silently stops matching the TS source
 * would otherwise make every comparison vacuous and the test green over nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');

const SITE = read('apps/site/src/disclaimers-copy.ts');
const DOC = read('docs/DISCLAIMERS.md');

/** A double-quoted string property of the HERO object, e.g. `bannerOffer: "..."`. */
const heroString = (key) => {
  const m = SITE.match(new RegExp(`\\b${key}:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) throw new Error(`disclaimers-copy.ts: HERO.${key} not found — the extractor no longer matches the source`);
  return m[1];
};

/**
 * Each register entry as "Title — severity label". The label is part of the index, not decoration:
 * on 2026-09-24 r5's label changed from "Handled in code, never exercised" to "Exempted on Arc,
 * fails open" and a headings-only comparison stayed green over the stale label.
 */
const registerEntries = () => {
  const e = [...SITE.matchAll(/"severityLabel":\s*"([^"]+)",\s*"heading":\s*"\d+\.\s*([^"]+)"/g)]
    .map((m) => `${m[2]} — ${m[1]}`);
  if (e.length === 0) throw new Error('disclaimers-copy.ts: no register entries parsed');
  return e;
};

/** The numbered list under the doc's register heading, in order, as "Title — label". */
const docRegister = () => {
  const section = DOC.split(/^## The risk register\s*$/m)[1];
  if (section === undefined) throw new Error('docs/DISCLAIMERS.md: no "## The risk register" section');
  const items = [...section.split(/^## /m)[0].matchAll(/^\d+\. \*\*(.+?)\*\* — (.+?)\.$/gm)]
    .map((m) => `${m[1]} — ${m[2]}`);
  if (items.length === 0) throw new Error('docs/DISCLAIMERS.md: the risk register section lists nothing');
  return items;
};

test('the doc quotes the site\'s standing disclaimers verbatim', () => {
  for (const key of ['bannerOffer', 'totalLossParagraph', 'jurisdictionParagraph']) {
    const text = heroString(key);
    assert.ok(DOC.includes(text), `docs/DISCLAIMERS.md must carry HERO.${key} verbatim:\n  ${text}`);
  }
});

test('the doc indexes every entry of the site\'s risk register, in order, by exact heading and severity label', () => {
  // The site heading is "N. Title" with a severityLabel; the doc lists it as "N. **Title** — label."
  assert.deepEqual(docRegister(), registerEntries());
});

test('the doc is linked from README.md and from both llms.txt copies, once each', () => {
  for (const p of ['README.md', 'llms.txt', 'apps/site/public/llms.txt']) {
    // Counts markdown link TARGETS, so a link whose visible text is also the path counts once.
    const n = read(p).split('](docs/DISCLAIMERS.md)').length - 1;
    assert.equal(n, 1, `${p} must link docs/DISCLAIMERS.md exactly once (found ${n})`);
  }
});
