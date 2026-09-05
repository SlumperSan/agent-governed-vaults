/**
 * Config/doc truth pins.
 *
 * `contracts/config/base-mainnet.json` is the reference configuration. The launch docs argue its
 * values, and twice now the two have drifted apart without anything turning red:
 *
 *   - LAUNCH-READINESS §2 and go-to-market-plan said the exit fee decays over 302,400 s while the
 *     config carries 604,800 s (Finance: "Member Cost and the HWM", "Fee Model Sensitivities").
 *   - `govDefencesNote` claimed Governance enforces a 100 bps proposal-threshold floor; that floor
 *     was implemented, measured and reverted (`test/audit/AuditProposalThresholdFloor.t.sol`).
 *     A config note that misstates a security check is how the next vault gets configured wrong
 *     (security-ops §8 item 11).
 *
 * Same pattern as apps/site/test/site.test.mjs: read the config, read the prose, and refuse to
 * let a number or a security claim in the prose disagree with the thing it describes. Which
 * decay period is *intended* is a launch parameter and not this test's business; it only
 * insists the docs say what the config carries.
 *
 * ## Positive lists vs. negative guards — the distinction this file turns on
 *
 * A *positive* requirement ("LAUNCH-READINESS must state the decay period") can safely name its
 * files: the worst a stale list does is require too little, and requiring too little never lets a
 * false claim through. A *negative* guard ("no doc may state a different decay period") must NOT
 * name its files, because the drift it exists to catch arrives in the file nobody added to the
 * list. This file's first version got that wrong: a hand-kept two-file list plus one literal
 * phrasing per claim, so appending `**Exit fee:** decay 302,400 s (3.5 days).` to
 * `docs/vault/fees-and-carry.md` left the suite green — the exact drift the file exists to stop.
 * So: `LAUNCH_DOCS` below is used only for positive assertions, and every negative guard
 * enumerates markdown from the filesystem and matches the claim by *shape*, not by one phrasing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(path.join(REPO, ...p), 'utf8');

const mainnet = JSON.parse(read('contracts', 'config', 'base-mainnet.json'));
const sepolia = JSON.parse(read('contracts', 'config', 'base-sepolia.json'));

/**
 * EVERY mainnet configuration, enumerated from the filesystem — never from a list.
 *
 * The per-config assertions below used to iterate a hand-written pair,
 * `[['base-mainnet.json', mainnet], ['base-sepolia.json', sepolia]]`. That is the same mistake the
 * header warns about one level up: a guard scoped by a hand-kept list cannot see the file nobody
 * remembered to add. When `contracts/config/robinhood-mainnet.json` landed, every govDefencesNote
 * and proposal-threshold assertion in this file went on describing the two Base configs and said
 * nothing at all about the new one — a mistyped note or a zeroed threshold in it reddened nothing.
 *
 * So the mainnet side is enumerated: any `*-mainnet.json` in `contracts/config/` is covered the day
 * it is added, without an edit here. `base-sepolia.json` is still named, because it is the ONLY
 * testnet config and a glob for it would be a glob of one.
 */
const mainnetConfigs = () =>
  readdirSync(path.join(REPO, 'contracts', 'config'))
    .filter((f) => f.endsWith('-mainnet.json'))
    .sort()
    .map((f) => [f, JSON.parse(read('contracts', 'config', f))]);

/** Mainnet configs plus the one testnet config: the full set the shared assertions apply to. */
const allConfigs = () => [...mainnetConfigs(), ['base-sepolia.json', sepolia]];

// Positive-requirement list ONLY (see the header): the launch-parameter docs that must state the
// values. Never used to scope a negative guard.
const LAUNCH_DOCS = ['docs/LAUNCH-READINESS.md', 'docs/vault/go-to-market-plan.md'];

// Directories that are dated records rather than live claims: an execution review quoting
// `exitFeeMaxBps = 0` as a hypothetical is describing the state it reviewed, not asserting the
// launch value. Only the exit-fee-maximum guard honours this; the decay guard covers everything.
const RECORD_DIRS = ['docs/audit', 'docs/reviews'];

// Build outputs, dependencies and vendored submodules are not our prose.
//
// `.claude` is skipped for a different reason than the rest: it holds OTHER SESSIONS' worktrees.
// This walker starts at REPO, so without this entry it reads their checkouts and a stale copy of
// a file someone else is mid-edit on turns this suite red for reasons unrelated to the change
// being tested. CLAUDE.md records that as a real cost of the shared tree; this is the fix.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'lib',
  'out',
  'cache',
  'broadcast',
  'coverage',
]);

const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** Every markdown file in the repository, enumerated from the filesystem — never from a list. */
const markdownFiles = () => {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.md')) {
        found.push(path.join(dir, entry.name));
      }
    }
  })(REPO);
  return found.map((f) => path.relative(REPO, f).split(path.sep).join('/'));
};

/**
 * Every claim of a decay period made in prose, whatever the word order. Keyed on a number sitting
 * in the decay-period slot rather than on one sentence, so "decays over N s", "N s decay",
 * "decay period of N s" and "decays to zero over D days" are all one class.
 */
const DECAY_SECONDS_PATTERNS = [
  /\bdecay[a-z]*\s+(?:[a-z]+\s+){0,3}(\d[\d,]*)\s*(?:s|sec|secs|seconds)\b/gi,
  /\b(\d[\d,]*)\s*(?:s|sec|secs|seconds)\s+(?:of\s+)?decay\b/gi,
];
const DECAY_DAYS_PATTERNS = [
  /\bdecay[a-z]*\s+(?:[a-z]+\s+){0,3}(\d+(?:\.\d+)?)\s*(?:d|day|days)\b/gi,
  /\b(\d+(?:\.\d+)?)[\s-](?:d|day|days)\s+(?:of\s+)?decay\b/gi,
];
// The days rendering that follows a seconds figure: "decay 604,800 s (7 days)".
const TRAILING_DAYS = /^\s*\(\s*(\d+(?:\.\d+)?)\s*(?:d|day|days)\s*\)/i;

/**
 * Claims of the vault's configured exit-fee maximum. The lookbehinds exempt the *stacked* cap
 * (parent + child, SV-4), which is a derived figure and legitimately differs from the config.
 */
const FEE_MAX_PATTERNS = [
  /`exitFeeMaxBps\s*=\s*(\d+)`/g,
  /(?<!stacked\s)(?<!combined\s)\bexit[- ]fee\s+(?:maximum|max|cap|ceiling)\b[^.\n]{0,40}?(\d+)\s*bps/gi,
  /(\d+)\s*bps\b[^.\n]{0,40}?(?<!stacked\s)(?<!combined\s)\bexit[- ]fee\s+(?:maximum|max|cap|ceiling)\b/gi,
];

test('the config carries a whole number of days of exit-fee decay, so the prose can render it', () => {
  const s = mainnet.smoke.exitFeeDecayPeriod;
  assert.equal(typeof s, 'number');
  assert.ok(s > 0 && Number.isInteger(s), `exitFeeDecayPeriod must be a positive integer, got ${s}`);
  assert.equal(s % 86_400, 0, `exitFeeDecayPeriod ${s} is not a whole number of days; update the docs' rendering and this test together`);
});

test('every launch doc states the exit-fee decay the mainnet config carries', () => {
  const seconds = mainnet.smoke.exitFeeDecayPeriod;
  const days = seconds / 86_400;
  const expected = `decay ${withCommas(seconds)} s (${days} day${days === 1 ? '' : 's'})`;
  for (const doc of LAUNCH_DOCS) {
    assert.ok(read(doc).includes(expected), `${doc} does not state "${expected}" — base-mainnet.json smoke.exitFeeDecayPeriod is ${seconds}`);
  }
});

test('no markdown file in the repo states a decay period other than the one the config carries', () => {
  // The negative guard. Enumerated from the filesystem so a NEW doc making a wrong claim is caught,
  // which a named-file list cannot do. Prior values may survive only as flagged history stated
  // outside the decay-period slot ("this line previously said 302,400 s"), which is how
  // LAUNCH-READINESS §2 and go-to-market-plan currently record theirs.
  const seconds = mainnet.smoke.exitFeeDecayPeriod;
  const days = seconds / 86_400;
  const files = markdownFiles();
  assert.ok(files.length > 50, `only ${files.length} markdown files found; the walk is not reaching docs/`);
  assert.ok(files.includes('docs/vault/fees-and-carry.md'), 'the walk no longer reaches docs/vault/, where the fee prose lives');

  let claims = 0;
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, idx) => {
      const where = `${file}:${idx + 1}`;
      for (const rx of DECAY_SECONDS_PATTERNS) {
        for (const m of line.matchAll(rx)) {
          claims += 1;
          assert.equal(m[1].replace(/,/g, ''), String(seconds), `${where} states "${m[0]}" as the exit-fee decay period; the config carries ${seconds} s`);
          const trailing = TRAILING_DAYS.exec(line.slice(m.index + m[0].length));
          if (trailing) {
            assert.equal(Number(trailing[1]), days, `${where} renders ${seconds} s as "${trailing[0].trim()}"; ${seconds} s is ${days} days`);
          }
        }
      }
      for (const rx of DECAY_DAYS_PATTERNS) {
        for (const m of line.matchAll(rx)) {
          claims += 1;
          assert.equal(Number(m[1]), days, `${where} states "${m[0]}" as the exit-fee decay period; the config carries ${seconds} s = ${days} days`);
        }
      }
    });
  }
  assert.ok(claims >= LAUNCH_DOCS.length, `only ${claims} decay-period claims matched across ${files.length} markdown files; the patterns have stopped recognising the form the docs use`);
});

/**
 * The governance tuple, bound to the config.
 *
 * WHY THIS EXISTS. On 2026-09-03 `smoke.gov.timelockDuration` went 86400 -> 0 (an owner decision).
 * Two live statements survived the change and CI could not see either, because nothing bound this
 * field to anything:
 *   - `base-mainnet.json`'s OWN `govNote`, twelve lines below the value, still read "this sets a
 *     non-zero timelockDuration ... mainnet capital wants a day to react" — the config annotating
 *     itself with the opposite of its own value;
 *   - `docs/vault/go-to-market-plan.md` still carried "Zero timelock is defensible *because* Mode-F
 *     exits exist", the exact claim LAUNCH-READINESS.md had just withdrawn as false.
 * Both are in LAUNCH_DOCS or the config itself, so binding the tuple would have caught the second
 * and the self-consistency check catches the first.
 */
test('every launch doc states the governance tuple the mainnet config carries', () => {
  const g = mainnet.smoke.gov;
  const tuple = `\`${g.commitDuration}/${g.revealDuration}/${g.timelockDuration}/${g.executionWindow}\``;
  for (const doc of LAUNCH_DOCS) {
    assert.ok(
      read(doc).includes(tuple),
      `${doc} does not state the config's governance tuple ${tuple} ` +
        `(commitDuration/revealDuration/timelockDuration/executionWindow from base-mainnet.json). ` +
        `If a gov value changed, this doc is now stale.`
    );
  }
});

/**
 * The config's own annotation may not contradict the value it annotates.
 *
 * The note deliberately QUOTES the withdrawn wording so the record survives, so a naive match
 * false-positives on the correction itself. Attributed quotations live inside single quotes;
 * strip them and test only what the note asserts in its OWN voice.
 *
 * The first version of this guard shipped INERT: it was written through a shell heredoc, which
 * turned every intended \b into a literal U+0008 backspace, so the patterns could never match
 * prose and the assertion was vacuous — it passed on the exact defect it was written for. It is
 * written from a file now, and the probe below fails loudly if it ever goes inert again. A guard
 * that cannot fail is worse than no guard, because it reads as coverage.
 */
function govNoteAssertsNonZeroTimelock(note) {
  const asserted = String(note ?? '').replace(/'[^']*'/g, ' ');
  return /\bnon-zero\s+timelock/i.test(asserted)
    || /\bwants?\s+a\s+day\s+to\s+react\b/i.test(asserted)
    || /\bsets?\s+a\s+(?:non-?zero\s+)?(?:timelock|delay)\b/i.test(asserted);
}

test("base-mainnet.json's govNote does not contradict its own timelockDuration", () => {
  const g = mainnet.smoke.gov;
  if (g.timelockDuration !== 0) return; // only the zero case can be contradicted this way
  assert.ok(
    !govNoteAssertsNonZeroTimelock(mainnet.smoke.govNote),
    'smoke.gov.timelockDuration is 0 but govNote asserts a non-zero timelock in its own voice '
      + '(attributed quotations are excluded). The config would be annotating itself with the '
      + 'opposite of its own value.'
  );
});

test('probe: the govNote guard is live, and tolerates the correction it must tolerate', () => {
  // The verbatim wording that shipped as the Round-1 defect, asserted in the note's own voice.
  const defect = 'Unlike base-sepolia.json this sets a non-zero timelockDuration: a testnet '
    + 'smoke run wants zero delay, mainnet capital wants a day to react to a passed proposal.';
  assert.equal(
    govNoteAssertsNonZeroTimelock(defect),
    true,
    'the guard is INERT: it no longer catches the verbatim defect it was written for. Check for '
      + 'literal U+0008 bytes where \\b was intended.'
  );

  // The same wording ATTRIBUTED as a quotation must be tolerated, or the correction trips it.
  const corrected = 'timelockDuration is 0 here. This note previously read "Unlike base-sepolia'
    + ".json this sets a non-zero timelockDuration ... mainnet capital wants a day to react to a "
    + "passed proposal', which is the opposite of the value it annotates; it is withdrawn.";
  assert.equal(
    govNoteAssertsNonZeroTimelock(corrected.replace('"', "'")),
    false,
    'the guard false-positives on an attributed quotation of the withdrawn wording'
  );

  // And the note the config actually ships must pass.
  assert.equal(
    govNoteAssertsNonZeroTimelock(mainnet.smoke.govNote),
    false,
    'the shipped govNote trips the guard'
  );
});

test('every launch doc states the exitFeeMaxBps the mainnet config carries', () => {
  const bps = mainnet.smoke.exitFeeMaxBps;
  for (const doc of LAUNCH_DOCS) {
    assert.ok(read(doc).includes(`\`exitFeeMaxBps = ${bps}\``), `${doc} never states the config's exitFeeMaxBps (${bps})`);
  }
});

test('no live markdown file states an exit-fee maximum other than the one the config carries', () => {
  const bps = mainnet.smoke.exitFeeMaxBps;
  for (const dir of RECORD_DIRS) {
    assert.ok(existsSync(path.join(REPO, dir)), `${dir} no longer exists; RECORD_DIRS is exempting a path that is gone`);
  }
  const files = markdownFiles().filter((f) => !RECORD_DIRS.some((d) => f.startsWith(`${d}/`)));
  let claims = 0;
  for (const file of files) {
    const lines = read(file).split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const rx of FEE_MAX_PATTERNS) {
        for (const m of line.matchAll(rx)) {
          claims += 1;
          assert.equal(Number(m[1]), bps, `${file}:${idx + 1} states "${m[0].trim()}" as the vault's exit-fee maximum; base-mainnet.json carries ${bps}`);
        }
      }
    });
  }
  assert.ok(claims >= LAUNCH_DOCS.length, `only ${claims} exit-fee-maximum claims matched; the patterns have stopped recognising the form the docs use`);
});

test('the exit-fee decay period in the mainnet config matches the site reference table by test, not by hand', () => {
  // apps/site/test/site.test.mjs already pins how-it-works.html to the config. This cross-check
  // only makes the dependency explicit so a future edit of that test cannot silently drop it.
  const siteTest = read('apps', 'site', 'test', 'site.test.mjs');
  assert.match(siteTest, /config\.smoke\.exitFeeDecayPeriod/, 'site.test.mjs no longer pins the exit-fee decay row to the reference mainnet configuration it reads (CONFIG_PATH)');
});

test("Governance.sol has no proposalThresholdBps floor, and every config's govDefencesNote says so", () => {
  const gov = read('contracts', 'src', 'Governance.sol');
  // Source of truth: the validator bounds the threshold from above only. If a floor ever lands,
  // this assertion fails first and the notes below must be rewritten with it.
  assert.match(gov, /require\(cfg\.proposalThresholdBps <= BPS, BadGovConfig\(\)\);/, 'the <= BPS bound on proposalThresholdBps moved or changed');
  assert.doesNotMatch(gov, /proposalThresholdBps\s*>=/, "Governance.sol now enforces a proposalThresholdBps floor; every config's govDefencesNote must be rewritten");
  assert.match(gov, /NO FLOOR on proposalThresholdBps/, 'the M-6 "no floor" comment in _validateConfig is gone');

  const NO_FLOOR = 'NO contract floor on proposalThresholdBps';
  for (const [name, cfg] of allConfigs()) {
    const note = cfg.smoke.govDefencesNote;
    assert.equal(typeof note, 'string', `${name}: smoke.govDefencesNote missing`);
    assert.ok(note.includes(NO_FLOOR), `${name}: govDefencesNote must state that there is no contract floor on proposalThresholdBps`);
    assert.match(note, /AuditProposalThresholdFloor\.t\.sol/, `${name}: govDefencesNote must point at the reverted-floor audit artifact`);

    // The two literal guards the first version had. Kept, not replaced: they are whole-note, so
    // they still catch a false claim smuggled into the same sentence as the denial, which the
    // sentence-level guard below cannot see.
    assert.doesNotMatch(note, /enforces a \d+ bps threshold floor/i, `${name}: govDefencesNote still claims a threshold floor the contract does not enforce`);
    assert.doesNotMatch(note, /threshold floor,/i, `${name}: govDefencesNote still lists a threshold floor among the enforced bounds`);

    // And the class guard, by shape rather than by phrasing: ANY sentence that puts a lower bound
    // next to the proposal threshold must be the one that denies it. Matching only the two literal
    // strings above let "Governance also enforces a threshold floor of 100 bps." through — a false
    // security claim in the string the configs cite as their guarantee.
    // (Sentence granularity: a false claim smuggled into the same sentence as the denial would
    // still pass. Splitting on `;` as well as `.` keeps that window to one clause.)
    for (const sentence of note.split(/(?<=[.;])\s+/)) {
      if (!/threshold/i.test(sentence)) continue;
      if (!/\b(floor|minimum|minimums|at least|lower bound|no less than)\b/i.test(sentence)) continue;
      assert.ok(sentence.includes(NO_FLOOR), `${name}: govDefencesNote claims a proposal-threshold lower bound the contract does not enforce: ${JSON.stringify(sentence.trim())}`);
    }

    // The bounds it does claim must be the contract's.
    assert.match(gov, /CONCENTRATION_CAP_CEILING_BPS = 5_000/);
    assert.match(gov, /PROPOSAL_COOLDOWN_FLOOR = 1 hours/);
    assert.match(gov, /PROPOSAL_COOLDOWN_CAP = 30 days/);
    assert.match(gov, /cfg\.concentrationCapBps > 0 && cfg\.concentrationCapBps <= CONCENTRATION_CAP_CEILING_BPS/, 'the non-zero bound on concentrationCapBps moved or changed');
    assert.match(note, /5000 bps concentration ceiling/, `${name}: note must state the 5000 bps concentration ceiling`);
    assert.match(note, /nonzero concentrationCapBps/, `${name}: note must state the non-zero bound _validateConfig enforces on concentrationCapBps`);
    assert.match(note, /proposalCooldown in \[1 hour, 30 days\]/, `${name}: note must state the cooldown bounds`);
  }
});

test('every config still chooses a proposal threshold above zero, since the contract will accept zero', () => {
  // Not a contract invariant — the note above explains why — so it is a config invariant here.
  for (const [name, cfg] of allConfigs()) {
    assert.ok(cfg.smoke.gov.proposalThresholdBps > 0, `${name}: proposalThresholdBps is 0, re-opening the M-7/C-1 precondition the note describes`);
  }
});

test('every `allowSubVaults = false` citation of `Deploy.s.sol:N` in docs/ points at the root-vaults-only line', () => {
  // Scoped to doc lines that make the C-1 claim. Historical audit reports cite other Deploy.s.sol
  // lines as they stood at the time; those are records, not live claims, and are left alone.
  const deploy = read('contracts', 'script', 'Deploy.s.sol').split(/\r?\n/);
  const files = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.md')) files.push(full);
    }
  })(path.join(REPO, 'docs'));
  let cited = 0;
  for (const file of files) {
    for (const docLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!/allowSubVaults = false/.test(docLine)) continue;
      for (const m of docLine.matchAll(/Deploy\.s\.sol:(\d+)\b/g)) {
        cited += 1;
        const line = deploy[Number(m[1]) - 1] ?? '';
        assert.match(line, /false, \/\/ C-1: root vaults only/, `${path.relative(REPO, file)} cites Deploy.s.sol:${m[1]} for allowSubVaults = false, but that line is now: ${JSON.stringify(line.trim())}`);
      }
    }
  }
  assert.ok(cited > 0, 'no doc cites Deploy.s.sol:N for allowSubVaults = false any more; drop this test or re-point it');
});

/**
 * Every prose surface a reader acts on. Enumerated from the filesystem, never from a list: the
 * drift this catches arrives in the file nobody added.
 *
 * WIDENED from `.md`/`.html` to include `.json` and `.txt`, because the first version missed the
 * offender with the widest blast radius: the false sequencer claim lived in `base-mainnet.json`'s
 * `sequencerUptimeFeedNote`, which is the DEPLOYER's own reference, and `llms.txt` is the file an
 * integrating agent reads instead of the source. A guard that skips the two surfaces most likely
 * to be acted on is not a guard.
 */
const PROSE_EXT = ['.md', '.html', '.json', '.txt'];
function proseFiles() {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (PROSE_EXT.some((e) => entry.name.endsWith(e)) && entry.name !== 'package-lock.json') {
        found.push(path.join(dir, entry.name));
      }
    }
  })(REPO);
  return found.map((f) => path.relative(REPO, f).split(path.sep).join('/'));
}

/**
 * Prose claiming the oracle REVERTS when it has no sequencer uptime feed. It does the opposite.
 *
 * WIDENED after review. The first version matched a PHRASING FAMILY, not a shape: the alternation
 * was `(?:one|it|the feed|a feed)`, so 10 of 14 rephrasings of the identical claim walked straight
 * through — including `Without a sequencer uptime feed the oracle reverts every price.`, which
 * differs from the shipped wording only by naming the noun. CLAUDE.md's standard is to match the
 * banned SHAPE; a guard that only catches the sentence already fixed can never catch the next one.
 *
 * Three axes are now covered: the CONDITION as a `without`-phrase (any feed noun), the condition
 * as an ABSENCE adjective (`missing`/`absent`/`unconfigured`/`unset`/`no`), and the CONSEQUENCE as
 * revert OR its synonyms (`refuse`/`freeze`), in either word order.
 */
const SEQ_CONSEQUENCE = '(?:revert|refus|freez)';
const SEQ_FEEDNOUN = '(?:one|it|(?:a|an|the)[^.]{0,40}?feed)';
const SEQUENCER_FAILS_CLOSED = [
  new RegExp(`without ${SEQ_FEEDNOUN}[^.]{0,80}\\b${SEQ_CONSEQUENCE}`, 'i'),
  new RegExp(`\\b${SEQ_CONSEQUENCE}[^.]{0,80}\\bwithout ${SEQ_FEEDNOUN}`, 'i'),
  new RegExp(`\\b(?:missing|absent|unconfigured|unset|no)\\b[^.]{0,60}\\bfeed\\b[^.]{0,80}\\b${SEQ_CONSEQUENCE}`, 'i'),
  // …and the same absence stated AFTER the noun ("if the feed is absent, priceWad reverts").
  new RegExp(`\\bfeed\\b[^.]{0,60}\\b(?:is|are|was|were)\\s+(?:missing|absent|unconfigured|unset)\\b[^.]{0,80}\\b${SEQ_CONSEQUENCE}`, 'i'),
  new RegExp(`\\b${SEQ_CONSEQUENCE}[^.]{0,80}\\bunless\\b[^.]{0,60}\\bfeed\\b`, 'i'),
];

/**
 * The claim this guard bans is about the ORACLE at PRICE time. The enforcement that genuinely
 * exists is the DEPLOY SCRIPT refusing to deploy — and that true sentence has the same shape
 * ("refuses … without a feed"), so widening the consequence verb to `refus` made the guard flag
 * the very prose #168 landed to correct it. Subject, not shape, is what separates them.
 *
 * A line that explicitly attributes the enforcement to deploy time is therefore exempt. This is a
 * real narrowing and it is stated rather than hidden: prose that says the ORACLE reverts and also
 * happens to mention the deploy script would slip through. That is the right trade — the failure
 * this guard exists to stop is a reader believing the RUNTIME protects them, and a sentence that
 * names deploy-time enforcement is telling them the truth about where the protection lives.
 */
// COMPANION GUARD, 2026-09-04 — read this before trusting the exemption below.
//
// This escape hatch says: a sentence attributing the enforcement to DEPLOY time is making the true
// claim, so let it through. That was airtight while `requiresSequencerUptimeFeed` covered every
// chain but local and Base Sepolia. It is not any more: chain 4663 is exempt, so on the chain the
// protocol is deployed on there is no deploy-time enforcement either, and a sentence saying "mandatory,
// enforced at deploy time" now walks past this guard while being false about that chain.
//
// The leg that closes it is NOT here, deliberately — it needs the deployment record to be
// meaningful, and this suite must not depend on a file that only exists after a broadcast. It is
// `scripts/test/claims-robinhood-deployment.test.mjs`, "every sentence crediting deploy-time
// enforcement of the sequencer feed says which chains it does not cover". If that file is ever
// deleted, this exemption is open again.
const SEQ_DEPLOY_TIME_ENFORCEMENT = /deploy[- ]time|deploy script|at deploy|DeployChainlinkOracle|verify-chainlink-oracle/i;

/**
 * A NEGATED consequence is the true claim, not the banned one.
 *
 * `base-mainnet.json`'s corrected note says the oracle "would serve prices straight through a
 * sequencer outage and NEVER REVERT" — the fail-open behaviour, stated correctly. The patterns
 * above match `without … the feed … revert` and cannot see the `never`, so sentence-scoping the
 * guard (which was the right fix for the deploy-time exemption) surfaced it as an offender.
 * Negation is the one context in which the banned shape means its own opposite.
 */
// NOTE the absence of `without` from this list, deliberately. `without … reverts` IS the banned
// claim; adding it here would exempt the very shape the guard exists to catch. Only true negators.
const SEQ_NEGATED = /\b(?:never|not|n't|cannot|can not)\s+(?:\w+\s+){0,3}(?:revert|refus|freez)/i;

/**
 * The L2 sequencer uptime feed: mandatory, but NOT in the way three public claims said.
 *
 * `ChainlinkOracle._requireSequencerUp` opens with `if (address(seq) == address(0)) return;`, and
 * `priceWad` is the only price-serving entry point. So an oracle deployed with a zero feed SKIPS
 * the gate and serves prices straight through a sequencer outage — it fails OPEN. Three live
 * claims said the opposite ("reverts every price without it"), inverting the safety direction of
 * the most-cited L2 defence: a deployer who omitted the feed would get no revert to tell them.
 *
 * "Mandatory" is still TRUE and the corrected prose keeps it — the enforcement is just elsewhere.
 * `DeployChainlinkOracle.s.sol` requires a non-zero sequencer on every chain but the ids on its
 * exempt allowlist (local 31337, Base Sepolia 84532 and, since 2026-09-04, Robinhood Chain 4663,
 * for which Chainlink publishes no uptime feed), checked before any other config and with no env
 * override. The set itself is pinned by scripts/test/verify-chainlink-oracle.test.mjs; this test
 * only asserts that the guard still exists.
 *
 * This binds all three legs, so the prose cannot drift from the code in either direction.
 */
test('the sequencer uptime feed is configured on mainnet, and the code still enforces it where the docs say', () => {
  const seq = String(mainnet.chainlinkOracle.sequencerUptimeFeed ?? '');
  assert.match(seq, /^0x[0-9a-fA-F]{40}$/, 'base-mainnet.json dropped chainlinkOracle.sequencerUptimeFeed');
  assert.notEqual(
    seq.toLowerCase(),
    `0x${'0'.repeat(40)}`,
    'base-mainnet.json zeroed the sequencer uptime feed; on Base that ships an oracle with no L2 gate'
  );

  // If the contract is ever changed to fail CLOSED, every doc that now says it "skips the gate"
  // becomes false — this goes red rather than letting the prose rot silently.
  const oracle = read('contracts', 'src', 'oracle', 'ChainlinkOracle.sol');
  assert.ok(
    oracle.includes('if (address(seq) == address(0)) return;'),
    'ChainlinkOracle no longer skips _requireSequencerUp on address(0). Every doc saying it "skips the gate" / fails open must be rewritten.'
  );

  // And the deploy-time refusal the corrected docs now credit must actually exist.
  const script = read('contracts', 'script', 'DeployChainlinkOracle.s.sol');
  assert.ok(
    script.includes('!requiresSequencerUptimeFeed(block.chainid)'),
    'DeployChainlinkOracle lost its fail-closed sequencer require; the docs credit it as the enforcement that carries the weight'
  );
});

test('no live prose claims the oracle reverts when no sequencer uptime feed is configured', () => {
  const offenders = [];
  for (const rel of proseFiles()) {
    if (RECORD_DIRS.some((d) => rel.startsWith(`${d}/`))) continue; // dated records keep their wording
    // SENTENCES, not lines — same reason as the sub-vault guard, plus one specific to this guard:
    // the deploy-time exemption below was a LINE-level `continue` over prose wrapped at ~100 cols,
    // so one mention of "deploy script" anywhere on a line disarmed the guard for that whole line.
    // Scoped to a sentence it disarms only the clause that actually makes the deploy-time claim.
    for (const { text, line } of sentencesOf(read(rel))) {
      if (!/sequencer/i.test(text)) continue;
      // A sentence that attributes the enforcement to DEPLOY time is making the true claim, not
      // the banned one — see SEQ_DEPLOY_TIME_ENFORCEMENT for why subject beats shape here.
      if (SEQ_DEPLOY_TIME_ENFORCEMENT.test(text)) continue;
      if (SEQ_NEGATED.test(text)) continue; // "…and never revert" is the fail-OPEN truth
      // The corrected wording quotes the withdrawn claim so the record survives; skip attributed
      // quotations the same way the govNote guard does, and judge only the file's own voice.
      const own = text.replace(/'[^']*'/g, ' ');
      if (SEQUENCER_FAILS_CLOSED.some((rx) => rx.test(own))) {
        offenders.push(`${rel}:~${line}  ${text.trim().slice(0, 140)}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `these claim the oracle reverts without a sequencer uptime feed; it returns early and prices anyway `
      + `(ChainlinkOracle.sol, _requireSequencerUp):\n  ${offenders.join('\n  ')}`
  );
});

test('probe: the sequencer-fails-closed guard is live', () => {
  // Two sets, and the second is the one that matters.
  //
  // SHIPPED: the wordings that were actually live. The first two are verbatim; the third is a
  // PARAPHRASE — risks.html's original read `mandatory — without one the oracle reverts every
  // price —`. An earlier version of this comment called all three "verbatim", which was a false
  // literal claim inside the file whose whole job is literal truth, so it is corrected rather
  // than waved through, and the real wording is included below.
  //
  // INVENTED: phrasings that never shipped. A probe built only from strings already fixed proves
  // nothing — it passes on the guard's narrowest possible form. Review found the first version
  // missed 10 of 14 rephrasings; these are drawn from that set, so the probe can now FAIL.
  for (const claim of [
    // shipped
    'MANDATORY on Base — ChainlinkOracle reverts every price without it.',
    'Without one the oracle reverts every price.',
    'mandatory — without one the oracle reverts every price —',
    // invented: never shipped, must still be caught
    'Without a sequencer uptime feed the oracle reverts every price.',
    'A missing sequencer uptime feed causes the oracle to revert.',
    'If the sequencer uptime feed is absent, priceWad reverts.',
    'The oracle reverts unless a sequencer uptime feed is configured.',
    'Without one the oracle refuses to price anything.',
    'With no uptime feed configured the oracle freezes every price.',
  ]) {
    assert.ok(
      SEQUENCER_FAILS_CLOSED.some((rx) => rx.test(claim)),
      `the guard no longer catches: ${claim}`
    );
  }
  // And an attributed quotation of it must be tolerated, or the correction trips its own guard.
  const corrected = "This note previously read 'ChainlinkOracle reverts every price without it', which inverted the direction the contract fails in.";
  const own = corrected.replace(/'[^']*'/g, ' ');
  assert.ok(!SEQUENCER_FAILS_CLOSED.some((rx) => rx.test(own)), 'the guard false-positives on its own correction');

  // NEGATION: the fail-OPEN truth uses the banned shape with the verb negated. It must pass…
  const failsOpen = 'an oracle somehow deployed without the feed would serve prices straight through a sequencer outage and never revert';
  assert.ok(SEQ_NEGATED.test(failsOpen), 'the negation exemption no longer recognises the corrected fail-open wording');

  // …but the exemption must NOT swallow the banned claim itself. `without` is a preposition here,
  // not a negator, and listing it would have disarmed the whole guard.
  for (const banned of [
    'Without one the oracle reverts every price.',
    'Without a sequencer uptime feed the oracle reverts every price.',
  ]) {
    assert.ok(!SEQ_NEGATED.test(banned), `the negation exemption wrongly clears a banned claim: ${banned}`);
  }
});

/**
 * `allowSubVaults` is a PER-DEPLOYMENT immutable, not a protocol property — and the docs now say so
 * in those words. The two scripts disagree on purpose: mainnet launches root-only (that is what
 * closes C-1), while testnet enables sub-vaults because the SV-* soak drills need a real child
 * vault to exercise. Prose that flattens either side into a universal is false against the other.
 *
 * This pins BOTH legs. Flip either script and the docs describing the asymmetry go red here rather
 * than rotting into a claim no deployment satisfies.
 */
test('allowSubVaults is asymmetric by design: Deploy.s.sol false, DeployTestnet.s.sol true', () => {
  const mainnetScript = read('contracts', 'script', 'Deploy.s.sol');
  assert.match(
    mainnetScript,
    /false, \/\/ C-1: root vaults only/,
    'Deploy.s.sol no longer passes allowSubVaults = false. That is the C-1 fix; every doc saying the '
      + 'mainnet launch path is root-only must be rewritten before this is changed.'
  );

  const testnetScript = read('contracts', 'script', 'DeployTestnet.s.sol');
  assert.match(
    testnetScript,
    /C-1: TESTNET deliberately enables sub-vaults[\s\S]{0,400}?\n\s*true,/,
    'DeployTestnet.s.sol no longer passes allowSubVaults = true. The docs cite the testnet factory as '
      + 'the proof that allowSubVaults is per-deployment rather than a protocol property, and the SV-7 '
      + 'look-through soak drill has no environment to run in without it.'
  );

  // And the recorded on-chain read of the LIVE testnet factory must still agree with that script.
  // A script says what was intended; this is what the chain answered.
  // NOT named `sepolia`: line 41 already binds that to `contracts/config/base-sepolia.json`, a
  // DIFFERENT file (the deploy config, not the deployed address book). Shadowing one config with
  // another inside a truth guard is how the wrong file gets asserted against.
  const sepoliaDeployment = JSON.parse(read('contracts', 'config', 'deployments', 'base-sepolia.json'));
  assert.equal(
    sepoliaDeployment.verifiedWiring?.['factory.allowSubVaults()'],
    true,
    'base-sepolia.json no longer records factory.allowSubVaults() === true. docs/vault/subvaultregistry.md '
      + 'cites that read by name as the evidence the flag is per-deployment.'
  );
});

/**
 * The PROSE half of the allowSubVaults asymmetry — the guard whose absence let this defect ship.
 *
 * The test above pins the two SCRIPTS and the recorded on-chain read. It pins no prose, so nothing
 * stopped a doc re-asserting the universal — and that is exactly how the first version of this
 * change was rejected: it scoped bullet 2 of a two-bullet list and left bullet 1, and left the
 * canonical decision note (`root-vaults-only.md`) saying "the protocol ships with sub-vaults
 * disabled … every vault is wired root-only".
 *
 * WHAT IS BANNED, and why these shapes rather than a scoping heuristic. "At launch" reads like
 * scoping but is not: `root-vaults-only.md` said "At launch the protocol ships with…" and was
 * still false, because the flag binds a FACTORY, not a date. So this guard does not try to judge
 * whether a sentence is sufficiently qualified. It bans the two CONSTRUCTIONS that erase the
 * per-factory binding no matter how they are qualified:
 *
 *   1. "<subject> ships with allowSubVaults = false" / "the protocol ships with sub-vaults
 *      disabled" — a factory is CONSTRUCTED with a constructor argument; nothing "ships with" one.
 *      `Deploy.s.sol` passes false and `DeployTestnet.s.sol` passes true, so there is no subject
 *      for which this sentence is true.
 *   2. "every vault is wired …" / "no vault can be funded as a child" with no possessive — the
 *      missing "it deploys" is the whole tell. `VaultFactory._deploy` wires
 *      `allowSubVaults ? subVaultRegistry : address(0)`, so the claim is true of the vaults A
 *      GIVEN FACTORY deploys and false across the deployment set.
 *
 * Both are cheap to write correctly ("Deploy.s.sol constructs VaultFactory with…", "every vault it
 * deploys is wired…"), which is what makes banning the construction outright the right call rather
 * than a judgement about context.
 */
// The VERB is not the shape — the missing factory is. A second review escaped 11 of 12 minimal
// variants of the legs below by swapping the verb ("is deployed with", "launches with"), the voice
// ("wires every vault" for "every vault is wired"), the quantifier ("all"/"each" for "every") or
// the tense. TWO of those escapes were live in the tree. So each leg now enumerates its own
// inflections rather than one surface form, and correctness is carried by SUBVAULT_SCOPED below:
// prose written correctly always names the factory (`Deploy.s.sol`, "it deploys", "on that
// factory"), so the verb list can widen freely without flagging the fix.
// `launches`/`launched` only — NEVER bare `launch`, which is overwhelmingly the NOUN here ("at
// launch", "the launch factory", "moot at launch"). Including it flagged two correctly-scoped
// sentences on its first run, and a guard that cries wolf on correct prose gets deleted.
const SV_CONSTRUCT = '(?:ships?|launch(?:es|ed)|is deployed|are deployed|is built|is created|comes?)';
const SV_QUANT = '(?:every|each|all)\\s+(?:deployed\\s+)?vaults?';
const SUBVAULT_UNIVERSAL = [
  // 1. "<subject> ships / is deployed with / launches with allowSubVaults = false"
  new RegExp(`\\b${SV_CONSTRUCT}\\b(?:\\s+with)?[^.]{0,60}\\ballowSubVaults\\b`, 'i'),
  new RegExp(`\\bprotocol\\b[^.]{0,60}\\b${SV_CONSTRUCT}\\b(?:\\s+with)?[^.]{0,60}\\bsub-?vaults?\\b[^.]{0,30}\\bdisabled\\b`, 'i'),
  // 2. the unpossessed universal, passive AND active, any quantifier or tense:
  //    "every vault is wired" / "all vaults are wired" / "wires every vault" —
  //    but never "every vault IT DEPLOYS is wired", which SUBVAULT_SCOPED exempts.
  new RegExp(`\\b${SV_QUANT}\\s+(?:is|are|was|were)\\s+wired\\b`, 'i'),
  new RegExp(`\\bwires?\\s+${SV_QUANT}\\b`, 'i'),
  // 3. the impossibility claims
  /\bno vault can (?:ever )?be funded as a child\b/i,
  /\bno parent\/child edge (?:can (?:ever )?(?:be|exist)|is ever (?:registered|created))/i,
];

/** Sentences that name the factory they are about are making the true claim, not the banned one. */
const SUBVAULT_SCOPED = /\bit deploys\b|\bon (?:that|such a|this) factory\b|\bwhen false\b|\bDeploy\.s\.sol\b|\brefusing creation here\b/i;

/**
 * SENTENCES, not lines. Markdown wraps at ~100 columns, so a claim and the clause that scopes it
 * routinely sit on different lines: `c1-empty-electorate.md` says "…so on that factory
 * `createChildVault` reverts and every vault it deploys is wired `subVaultRegistry = address(0)`
 * — no vault can be funded as a child there…", where the scoping is two lines above the claim. A
 * line-based guard reads that as an unscoped universal and false-positives on correct prose,
 * which is how a guard gets weakened or deleted. Paragraph-joined, then split on sentence ends.
 */
function sentencesOf(text) {
  const out = [];
  let line = 1;
  for (const para of text.split(/\r?\n\s*\r?\n/)) {
    const rows = para.split(/\r?\n/);
    // A markdown TABLE ROW is its own unit. Joining a table into one paragraph splices text across
    // cells, which both invents sentences that nobody wrote and lets a claim in one cell borrow
    // scoping from another. Each `|` row stands alone; everything else is joined as wrapped prose.
    let buf = [];
    let bufLine = line;
    const flush = () => {
      const joined = buf.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) for (const s of joined.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/)) out.push({ text: s, line: bufLine });
      buf = [];
    };
    rows.forEach((row, i) => {
      if (/^\s*\|/.test(row)) {
        flush();
        for (const cell of row.split('|')) {
          const c = cell.replace(/\s+/g, ' ').trim();
          if (c) for (const s of c.split(/(?<=[.!?])\s+(?=[A-Z`*[(])/)) out.push({ text: s, line: line + i });
        }
        bufLine = line + i + 1;
      } else {
        if (buf.length === 0) bufLine = line + i;
        // STRIP THE BLOCKQUOTE MARKER before joining. Without this, a banned phrase that crosses a
        // wrap inside a `>` block joins as "…every deployed > vault is wired…" and is unmatchable —
        // an INERT REGION covering exactly where these launch claims live (the DEPLOYMENT.md,
        // INCIDENTS.md and THREAT-MODEL.md banners are all blockquotes). Review found a live
        // uncorrected instance hiding in precisely that shape. List markers get the same treatment
        // for the same reason.
        buf.push(row.replace(/^\s*(?:>\s?)+/, '').replace(/^\s*(?:[-*+]|\d+\.)\s+/, ''));
      }
    });
    flush();
    line += rows.length + 1;
  }
  return out;
}

test('no live prose states allowSubVaults as a protocol universal', () => {
  const offenders = [];
  for (const rel of proseFiles()) {
    if (RECORD_DIRS.some((d) => rel.startsWith(`${d}/`))) continue; // dated records keep their wording
    for (const { text, line } of sentencesOf(read(rel))) {
      if (!/allowSubVaults|sub-?vault|child/i.test(text)) continue;
      if (SUBVAULT_SCOPED.test(text)) continue;
      // Attributed quotations survive, exactly as the govNote and sequencer guards allow.
      const own = text.replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
      if (SUBVAULT_UNIVERSAL.some((rx) => rx.test(own))) {
        offenders.push(`${rel}:~${line}  ${text.trim().slice(0, 140)}`);
      }
    }
  }
  assert.equal(
    offenders.length,
    0,
    `these state allowSubVaults as a property of the protocol; it is a constructor immutable, so it `
      + `binds ONE factory (Deploy.s.sol passes false, DeployTestnet.s.sol passes true):\n  ${offenders.join('\n  ')}`
  );
});

test('probe: sentencesOf sees through blockquotes and list markers, and does not splice table cells', () => {
  // THE INERT REGION THIS CLOSES. `>` markers were not stripped before joining, so a banned phrase
  // that crossed a wrap inside a blockquote joined as "…every deployed > vault is wired…" and was
  // unmatchable. Every launch banner in this repo is a blockquote (DEPLOYMENT, INCIDENTS,
  // THREAT-MODEL), so the guard was blind exactly where these claims live. A live uncorrected
  // instance was found hiding in precisely that shape.
  // The wrap must fall INSIDE the banned phrase, and the phrase must be the ONLY banned shape in
  // the sentence. An earlier version of this probe put "is deployed with `allowSubVaults`" in the
  // same sentence, so leg 1 matched across the stray `>` (its `[^.]{0,60}` window spans it happily)
  // and the probe passed with the strip REMOVED — vacuous, the exact defect it was written to
  // prevent. Mutation-tested: deleting the strip must turn this red.
  const blockquoted = ['> so `createChildVault` reverts and every deployed', '> vault is wired root-only.'].join('\n');
  const found = sentencesOf(blockquoted).some(
    (s) => !SUBVAULT_SCOPED.test(s.text) && SUBVAULT_UNIVERSAL.some((rx) => rx.test(s.text))
  );
  assert.ok(found, 'sentencesOf no longer strips the blockquote marker; the guard is blind inside `>` blocks');

  // The same claim behind a list marker.
  const listed = ['- `VaultFactory` ships with `allowSubVaults = false`, so every', '  vault is wired root-only.'].join('\n');
  assert.ok(
    sentencesOf(listed).some((s) => SUBVAULT_UNIVERSAL.some((rx) => rx.test(s.text))),
    'sentencesOf no longer strips list markers'
  );

  // …and table cells must NOT be spliced together, or a claim in one cell borrows scoping from
  // another and the guard silently under-reports.
  const table = '| `VaultFactory` ships `allowSubVaults = false` | see `Deploy.s.sol` for the launch path |';
  const units = sentencesOf(table).map((s) => s.text);
  assert.ok(
    units.some((u) => /ships/.test(u) && !/Deploy\.s\.sol/.test(u)),
    'table cells are being joined; a cell must not inherit another cell\'s scoping'
  );
});

test('probe: the sub-vault-universal guard is live', () => {
  // The wordings that were actually shipped and had to be corrected. If any stops matching, the
  // guard has gone inert and the universal creeps back into the docs it was removed from.
  for (const claim of [
    'At launch the protocol ships with sub-vaults disabled: `VaultFactory.allowSubVaults = false`, so `createChildVault` reverts and every vault is wired root-only.',
    '[[vaultfactory]] ships with `allowSubVaults = false` (immutable). This disables sub-vaults in',
    '`VaultFactory` ships with immutable `allowSubVaults = false`: `createChildVault` reverts',
    'every deployed vault is wired root-only, so no funded child can exist',
    '`VaultFactory` ships `allowSubVaults = false` — `createChildVault` reverts',
    // Found by a SECOND review, after the first widening: both were live in the tree and both
    // escaped, one by swapping the verb and one by swapping the voice.
    '`VaultFactory` is deployed with `allowSubVaults = false`, so `createChildVault` reverts',
    '`VaultFactory.allowSubVaults = false` makes `createChildVault` revert and wires every vault root-only',
    '`_deploy` wires every vault with `subVaultRegistry = address(0)`',
    // invented: never shipped, must still be caught
    'On this protocol no vault can be funded as a child.',
    'No parent/child edge can ever exist anywhere in the system.',
  ]) {
    assert.ok(
      SUBVAULT_UNIVERSAL.some((rx) => rx.test(claim)),
      `the guard no longer catches: ${claim}`
    );
  }
  // …and the corrected constructions must NOT trip it, or the fix trips its own guard.
  for (const ok of [
    '`Deploy.s.sol` constructs [[vaultfactory]] with `allowSubVaults = false`.',
    'Every vault it deploys is wired with `subVaultRegistry = address(0)`.',
    'so on that factory no vault can be funded as a child',
    'When false: `createChildVault` reverts and every deployed vault is wired with `subVaultRegistry = address(0)`',
  ]) {
    assert.ok(
      SUBVAULT_SCOPED.test(ok) || !SUBVAULT_UNIVERSAL.some((rx) => rx.test(ok)),
      `the guard false-positives on corrected prose: ${ok}`
    );
  }
});

/**
 * THE LAUNCH-ORACLE BLOCK, pinned against the contract that consumes it — for every mainnet config.
 *
 * `ChainlinkOracle`'s constructor bounds are the only thing standing between a typo and a
 * permanently mis-parameterised immutable oracle, and they are checked at DEPLOY time: a heartbeat
 * outside `[MIN_HEARTBEAT, MAX_HEARTBEAT]` or a band wider than `MAX_BAND_RATIO` reverts the
 * constructor, which costs a round trip and, on a chain where the deployer is paying real gas, the
 * gas with it. The values live in a JSON file no compiler reads. So they are pinned here, from the
 * config side, against the constants read out of the contract source rather than retyped into this
 * test.
 *
 * This is a POSITIVE requirement in the header's sense — it asserts what each config must satisfy,
 * never that no other file may say something — so enumerating the configs is safe, and enumerating
 * is what makes the next mainnet config covered on the day it lands rather than on the day someone
 * remembers this file.
 */
test("every mainnet config's chainlinkOracle assets satisfy the ChainlinkOracle constructor bounds", () => {
  const oracle = read('contracts', 'src', 'oracle', 'ChainlinkOracle.sol');
  // Read the bounds from the contract. A renamed constant still binds; a CHANGED one goes red here
  // first, which is the point — these numbers must never become two independent copies.
  const constant = (name) => /** @type {string | undefined} */ (
    new RegExp(`constant ${name} = (\\d[\\d_]*);`).exec(oracle)?.[1]
  )?.replace(/_/g, '');
  const minHeartbeat = Number(constant('MIN_HEARTBEAT'));
  const maxHeartbeat = Number(constant('MAX_HEARTBEAT'));
  const maxBandRatio = BigInt(constant('MAX_BAND_RATIO') ?? '0');
  assert.ok(
    Number.isFinite(minHeartbeat) && Number.isFinite(maxHeartbeat) && maxBandRatio > 0n,
    'could not read MIN_HEARTBEAT / MAX_HEARTBEAT / MAX_BAND_RATIO out of ChainlinkOracle.sol'
  );

  for (const [name, cfg] of mainnetConfigs()) {
    const co = cfg.chainlinkOracle;
    assert.ok(co, `${name}: no chainlinkOracle block — the launch oracle has no configuration`);
    const assets = co.assets;
    assert.ok(Array.isArray(assets) && assets.length > 0, `${name}: chainlinkOracle.assets is empty; there is nothing to price`);

    for (const a of assets) {
      const where = `${name} / ${a.symbol}`;
      // The settlement token is pinned at 1e18 and the constructor rejects an asset that is ALSO the
      // pinned token (ChainlinkOracle.sol:151). Compared case-insensitively: these addresses are
      // copied out of block explorers and are checksummed inconsistently across the configs.
      assert.notEqual(
        String(a.asset).toLowerCase(),
        String(cfg.usdc).toLowerCase(),
        `${where}: listed as a priced asset AND as the pinned settlement token; the constructor rejects that`
      );

      assert.ok(
        a.heartbeatSeconds >= minHeartbeat && a.heartbeatSeconds <= maxHeartbeat,
        `${where}: heartbeatSeconds ${a.heartbeatSeconds} is outside ChainlinkOracle's [${minHeartbeat}, ${maxHeartbeat}]`
      );

      // Band shape. `hi == 0` disables the band, which the constructor permits but which
      // verify-chainlink-oracle.mjs rejects for mainnet — so on a MAINNET config it must be set.
      const lo = BigInt(a.minPriceWad);
      const hi = BigInt(a.maxPriceWad);
      assert.ok(lo > 0n, `${where}: minPriceWad is 0 — a mainnet asset must carry the sane-price band`);
      assert.ok(hi > lo, `${where}: maxPriceWad ${hi} is not strictly above minPriceWad ${lo}`);
      assert.ok(hi <= lo * maxBandRatio, `${where}: band is wider than MAX_BAND_RATIO (${maxBandRatio}x)`);

      // The feed's own decimals, pinned beside the aggregator implementation. ChainlinkOracle caches
      // `scale` from decimals() ONCE at construction, so this is the number that cache is derived
      // from, and 8 is the Chainlink USD-feed convention.
      assert.equal(a.aggregatorPin?.decimals, 8, `${where}: aggregatorPin.decimals must be 8`);
      assert.match(
        String(a.aggregatorPin?.observedAt ?? ''),
        /^\d{4}-\d{2}-\d{2}$/,
        `${where}: aggregatorPin.observedAt must be a date — an undated pin records nothing`
      );

      // DENOMINATION. ChainlinkOracle requires the description to end in a USD quote leg
      // (ChainlinkOracle.sol:272-273); the string the config records must satisfy the same rule, or
      // the exact-string check in verify-chainlink-oracle.mjs is comparing against a feed the
      // constructor would refuse anyway.
      assert.match(
        String(a.feedDescriptionOnChain ?? ''),
        /(?: |\/)USD$/,
        `${where}: feedDescriptionOnChain is not USD-quoted; ChainlinkOracle's constructor rejects such a feed`
      );
    }
  }
});

/**
 * ROBINHOOD CHAIN 4663 — the sequencer-uptime-feed exemption, and why it gets its own test.
 *
 * The Base guard above ('the sequencer uptime feed is configured on mainnet…') asserts a `0x…40`
 * address. That assertion is CORRECT for Base and would be wrong to generalise: chain 4663 has no
 * L2 Sequencer Uptime Feed to configure — Chainlink publishes none for it, and the Base feed
 * address carries zero bytes of code there. The empty string is the owner-approved answer of
 * 2026-09-04, not a dropped field. So the two configs get two tests, each asserting the thing that
 * is true of it.
 *
 * What still needs guarding here is the pair of claims the empty field rests on, because both are
 * falsifiable and neither is self-evident from the empty string:
 *
 *   1. The emptiness is DELIBERATE and DATED. An empty `sequencerUptimeFeed` with no note beside it
 *      is indistinguishable from a config someone did not finish, and the difference is the whole
 *      difference — one is an owner decision on the record, the other is a missing security control.
 *   2. The contract still fails OPEN on `address(0)`. The config's note tells a reader the oracle
 *      "serves prices straight through a sequencer outage and never reverts on that account". If
 *      `_requireSequencerUp` is ever changed to fail CLOSED, that note becomes false — and it is the
 *      note a reader consults to understand what the exemption costs them.
 */
test('robinhood-mainnet.json leaves the sequencer uptime feed empty, on the record and for the stated reason', () => {
  const rh = JSON.parse(read('contracts', 'config', 'robinhood-mainnet.json'));
  assert.equal(rh.chainId, 4663, 'robinhood-mainnet.json is not chain 4663');

  const seq = rh.chainlinkOracle.sequencerUptimeFeed;
  assert.equal(seq, '', 'robinhood-mainnet.json now names a sequencer uptime feed; rewrite sequencerUptimeFeedNote to match it');

  // The note, matched by SHAPE rather than by one phrasing: an owner approval, and its date.
  const note = String(rh.chainlinkOracle.sequencerUptimeFeedNote ?? '');
  assert.match(note, /owner[- ]approved/i, 'sequencerUptimeFeedNote must record that the exemption is owner-approved');
  assert.match(note, /\b2026-09-04\b/, 'sequencerUptimeFeedNote must carry the date of that approval');

  // Claim 2: the runtime behaviour the note describes.
  const oracle = read('contracts', 'src', 'oracle', 'ChainlinkOracle.sol');
  assert.ok(
    oracle.includes('if (address(seq) == address(0)) return;'),
    'ChainlinkOracle no longer skips _requireSequencerUp on address(0). robinhood-mainnet.json\'s '
      + 'sequencerUptimeFeedNote tells the reader that an oracle with a zero feed serves prices '
      + 'through an outage and never reverts on that account; rewrite it before this changes.'
  );
});
