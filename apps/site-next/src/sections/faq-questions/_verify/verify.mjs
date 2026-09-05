/**
 * Transient. Proves the port rather than asserting it.
 *
 * Builds this section on its own with the project's own toolchain, renders it
 * with renderToString, then compares the rendered article contents — question,
 * paragraph bytes, in document order — against the
 * seventeen <article class="qa"> blocks of apps/site/faq.html. Class attributes
 * and wrappers are ignored; anything else that differs is a copy defect.
 *
 * Run from apps/site-next:  node src/sections/faq-questions/_verify/verify.mjs
 */
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..'); // apps/site-next
const SOURCE = path.resolve(ROOT, '../site/faq.html');
const OUT = path.join(HERE, 'build');

await build({
  configFile: false,
  root: ROOT,
  logLevel: 'warn',
  plugins: [react()],
  build: {
    ssr: true,
    rollupOptions: { input: { harness: path.join(HERE, 'harness.tsx') } },
    outDir: OUT,
    emptyOutDir: true,
  },
});

const { renderSection } = await import(pathToFileURL(path.join(OUT, 'harness.js')).href);
const rendered = renderSection();
writeFileSync(path.join(HERE, 'section.html'), rendered, 'utf8');

/** question + paragraph bytes, in document order, per article. */
function articlesOf(html) {
  return [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/g)].map((m) => {
    const body = m[1];
    const question = body.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/)?.[1] ?? '(no h2)';
    const nodes = [];
    const re = /<p\b[^>]*>([\s\S]*?)<\/p>/g;
    for (const n of body.matchAll(re)) {
      nodes.push(`P|${n[1]}`);
    }
    return { question, nodes };
  });
}

const want = articlesOf(readFileSync(SOURCE, 'utf8'));
const got = articlesOf(rendered);

let bad = 0;
const fail = (msg) => {
  bad += 1;
  console.log(`  FAIL ${msg}`);
};

console.log(`articles: source ${want.length}, rendered ${got.length}`);
if (want.length !== got.length) fail('article count differs');

for (let i = 0; i < Math.min(want.length, got.length); i++) {
  const a = want[i];
  const b = got[i];
  if (a.question !== b.question) {
    fail(`article ${i + 1} question\n    want ${JSON.stringify(a.question)}\n    got  ${JSON.stringify(b.question)}`);
    continue;
  }
  if (a.nodes.length !== b.nodes.length) {
    fail(`article ${i + 1} (${a.question}) node count: want ${a.nodes.length}, got ${b.nodes.length}`);
  }
  for (let j = 0; j < Math.max(a.nodes.length, b.nodes.length); j++) {
    if (a.nodes[j] !== b.nodes[j]) {
      fail(
        `article ${i + 1} (${a.question}) node ${j + 1}\n    want ${JSON.stringify(a.nodes[j])}\n    got  ${JSON.stringify(b.nodes[j])}`,
      );
    }
  }
}

// The counted sentences, and the shapes that must be absent.
const count = (h, n) => h.split(n).length - 1;
const TOKEN = 'No token. No points. No airdrop. No presale.';
const LICENCE = 'Source-available under BUSL-1.1 — not open source.';
const checks = [
  ['FOOTER_TOKEN copies in this section', count(rendered, TOKEN), 1],
  ['FOOTER_LICENCE copies in this section', count(rendered, LICENCE), 1],
  ['h1 elements', count(rendered, '<h1'), 0],
  ['escaped apostrophes', count(rendered, '&#x27;'), 0],
  ['escaped ampersands', count(rendered, '&amp;'), 0],
];
for (const [what, got_, want_] of checks) {
  const ok = got_ === want_;
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${got_} (want ${want_})`);
}

// The banned shapes that bite hardest on this page, checked in the RENDERED
// markup rather than in the source strings.
const BANNED = [
  /\bguarantee(?:s|d|ing)?\b/i,
  /\bsafe\b/i,
  /\balpha\b/i,
  /\baudit(?:s|ed|or|ors)\b/i,
  /\bsign up\b/i,
  /\bget started\b/i,
  /\bconnect wallet\b/i,
  /\bwe manage\b/i,
  /\bwe run\b/i,
  /\bwe rebalance\b/i,
  /\bmanaged\b/i,
  /\bour vault\b/i,
  /\byour portfolio\b/i,
  /\bcbETH\b/i,
  /\bAPY\b/i,
  /\bpassive income\b/i,
  /\bhigh yield\b/i,
  /\brisk-?free\b/i,
  /\bwaitlist\b/i,
  /\bearly access\b/i,
  /\bzero capital cost\b/i,
  /no share of the exit fee/i,
  /must be topped up/i,
  /set lower by many vaults/i,
  /all of which are now resolved/i,
  /\bpassed[-\s]but[-\s]pending\b/i,
  /\bpassed[-\s]but[-\s]unexecuted\b/i,
  /\bbetween a vote passing\b/i,
  /\bvote passing and execut/i,
  /\brebalance has passed but has not yet executed\b/i,
];
// The one permitted negation this section uses, stripped before the scan.
const scrubbed = rendered.split('a good-faith measure and not a guarantee').join(' ');
for (const re of BANNED) {
  const hit = scrubbed.match(re);
  if (hit) fail(`banned shape ${re} matched ${JSON.stringify(hit[0])}`);
}

// Page-level facts this section is responsible for supplying.
const positives = [
  ['the permitted negation is in use', /a good-faith measure and not a guarantee/],
  ['50,000 is labelled planned', /planned 50,000 USDC/],
  ['the open High is named in its own sentence', /purchasable member count below five members — remains open at the launch configuration/],
  ['the attestation qualifier shares its paragraph', /external security review[\s\S]{0,900}no public report/],
  ['stake-weighted is qualified in the same breath', /stake-weighted at five or more members/],
  ['the Mode-F trigger names the reveal phase', /from the moment the reveal phase opens on any live proposal/],
  ['risk 15 is linked', /href="risks\.html#r15"/],
  ['risk 13 is linked', /href="risks\.html#r13"/],
  ['the operators page is linked', /href="operators\.html"/],
];
for (const [what, re] of positives) {
  const ok = re.test(rendered);
  if (!ok) bad += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
}

// Every sentence carrying "deployed" must negate it.
const prose = rendered.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]*>/g, ' ');
const NEGATED = /\bnot\b|\bno\b|\bnever\b|\bnothing\b|\bnone\b|\bnor\b|\bcannot\b|\bsuperseded\b|\bwould be\b/i;
for (const sentence of prose.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/)) {
  if (!/\bdeployed\b/i.test(sentence)) continue;
  if (!NEGATED.test(sentence)) fail(`"deployed" unnegated — ${JSON.stringify(sentence.trim())}`);
}

console.log(bad === 0 ? '\nALL CHECKS PASSED' : `\n${bad} FAILURE(S)`);
process.exit(bad === 0 ? 0 : 1);
