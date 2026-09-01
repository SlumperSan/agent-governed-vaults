/**
 * Config/doc truth pins.
 *
 * `contracts/config/base-mainnet.json` is what deploys. The launch docs argue its values, and
 * twice now the two have drifted apart without anything turning red:
 *
 *   - LAUNCH-READINESS §2 and go-to-market-plan said the exit fee decays over 302,400 s while the
 *     config deployed 604,800 s (Finance: "Member Cost and the HWM", "Fee Model Sensitivities").
 *   - `govDefencesNote` claimed Governance enforces a 100 bps proposal-threshold floor; that floor
 *     was implemented, measured and reverted (`test/audit/AuditProposalThresholdFloor.t.sol`).
 *     A config note that misstates a security check is how the next vault gets configured wrong
 *     (security-ops §8 item 11).
 *
 * Same pattern as apps/site/test/site.test.mjs: read the config, read the prose, and refuse to
 * let a number or a security claim in the prose disagree with the thing it describes. Which
 * decay period is *intended* is a launch parameter and not this test's business; it only
 * insists the docs say what deploys.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p) => readFileSync(path.join(REPO, ...p), 'utf8');

const mainnet = JSON.parse(read('contracts', 'config', 'base-mainnet.json'));
const sepolia = JSON.parse(read('contracts', 'config', 'base-sepolia.json'));

// The launch-parameter docs: the ones that state the exit-fee decay as a number.
const DECAY_DOCS = ['docs/LAUNCH-READINESS.md', 'docs/vault/go-to-market-plan.md'];

const withCommas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

test('the config deploys a whole number of days of exit-fee decay, so the prose can render it', () => {
  const s = mainnet.smoke.exitFeeDecayPeriod;
  assert.equal(typeof s, 'number');
  assert.ok(s > 0 && Number.isInteger(s), `exitFeeDecayPeriod must be a positive integer, got ${s}`);
  assert.equal(s % 86_400, 0, `exitFeeDecayPeriod ${s} is not a whole number of days; update the docs' rendering and this test together`);
});

test('every launch doc states the exit-fee decay the mainnet config deploys, and no other value as current', () => {
  const seconds = mainnet.smoke.exitFeeDecayPeriod;
  const days = seconds / 86_400;
  const expected = `decay ${withCommas(seconds)} s (${days} day${days === 1 ? '' : 's'})`;
  for (const doc of DECAY_DOCS) {
    const text = read(doc);
    assert.ok(text.includes(expected), `${doc} does not state "${expected}" — base-mainnet.json smoke.exitFeeDecayPeriod is ${seconds}`);
    // Any *current* statement of the decay ("decay N s") must be the config's value. The prior
    // 302,400 s figure is allowed to survive only as flagged history ("previously said ... s"),
    // which this pattern deliberately does not match.
    for (const m of text.matchAll(/\bdecay\s+(\d[\d,]*)\s*s\b/g)) {
      assert.equal(m[1].replace(/,/g, ''), String(seconds), `${doc} states "${m[0]}" as current; the config deploys ${seconds} s`);
    }
  }
});

test('every launch doc states the exitFeeMaxBps the mainnet config deploys', () => {
  const bps = mainnet.smoke.exitFeeMaxBps;
  for (const doc of DECAY_DOCS) {
    const text = read(doc);
    for (const m of text.matchAll(/`exitFeeMaxBps = (\d+)`/g)) {
      assert.equal(Number(m[1]), bps, `${doc} says exitFeeMaxBps = ${m[1]}; base-mainnet.json deploys ${bps}`);
    }
    assert.ok(text.includes(`\`exitFeeMaxBps = ${bps}\``), `${doc} never states the config's exitFeeMaxBps (${bps})`);
  }
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

  for (const [name, cfg] of [['base-mainnet.json', mainnet], ['base-sepolia.json', sepolia]]) {
    const note = cfg.smoke.govDefencesNote;
    assert.equal(typeof note, 'string', `${name}: smoke.govDefencesNote missing`);
    assert.doesNotMatch(note, /enforces a \d+ bps threshold floor/i, `${name}: govDefencesNote still claims a threshold floor the contract does not enforce`);
    assert.doesNotMatch(note, /threshold floor,/i, `${name}: govDefencesNote still lists a threshold floor among the enforced bounds`);
    assert.match(note, /NO contract floor on proposalThresholdBps/, `${name}: govDefencesNote must state that there is no contract floor on proposalThresholdBps`);
    assert.match(note, /AuditProposalThresholdFloor\.t\.sol/, `${name}: govDefencesNote must point at the reverted-floor audit artifact`);
    // The bounds it does claim must be the contract's.
    assert.match(gov, /CONCENTRATION_CAP_CEILING_BPS = 5_000/);
    assert.match(gov, /PROPOSAL_COOLDOWN_FLOOR = 1 hours/);
    assert.match(gov, /PROPOSAL_COOLDOWN_CAP = 30 days/);
    assert.match(note, /5000 bps concentration ceiling/, `${name}: note must state the 5000 bps concentration ceiling`);
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
