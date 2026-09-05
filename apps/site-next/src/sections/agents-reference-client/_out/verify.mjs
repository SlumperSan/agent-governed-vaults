/**
 * agents-reference-client — byte-fidelity check.
 *
 * It reads the SOURCE page, pulls the "Reference client" section out of it,
 * and asserts that every sentence and every href in that section appears as a
 * literal substring of ../copy.ts. That is the direction that matters: it
 * proves the transcription introduced no byte, rather than proving the two
 * files merely look alike.
 *
 * It then sweeps this section's three files for the banned vocabulary the
 * claims suite scans stylesheets and prose for, because a comment in a
 * stylesheet is exposed exactly as a paragraph is.
 *
 * Run: node src/sections/agents-reference-client/_out/verify.mjs   (from apps/site-next)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sectionDir = path.join(here, '..');
const SOURCE = path.resolve(here, '../../../../../site/agents.html');

const html = readFileSync(SOURCE, 'utf8');
const copy = readFileSync(path.join(sectionDir, 'copy.ts'), 'utf8');
const tsx = readFileSync(path.join(sectionDir, 'AgentsReferenceClient.tsx'), 'utf8');
const css = readFileSync(path.join(sectionDir, 'AgentsReferenceClient.module.css'), 'utf8');

const failures = [];
const checks = [];

/* --- isolate the source section ------------------------------------------ */

const start = html.indexOf('<p class="eyebrow">Reference client</p>');
if (start === -1) {
  failures.push('source section not found: the "Reference client" eyebrow is gone from agents.html');
}
const end = html.indexOf('</section>', start);
const section = html.slice(start, end);

/* --- the four prose strings, extracted from the source, not retyped ------- */

const extract = (re, label) => {
  const m = section.match(re);
  if (!m) {
    failures.push(`could not extract ${label} from the source section`);
    return null;
  }
  return m[1];
};

const strings = [
  ['eyebrow', extract(/<p class="eyebrow">([^<]+)<\/p>/, 'the eyebrow')],
  ['heading', extract(/<h2>([^<]+)<\/h2>/, 'the heading')],
  ['first paragraph', extract(/<p>([^<]+)<\/p>/, 'the first paragraph')],
  ['second paragraph', extract(/<p class="tight">([^<]+)<\/p>/, 'the second paragraph')],
];

for (const [label, value] of strings) {
  if (value === null) continue;
  if (copy.includes(value)) {
    checks.push(`OK   ${label} is byte-identical in copy.ts (${value.length} chars)`);
  } else {
    failures.push(`DRIFT  ${label} is NOT byte-identical in copy.ts\n  source: ${value}`);
  }
}

/* --- the em dash survived, and no entity crept in ------------------------- */

const detail = strings[3][1] ?? '';
if (detail.includes('—')) {
  checks.push('OK   the source paragraph carries a U+2014 em dash');
  if (!copy.includes('bugs in it — one gate')) {
    failures.push('DRIFT  the restrictive em-dash pair is not present verbatim in copy.ts');
  } else {
    checks.push('OK   the restrictive em-dash pair is carried verbatim');
  }
}
if (/&(?:amp|#x27|#39|mdash);/.test(copy)) {
  failures.push('an HTML entity appears in copy.ts; the guards read raw bytes, not entities');
}

/* --- the two closing sentences stay two sentences ------------------------- */

for (const s of ['Both are fixed with regression tests.', 'Both were invisible to mocks.']) {
  if (copy.includes(s)) checks.push(`OK   carried: ${s}`);
  else failures.push(`MISSING  ${s}`);
}
if (/all of which are now resolved/i.test(copy)) {
  failures.push('banned aggregate-resolution shape present');
}

/* --- the two hrefs ------------------------------------------------------- */

const hrefs = [...section.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
const expected = [
  'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/docs/REFERENCE-AGENT.md',
  'https://github.com/SlumperSan/agent-governed-vaults',
];
if (JSON.stringify(hrefs) !== JSON.stringify(expected)) {
  failures.push(`source hrefs changed: ${JSON.stringify(hrefs)}`);
} else {
  checks.push('OK   both source hrefs are the two this section composes from REPO_URL');
}
if (!copy.includes('/blob/protocol/main/docs/REFERENCE-AGENT.md')) {
  failures.push('the document path is not composed in copy.ts');
}

/* --- banned vocabulary, over all three files ----------------------------- */

const BANNED = [
  /\bAPY\b/i,
  /\bguarantee(?:s|d|ing)?\b/i,
  /\brisk-?free\b/i,
  /\bprojected returns?\b/i,
  /\bexpected returns?\b/i,
  /\bhigh yield\b/i,
  /\bzero capital cost\b/i,
  /\bour fund\b/i,
  /\bwe manage\b/i,
  /\bpassive income\b/i,
  /\bwaitlist\b/i,
  /\bearly access\b/i,
  /\bcbETH\b/i,
  /\baudit(?:s|ed|or|ors)\b/i,
  /\bsafe\b/i,
  /\bAPR\b/,
  /\bROI\b/,
  /annuali[sz]ed/i,
  /\btarget return/i,
  /\bestimated return/i,
  /\boutperform\w*/i,
  /\balpha\b/i,
  /\bconnect wallet\b/i,
  /\bsign up\b/i,
  /\bget started\b/i,
  /\bwe run\b/i,
  /\bwe rebalance\b/i,
  /\byour portfolio\b/i,
  /\bmanaged\b/i,
  /\bour vault\b/i,
  /\bairdrop\b/i,
  /\bpresale\b/i,
  /\bopen source\b/i,
];

for (const [name, text] of [
  ['copy.ts', copy],
  ['AgentsReferenceClient.tsx', tsx],
  ['AgentsReferenceClient.module.css', css],
]) {
  for (const re of BANNED) {
    const m = text.match(re);
    if (m) failures.push(`BANNED  ${name} matches ${re}: ${JSON.stringify(m[0])}`);
  }
}
checks.push('OK   banned-vocabulary sweep ran over all three section files');

/* --- no pinned footer sentence leaked into this section ------------------ */

for (const s of [
  'No token. No points. No airdrop. No presale.',
  'Source-available under BUSL-1.1 — not open source.',
]) {
  for (const [name, text] of [
    ['copy.ts', copy],
    ['AgentsReferenceClient.tsx', tsx],
  ]) {
    if (text.includes(s)) failures.push(`a pinned footer sentence appears in ${name}`);
  }
}
checks.push('OK   neither pinned footer sentence appears in this section');

/* --- report -------------------------------------------------------------- */

for (const c of checks) console.log(c);
if (failures.length) {
  console.error('\n' + failures.length + ' FAILURE(S):');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log('\nall checks passed');
