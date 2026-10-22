/**
 * Claims truth: what the deploy key can do.
 *
 * Under the same-address CREATE2 deployment (PR 462) the protocol's one privileged key,
 * `PROTOCOL_INITIALIZER`, has FOUR one-shot calls, not three: the three wires
 * (`OperatorRegistry.wire`, `SubVaultRegistry.wire`, `Governance.wireSubVaultRegistry`) and
 * `VaultFactory.initialize(address[])`, which sets the oracle allowlist, and with an empty list leaves
 * the C-6 curation gate off for good on that chain. The LIVE Arc deployment is the earlier plain-CREATE
 * set: three wires, all made, and a factory whose allowlist was fixed in its constructor, with no
 * `initialize` at all. So there are two true accounts, one per deployment, and a public sentence has to
 * say which it describes.
 *
 * Review of PR 462 found four public places that still said the key's "entire power" is three wiring
 * calls writing four address slots and "none of it a path to your money": `apps/site/src/copy.ts`,
 * `apps/site/src/disclaimers-copy.ts`, `apps/web/index.html` and `docs/INCIDENTS.md`. The same PR had
 * edited two disclaimers to say the allowlist is set by "a one-shot initialize call", which is false of
 * the live Arc factory. The PR had grepped the phrase it was editing ("fixed in its constructor") and
 * missed the SHAPE of the claim that the same fact falsified. No existing guard could see either: they
 * match banned shapes and none of these was one.
 *
 * Two shapes are guarded, both negative, so both walk the filesystem and name no file:
 *
 *   1. A sentence that BOUNDS the key's power (entire, whole, only, "all it does", "spent at wiring",
 *      "three one-shot calls", "four address slots", "exactly one privileged key", "no post-wiring
 *      authority") must carry, within its window, both the fourth call (`initialize`) and a word that
 *      says which deployment each count describes (live, today, first set, v1, plain CREATE).
 *   2. The factory allowlist said to be set by `initialize` must name the deployment it is true of
 *      (v1, v2, CREATE2, same-address, constructor, "brought up", current source ...). The
 *      version-neutral wording "set once, when the factory is brought up" is true of both and needs
 *      nothing more.
 *
 * Surfaces are the same as `claims-lede-truth.test.mjs` (`.md`, `.html`, `.txt`, `.json`, enumerated
 * from the filesystem) plus the string literals of `apps/site/src/*.ts`, which that walk cannot see
 * (see `claims-site-ts-truth.test.mjs`).
 *
 * A FIFTH call exists in the v2 source from fee model A1: `FeeEngine.initialize(address)`, which sets the
 * fee treasury. The shapes below are unchanged (they require the fourth call and the deployment each count
 * describes); public sentences that list the key's calls name the fifth beside the fourth.
 *
 * LIMIT, stated rather than implied: this catches the bounded-power shape and the unqualified
 * allowlist shape. A new way of saying the key has no other power, built without any cue word above,
 * will pass. The shapes are widened when one is found, the way `claims-lede-truth.test.mjs` guard 6
 * was, and every widening is mutation-probed below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStringLiterals } from '../lib/extract-string-literals.mjs';
import { flat, deployKeyPowerHits, unqualifiedInitializeHits, keyOnlyChoiceHits } from '../lib/claims-shapes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'lib', 'out', 'cache', 'broadcast', 'coverage', 'artifacts', 'dist-ssr']);
const PUBLIC_EXT = new Set(['.md', '.html', '.txt', '.json']);
// Dated reviews and findings quote the false claims they report; the claim is theirs to quote.
const RECORD_DIRS = ['docs/reviews/'];

/** Entities in the site copy that change nothing about a shape: a space is enough. */
const plain = (s) => s.replace(/&[a-z#0-9]+;/gi, ' ');

const publicTexts = () => {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (PUBLIC_EXT.has(path.extname(e.name)) && !e.name.endsWith('package-lock.json')) {
        const file = path.relative(REPO, path.join(dir, e.name)).split(path.sep).join('/');
        if (RECORD_DIRS.some((r) => file.startsWith(r))) continue;
        out.push({ file, text: readFileSync(path.join(dir, e.name), 'utf8') });
      }
    }
  })(REPO);
  const siteDir = path.join(REPO, 'apps', 'site', 'src');
  for (const e of readdirSync(siteDir, { withFileTypes: true })) {
    if (!e.isFile() || !e.name.endsWith('.ts')) continue;
    const strings = extractStringLiterals(readFileSync(path.join(siteDir, e.name), 'utf8'));
    out.push({ file: `apps/site/src/${e.name}`, text: strings.join(' ') });
  }
  // A guard over an empty corpus is indistinguishable from a clean one.
  assert.ok(out.length >= 50, `the walk returned ${out.length} file(s)`);
  for (const must of ['apps/site/src/copy.ts', 'apps/site/src/disclaimers-copy.ts', 'apps/web/index.html', 'docs/INCIDENTS.md']) {
    assert.ok(out.some((o) => o.file === must), `${must} was not walked`);
  }
  return out.map((o) => ({ file: o.file, text: flat(plain(o.text)) }));
};

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

// The sentences as they read before this fix, one per place the review found, plus the two
// disclaimer sentences the PR itself introduced.
const FALSE_COPY_TS =
  'One deploy key exists and its entire power is pointing the registries at each other, three one-shot calls writing four address slots, each reverting the second time it is tried. That is the whole list of what any key can do here, and none of it is a path to your money.';
const FALSE_DISCLAIMER =
  'One privileged caller exists, the deploy key, and its entire power is wiring: three one-shot calls that write four registry-pointer slots and revert the second time each is tried. None of the four is a path to member funds.';
const FALSE_INDEX_HTML =
  'One deploy key exists and its whole power is wiring, three one-shot calls writing four address slots, none of them a path to your money.';
const FALSE_INCIDENTS =
  'There is exactly one privileged key, and it is spent at wiring: OperatorRegistry.wire, SubVaultRegistry.wire and Governance.wireSubVaultRegistry are each onlyDeployer and each revert once their slot is set, four registry-pointer slots in total.';
const FALSE_LAUNCH_ROW =
  '| Deployer EOA | operations | Deploys and wires the singletons; **no post-wiring authority**; no owner functions exist to hold |';
const FALSE_ALLOWLIST_V1 = "The factory's allowlist is set once, by a one-shot initialize call, with no add, no remove and no owner afterwards.";

const APPROVED_KEY =
  'One deploy key exists and every call it has is one-shot. On the Arc deployment live today those were three wirings writing four address slots, all already made. The same-address deployment built from the current source adds a fourth call, VaultFactory.initialize, that sets which price oracles the factory will accept.';
const APPROVED_ALLOWLIST_NEUTRAL = "The factory's allowlist is set once, when the factory is brought up, with no add, no remove and no owner afterwards.";
const APPROVED_ALLOWLIST_V2 = "On the same-address factory the allowlist is set once by VaultFactory.initialize, callable only by PROTOCOL_INITIALIZER.";

test('no public surface bounds the deploy key\'s power by the three wires without the fourth call and the deployment it belongs to', () => {
  const hits = [];
  for (const { file, text } of publicTexts()) for (const quote of deployKeyPowerHits(text)) hits.push({ file, quote });
  assert.deepEqual(
    hits,
    [],
    'PROTOCOL_INITIALIZER has FOUR one-shot calls on the same-address deployment: the three wires and\n' +
      'VaultFactory.initialize, which sets the oracle allowlist (an empty list leaves C-6 off for good).\n' +
      'The live Arc deployment has three, all made. Say which deployment each count describes, name the\n' +
      'fourth call, and do not claim the key is "not a path to your money" without justifying it.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('no public surface says the factory allowlist is set by initialize without naming the deployment it is true of', () => {
  const hits = [];
  for (const { file, text } of publicTexts()) for (const quote of unqualifiedInitializeHits(text)) hits.push({ file, quote });
  assert.deepEqual(
    hits,
    [],
    'The live Arc factory (plain CREATE) fixed its allowlist in its constructor and has no initialize.\n' +
      'The same-address factory built from current source sets it in a one-shot initialize. Name the\n' +
      'deployment, or use the version-neutral wording "set once, when the factory is brought up".\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('no public surface calls one of the deploy key choices the only one', () => {
  const hits = [];
  for (const { file, text } of publicTexts()) for (const quote of keyOnlyChoiceHits(text)) hits.push({ file, quote });
  assert.deepEqual(
    hits,
    [],
    'The three wire calls check only the caller and non-zero arguments, so the key also chooses which\n' +
      'factory, fee engine and sub-registry the registries point at; a wrong pointer blocks vault creation\n' +
      'or fakes track records. Enumerate what the key chooses; never call one choice the only one.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---- mutation probes: reintroduce each defect, confirm the shape catches it --------------------

test('probe: every false sentence the review found is caught', () => {
  for (const [name, s] of Object.entries({ FALSE_COPY_TS, FALSE_DISCLAIMER, FALSE_INDEX_HTML, FALSE_INCIDENTS, FALSE_LAUNCH_ROW })) {
    assert.ok(deployKeyPowerHits(flat(s)).length > 0, `${name} must be caught`);
  }
  assert.ok(unqualifiedInitializeHits(flat(FALSE_ALLOWLIST_V1)).length > 0, 'the unqualified initialize claim must be caught');
  assert.ok(
    unqualifiedInitializeHits(flat('Chainlink deprecates a blessed feed. The C-6 allowlist is set once by `VaultFactory.initialize` (callable once, by the protocol initializer only): no add, no remove, no owner afterwards.')).length > 0,
    'the LAUNCH-READINESS row 12 wording, whose dotted identifier once hid it from the shape, must be caught',
  );
  assert.ok(
    unqualifiedInitializeHits(flat('The oracle prices the assets it is constructed with, and the factory’s oracle allowlist is set once, by a one-shot initialize call, with no add, no remove and no owner afterwards.')).length > 0,
    'the risk-12 scope row wording must be caught',
  );
});

test('probe: the "only choice the key makes" sentences the review found are caught, and the enumerating wording passes', () => {
  for (const s of [
    'The allowlist is the one thing the key chooses, and a fake oracle on it is exactly the attack.',
    'That fourth call is the one choice the key makes that a later vault depends on.',
    'Each call works once, and factory.initialize is the one that chooses something: the oracle allowlist.',
    'The only decision the deploy key makes is the allowlist.',
  ]) {
    assert.ok(keyOnlyChoiceHits(flat(s)).length > 0, s);
  }
  for (const ok of [
    'The key chooses two kinds of thing: which addresses the registries point at and, on the same-address deployment, which oracles the factory accepts.',
    'That fourth call is the only one whose argument decides which price source a vault may use.',
    'factory.initialize is the one that decides which oracles a vault may use.',
  ]) {
    assert.deepEqual(keyOnlyChoiceHits(flat(ok)), [], ok);
  }
});

test('probe: the approved wording passes both shapes', () => {
  assert.deepEqual(deployKeyPowerHits(flat(APPROVED_KEY)), []);
  assert.deepEqual(unqualifiedInitializeHits(flat(APPROVED_ALLOWLIST_NEUTRAL)), []);
  assert.deepEqual(unqualifiedInitializeHits(flat(APPROVED_ALLOWLIST_V2)), []);
});

test('probe: a key sentence with the fourth call but no deployment qualifier, or the reverse, is still caught', () => {
  const noQualifier = 'One deploy key exists and its entire power is four one-shot calls, the last being initialize.';
  assert.ok(deployKeyPowerHits(flat(noQualifier)).length > 0, 'initialize without saying which deployment');
  const noFourth = 'One deploy key exists and its entire power is three one-shot wirings on the Arc deployment live today.';
  assert.ok(deployKeyPowerHits(flat(noFourth)).length > 0, 'a live/today qualifier without the fourth call');
  const looseLive = 'The deploy key\'s whole power is wiring. Vaults are live on Arc today; the initialize call is in the next paragraph.';
  assert.ok(deployKeyPowerHits(flat(looseLive)).length > 0, '"live" or "today" alone is not a deployment qualifier');
});

test('probe: "a fourth call" counts as the fourth call in copy that names no function, "a fourth" alone does not', () => {
  const q = "On the Arc deployment live today the deploy key's whole power was three one-shot calls";
  assert.deepEqual(deployKeyPowerHits(flat(`${q}, and the same-address deployment adds a fourth call that sets the allowlist.`)), []);
  assert.ok(deployKeyPowerHits(flat(`${q}, and nothing else.`)).length > 0);
});

test('probe: the shape is not tied to one phrasing', () => {
  for (const s of [
    'The initializer key can do nothing but three wiring calls.',
    'The deployer key\'s only power is to wire the registries.',
    'Its whole power is wiring; the deploy key is spent at wiring.',
    'The deploy key does one thing, all it does is point three contracts at each other.',
    'The PROTOCOL_INITIALIZER has exactly one privileged job: four address slots.',
  ]) {
    assert.ok(deployKeyPowerHits(flat(s)).length > 0, s);
  }
  // Documented limit: "can do nothing but" carries no cue word and passes.
  assert.deepEqual(deployKeyPowerHits(flat('The initializer key can do nothing but wire.')), []);
});

test('probe: a table row without a full stop is covered, and prose that is not about the key is left alone', () => {
  assert.ok(deployKeyPowerHits(flat('| Deployer EOA | ops | Deploys and wires; **no post-wiring authority** |')).length > 0);
  assert.deepEqual(deployKeyPowerHits(flat('VaultDeployer holds no authority and its only job is to CREATE vaults.')), []);
  assert.deepEqual(deployKeyPowerHits(flat('Six singleton deploys, three wire calls, plus the oracle deploy landed in eleven blocks.')), []);
});
