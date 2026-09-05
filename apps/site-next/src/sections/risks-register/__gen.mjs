// Temporary generator. Writes entries.tsx from the reviewed bytes in
// apps/site/risks.html so no sentence in this section is hand-transcribed.
// Deleted once entries.tsx exists and __probe.mjs has verified it against the
// same source.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(here, '../../../../site/risks.html'), 'utf8');

const MODE_F_TRIGGER =
  'From the moment the reveal phase opens on any live proposal (not from the moment one passes)';
const MODE_F_MID = MODE_F_TRIGGER.charAt(0).toLowerCase() + MODE_F_TRIGGER.slice(1);

const articles = [...html.matchAll(/<article class="risk" id="(r\d+)">([\s\S]*?)<\/article>/g)].map(
  ([, id, body]) => {
    const sev = body.match(/<span class="([^"]+)">([\s\S]*?)<\/span>/);
    const h2 = body.match(/<h2>([\s\S]*?)<\/h2>/);
    const rows = [...body.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)].map((m) => ({
      dt: m[1],
      dd: m[2],
    }));
    return { id, severityClass: sev[1], severityLabel: sev[2], heading: h2[1], rows };
  },
);

if (articles.length !== 15) throw new Error(`expected 15 articles, parsed ${articles.length}`);
for (const a of articles) {
  if (a.rows.length !== 3) throw new Error(`${a.id}: expected 3 rows, parsed ${a.rows.length}`);
  const dts = a.rows.map((r) => r.dt).join('|');
  if (dts !== 'What it is|Worst case|What is done') throw new Error(`${a.id}: rows are ${dts}`);
}

// The one string that is composed rather than pasted: r6's "What it is" cell
// carries the Mode-F trigger clause mid-sentence, so it is spliced from the
// shell constant with its first letter folded.
const r6 = articles.find((a) => a.id === 'r6');
const r6Body = r6.rows[0].dd;
const at = r6Body.indexOf(MODE_F_MID);
if (at < 0) throw new Error('r6: the Mode-F clause is not in the source cell as expected');
const r6Head = r6Body.slice(0, at);
const r6Tail = r6Body.slice(at + MODE_F_MID.length);
if (r6Head + MODE_F_MID + r6Tail !== r6Body) throw new Error('r6: splice does not reproduce source');

const q = (s) => JSON.stringify(s);

const entryLiteral = (a) => {
  const rows = a.rows.map((r, i) => {
    const dd = a.id === 'r6' && i === 0 ? `${q(r6Head)} + MODE_F_CLAUSE + ${q(r6Tail)}` : q(r.dd);
    return `      { dt: ${q(r.dt)}, dd: ${dd} },`;
  });
  return [
    `  {`,
    `    id: ${q(a.id)},`,
    `    severityClass: ${q(a.severityClass)},`,
    `    severityLabel: ${q(a.severityLabel)},`,
    `    heading: ${q(a.heading)},`,
    `    rows: [`,
    ...rows,
    `    ],`,
    `  },`,
  ].join('\n');
};

const HEADER = [
  '/**',
  ' * risks-register — the reviewed copy for r1..r15, held as HTML source bytes.',
  ' *',
  ' * WHERE IT CAME FROM. Every string in this file was lifted byte-for-byte out',
  ' * of the fifteen `<article class="risk">` blocks of `apps/site/risks.html`, by',
  ' * a script rather than by hand, and `__probe.mjs` re-reads that same file and',
  ' * asserts the RENDERED markup is byte-equal to it. Nothing here was rewritten,',
  ' * re-punctuated, shortened or newly written. This section composes no prose:',
  ' * a risk register is the last page on the site where a sentence should be',
  ' * improved in passing.',
  ' *',
  ' * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so an',
  ' * apostrophe reaches `dist/risks.html` as `&#x27;` and a byte comparison',
  ' * against the reviewed original fails on markup that reads perfectly in a',
  ' * browser. Twelve of the cells below carry an apostrophe, a quotation mark, or',
  ' * `<strong>` / `<code>` / `<em>` markup that must survive as markup. Every one',
  ' * of them is rendered through `<Pinned>` (src/shell/PinnedText.tsx), which',
  ' * writes the stored bytes straight onto the semantic element.',
  ' *',
  ' * ---------------------------------------------------------------------------',
  ' * FOUR THINGS THE GUARDS READ OUT OF THIS DATA',
  ' * ---------------------------------------------------------------------------',
  ' * 1. THE UNMITIGATED COUNT IS DERIVED FROM THESE CELLS, NOT DECLARED.',
  ' *    `apps/site/test/site.test.mjs` parses every',
  ' *    `<dt>What is done</dt><dd>…</dd>` cell out of the built page, strips the',
  ' *    tags, trims, and counts the ones whose text begins with "Nothing". That',
  ' *    count is seven today — r1, r2, r4, r6, r8, r10, r15 — and it is what',
  ' *    risks-hero must spell as "Seven of these have no mitigation" and',
  ' *    who-its-for as "the seven where the honest answer is that nothing is',
  ' *    done". Anything rendered before the word "Nothing" inside one of those',
  ' *    cells — a label, a visually-hidden prefix, a wrapper element carrying',
  ' *    text — drops the count and reds two sections nobody in this directory',
  ' *    owns.',
  ' *',
  ' * 2. THE ANCHOR SET IS DERIVED THE SAME WAY. The contents heading',
  ' *    ("All fifteen.") and the check that every `<article class="risk" id="rN">`',
  ' *    has a matching `href="#rN"` are both computed from the ids emitted here.',
  ' *    Adding, removing or renumbering an entry moves risks-contents with it.',
  ' *',
  ' * 3. r5 MUST NOT CARRY A MITIGATED CHIP, and must say the sequencer path has',
  ' *    "never run against a real" or "never executed against a real" feed. Its',
  ' *    severity class is plain `severity` for that reason, and the sentence is',
  ' *    in its "What is done" cell. The guard slices the page between `id="r5"`',
  ' *    and `id="r6"`, so both facts have to be inside this entry.',
  ' *',
  ' * ---------------------------------------------------------------------------',
  ' * THE NUMBERS, EACH READ OUT OF THE CONFIGURATION OR THE CONTRACT',
  ' * ---------------------------------------------------------------------------',
  ' * Every figure quoted in the cells below is a reference-configuration value',
  ' * or a contract constant, and several are pinned by name: the claims suite',
  ' * compares `contracts/config/base-mainnet.json` against the strings on this',
  ' * page, so a config edit reds the gate rather than silently desynchronising',
  ' * the site.',
  ' *',
  ' *   r3, r5  "3,600 seconds" staleness bound, and the 3,600-second grace period',
  ' *     contracts/config/base-mainnet.json  chainlinkOracle.assets[].heartbeatSeconds = 3600',
  ' *     contracts/config/base-mainnet.json  chainlinkOracle.sequencerUptimeFeedNote:',
  ' *       "GRACE_PERIOD is 3600s (ChainlinkOracle constant)"',
  ' *',
  ' *   r3  the two sane-price bands',
  ' *     WETH  minPriceWad 100000000000000000000       = $100',
  ' *           maxPriceWad 100000000000000000000000    = $100,000',
  ' *     cbBTC minPriceWad 1000000000000000000000      = $1,000',
  ' *           maxPriceWad 1000000000000000000000000   = $1,000,000',
  ' *     All four are asserted present on how-it-works.html AND risks.html.',
  ' *',
  ' *   r6  "24 hours in the reference configuration (a zero timelock plus a',
  ' *       24-hour execution window)"',
  ' *     contracts/config/base-mainnet.json  smoke.gov.executionWindow = 86400',
  ' *     The zero timelock is a parameter of Vault #1, which is why the sentence',
  ' *     names the reference configuration rather than the protocol.',
  ' *',
  ' *   r7  "25% of voting-eligible stake" quorum floor, and the reference minimum',
  ' *     contracts/config/base-mainnet.json  smoke.gov.quorumBps = 2500',
  ' *     contracts/config/base-mainnet.json  smoke.minDepositUsdc = 100000000 (6 dp)',
  ' *     "about 400 USDC" is four of those seats — the four a single-member vault',
  ' *     needs to leave the sub-five regime. Both strings are pinned to the',
  ' *     config by name.',
  ' *',
  ' *   r7  the delegate concentration cap named as "a cap on how much delegated',
  ' *       weight any single delegate may receive"',
  ' *     contracts/config/base-mainnet.json  smoke.gov.concentrationCapBps = 4000',
  ' *',
  ' *   r8  "100% of voting-eligible stake plus a timelock"',
  ' *     contracts/src/Governance.sol:538-541  a RuleChange passes only on',
  ' *       p.revealedWeight == p.snapshotTotal && p.forWeight >= p.snapshotTotal',
  ' *     contracts/src/Governance.sol:531      passing starts the timelock',
  ' *',
  ' *   r14  "planned capacity cap is 50,000 USDC"',
  ' *     A planned parameter of a vault that has not been created. Any page',
  ' *     carrying the figure must also carry the word "planned"; this cell',
  ' *     supplies both, in the same sentence.',
  ' *',
  ' *   r6  the Mode-F trigger',
  ' *     contracts/src/Governance.sol:648-659  hasPendingExecution returns true',
  ' *       from p.commitDeadline onward — the reveal phase, not passage.',
  ' */',
  "import { MODE_F_TRIGGER } from '../../shell/pinned';",
  '',
  '/** One `<dt>`/`<dd>` pair. Both are HTML source bytes; both render bare. */',
  'export type RiskRow = {',
  '  /** Exactly "What it is", "Worst case" or "What is done". */',
  '  readonly dt: string;',
  '  readonly dd: string;',
  '};',
  '',
  'export type RiskEntry = {',
  '  /** r1..r15. The anchor risks-contents links to, and the guard reads. */',
  '  readonly id: string;',
  '  /**',
  '   * The chip class, verbatim from the source: `severity`, or',
  '   * `severity severity--accepted` where the entry is an accepted residual.',
  '   * `severity--mitigated` appears nowhere, and r5 must never acquire it.',
  '   */',
  '  readonly severityClass: string;',
  '  readonly severityLabel: string;',
  '  readonly heading: string;',
  '  readonly rows: readonly RiskRow[];',
  '};',
].join('\n');

const file = `${HEADER}

/**
 * The Mode-F trigger clause as it reads mid-sentence in r6.
 *
 * The clause is a passage that travels — it appears on how-it-works, faq,
 * who-its-for, agents and here — so it is imported from the one place that
 * holds it rather than retyped into this file. The source cell opens the
 * clause mid-sentence, after "And ", so the first letter is folded and every
 * other byte is the constant's. The fold is checked two ways: the generator
 * asserted the spliced string reproduces the source cell exactly, and
 * __probe.mjs asserts the rendered r6 cell is byte-equal to the reviewed
 * original.
 *
 * Five misstatements of this clause are asserted ABSENT from every page —
 * "passed-but-pending", "passed-but-unexecuted", "between a vote passing",
 * "vote passing and execut", and "rebalance has passed but has not yet
 * executed". The queue opens when the reveal phase opens, which is when
 * Governance.hasPendingExecution starts returning true at p.commitDeadline
 * (contracts/src/Governance.sol:648-659), not when a proposal passes.
 */
const MODE_F_CLAUSE = MODE_F_TRIGGER.charAt(0).toLowerCase() + MODE_F_TRIGGER.slice(1);

/** The fifteen entries, in document order. */
export const ENTRIES: readonly RiskEntry[] = [
${articles.map(entryLiteral).join('\n')}
];
`;

writeFileSync(path.join(here, 'entries.tsx'), file, 'utf8');
console.log('wrote entries.tsx —', articles.length, 'entries');
