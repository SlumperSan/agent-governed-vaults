// @ts-check
/**
 * The Robinhood Chain mainnet claims are bound to the deployment record — mechanically.
 *
 * ## Why this file exists, and why it is RED on the branch that introduces it
 *
 * On 2026-09-04 the owner decided to deploy and operate on Robinhood Chain mainnet (chain 4663).
 * Every public surface in this repository then said, in ten pinned copies of one banner and dozens
 * of shorter fragments, that nothing was deployed to mainnet. Rewriting those sentences is easy;
 * rewriting them into a *second* set of unsourced assertions is easier still, and that is the
 * failure this file exists to make impossible.
 *
 * So the prose was written with placeholders — `{{RH_DEPLOYED_AT}}`, `{{RH_FACTORY}}`,
 * `{{RH_SMOKE_VAULT}}` — and this test asserts two things that cannot both be satisfied until the
 * deployment has actually happened:
 *
 *   1. `contracts/config/deployments/robinhood-mainnet.json` exists and carries chain 4663, a
 *      deployment date, the factory, a determinate answer on the first vault, and an oracle block
 *      matching what the prose says about that chain; and
 *   2. no placeholder survives anywhere in the tree, and every surface that cites a value from the
 *      record carries the value the record actually holds.
 *
 * Until the record is committed this file FAILS, and that is its purpose, not a defect. The claims
 * cannot land before the fact they describe. **It must never be made to skip.** A skipped test on a
 * missing file is indistinguishable from a passing one in a summary line, which is the exact shape
 * of the soak's inert freeze-safety leg (`SOAK_VAULTS` read but never set: an empty `.map()` and an
 * all-clear read the same).
 *
 * ## The vault is TWO states, and the guard asserts which one the prose is written for
 *
 * The singletons and vault #1 are different events with a gap between them: `VaultFactory` went in
 * on 2026-09-05 and `factory.vaultCount()` read 0 at the record's read block, because the vault has
 * to be created BY THE CREATOR SAFE and that transaction had not happened. The first version of
 * this file required `smokeVault.address` to be a 20-byte address unconditionally, which would have
 * held #211 red until the Safe acted — and, worse, invited whoever got tired of that to write a
 * first-vault address into prose ahead of the chain.
 *
 * So the vault leg is now symmetric, and it pins the prose to the state the record is in:
 *
 *   - `smokeVault === null` — the record must also carry
 *     `verifiedWiring["factory.vaultCount()"] === 0`, the chain read that substantiates it, and
 *     every surface listed under `vault` in `CITES` must carry `NO_VAULT_PHRASE` verbatim.
 *   - `smokeVault.address` present — it must be a 20-byte address, every one of those surfaces must
 *     carry it, and NONE of them may still carry `NO_VAULT_PHRASE`.
 *
 * The second half of each branch is the half that matters. Requiring the address when it exists is
 * the original mechanism; forbidding the no-vault sentence in the same breath is what stops the
 * copy surviving the event it denies. Neither branch can be satisfied by a file that hedges: the
 * record says null or it says an address, and the prose says one thing or the other.
 *
 * `contracts/config/deployments/robinhood-mainnet.json`'s own `smokeVaultNote` still describes the
 * unconditional version of this leg and says #211 cannot go green until vault #1 exists. That
 * paragraph is stale as of this change. It is not edited here, because a claims guard does not get
 * to rewrite the record it checks — whoever next updates that file for the vault owns it.
 *
 * ## What it deliberately does NOT do
 *
 * It does not fabricate the record, and nobody should. A stub `robinhood-mainnet.json` with
 * plausible addresses is a fabricated record of an on-chain event, and it would turn this whole
 * mechanism into theatre — the file would go green while every address in it was invented. The
 * record is written by whoever broadcasts, from what the chain returns.
 *
 * It does not restate the vault's parameters — the cap, the exit fee, the proposal threshold. Those
 * are facts in the address book and readable on-chain; prose that repeats them acquires a second
 * copy that can drift, and `config-doc-truth.test.mjs` already pins the *reference* configuration's
 * copies of those numbers to `contracts/config/base-mainnet.json`. The site cites the directory.
 *
 * ## The companion leg config-doc-truth cannot carry
 *
 * `config-doc-truth.test.mjs`'s sequencer guard disarms on any sentence attributing the enforcement
 * to deploy time, because that used to be the whole truth. It is not any more: chain 4663 is exempt
 * from `DeployChainlinkOracle.requiresSequencerUptimeFeed`, so on the chain the protocol is
 * deployed on there is no deploy-time refusal either. The leg that closes that hole is here (it needs to know about
 * 4663, and that suite must not depend on a file that only exists after a broadcast).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECORD_REL = 'contracts/config/deployments/robinhood-mainnet.json';
const RECORD = path.join(REPO, ...RECORD_REL.split('/'));

/** The chain the prose names, in the one place this file is allowed to hardcode it. */
const CHAIN_ID = 4663;

/** Chainlink on Robinhood Chain publishes on this heartbeat, which is ChainlinkOracle's ceiling. */
const MAX_HEARTBEAT = 86_400;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const ZERO = `0x${'0'.repeat(40)}`;

/** The record key whose chain read substantiates "no vault has been created on it yet". */
const VAULT_COUNT_KEY = 'factory.vaultCount()';

/**
 * The sentence the no-vault state is written as, required verbatim on every surface that would
 * otherwise name the first vault — and FORBIDDEN on all of them once the record holds an address.
 *
 * One string rather than a pattern, so a page cannot satisfy this leg with a near-miss that reads
 * differently to a human ("no vault yet", "the vault is not live"). It stops at "created" because
 * the surfaces legitimately continue it four ways — "…created yet", "…created on it yet", "…created
 * on chain 4663", "…created, and vault #1 is the Safe's to create" — and requiring one of those
 * would be requiring a house style rather than a fact. It is embeddable mid-sentence on purpose:
 * every surface writes it into its own grammar and none of them has to quote a paragraph.
 */
const NO_VAULT_PHRASE = 'no vault has been created';

/**
 * Does `text` carry the no-vault sentence?
 *
 * Whitespace-collapsed and lowercased, because the sentence is prose: it wraps across a line break
 * in five of the eight surfaces that carry it, and it opens three of them (capital N). Neither
 * changes what a reader is told. Everything else about it is exact — a page that writes "no vault
 * exists yet" does not satisfy this, on purpose, because one agreed sentence is what makes the
 * forbidding half of this leg mean anything.
 */
const saysNoVault = (text) => text.replace(/\s+/g, ' ').toLowerCase().includes(NO_VAULT_PHRASE);

/**
 * Read the vault out of the record as one of exactly two states, or throw.
 *
 * A record that carries `smokeVault` as anything other than `null` or an object with a 20-byte
 * `address` is neither state, and the prose has nothing determinate to be written against — so it
 * fails here rather than silently taking the no-vault branch. That mattered: `?? {}` on a null
 * `smokeVault` yields `undefined` for `.address`, which is indistinguishable from a typo'd key.
 */
function vaultState(rec) {
  const raw = rec.smokeVault;
  if (raw === null) return { exists: false, address: '' };
  assert.ok(
    raw && typeof raw === 'object',
    `${RECORD_REL}: smokeVault is ${JSON.stringify(raw)}. It must be null — no vault created yet,` +
      ` and the prose says so — or an object carrying the first vault's 20-byte address. Anything` +
      ` else leaves every surface that mentions the first vault with nothing to be checked against.`,
  );
  const address = String(raw.address ?? '');
  assert.match(
    address,
    ADDR,
    `${RECORD_REL}: smokeVault is present but smokeVault.address is not a 20-byte address` +
      ` (${address}). Write the address the chain returned, or set smokeVault to null.${HOWTO}`,
  );
  return { exists: true, address };
}

// Built from parts so this file does not match its own sweep. `.mjs` is walked below precisely
// because it is in no other guard's walk, and five stale claims lived in `.mjs` comments for months
// on exactly that account.
const PLACEHOLDER = new RegExp(`\\{${'{'}RH_[A-Z_]+\\}${'}'}`, 'g');

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude', 'lib', 'out', 'cache', 'broadcast', 'coverage', 'artifacts',
]);

// Wider than claims-lede-truth's PUBLIC_EXT on purpose: a placeholder left in a source comment is
// as unshipped as one left in a heading, and nothing else walks these extensions.
const WALK_EXT = new Set(['.md', '.html', '.txt', '.json', '.mjs', '.js', '.sol', '.yaml', '.yml']);

/** Every file this guard sweeps, enumerated from the filesystem — never from a list. */
const walk = () => {
  const found = [];
  (function rec(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) rec(path.join(dir, entry.name));
      } else if (WALK_EXT.has(path.extname(entry.name))) {
        found.push(path.join(dir, entry.name));
      }
    }
  })(REPO);
  return found
    .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
    .filter((f) => !f.endsWith('package-lock.json'));
};

const read = (rel) => readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');

/**
 * Which surfaces must carry which values once the placeholders are substituted.
 *
 * A POSITIVE requirement may name its files — requiring too little never lets a falsehood through,
 * and this list is derived from where the placeholders were actually written. The negative half
 * (no placeholder anywhere) enumerates from the filesystem, per the rule in
 * `config-doc-truth.test.mjs`'s header.
 *
 * `date` is the record's calendar date; `factory` and `vault` are its addresses. The addresses are
 * the load-bearing half: a date could coincide with the decision date already in this prose, but an
 * address cannot be written from memory, so a surface listing `factory` or `vault` proves the
 * substitution was done from the record.
 */
const CITES = {
  'llms.txt': ['date', 'factory', 'vault'],
  'apps/site/llms.txt': ['date', 'factory', 'vault'],
  'README.md': ['date', 'factory', 'vault'],
  'docs/NOW.md': ['date', 'factory', 'vault'],
  'docs/LAUNCH-READINESS.md': ['date', 'factory', 'vault'],
  'docs/INCIDENTS.md': ['date', 'factory', 'vault'],
  'docs/vault/current-state.md': ['date', 'factory', 'vault'],
  // status.html is the only page carrying the addresses, so it is the only page whose
  // substitution can be proved rather than inferred: `date` alone could coincide with a
  // date already in the prose, and an address cannot be written from memory.
  'apps/site/status.html': ['date', 'factory', 'vault'],
  'apps/site/index.html': ['date'],
  // faq.html quotes the pinned status sentence, which carries the date and the address book's PATH
  // but no address — status.html is the only page that publishes addresses, deliberately, and
  // requiring a second copy here would be requiring the drift this file exists to catch.
  'apps/site/faq.html': ['date'],
  // risks.html was retired into disclaimers.html by #220; the page moved, the requirement did not.
  'apps/site/disclaimers.html': ['date'],
  'docs/DEPLOYMENT.md': ['date'],
  'docs/AUDIT-HANDOFF.md': ['date'],
  'docs/CHANGES-SINCE-REVIEWS.md': ['date'],
  'docs/REFERENCE-AGENT.md': ['date'],
  'docs/vault/HOME.md': ['date'],
  'docs/vault/launch-readiness-gates.md': ['date'],
  'docs/vault/go-to-market-plan.md': ['date'],
  'docs/vault/open-items.md': ['date'],
};

const HOWTO =
  `\n\nThe record is written by whoever broadcasts, from what the chain returns — never invented here.` +
  `\nIt takes the same shape as contracts/config/deployments/base-sepolia.json, which` +
  ` scripts/soak/deployment.mjs parses, and these claims read:` +
  `\n  chainId                        ${CHAIN_ID}` +
  `\n  deployedAt                     ISO-8601 instant of the deploy block` +
  `\n  singletons.VaultFactory        20-byte address` +
  `\n  smokeVault                     the first vault (created by the Safe), or null if none exists` +
  `\n  verifiedWiring["${VAULT_COUNT_KEY}"]  0 while smokeVault is null — the read that proves it` +
  `\n  oracle.sequencerUptimeFeed     ${ZERO} — no Chainlink uptime feed exists for this chain` +
  `\n  oracle.maxStalenessSeconds     ${MAX_HEARTBEAT} — the feeds' heartbeat, and ChainlinkOracle's` +
  ` MAX_HEARTBEAT ceiling (contracts/src/oracle/ChainlinkOracle.sol:98)` +
  `\n  verifiedWiring["factory.allowSubVaults()"]  what the factory returned, read back on-chain`;

/** Load the record, or fail with the schema the prose depends on. Never skips. */
function loadRecord() {
  assert.ok(
    existsSync(RECORD),
    `${RECORD_REL} does not exist, so every Robinhood Chain claim in this repository is` +
      ` unsourced and this branch is not mergeable. That is what this test is for: the prose was` +
      ` written to be true ONCE the record is committed, and it cannot land before it.${HOWTO}`,
  );
  return JSON.parse(read(RECORD_REL));
}

test('the Robinhood Chain deployment record exists and is chain 4663', () => {
  const rec = loadRecord();
  assert.equal(
    Number(rec.chainId),
    CHAIN_ID,
    `${RECORD_REL} records chainId ${rec.chainId}; every claim written against it names ${CHAIN_ID}.` +
      ` One of the two is wrong and prose is not the place to resolve it.`,
  );
});

test('the record carries the fields the prose cites', () => {
  const rec = loadRecord();
  const factory = (rec.singletons ?? {}).VaultFactory;
  assert.match(String(factory ?? ''), ADDR, `${RECORD_REL}: singletons.VaultFactory is not a 20-byte address (${factory})${HOWTO}`);
  const at = String(rec.deployedAt ?? '');
  assert.match(at, /^\d{4}-\d{2}-\d{2}T/, `${RECORD_REL}: deployedAt is not an ISO-8601 instant (${at})${HOWTO}`);
  assert.ok(!Number.isNaN(Date.parse(at)), `${RECORD_REL}: deployedAt does not parse as a date (${at})`);
  // Throws unless smokeVault is exactly one of the two states the prose can be written against.
  vaultState(rec);
});

test('a null smokeVault is backed by the vaultCount read that substantiates it', () => {
  // "No vault has been created on it yet" is a claim about the chain, not about a missing key. The
  // record makes it checkable by carrying the read: vaultCount() was 0 at its own read block. A
  // record that omits the vault AND omits the count states nothing a reader can verify, and the
  // pages that say there is no vault would be sourced to an absence.
  const rec = loadRecord();
  const vault = vaultState(rec);
  if (vault.exists) return;
  const wiring = rec.verifiedWiring ?? {};
  assert.ok(
    Object.prototype.hasOwnProperty.call(wiring, VAULT_COUNT_KEY),
    `${RECORD_REL}: smokeVault is null, so every public surface says "${NO_VAULT_PHRASE}" — but` +
      ` verifiedWiring[${JSON.stringify(VAULT_COUNT_KEY)}] is missing, so nothing in the record` +
      ` establishes it from the chain. Record what VaultFactory.vaultCount() returned;` +
      ` keys present: ${JSON.stringify(Object.keys(wiring))}${HOWTO}`,
  );
  assert.equal(
    Number(wiring[VAULT_COUNT_KEY]),
    0,
    `${RECORD_REL}: smokeVault is null but verifiedWiring[${JSON.stringify(VAULT_COUNT_KEY)}] is` +
      ` ${wiring[VAULT_COUNT_KEY]}. The factory has created ${wiring[VAULT_COUNT_KEY]} vault(s), so` +
      ` "${NO_VAULT_PHRASE}" is false on every surface that says it. Record the vault's address` +
      ` under smokeVault and rewrite those surfaces to name it.${HOWTO}`,
  );
});

test('the record agrees with what the prose says about that chain\'s oracle', () => {
  // These two are not bookkeeping. Every page that describes the Robinhood Chain vault says the
  // sequencer check does not execute there and that a price up to a day old is accepted; if the
  // record disagrees, the pages are wrong and this is where that is found.
  const rec = loadRecord();
  const oracle = rec.oracle ?? {};
  assert.equal(
    String(oracle.sequencerUptimeFeed ?? '').toLowerCase(),
    ZERO,
    `${RECORD_REL}: oracle.sequencerUptimeFeed is ${oracle.sequencerUptimeFeed}, not the zero address.` +
      ` Every surface says Chainlink publishes no L2 sequencer uptime feed for chain ${CHAIN_ID}, so the` +
      ` gate is skipped there. A non-zero feed makes all of them false.`,
  );
  assert.equal(
    Number(oracle.maxStalenessSeconds),
    MAX_HEARTBEAT,
    `${RECORD_REL}: oracle.maxStalenessSeconds is ${oracle.maxStalenessSeconds}. The prose says the feeds on` +
      ` this chain publish on ${MAX_HEARTBEAT} s, exactly ChainlinkOracle's MAX_HEARTBEAT` +
      ` (contracts/src/oracle/ChainlinkOracle.sol:98), and that a price up to a day old is accepted there.`,
  );
});

// This file is the one exemption, and it is the rulebook exemption rather than a convenience: the
// docstring above NAMES the three placeholders so a reader knows what to substitute, exactly as
// CLAUDE.md quotes a banned claim shape in order to prohibit it. A regex cannot tell a rule from a
// claim, so the rule's own file is excluded — and nothing else is, deliberately: an exemption LIST
// here would be the drift this guard exists to catch. If this file ever carries a placeholder
// anywhere but in prose explaining the mechanism, that is a defect no test will find for you.
const GUARD_SELF = 'scripts/test/claims-robinhood-deployment.test.mjs';

test('no placeholder survives anywhere in the tree', () => {
  const offenders = [];
  for (const rel of walk()) {
    if (rel === GUARD_SELF) continue;
    const text = readFileSync(path.join(REPO, ...rel.split('/')), 'utf8');
    for (const m of text.matchAll(PLACEHOLDER)) offenders.push(`${rel}: ${m[0]}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `these still carry an unsubstituted placeholder. Substitute the value from ${RECORD_REL} —` +
      ` the deployment date (YYYY-MM-DD), singletons.VaultFactory, smokeVault.address — in every one,` +
      ` then re-run. A placeholder in published prose is a claim with a hole where its source goes:\n  ` +
      offenders.join('\n  '),
  );
});

/**
 * No Robinhood Chain deploy date is written as a literal.
 *
 * The placeholder leg above is satisfied by ONE `{{RH_DEPLOYED_AT}}` on a page while a second
 * sentence three lines up asserts a date that was never the deploy date. That is not hypothetical:
 * it is what this file shipped with in its first round, on nineteen surfaces, including a section
 * heading three lines above its own placeholder and a published risks-page sentence. The date that
 * got written was the DECISION date — knowable on the day, and therefore easy to reach for — while
 * the deploy date is whatever the broadcast returns and is not knowable until it does.
 *
 * The discriminator is not "does a date appear near a deployment sentence". After substitution the
 * real date appears in exactly that position on every surface, and that is the mechanism working.
 * It is: **every date literal written in a deploy-date shape, about this chain, must equal the
 * record's own `deployedAt`.** That makes the leg RED before the broadcast (no record), RED for any
 * literal that disagrees with the record afterwards, and green only on a tree whose dates all came
 * from the record.
 *
 * Two design choices, because both have a failure mode the other does not:
 *
 *   - The legal forms are MASKED OUT of the text before the scan, not exempted by a window cue
 *     list. A mask names the exact strings this repository has agreed to write — the decision-date
 *     form `docs/vault/HOME.md:10` fixed, and dated authoring markers. A cue list grows one entry
 *     per surface that happens to trip it, which is how a guard ends up fitted to the tree it was
 *     written against rather than to the rule.
 *   - Scope is decided by the NEAREST chain token, not by "is 4663 anywhere nearby". A dated Base
 *     Sepolia record sitting in the same paragraph as a Robinhood sentence is a Base Sepolia
 *     record; a window test cannot tell those apart and would red the repository's own history.
 *
 * What it cannot catch, stated so the next reader does not trust it further than it goes: a deploy
 * date written without a date literal. Five banner markers said "…deployed to Robinhood Chain
 * mainnet (chain 4663) on that date", back-referencing a date earlier in the sentence. No date
 * regex reaches that construction; it was found by reading and fixed by hand.
 */
// The shape, matched in one regex rather than as "a date with a deployment word somewhere near it".
// `deploy` alone is excluded so `Deploy.s.sol` and `config/deployments/` are not predicates, and the
// gap forbids `.;:!?` so the match cannot span a sentence boundary — which is exactly what separates
// "deployed <date>" from "row 7 on <date> when the gate closed. The protocol is deployed…". The
// dates are written as `<date>` here rather than as literals so that this file does not match its
// own sweep, on the same reasoning as PLACEHOLDER above.
// The lookbehind is what makes the comment above true rather than aspirational. `deploy` alone was
// excluded so `Deploy.s.sol` would not be a predicate, but `deployment` and `deployments` were left
// in, so `contracts/config/deployments/…` and a link to `docs/DEPLOYMENT.md` both WERE predicates —
// which turned "an owner-approved weakening, dated <date> and recorded in docs/DEPLOYMENT.md" into a
// deploy-date claim about a filename. A deploy word immediately after a path separator is part of a
// path; nothing that is actually a claim is written that way.
const DEPLOY_VERB = String.raw`(?<![/\\])deploy(?:ed|ment|ments|ing)\b|holding real funds|it is running|running on a mainnet|went live`;
const SAME_CLAUSE = String.raw`[^.;:!?]{0,40}?`;
const DEPLOY_DATE_SHAPE = new RegExp(
  `(?:${DEPLOY_VERB})${SAME_CLAUSE}(?<after>(?<!\\d)20\\d{2}-\\d{2}-\\d{2}(?!\\d))` +
    `|(?<before>(?<!\\d)20\\d{2}-\\d{2}-\\d{2}(?!\\d))${SAME_CLAUSE}(?:${DEPLOY_VERB})`,
  'gi',
);
const RH_TOKEN = /robinhood|4663/gi;
const OTHER_CHAIN_TOKEN = /base sepolia|base mainnet|\b84532\b|\b8453\b|\bsepolia\b|\b31337\b|local node/gi;

/** The forms a date literal is allowed to take. Masked, character-for-character, before the scan. */
const LEGAL_DATE_FORMS = new RegExp(
  [
    // The decision date, in the form docs/vault/HOME.md:10 fixed and CLAUDE.md's rule follows.
    String.raw`(?:on |by |since |from |after )?the owner'?s decision (?:of|to deploy of) 20\d{2}-\d{2}-\d{2}`,
    String.raw`the owner (?:decided|approved) on 20\d{2}-\d{2}-\d{2}`,
    String.raw`on 20\d{2}-\d{2}-\d{2} the owner (?:decided|approved)`,
    // The sequencer-feed exemption is an owner APPROVAL of a weakening, dated the day it was given.
    // Same fact class as the decision date and masked for the same reason: it is a date on which
    // somebody decided something, never a date on which anything was broadcast. The noun is left
    // open because the repository writes both "exemption" and "weakening"; the discriminator is the
    // `owner-approved` prefix, which no deployment sentence carries.
    String.raw`owner-approved [a-z-]+,?\s*(?:of|dated)\s+20\d{2}-\d{2}-\d{2}`,
    String.raw`\(owner, 20\d{2}-\d{2}-\d{2}\)`,
    // Dated authoring markers: when a sentence was written or a row corrected, never when anything
    // was deployed. The verb is the whole discriminator, so it is enumerated rather than loosened.
    String.raw`(?:revised|added|updated|rewritten|written|recorded|corrected|correction|counsel:|note|until|before|since the|through the|shipped until)\s*(?:again\s*)?(?:on\s+|of\s+)?20\d{2}-\d{2}-\d{2}`,
    // Dated OBSERVATION markers — when a value was read from the chain, not when it was deployed.
    // `contracts/config/robinhood-mainnet.json` stamps every verified field `[ONCHAIN <date>]`, and
    // several of those fields are about OTHER contracts' deployments on 4663 (a WBTC that is not
    // there, a cbBTC that is), which is the nearest-chain-token rule working correctly against a
    // sentence that is nonetheless not about ours.
    String.raw`(?:onchain|on-chain|observed|sampled|read)\s*(?:on\s+)?20\d{2}-\d{2}-\d{2}`,
    // A bare parenthesised date is a dating annotation on a heading or a clause, not a claim about
    // when something was deployed — `### A second mainnet configuration, and the deployment made
    // from it (<date>)`, which dates the SECTION and not the broadcast. The trade is
    // stated rather than hidden: a deploy date written ONLY as `(<date>)` would pass this leg. No
    // surface in this repository writes one that way; every real instance found in the round that
    // motivated this leg was `deployed <date>`, `since <date>` or `<date> … deployment`.
    String.raw`\((?:owner, )?20\d{2}-\d{2}-\d{2}\)`,
    // A date used as an adjective for an authoring or soak-run event, not for the deployment.
    String.raw`20\d{2}-\d{2}-\d{2}\s+(?:pass|run|rewrite|failure|two-chain|drill|probe)`,
    // A date bound to a verb that is NOT a deployment: the gate row closed, the lifecycle passed,
    // the audit was attested. Naming the verb the date belongs to is what keeps this a rule about
    // grammar rather than a list of files that happen to trip it.
    String.raw`\b(?:passed|ran|closed|landed|merged|corrected|verified|re-verified|attested|triaged|reviewed|measured|drilled)\s+(?:on\s+)?20\d{2}-\d{2}-\d{2}`,
  ].join('|'),
  'gi',
);

/** Distance from `i` to the nearest match of `re` in `text`, or Infinity if there is none. */
const nearest = (text, i, re) => {
  let best = Infinity;
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) best = Math.min(best, Math.abs((m.index ?? 0) - i));
  return best;
};

test('no Robinhood Chain deploy date is written as a literal', () => {
  const rec = loadRecord();
  const truth = String(rec.deployedAt ?? '').slice(0, 10);
  assert.match(truth, /^\d{4}-\d{2}-\d{2}$/, `${RECORD_REL}: deployedAt has no calendar date to check against${HOWTO}`);
  const offenders = [];
  for (const rel of walk()) {
    const raw = readFileSync(path.join(REPO, ...rel.split('/')), 'utf8').replace(/\s+/g, ' ');
    // Masked to the same length, so offsets and the quoted excerpt still line up with the source.
    const text = raw.replace(LEGAL_DATE_FORMS, (m) => ' '.repeat(m.length));
    for (const m of text.matchAll(DEPLOY_DATE_SHAPE)) {
      const date = m.groups.after ?? m.groups.before;
      if (date === truth) continue;
      const i = (m.index ?? 0) + m[0].indexOf(date);
      // Scope by the NEAREST chain token: a dated Base Sepolia record in the same paragraph as a
      // Robinhood sentence is a Base Sepolia record, and a window test cannot tell those apart.
      if (nearest(text, i, RH_TOKEN) > nearest(text, i, OTHER_CHAIN_TOKEN)) continue;
      offenders.push(`${rel}: …${raw.slice(Math.max(0, i - 90), i + date.length + 90).trim()}…`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these write a Robinhood Chain deploy date as a literal that ${RECORD_REL} does not hold` +
      ` (deployedAt is ${truth}). The deployment date is whatever the broadcast returned; ${CHAIN_ID} was` +
      ` DECIDED on a date that is knowable in advance and is not the same fact. Substitute the record's` +
      ` date, or write the decision form — "on the owner's decision of <date>" — if that is what is` +
      ` meant:\n  ` +
      offenders.join('\n  '),
  );
});

test('every surface that cites the record carries the value the record holds', () => {
  const rec = loadRecord();
  const vault = vaultState(rec);
  const values = {
    date: String(rec.deployedAt ?? '').slice(0, 10),
    factory: String((rec.singletons ?? {}).VaultFactory ?? ''),
    vault: vault.address,
  };
  for (const [rel, wants] of Object.entries(CITES)) {
    assert.ok(existsSync(path.join(REPO, ...rel.split('/'))), `${rel} is listed as citing the deployment record but does not exist`);
    const text = read(rel);
    for (const want of wants) {
      // The one field with two truths. With no vault there is no address to require, so the
      // requirement becomes the sentence that says so — and the address form is forbidden by the
      // absence of anything to write. Once the vault exists the two swap, and the no-vault sentence
      // becomes the thing that must be gone: that is the half that stops stale copy outliving the
      // event it denies, which is exactly how "Not deployed to mainnet." survived the deploy.
      if (want === 'vault' && !vault.exists) {
        assert.ok(
          saysNoVault(text),
          `${rel} names the Robinhood Chain deployment, and ${RECORD_REL} holds smokeVault null` +
            ` with verifiedWiring[${JSON.stringify(VAULT_COUNT_KEY)}] 0 — no vault exists on chain` +
            ` ${CHAIN_ID}. This surface must say so, in these words: "${NO_VAULT_PHRASE}".` +
            ` A page that names a deployment and is silent about whether anything can be deposited` +
            ` into it reads as an invitation.`,
        );
        continue;
      }
      const v = values[want];
      assert.ok(v, `${RECORD_REL} has no ${want} to check ${rel} against`);
      // Addresses are compared case-insensitively: a record may hold the checksummed form and prose
      // may quote the lowercase one, and both name the same contract.
      const hay = want === 'date' ? text : text.toLowerCase();
      const needle = want === 'date' ? v : v.toLowerCase();
      assert.ok(
        hay.includes(needle),
        `${rel} cites the Robinhood Chain deployment but does not carry the ${want} from ${RECORD_REL}` +
          ` (${v}). Either the substitution was missed or the prose drifted from the record.`,
      );
      if (want === 'vault') {
        assert.ok(
          !saysNoVault(text),
          `${rel} names the first vault ${v} from ${RECORD_REL} AND still says "${NO_VAULT_PHRASE}".` +
            ` The vault exists; that sentence was written for the state before it did and is now` +
            ` false. Rewrite the surface rather than adding the address beside it.`,
        );
      }
    }
  }
});

test('no surface claims there is no vault once the record holds one', () => {
  // The leg above only reaches the CITES list. The no-vault sentence was written into prose that
  // does not cite an address — an INCIDENTS banner, a quickstart aside — and those are exactly the
  // surfaces nobody revisits on the day the vault lands. Enumerated from the filesystem for the
  // reason config-doc-truth's header gives: a negative that names its files is a negative that
  // misses the file added after it was written.
  const rec = loadRecord();
  const vault = vaultState(rec);
  if (!vault.exists) return;
  const offenders = [];
  for (const rel of walk()) {
    if (rel === GUARD_SELF) continue;
    if (rel === RECORD_REL) continue; // the record's own note explains its history
    const text = readFileSync(path.join(REPO, ...rel.split('/')), 'utf8').replace(/\s+/g, ' ');
    if (saysNoVault(text)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `${RECORD_REL} records the first vault at ${vault.address}, so "${NO_VAULT_PHRASE}" is false` +
      ` wherever it still appears. Rewrite each of these to name the vault, or to say what is true` +
      ` of it now:\n  ` + offenders.join('\n  '),
  );
});

test('the deploy script exempts chain 4663 from the sequencer uptime requirement', () => {
  // The prose says a deploy on 4663 proceeds without a sequencer uptime feed. On the tree this
  // branch forked from it does NOT: `requiresSequencerUptimeFeed` returned true for every chain but
  // 31337 and 84532, so the deploy would have reverted. The exemption therefore has to land before
  // the deployment can happen, and this pins the ordering rather than trusting it. A substring
  // match, because the function cannot be evaluated from JS — it covers both a literal `4663` and a
  // named constant whose value is written there.
  const script = read('contracts/script/DeployChainlinkOracle.s.sol');
  assert.ok(
    script.includes(String(CHAIN_ID)),
    `contracts/script/DeployChainlinkOracle.s.sol does not mention chain ${CHAIN_ID}, so` +
      ` requiresSequencerUptimeFeed still requires a sequencer uptime feed there and a deploy on that` +
      ` chain reverts. Every surface saying the vault on ${CHAIN_ID} prices with the gate skipped is` +
      ` describing a deployment that could not have been made. Land the exemption first.`,
  );
});

/**
 * The companion leg for `config-doc-truth.test.mjs`'s deploy-time exemption.
 *
 * That guard lets any sentence through that credits deploy-time enforcement, because while
 * `requiresSequencerUptimeFeed` covered every chain but two, "mandatory, enforced at deploy time"
 * was simply true. With chain 4663 exempt it is false about the chain the protocol is deployed on — and
 * the exemption waves it straight past. So: wherever prose credits deploy-time enforcement of the
 * sequencer feed, the exemption must be visible in the same breath.
 *
 * A WINDOW rather than a sentence, deliberately. The true form of this claim routinely spans
 * sentence boundaries — "…is mandatory. The enforcement sits at deploy time… The chains it does not
 * cover are…" — and a sentence-scoped rule would red the correct three-sentence construction while
 * passing a one-sentence universal that happened to avoid the word "sequencer".
 */
const DEPLOY_TIME = /deploy[- ]time|deploy script|at deploy|pre-deploy/gi;
// All three must be in the window, or the match is not this claim. "deploy script" alone appears in
// recovery instructions and in fork-test comments, and a guard that reds those gets deleted by the
// next person who hits it — the failure mode this repository's own claims tests warn about twice.
const SEQ_SUBJECT = /sequencer/i;
const SEQ_FEED = /uptime feed/i;
const ENFORCEMENT = /\bmandator(?:y|ily)\b|\benforce(?:d|s|ment)?\b|\brequire(?:d|s|ment)?\b|\brefus(?:e|es|al)\b/i;
const EXEMPTION_VISIBLE = /4663|robinhood|exempt|does not cover|not all of them|enumeration|31337|84532/i;
const WINDOW = 400;

// Prose only, and not the guards themselves. A test file quoting the rule in order to enforce it is
// the same shape as a rulebook quoting a banned phrase in order to ban it; `.sol` and `.mjs`
// comments were swept by hand in the same commit and are covered by the placeholder leg above.
const PROSE_ONLY = new Set(['.md', '.html', '.txt', '.json']);

test('every claim of deploy-time sequencer enforcement says which chains it does not cover', () => {
  const offenders = [];
  for (const rel of walk()) {
    if (!PROSE_ONLY.has(path.extname(rel))) continue;
    if (rel.startsWith('docs/audit/') || rel.startsWith('docs/reviews/')) continue; // dated records
    const text = readFileSync(path.join(REPO, ...rel.split('/')), 'utf8').replace(/\s+/g, ' ');
    for (const m of text.matchAll(DEPLOY_TIME)) {
      const i = m.index ?? 0;
      const win = text.slice(Math.max(0, i - WINDOW), i + m[0].length + WINDOW);
      if (!SEQ_SUBJECT.test(win) || !SEQ_FEED.test(win) || !ENFORCEMENT.test(win)) continue;
      if (EXEMPTION_VISIBLE.test(win)) continue;
      offenders.push(`${rel}: …${text.slice(Math.max(0, i - 80), i + m[0].length + 80).trim()}…`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these credit deploy-time enforcement of the L2 sequencer uptime feed without saying which chains` +
      ` DeployChainlinkOracle.requiresSequencerUptimeFeed does NOT cover. It is an enumeration — a local` +
      ` node (31337), Base Sepolia (84532) and Robinhood Chain (${CHAIN_ID}) — and on an` +
      ` exempt chain there is no deploy-time refusal and no price-time gate, so nothing enforces the feed` +
      ` at all. Unqualified, the claim is false about the chain the protocol is deployed on:\n  ` +
      offenders.join('\n  '),
  );
});

test('probe: the deploy-time-scope guard is live', () => {
  // The shape that must be caught: the wording that was live on every surface before 2026-09-04,
  // and the wording config-doc-truth's exemption still waves through.
  const caught = (s) => {
    const text = s.replace(/\s+/g, ' ');
    for (const m of text.matchAll(DEPLOY_TIME)) {
      const i = m.index ?? 0;
      const win = text.slice(Math.max(0, i - WINDOW), i + m[0].length + WINDOW);
      if (!SEQ_SUBJECT.test(win) || !SEQ_FEED.test(win) || !ENFORCEMENT.test(win)) continue;
      if (EXEMPTION_VISIBLE.test(win)) continue;
      return true;
    }
    return false;
  };
  for (const claim of [
    // shipped, and false about chain 4663 since the Robinhood Chain deployment
    'A Chainlink L2 Sequencer Uptime Feed is mandatory, enforced at deploy time rather than at price time.',
    'On Base a Chainlink L2 Sequencer Uptime Feed is mandatory. The enforcement sits at deploy time rather than in the oracle.',
    // invented: never shipped, must still be caught
    'The sequencer gate protects the Robinhood Chain deployment because the uptime feed is required at deploy time.'.replace('Robinhood Chain', 'production'),
    'Every mainnet deploy requires a sequencer uptime feed; the deploy script enforces it.',
  ]) {
    assert.ok(caught(claim), `the guard no longer catches: ${claim}`);
  }
  // …and the corrected constructions must NOT trip it, or the fix trips its own guard.
  for (const ok of [
    'The deploy script refuses every chain it covers without a sequencer uptime feed; a local node, Base Sepolia and Robinhood Chain are the chains it does not cover.',
    'A Chainlink L2 Sequencer Uptime Feed is mandatory, enforced at deploy time, on the chains requiresSequencerUptimeFeed covers — 31337, 84532 and 4663 are exempt.',
  ]) {
    assert.ok(!caught(ok), `the guard false-positives on corrected prose: ${ok}`);
  }
});

/**
 * The Open Graph card is a claim nobody greps.
 *
 * `apps/site/assets/og-card.png` is a 1200x630 PNG whose strapline is rendered into pixels. No
 * claims guard can read pixels, so this pins the STALE file by digest: the card must be regenerated
 * before the copy that describes it ships, or the eight `og:image:alt` attributes describe an image
 * that says something else. This is the whole mechanism available, and it is enough to stop the
 * stale card landing.
 *
 * The digests below are of RETIRED cards, never of the wanted one. A positive pin would have to be
 * updated on every re-render — a font-hinting change is enough to move the bytes — and a guard that
 * has to be updated to stay green is a guard people update without reading.
 *
 * It is a SET, and it only ever grows. Each retirement adds a row and removes none, because
 * dropping the old digest to make room for the new one would quietly reopen the failure the old one
 * was catching: a revert, a bad merge or a stale checkout can put any previous card back, and the
 * card that says "Not deployed." is the one whose return would republish a false claim. Two rows so
 * far, and the reason each was retired is recorded next to it — a bare list of hashes is unreadable
 * within a week.
 *
 * The generator is `scripts/build-og-card.mjs`, whose `WORDMARK` and `STRAPLINE` constants are the
 * source of the words; run it, then re-read the eight alt attributes.
 */
const RETIRED_OG_CARDS = [
  {
    sha256: 'aa5a32e50adaf5b0c2b28526eaee03a12382514d76366ce2e5a724db2fb6bb8b',
    why: 'the light card whose strapline read "Built for Robinhood Chain. / Not deployed." — true'
      + ' when it was rendered on 2026-09-05 and false from the deployment onward',
  },
  {
    sha256: '4d5c46b1932b5559ff453f7e2dc280938e743758c7d5354da3bb85521e4331be',
    why: 'the light card headed "Agent-Governed Vaults", with the accent glyph and the rwally.com'
      + ' host line. Not false — retired on the owner\'s direction of 2026-09-05 for a dark card'
      + ' carrying the wordmark and the status line and nothing else',
  },
];

test('the Open Graph card is not one of the retired cards', () => {
  const buf = readFileSync(path.join(REPO, 'apps', 'site', 'assets', 'og-card.png'));
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  const hit = RETIRED_OG_CARDS.find((c) => c.sha256 === digest);
  assert.equal(
    hit,
    undefined,
    `apps/site/assets/og-card.png is a retired card: ${hit?.why}. Every page's og:image:alt` +
      ' describes the current one — a dark card carrying "Rwally" and "Deployed on Robinhood' +
      ' Chain." — and the alt text must describe the image a reader sees. Regenerate it with' +
      ' `node scripts/build-og-card.mjs` (it renders at 1200x630 and verifies the IHDR before' +
      ' overwriting), then APPEND the digest of the card you retired to RETIRED_OG_CARDS in this' +
      ' file. Append; do not replace a row, or the card it was catching can come back unseen.',
  );
});

/**
 * The one wiring fact the prose defers to the record rather than restating.
 *
 * `Deploy.s.sol` passes `allowSubVaults = false` and `DeployTestnet.s.sol` passes `true`, so the
 * value is a property of A FACTORY and not of the protocol — and there are now three factories. Every
 * surface that names it was rewritten to say "read `verifiedWiring["factory.allowSubVaults()"]` in
 * the Robinhood Chain record" instead of asserting either script's value, which is only an honest
 * instruction if the record actually carries that key. This asserts the key is PRESENT and says what
 * the launch path would set it to; it does not assert the value, because the deployer chooses which
 * script ran and inventing a constraint the record must satisfy is how a guard starts dictating
 * facts instead of checking them.
 */
const WIRING_KEY = 'factory.allowSubVaults()';

test('the record carries the wiring fact the prose sends readers to', () => {
  const rec = loadRecord();
  const wiring = rec.verifiedWiring ?? {};
  assert.ok(
    Object.prototype.hasOwnProperty.call(wiring, WIRING_KEY),
    `${RECORD_REL}: verifiedWiring[${JSON.stringify(WIRING_KEY)}] is missing. Several surfaces —` +
      ' llms.txt (both copies), docs/vault/root-vaults-only.md, docs/AUDIT-HANDOFF.md — tell a reader' +
      ' to read that key rather than assume either deploy script\'s value, and an instruction to read' +
      ' a key that is not there is worse than no instruction. Record what `VaultFactory.allowSubVaults()`' +
      ` returned on chain ${CHAIN_ID}. The launch path (Deploy.s.sol) constructs the factory with it` +
      ' false — root vaults only, the C-1 fix — so that is what a launch-path deploy should show;' +
      ` keys present: ${JSON.stringify(Object.keys(wiring))}${HOWTO}`,
  );
});
