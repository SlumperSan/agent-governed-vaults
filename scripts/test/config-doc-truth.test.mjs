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

// Positive-requirement list ONLY (see the header): the launch-parameter docs that must state the
// values. Never used to scope a negative guard.
const LAUNCH_DOCS = ['docs/LAUNCH-READINESS.md', 'docs/vault/go-to-market-plan.md'];

// Directories that are dated records rather than live claims: an execution review quoting
// `exitFeeMaxBps = 0` as a hypothetical is describing the state it reviewed, not asserting the
// launch value. Only the exit-fee-maximum guard honours this; the decay guard covers everything.
const RECORD_DIRS = ['docs/audit', 'docs/reviews'];

// Build outputs, dependencies and vendored submodules are not our prose.
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib', 'out', 'cache', 'broadcast', 'coverage']);

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

test("base-mainnet.json's govNote does not contradict its own timelockDuration", () => {
  const g = mainnet.smoke.gov;
  const note = String(mainnet.smoke.govNote ?? '');
  // The note quotes the withdrawn wording deliberately; only flag it ASSERTING a non-zero delay.
  const assertsNonZero = /this sets a non-zero timelockDuration/i.test(note)
    || /mainnet capital wants a day to react(?![^.]*withdrawn)/i.test(note);
  if (g.timelockDuration === 0) {
    assert.ok(
      !assertsNonZero,
      `smoke.gov.timelockDuration is 0 but govNote asserts a non-zero timelock. ` +
        `The config would be annotating itself with the opposite of its own value.`
    );
  }
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
  assert.match(siteTest, /config\.smoke\.exitFeeDecayPeriod/, 'site.test.mjs no longer pins the exit-fee decay row to base-mainnet.json');
});

test('Governance.sol has no proposalThresholdBps floor, and govDefencesNote in both configs says so', () => {
  const gov = read('contracts', 'src', 'Governance.sol');
  // Source of truth: the validator bounds the threshold from above only. If a floor ever lands,
  // this assertion fails first and the notes below must be rewritten with it.
  assert.match(gov, /require\(cfg\.proposalThresholdBps <= BPS, BadGovConfig\(\)\);/, 'the <= BPS bound on proposalThresholdBps moved or changed');
  assert.doesNotMatch(gov, /proposalThresholdBps\s*>=/, 'Governance.sol now enforces a proposalThresholdBps floor; govDefencesNote in both configs must be rewritten');
  assert.match(gov, /NO FLOOR on proposalThresholdBps/, 'the M-6 "no floor" comment in _validateConfig is gone');

  const NO_FLOOR = 'NO contract floor on proposalThresholdBps';
  for (const [name, cfg] of [['base-mainnet.json', mainnet], ['base-sepolia.json', sepolia]]) {
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

test('the configs still choose a proposal threshold above zero, since the contract will accept zero', () => {
  // Not a contract invariant — the note above explains why — so it is a config invariant here.
  for (const [name, cfg] of [['base-mainnet.json', mainnet], ['base-sepolia.json', sepolia]]) {
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
