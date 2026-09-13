/**
 * risks-review-status — standalone SSR probe.
 *
 * WHY IT IS CHECKED IN RATHER THAN DELETED. Integrate has not landed
 * `src/pages/RisksPage.tsx`, so this section does not reach `dist/risks.html`
 * and `npm run build` prints `risks.html … SHELL ONLY — no page body yet`. A
 * green build therefore proves that the section COMPILES and nothing about
 * what it renders. This file renders it on its own through the project's own
 * toolchain and asserts the markup shape the guards read, so the section stays
 * re-verifiable by whoever composes the page later. Three sibling sections keep
 * a standalone SSR check for the same reason, each naming its own unlanded page
 * in its docstring: `risks-register/__probe.mjs` (RisksPage),
 * `agents-reference-client/_out/render-check.mjs` (AgentsPage) and
 * `who-hero/_out/verify.mjs` (WhoItsForPage). A fourth,
 * `faq-questions/_verify/verify.mjs`, is the same shape but describes itself as
 * transient rather than as standing in for a page.
 *
 * RUN IT from apps/site-next:
 *
 *     node src/sections/risks-review-status/__probe.mjs
 *
 * It exits non-zero and lists every problem; it writes `__probe-out/` (the SSR
 * bundle) and `__preview.html` (a standalone page to look at), both generated
 * and both safely deleted.
 *
 * WHAT IT ACTUALLY DISCRIMINATES. Not "the sentence is somewhere on the page"
 * — `html.includes` would pass that on a paragraph split three ways. The two
 * checks below reimplement the guard's own scoping logic:
 *   - BLOCK scope: `external security review` and `no public report` must sit
 *     inside the same <p>/<dd>/<li> (apps/site/test/site.test.mjs:461-481);
 *   - SENTENCE scope: wherever `remains open at the launch configuration`
 *     appears, `purchasable member count` or `H-8` must be in that same
 *     sentence (apps/site/test/site.test.mjs:763-784).
 * Both citations name their path in full because there are two files called
 * `site.test.mjs` in this repository, and these line numbers resolve only in
 * the one under `apps/site` — the suite covering the site currently served.
 * It also diffs every carried sentence against apps/site/risks.html byte for
 * byte, and the attestation against index.html and faq.html as well — which is
 * the check that catches drift on the two pages this section does not own.
 */
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const OUT = path.join(HERE, '__probe-out');

await build({
  root: ROOT,
  configFile: false,
  logLevel: 'error',
  plugins: [react()],
  build: {
    ssr: true,
    rollupOptions: { input: path.join(HERE, '__probe-entry.tsx') },
    outDir: OUT,
    emptyOutDir: true,
  },
});

const mod = await import(pathToFileURL(path.join(OUT, '__probe-entry.js')).href);
const html = renderToString(createElement(mod.default));

const source = readFileSync(path.resolve(ROOT, '..', 'site', 'risks.html'), 'utf8');
const indexSource = readFileSync(path.resolve(ROOT, '..', 'site', 'index.html'), 'utf8');
const faqSource = readFileSync(path.resolve(ROOT, '..', 'site', 'faq.html'), 'utf8');

const problems = [];
const check = (ok, msg) => {
  if (!ok) problems.push(msg);
};

/* ---- the sentences this section carries, in document order ---------------- */

const ATTESTATION =
  'An external security review was commissioned against the launch tree. The owner attests it returned no major issues. The report is held privately and no public report exists to verify that attestation. Alongside it, four internal adversarial review rounds and an AI pre-audit were run; the AI pre-audit found 41 issues including 5 Critical. All five Criticals are resolved or closed by launch configuration. One High — the purchasable member count below five members — remains open at the launch configuration, and a set of Medium and Low findings are accepted residuals that will not be fixed. A further class is dormant only because sub-vaults are disabled at launch: those are not repaired in code and would return if sub-vaults were ever enabled.';

const LAUNCH_STATUS =
  'Every security gate the team defined is cleared. That still certifies that the gates ran, not that the protocol is secure. One High — the purchasable member count below five members — remains open at the launch configuration and is not classified as a launch blocker.';

const BLOCKERS =
  'The remaining launch blockers are operational rather than security: a soak and a canary re-run. Every security gate the team defined is cleared. That still certifies that the gates ran, not that the protocol is secure. One High — the purchasable member count below five members — remains open at the launch configuration and is not classified as a launch blocker. The launch verdict as at 2026-08-29 is still NO-GO, recorded at <code>protocol/main</code>; check the repository for anything later.';

/**
 * THE PER-CLAIM REVIEW MARKER THIS SECTION CARRIED IS GONE, and the leg that
 * asserted it is inverted rather than deleted. Owner decision, 2026-09-04: the
 * markers are removed from the site entirely, and `test/site.test.mjs` reds on
 * the token anywhere under `src/`, `test/`, `scripts/` or `dist/`.
 *
 * The needle is concatenated rather than written out because this file is
 * itself under `src/` and inside that walk: spelling the token here would take
 * that guard red on this file.
 */
const MARKER_TOKEN = 'COUN' + 'SEL';

const CARRIED = [
  'On the security review',
  'What has and has not been checked.',
  ATTESTATION,
  BLOCKERS,
  'The awkward questions',
  'The mechanism',
  'Read the code yourself',
];

for (const sentence of CARRIED) {
  check(
    html.includes(sentence),
    `rendered markup is missing: ${JSON.stringify(sentence.slice(0, 70))}`,
  );
  check(
    source.includes(sentence),
    `apps/site/risks.html does not carry: ${JSON.stringify(sentence.slice(0, 70))}`,
  );
}

/* ---- the two cross-page passages ----------------------------------------- */

check(html.includes(LAUNCH_STATUS), 'LAUNCH_STATUS is not present unbroken');
check(indexSource.includes(ATTESTATION), 'the attestation is not byte-identical on index.html');
check(faqSource.includes(ATTESTATION), 'the attestation is not byte-identical on faq.html');
check(indexSource.includes(LAUNCH_STATUS), 'LAUNCH_STATUS is not byte-identical on index.html');

/* ---- block scoping: the guard reads the enclosing <p>, not the page ------- */

const blocks = [...html.matchAll(/<(p|dd|dt|li)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]);
const withReview = blocks.filter((b) => /external security review/i.test(b));
check(
  withReview.length === 1,
  `expected 1 block naming the external security review, got ${withReview.length}`,
);
check(
  withReview.every((b) => /no public report/i.test(b)),
  'the "no public report" qualifier is not in the same block as "external security review"',
);

/* ---- sentence scoping: the open High must be named where it is claimed ---- */

const text = html.replace(/<[^>]*>/g, ' ');
for (const sentence of text.split(/(?<=[.!?])\s+/)) {
  if (/remains open at the launch configuration/i.test(sentence)) {
    check(
      /purchasable member count|\bH-8\b/i.test(sentence),
      `claims a High remains open without naming it: ${JSON.stringify(sentence.trim().slice(0, 140))}`,
    );
  }
}

/* ---- structure and banned shapes ----------------------------------------- */

check(
  !html.includes(MARKER_TOKEN),
  'a per-claim review marker is back in the rendered markup; they were removed by owner decision 2026-09-04',
);
check(!/<h1/.test(html), 'this section must not carry an <h1>');
check((html.match(/<h2\b/g) ?? []).length === 1, 'expected exactly one <h2>');
check(
  !/&#x27;|&amp;|&quot;/.test(html),
  'an HTML entity reached the markup where a literal was intended',
);
check(!/all of which are now resolved/i.test(html), 'banned shape: "all of which are now resolved"');
check(
  !/no share of the exit fee|must be topped up|set lower by many vaults/i.test(html),
  'banned shape present',
);
check(
  !/passed-but-pending|passed-but-unexecuted|between a vote passing|vote passing and execut|rebalance has passed but has not yet executed/i.test(
    html,
  ),
  'a Mode-F misstatement is present',
);
check(
  !/\bsafe\b|\balpha\b|\bAPY\b|\bAPR\b|\bROI\b|\bwaitlist\b|get started|sign up|connect wallet/i.test(
    html,
  ),
  'banned vocabulary present',
);
check(
  !/\baudits?\b|\baudited\b|\bauditor\b/i.test(html.replace(/AI pre-audit/g, '')),
  'a bare audit form is present',
);
check(!/50,000/.test(html) || /planned/.test(html), '50,000 appears without "planned"');
check(html.includes('href="faq.html"'), 'missing href="faq.html"');
check(html.includes('href="how-it-works.html"'), 'missing href="how-it-works.html"');
check(
  html.includes('href="https://github.com/SlumperSan/agent-governed-vaults"'),
  'missing the repository link',
);
check(!/style="/.test(html), 'an inline style attribute reached the markup');
check(html.includes('<code>protocol/main</code>'), 'the git ref lost its <code> element');

/* ---- a standalone page to look at ----------------------------------------
   Module class names are un-hashed so the raw module stylesheet can be linked
   directly. The rewrite handles one or two classes in a single attribute —
   the primary link carries both `.action` and `.actionPrimary`. */

const unhash = (s) =>
  s.replace(/class="([^"]*)"/g, (_, v) =>
    `class="${v.replace(/_([A-Za-z0-9]+)_[a-z0-9]+_\d+/g, '$1')}"`,
  );

writeFileSync(
  path.join(HERE, '__preview.html'),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>risks-review-status preview</title>
<link rel="stylesheet" href="../../tokens.css">
<link rel="stylesheet" href="../../index.css">
<link rel="stylesheet" href="./RisksReviewStatus.module.css">
</head>
<body><main id="main">${unhash(html)}</main></body>
</html>
`,
  'utf8',
);

console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'ALL CHECKS PASSED');
console.log('\n--- markup ---\n' + html);
process.exit(problems.length ? 1 : 0);
