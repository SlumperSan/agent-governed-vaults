/**
 * Claims/lede truth pins — who does what, and how a vote is weighted.
 *
 * The public lede said, in eight files and thirteen places:
 *
 *     "Permissionless vaults where AI agents pool USDC into spot crypto index baskets and govern
 *      rebalances by weighted vote."
 *
 * Two independent falsehoods, both checkable in `contracts/src` in under a minute:
 *
 *   1. WHO DOES WHAT. `Governance.propose` has no operator check — it gates on stake alone
 *      (`require(own > 0)`, then `own * BPS >= proposalThresholdBps * total`), so any member over
 *      the threshold may propose and an operator holding zero shares may not. `Governance.execute`
 *      has no `msg.sender` check at all. `isExecutor` returns `account == address(this)` — it names
 *      the Governance contract, not an operator ACL. A grep for `operator` over `Governance.sol`
 *      returns ZERO matches, and all three `require(msg.sender ...)` gates in `VaultCore` are
 *      `OnlyGovernance`. Operatorship confers no authority to vote, execute, pause, reprice, or move
 *      member funds; its only on-chain consequence is fee accrual through `FeeEngine`.
 *      (This sentence read "confers no on-chain authority over a deployed vault" until guard 6 was
 *      written — the retired universal, sitting in the header of the file that bans it. `.mjs` is
 *      not in `PUBLIC_EXT`, so the guard could not catch its own docstring. Sixth instance.)
 *
 *   2. "STAKE-WEIGHTED" IS NOT UNIVERSAL. `Governance.finalize` has THREE quorum regimes, not one.
 *      A `RuleChange` needs full consensus (`revealedWeight == snapshotTotal`). Below
 *      `SIGNER_REGIME_BELOW` (5) members it is `headMajorityWithStake || forStakeMajority`. Only at
 *      five or more members is it the pure stake quorum. **Vault #1 launches small**, so the first
 *      vault is in exactly the regime the word "stake-weighted" misdescribes.
 *
 * ## Why this is a test and not a list in a review comment
 *
 * Ops5 found seven bad sites by hand; enumerating with a grep found thirteen, including a claim on
 * the public risks page that was false in the OPPOSITE direction ("a regime that is stake-blind",
 * superseded by the H-8/CM-7 fix). A hand list is wrong the moment someone adds a file. So this
 * file follows `config-doc-truth.test.mjs`'s rule exactly:
 *
 *     A *positive* requirement may name its files — requiring too little never lets a falsehood
 *     through. A *negative* guard must NOT name its files, because the drift it exists to catch
 *     arrives in the file nobody added to the list.
 *
 * Every guard below is negative, so every one of them enumerates public surfaces from the
 * filesystem and matches by SHAPE, not by one phrasing.
 *
 * ## SCOPE: THIS FILE GUARDS THE REPOSITORY ONLY. THE OTHER HALF IS UNGUARDED.
 *
 * State this plainly rather than let it be inferred, because a check scoped to one store does not
 * fail on the other — it passes, which reads identically to being safe.
 *
 * The project's claim-bearing prose lives in TWO stores. This repo is one. The other is the
 * Obsidian vault, which holds the counsel pack, the ToS draft, the outreach templates, the website
 * copy and the go-to-market hooks — by volume the most claim-dense prose in the project, and the
 * half with the highest consequence. It has no CI, and several agent sessions edit it live.
 *
 * That gap is not hypothetical. The sweep that produced this file ran over the repo and therefore
 * could not see `Business/Legal/Product Description for Counsel.md`, which carried three of the
 * exact defects fixed here plus a §4-forbidden exit claim — in the document that seeds the
 * securities memo. Two peers found it by hand. This file structurally could not have.
 *
 * The two names above are a CITATION AND AN INVENTORY, not a live process, and after 2026-09-04
 * they are the only reason the word survives in this file. On that date the owner removed the
 * review-marker workflow outright — "The audit counsel is now becoming an issue with
 * repetitiveness. Remove them entirely so that we can work faster." — so the eighty `apps/site`
 * markers are gone and `apps/site/test/site.test.mjs` reds if one returns. Neither line here was a
 * rule: nothing in this file has ever exempted a marked block from a guard, and there is nothing
 * to delete. They were left standing deliberately, because renaming a document that exists and a
 * historical sweep that happened would make this comment point at nothing, which is a worse
 * outcome than a stale-looking word.
 *
 * DO NOT "FIX" THIS BY POINTING THE WALK AT THE VAULT. That was tried: an Ops5 sweep of the vault's
 * claim-bearing stores returned **181 hits**, and the large majority were not defects at all — they
 * were guardrails quoting a banned phrase IN ORDER TO BAN IT (`core-claims-doc` §4's forbidden
 * list, `incident-comms` §0's rules, the placement packets' do-not-say sections, dated correction
 * banners). A regex cannot tell *asserting* a claim from *prohibiting* one, so a naive widening
 * reds on its own rulebook, and the predictable next move — relaxing patterns until it goes quiet —
 * manufactures a green. A vault-side check needs its own design: either explicitly fenced guardrail
 * sections, or the honest acceptance that it emits a READ LIST, not a verdict.
 *
 * So the vault is a NAMED open item, tracked in `Rules/claims-surface-spans-two-stores.md`, and not
 * a silent one. Anyone extending this file: widen the store only together with that design.
 *
 * **SCOPE HAS A SECOND AXIS, AND IT IS THE ONE THAT ACTUALLY BIT.** The paragraphs above draw the
 * boundary at the STORE (repo vs vault) and a reader finishes them believing the repo is covered.
 * It is not: coverage inside the repo is bounded by `PUBLIC_EXT`, and the first version of this
 * file omitted `.json` — which is where three live falsehoods were sitting, in
 * `contracts/config/*.json`, inside this file's own PR. The store axis was the one under
 * discussion; the file-type axis was the one with the defect behind it.
 *
 * Both axes must be stated wherever this file's scope is described. Neither is more real than the
 * other, and a check that names one boundary convincingly is how the other one goes unexamined.
 *
 * ## What is deliberately NOT banned
 *
 * The product is called the Agent-Governed Index Vault Protocol. Banning `agent-governed` would red
 * the repo's own name, `VaultCore.sol`'s NatSpec and the design docs — and the next person to hit
 * that weakens the gate instead of the copy. So these guards target the ATTRIBUTION
 * CONSTRUCTIONS (an agent *pooling*, an agent *governing*, a *universal* weighting claim), never the
 * product name.
 *
 * Since 2026-09-05 the same applies to the positioning phrase `the AI agent trading index`, which is
 * masked by name in `PRODUCT_PHRASES` before guard 1 runs, and whose exemption has its own probe
 * immediately after that guard. It used to pass by accident — the verb alternation carried
 * `trade|trades` and not `trading` — and an accident is not an exemption: the participles are banned
 * now, and the phrase is permitted deliberately.
 *
 * Likewise "stake-weighted" is not banned outright — it is TRUE at five or more members, and
 * `THREAT-MODEL.md` AG-3/SV-1 use it correctly as analysis. Guard 3 is a CO-OCCURRENCE rule: a file
 * may say "stake-weighted" only if it also carries the sub-five qualifier. That leaves correct
 * analytical prose alone and still goes red on the new file next week, which is the entire point.
 *
 * Guard 3's scope is the FILE, and that is deliberately coarse — a mutation probe carrying an
 * unqualified "stake-weighted" in one paragraph and "below five members" in an unrelated one stays
 * green. Tightening it to the paragraph would red the many files that state the qualifier once and
 * then use the short word correctly throughout, which is good writing. File scope is the setting
 * that catches the drift (a NEW file repeating the unqualified claim) without punishing prose that
 * has already told the reader the truth. Every other guard here is match-scoped, not file-scoped.
 *
 * ## RECORD_DIRS — honored by guard 4 ONLY, and here is the distinction
 *
 * `config-doc-truth.test.mjs` exempts dated records from exactly one of its guards, deliberately.
 * Same here: **only guard 4 honors RECORD_DIRS.** Guards 1, 2, 3 and 5 exempt nothing.
 *
 * The line that matters is not which directory a file sits in, it is what the sentence DOES:
 *
 *   - **A finding keeps the name it was filed under.** `docs/audit/AI-AUDIT-REPORT.md` titles H-8
 *     "The `<5`-member quorum regime is stake-blind". That was true when written, it is how every
 *     cross-reference in the repo addresses the finding, and editing it would falsify a dated
 *     record. Exempt.
 *   - **A sentence claiming what the code does TODAY must be true today.** `ARCHITECTURE.md`'s
 *     "<5 members: absolute signer counts" was a present-tense spec row describing code the
 *     H-8/CM-7 remediation replaced. Not exempt — and it was fixed rather than exempted.
 *
 * That is why guard 4's second escape hatch is a REMEDIATION-STATUS word in the window rather than
 * a finding reference: `ARCHITECTURE.md`'s false row cited CM-7 too, so a bare finding-reference
 * exemption would have waved the false claim straight through. Prose naming the old behaviour
 * *and* its status in the same breath ("H-8 ... partially fixed in code") is a record; prose that
 * names it flatly is a claim.
 *
 * Note what is NOT exempt: `docs/audit/README.md` is a *current* one-paragraph system summary
 * handed to reviewers, not a dated review, and it carried the defective lede — guards 1 and 2 cover
 * it, and they honor no exemptions at all.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The banned-shape regexes below are factored into `scripts/lib/claims-shapes.mjs` so
// `claims-web-prose-truth.test.mjs` (the guard scoped to `apps/web/src/*.mjs`, card #68) can reuse
// this exact shape set instead of a second, independently-maintained copy. This file still owns
// the reasoning for each shape (why it is banned, the approved replacement wording) in the
// comments immediately above where each one is used below — only the regex literals moved.
import {
  flat,
  sentencesOf,
  AGENT_ACTS,
  PRODUCT_PHRASES,
  maskProductPhrases,
  UNIVERSAL_WEIGHTED,
  STAKE_WEIGHTED,
  SUB_FIVE_QUALIFIER,
  STAKE_BLIND,
  REMEDIATION_STATUS,
  DENIED,
  ONCHAIN_MEMBER_GATE,
  POWER_CLAIM,
  ENUMERATION_FOLLOWS,
  FEE_BYPASSES_OPERATOR,
  RWLY_ATTRIBUTION,
  RWLY_BACKED_BY_VAULT,
} from '../lib/claims-shapes.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Build outputs, dependencies, vendored submodules and other agents' worktrees are not our prose.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.claude',
  'lib',
  'out',
  'cache',
  'broadcast',
  'coverage',
  'artifacts',
]);

// The surfaces a reader actually reads. Extensions, not a file list (see the header).
//
// `.json` is here because leaving it out hid three live falsehoods inside this file's own PR:
// `contracts/config/*.json` carried "the `<5`-member signer quorum regime is stake-blind" in
// `minDepositNote` — the note a vault creator reads to choose `minDepositUsdc`, which IS the
// entire H-8 mitigation. Config prose is prose. A reader acts on it, so it is a public surface.
const PUBLIC_EXT = new Set(['.md', '.html', '.txt', '.json']);

/** Every public prose surface in the repository, enumerated from the filesystem — never a list. */
const publicSurfaces = () => {
  const found = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (PUBLIC_EXT.has(path.extname(entry.name))) {
        found.push(path.join(dir, entry.name));
      }
    }
  })(REPO);
  return found
    .map((f) => path.relative(REPO, f).split(path.sep).join('/'))
    // package-lock and similar generated text are not prose.
    .filter((f) => !f.endsWith('package-lock.json'));
};

/**
 * THE FLOOR BELONGS HERE, NOT ONLY ON `publicSurfaces()`.
 *
 * `every prerendered page is inside the walk` floors `publicSurfaces()`, and that is the function
 * it reads. The seven content guards read THIS one. The two are a `.map()` apart, and nothing tied
 * them together: with `surfacesWithText` returning `[]` and `publicSurfaces` untouched, all 11
 * tests in this file stayed green -- 78 ms against a 544 ms baseline -- while the agent-attribution,
 * weighted-vote, stake-weighted, stake-blind, operator-power, deposit-screening and
 * RWLY-attribution guards each reported "no offending prose" having read no prose at all. That is
 * a floor on one property standing in for a floor on a neighbouring one, which is the adjacency
 * this repository rejects reviews over.
 */
const surfacesWithText = () => {
  const withText = publicSurfaces().map((f) => ({ file: f, text: readFileSync(path.join(REPO, f), 'utf8') }));
  assert.ok(
    withText.length >= 50,
    `the public-surface walk returned ${withText.length} file(s). Every guard below is NEGATIVE -- ` +
      'it reports the prose it found -- so an empty corpus is indistinguishable from a clean one.',
  );
  return withText;
};

const report = (hits) =>
  hits.map((h) => `  ${h.file}: "${h.quote.trim()}"`).join('\n');

// ---------------------------------------------------------------------------------------------
// Guard 1 — an AI agent does NOT pool, and does NOT govern.
//
// Matched by shape: an "agent"-ish subject within a few words of pool/govern/manage/trade. Catches
// "AI agents pool USDC", "agents govern rebalances", "governed by AI agents", "agent-governed index
// baskets" (as a mechanic), and phrasings nobody has written yet.
// ---------------------------------------------------------------------------------------------
// The subject/verb gap below is ADVERBS ONLY, never `\w+`. An arbitrary word gap made
// "agent identity that proposes rebalances" match as agent + <gap> + `rebalances`, reading a NOUN
// object as the verb and reddening `operators.html`, which describes the operator role correctly.
// "AI agents pool ...", "agents govern ...", "the agent manages ...", "agents trading ..."
//
// THE -ING FORMS WERE ADDED 2026-09-05, and the reason is worth recording because it was luck
// rather than design that the gap did no damage. The owner's positioning phrase is "the AI agent
// trading index", and this alternation carried `trade|trades` but not `trading` — so the phrase
// passed a guard that would have reddened "agents trade" one letter away. A guard that permits a
// phrase by oversight permits everything else the oversight covers, and the next editor closes it
// without knowing the product name depends on the hole. So: the participles are banned like every
// other form, and the product phrase is permitted BY NAME in PRODUCT_PHRASES below.
//
// "... governed by AI agents", "... pooled by agents"
//
// "agent-governed index baskets" used as a MECHANIC (a basket the agent governs), as distinct
// from the product name "Agent-Governed Index Vault Protocol" / "agent-governed vaults".
// (AGENT_ACTS itself is imported from `../lib/claims-shapes.mjs` — see this file's header.)

/**
 * Product names, permitted BY NAME rather than by an accident of the alternation above.
 *
 * `the AI agent trading index` is the owner's positioning phrase of 2026-09-05 and it names WHAT
 * THE INDEX IS ABOUT — what autonomous agents would hold if they had to argue for it and win a vote
 * — not who executes. It is not the banned shape, which is an agent as the SUBJECT of pooling or
 * governing: `Governance.propose` gates on stake, and `Governance.sol` contains zero occurrences of
 * "operator". The two read alike to a regex and differ entirely to a reader, so the phrase is masked
 * character-for-character before the scan, the way this repository's other guards mask a legal form.
 *
 * Keep this list to exact product phrases. It is not a place to park a sentence that is merely
 * inconvenient: anything added here stops being checked, everywhere, forever.
 * (PRODUCT_PHRASES and maskProductPhrases are imported from `../lib/claims-shapes.mjs`.)
 */

test('no public surface says an AI agent pools capital or governs a vault', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = maskProductPhrases(flat(text));
    for (const re of AGENT_ACTS) {
      for (const m of hay.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'Members pool and vote; an AI operator does neither on-chain.\n' +
      '`Governance.propose` gates on stake, not operatorship (require(own > 0), then the\n' +
      'proposalThresholdBps check) and `Governance.sol` contains ZERO occurrences of "operator".\n' +
      'All three require(msg.sender ...) gates in `VaultCore` are OnlyGovernance.\n' +
      'Say "members pool ... and ratify every rebalance by on-chain vote", and attribute proposing\n' +
      'to STAKE ("proposal rights follow stake, not operatorship"), never to operatorship.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('probe: the product-phrase exemption covers the phrase and nothing around it', () => {
  const caught = (s) => {
    const hay = maskProductPhrases(flat(s));
    return AGENT_ACTS.some((re) => {
      re.lastIndex = 0;
      return re.test(hay);
    });
  };
  // The permitted phrase, in the shapes it actually ships in.
  //
  // THE SHORT FORM IS THE ONE THAT SHIPS NOW. On 2026-09-09 the owner asked the site to stop
  // reading as a one-chain site, and the positioning line lost its chain: the hero, the README and
  // the three llms.txt copies all say "RWAlly is the AI agent trading index." The long form stays
  // listed beside it because it is still in the history and a reader who finds it there should not
  // have to wonder whether it was ever permitted -- and because a permit list that only accepts the
  // current wording turns every future copy edit into a guard edit made under deadline.
  for (const ok of [
    'Rwally is the AI agent trading index.',
    'Rwally is the AI agent trading index on Robinhood Chain.',
    'An AI agent trading index, made checkable.',
  ]) {
    assert.equal(caught(ok), false, `the guard reds the owner's own product phrase: ${ok}`);
  }
  // …and the banned shapes must still be caught, including the participles added with it and a
  // sentence that opens with the permitted phrase and then makes the false claim anyway.
  for (const bad of [
    'AI agents pool USDC into spot crypto index baskets.',
    'Agents trading the basket decide what it holds.',
    'The AI agent trading index is governed by AI agents.',
    'Rwally is the AI agent trading index, and its agents govern every rebalance.',
    'agent-governed index baskets rebalance on a schedule',
  ]) {
    assert.equal(caught(bad), true, `the guard no longer catches: ${bad}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Guard 2 — no universal "weighted vote" claim in a lede.
//
// "govern rebalances by weighted vote" / "commit-reveal weighted vote" asserts one weighting rule
// for all vaults. There are three. Matched by shape rather than by the one sentence that shipped.
// ---------------------------------------------------------------------------------------------
// UNIVERSAL_WEIGHTED is imported from `../lib/claims-shapes.mjs` — see this file's header.

test('no public surface claims a single universal weighted-vote regime', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    for (const re of UNIVERSAL_WEIGHTED) {
      for (const m of hay.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    '`Governance.finalize` has THREE quorum regimes, not one:\n' +
      '  - RuleChange      -> full consensus (revealedWeight == snapshotTotal)\n' +
      '  - memberCount < 5 -> headMajorityWithStake || forStakeMajority (SIGNER_REGIME_BELOW)\n' +
      '  - memberCount >= 5 -> the pure stake quorum\n' +
      'Vault #1 launches small, so the FIRST vault is in the middle regime.\n' +
      'Say "ratify every rebalance by on-chain vote" and qualify any weighting claim.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 3 — "stake-weighted" is allowed ONLY beside its sub-five qualifier (co-occurrence).
//
// This is the guard that pays for itself: it leaves correct analytical prose (THREAT-MODEL AG-3,
// the FAQ) alone, and reds the NEW file that repeats the unqualified claim.
// ---------------------------------------------------------------------------------------------
// STAKE_WEIGHTED and SUB_FIVE_QUALIFIER are imported from `../lib/claims-shapes.mjs`.

test('every "stake-weighted" claim carries its sub-five-member qualifier', () => {
  const offenders = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    if (STAKE_WEIGHTED.test(hay) && !SUB_FIVE_QUALIFIER.test(hay)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    'These files say "stake-weighted" without ever qualifying it.\n' +
      'Stake weighting is the regime only at FIVE OR MORE members. Below SIGNER_REGIME_BELOW (5),\n' +
      '`Governance.finalize` uses `headMajorityWithStake || forStakeMajority`, and a RuleChange\n' +
      'requires full consensus. Unqualified, the word is a falsifiable claim about vault #1.\n' +
      'Fix by qualifying in the same file (e.g. "stake-weighted at five or more members"), not by\n' +
      'adding the file to an exemption list — there is deliberately no exemption list.\n' +
      `Offending files:\n  ${offenders.join('\n  ')}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 4 — the sub-five regime is NOT stake-blind (the risks page had this backwards).
//
// H-8/CM-7 replaced a pure head count with `headMajorityWithStake || forStakeMajority`. Both
// branches weigh stake. Prose still calling that regime stake-blind, or a pure/absolute signer
// count, describes code that no longer exists — a falsehood in the safety-understating direction,
// which is still a falsehood.
// ---------------------------------------------------------------------------------------------
// STAKE_BLIND, REMEDIATION_STATUS and DENIED are imported from `../lib/claims-shapes.mjs`.
// `de-stake-blind` is the NAME OF THE FIX (PR #44); the lookbehind stops it matching as a claim.
// REMEDIATION_STATUS is deliberately NOT a finding-reference test (`H-8`/`CM-7`): ARCHITECTURE.md's
// false spec row cited CM-7 too, so that rule would have waved it through. DENIED is deliberately
// narrow — an explicit negation in the ~40 characters immediately BEFORE the match. An earlier
// version tested a bare `\bnot\b` anywhere within 120 characters either side, which exempts almost
// any prose and caught nothing.

// Dated records only — see the RECORD_DIRS section of the header. Guard 4 is the ONLY guard here
// that honors this, matching config-doc-truth.test.mjs's deliberate single-guard exemption. This
// one stays local (not in claims-shapes.mjs): it names REPO directories, and `apps/web/src` has no
// dated-record subdirectory for `claims-web-prose-truth.test.mjs`'s analogous guard to honor.
const RECORD_DIRS = ['docs/audit/', 'docs/reviews/'];

test('no public surface describes the sub-five regime as stake-blind', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    if (RECORD_DIRS.some((d) => file.startsWith(d))) continue;
    const hay = flat(text);
    for (const re of STAKE_BLIND) {
      for (const m of hay.matchAll(re)) {
        const i = m.index ?? 0;
        if (REMEDIATION_STATUS.test(hay.slice(Math.max(0, i - 200), i + 200))) continue;
        if (DENIED.test(hay.slice(Math.max(0, i - 60), i))) continue;
        hits.push({ file, quote: m[0] });
      }
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'The sub-five regime weighs stake in BOTH branches (H-8/CM-7):\n' +
      '  headMajorityWithStake = revealedVoterCount * 2 > memberCount\n' +
      '                          && forWeight * BPS >= quorumBps * snapshotTotal\n' +
      '  forStakeMajority      = forWeight * 2 > snapshotTotal\n' +
      'Calling it stake-blind, or a pure/absolute signer count, describes the PRE-fix code.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 5 — "permissionless" must not be paired with a claimed on-chain member gate.
//
// `VaultCore._deposit` has NO depositor allowlist (only minDepositUsdc + capacityCapUsdc) and
// `VaultFactory.createVault` has no msg.sender gate — its own NatSpec says "Permissionless". The
// word is TRUE, and the drift to pre-empt is the opposite one: copy that implies the CONTRACTS
// screen members, when the vault #1 allowlist is frontend-only, the same class as the geofence.
// ---------------------------------------------------------------------------------------------
// The gate must be a MEMBER gate to be a false claim. Requiring a member-ish noun inside the match
// beats excluding infrastructure nouns one at a time: the adapter, oracle, factory and
// target/selector allowlists are all real, and there will always be another one.
// ONCHAIN_MEMBER_GATE is imported from `../lib/claims-shapes.mjs`.

// ---------------------------------------------------------------------------------------------
// Guard 6 — the operator's powerlessness must be ENUMERATED, never claimed as a universal.
//
// The first version of this branch's own lede said the operator "holds no on-chain authority over
// a deployed vault". That is attackable, and Ops5 caught it: `FeeEngine.onFeeCollected` /
// `onFeeCollectedAsset` credit `claimableFees[registry.operatorAddressOf(opId)]`, and `claimFees`
// pays `claimableFees[msg.sender]` out to the caller. The operator address therefore holds a real,
// unilateral, on-chain right that nobody else has — the 10% performance fee. It is an ECONOMIC
// right, not a governance one, and the distinction is sound, but a universal negative invites a
// reader to find the one exception and they will find it in one transaction.
//
// So: enumerate. "operatorship confers no authority to vote, execute, pause, reprice, or move
// member funds" is unattackable and no longer than the sentence it replaces.
// ---------------------------------------------------------------------------------------------
// The first version of this guard listed three phrasings — "no privileged/special X", "no on-chain
// X", "operator has no X" — and a FIFTH instance of the shape walked straight past it, in this
// file's own PR: `risks.html`'s "It holds **no protocol-level privilege**". Not "privileged", not
// "on-chain", not "operator"; the noun was "privilege" rather than "power". The coverage failure was
// LEXICAL, not spatial — the walk had reached the file, the pattern had not reached the sentence.
//
// So do not enumerate phrasings. Match the SHAPE: "no <up to three modifiers> <power-noun>", with
// the modifier slot deliberately open to whatever the next author invents.
// The tell is a SCOPE-WIDENING modifier, not the noun. "no voting rights" and "no proposal rights"
// name a capability and are true and checkable; "no PRIVILEGED power" / "no PROTOCOL-LEVEL
// privilege" / "no ON-CHAIN authority" widen to everything and are the falsifiable form. A first
// draft of this guard matched any "no <modifier> <power-noun>" and reddened fourteen true, scoped
// statements across the repo — swinging from too lexical straight past correct into too broad.
//
// LIMIT, stated rather than implied: this catches the WIDENED form. A blanket claim built with no
// modifier at all ("the operator has no authority.") slips through, and that is accepted — the
// alternative reddens every scoped negation in the audit walkthroughs, and a guard that cries wolf
// on true prose gets weakened by the next author. Guards 1-5 share this property; none is a proof
// of absence.
// POWER_CLAIM is imported from `../lib/claims-shapes.mjs`.
//
// ...and exempt the one form that is NOT a universal: an ENUMERATION. The approved sentence reads
// "confers no authority to vote, execute, pause, reprice, or move member funds" — a list a reader
// can check item by item. "to <verb>, <verb>…" immediately after the noun is that shape. Anything
// else — a dash, a full stop, a scoping phrase like "over a deployed vault" — is the blanket form.
// (ENUMERATION_FOLLOWS is imported from the same module.)

test('the operator\'s lack of power is enumerated, never claimed as a universal', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    for (const m of hay.matchAll(POWER_CLAIM)) {
      const after = hay.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 120);
      if (ENUMERATION_FOLLOWS.test(after)) continue; // the approved, checkable form
      hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'The operator IS the sole recipient of the 10% performance fee:\n' +
      '  FeeEngine.onFeeCollected -> claimableFees[registry.operatorAddressOf(opId)][token] += amt\n' +
      '  FeeEngine.claimFees      -> pays claimableFees[msg.sender][token] to msg.sender\n' +
      'That is an economic right, not a governance one — but it IS an on-chain right nobody else\n' +
      'has, so a universal negative ("no privileged power", "holds no on-chain authority") is\n' +
      'falsifiable in one transaction. ENUMERATE instead:\n' +
      '  "operatorship confers no authority to vote, execute, pause, reprice, or move member funds"\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 7 — A VOTE AUTHORISES TRADES. IT DOES NOT AUTHORISE EVERY CHANGE.
//
// This family had NO guard at all until 2026-09-18, and the gap was not noticed because the file
// looks thorough: eleven tests, none of them about votes authorising anything. A file containing
// "Nothing rebalances until a proposal passes. No silent trades." passed every one. PR 306 was
// rejected for exactly this shape by a human, which is the only reason it did not ship.
//
// THE CLAIM SPLITS IN TWO AND THE HALVES HAVE OPPOSITE TRUTH VALUES. That is why one guard is not
// enough and why a single banned phrase would be wrong.
//
//   WHAT THE VAULT HOLDS changes constantly with no vote. Read VaultCore: `deposit` (:392, :403),
//   `activate` (:440 — its own NatSpec says "Callable by anyone"), `skipWindow` (:463),
//   `requestExit`/`settleQueuedExit` (:551, :591 — also callable by anyone), and
//   `pullChildEscrow` (:868), which is `external` with NO caller gate and credits `assetBalance`
//   directly. A blanket "nothing changes without a vote" is therefore FALSE TODAY, in seven places.
//
//   WHAT THE VAULT TRADES is gated. There are exactly THREE `msg.sender == address(governance)`
//   requires in VaultCore — :786, :824 and :900 — and the only call to
//   `IExecutionAdapter.executeSwap` in the contract sits inside the third of them,
//   `executeRebalance`. So "no silent trades" is TRUE today.
//
// A GUARD THAT BANNED THE TRADE CLAIM WOULD BE WRONG, AND ONE THAT PERMITTED IT WOULD GO SILENT
// EXACTLY WHEN IT MATTERS. The exit-swap change now being specified removes
// `require(msg.sender == address(governance))` from the only swap path in the protocol. The moment
// it lands, "no silent trades" becomes false and every surface carrying it becomes a false claim —
// and the plan of record assumes CI reds when copy and contract disagree.
//
// So guard 7b does not encode a verdict. IT READS THE CONTRACT AND RE-DERIVES ONE. A file may say
// the vault does not trade without a vote only while every `executeSwap` call site is enclosed by
// a governance require. When that stops being true the test reds, names the file making the claim
// AND the call site that falsified it, and the copy has to change in the same commit as the code.
// ---------------------------------------------------------------------------------------------

/**
 * The blanket form: a vote gates EVERYTHING. False in seven places, listed above.
 *
 * Leg 1 used to require the movement verb DIRECTLY after "nothing" / "no <noun>" (one optional
 * "ever"). That is a WORD SEQUENCE, not the claim's structure, and one interposed phrase slips
 * past it: "Nothing in a vault moves without a member vote" is the same false blanket as "nothing
 * changes without a vote", but the old regex passed it through undetected — recorded as card #71
 * while re-mutation-testing PR #312 on its rebased head. A regex tuned to that one extra example
 * would just as quietly miss the next reordering, so this replaces the word-sequence match with
 * the claim's actual STRUCTURE: a universal quantifier over the subject (nothing / no <noun> /
 * every <noun> / all <noun>) and a "without a vote/proposal" clause, both present in the SAME
 * sentence (via `sentencesOf`, so neither piece can bleed across a sentence boundary), in EITHER
 * order — "Without a vote, nothing moves." is exactly as false as the forward form.
 *
 * The verb set stays SCOPED to state-change verbs (changes/moves/happens/leaves/enters) and
 * deliberately excludes trade/rebalance/buy/sell/swap: those are TRADE_VOTE_CLAIMS' job, below,
 * because trading a vault's holdings genuinely IS gated by a vote today (guard 7b re-derives that
 * from VaultCore.sol on every run, rather than assuming it). Folding "traded" in here would red
 * "Nothing is traded without a vote; deposits and exits are yours." — a TRUE sentence that scopes
 * the vote requirement to the one path where it holds and explicitly disclaims it for the rest.
 *
 * The "one rule" leg below is KEPT, not folded in. The structural check needs a movement verb,
 * and the PR 305/306 lede shape also comes verbless: "One rule: nothing without a vote." carries
 * the same false blanket with no verb for the structure to find (Security, #429 review).
 */
const UNIVERSAL_QUANTIFIER_VERB =
  /\b(?:nothing|no\s+\w+|every\s+\w+|all\s+\w+)\b(?:\s+\w+){0,4}?\s+\b(?:changes?|moves?|happens?|leaves?|enters?)\b/gi;
const WITHOUT_VOTE_CLAUSE = /\bwithout\s+(?:a\s+)?(?:\w+\s+){0,2}?(?:vote|votes|voting|proposal)\b/gi;

/** True structural hit: both pieces present in the same sentence, order-independent. */
const isBlanketVoteSentence = (sentence) => {
  UNIVERSAL_QUANTIFIER_VERB.lastIndex = 0;
  WITHOUT_VOTE_CLAUSE.lastIndex = 0;
  return UNIVERSAL_QUANTIFIER_VERB.test(sentence) && WITHOUT_VOTE_CLAUSE.test(sentence);
};

const BLANKET_VOTE_CLAIMS = [
  // "every change is decided by vote", "all changes require a vote"
  /\b(?:every|each|all)\s+(?:change|movement|action)s?\b[^.]{0,40}?\b(?:requires?|needs?|decided by|gated by)\s+(?:a\s+)?(?:vote|proposal)\b/gi,
  // "one rule: nothing changes without a vote", and the verbless "one rule: nothing without a vote"
  // — the PR 306 / PR 305 lede shape. Kept: the structural check needs a verb (see above).
  /\bone rule\b[^.]{0,30}?\bnothing\b[^.]{0,40}?\bwithout\s+(?:a\s+)?vote\b/gi,
];

/** The TRADE form. True today; guard 7b re-derives that from the contract rather than assuming. */
const TRADE_VOTE_CLAIMS = [
  /\bno\s+silent\s+trades?\b/gi,
  /\bnothing\s+(?:is\s+)?(?:trades?|traded|rebalances?|rebalanced|bought|sold|swapped)\b[^.]{0,40}?\b(?:until|unless|without)\b[^.]{0,30}?\b(?:vote|proposal|passes|approved)\b/gi,
  /\bonly\s+a\s+(?:passed|approved|winning)\s+proposal\b[^.]{0,40}?\b(?:moves|trades|swaps|rebalances|buys|sells)\b/gi,
  /\b(?:does not|never|cannot|will not)\s+(?:buy|sell|trade|swap|rebalance)\b[^.]{0,40}?\b(?:without|until|unless)\b[^.]{0,30}?\b(?:vote|proposal|members? say|approved)\b/gi,
];

test('no public surface claims a vote gates EVERY change, which is false in seven places', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    for (const re of BLANKET_VOTE_CLAIMS) {
      for (const m of hay.matchAll(re)) hits.push({ file, quote: m[0] });
    }
    for (const sentence of sentencesOf(text)) {
      if (isBlanketVoteSentence(sentence)) hits.push({ file, quote: sentence.trim() });
    }
  }
  assert.deepEqual(
    hits,
    [],
    'A VOTE AUTHORISES TRADES; IT DOES NOT AUTHORISE EVERY CHANGE, and these sentences claim the\n' +
      'second. What a vault HOLDS changes with no vote in at least seven places, each read from\n' +
      'contracts/src/VaultCore.sol:\n' +
      '  :868 pullChildEscrow  — `external`, NO caller gate, credits assetBalance directly\n' +
      '  :440 activate         — its own NatSpec says "Callable by anyone"\n' +
      '  :591 settleQueuedExit — also callable by anyone\n' +
      '  :392 / :403 deposit,  :463 skipWindow,  :551 requestExit\n' +
      'Only :786, :824 and :900 are governance-gated.\n' +
      'SCOPE THE CLAIM TO THE INVESTMENT DECISION rather than widening it to the inventory:\n' +
      '  "what it invests in is decided by vote"   (true)\n' +
      '  "nothing changes without a vote"          (false, in seven places)\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('probe: the blanket-vote structural check catches the reorder card #71 found, and spares the scoped trade claim', () => {
  // The reorder escape itself, plus the shapes it generalizes to (quantifier and "without ...
  // vote" clause in either order, with real prose between them).
  for (const bad of [
    'One rule: nothing changes without a vote.',
    'Nothing in a vault moves without a member vote.',
    'No funds leave the vault without a proposal.',
    'Without a vote, nothing moves.',
  ]) {
    assert.equal(
      sentencesOf(bad).some(isBlanketVoteSentence),
      true,
      `the structural check no longer catches: ${bad}`,
    );
  }
  // "Every change needs a vote." is the same false blanket by a different structure (no "without"),
  // caught by BLANKET_VOTE_CLAIMS' surviving leg rather than the structural check — confirm the
  // combined guard still reds it.
  assert.match('Every change needs a vote.', BLANKET_VOTE_CLAIMS[0]);
  // The verbless lede: no movement verb, so only the kept "one rule" leg can catch it.
  const verbless = 'One rule: nothing without a vote.';
  assert.equal(sentencesOf(verbless).some(isBlanketVoteSentence), false, 'premise: the structural check cannot see a verbless blanket');
  assert.ok(BLANKET_VOTE_CLAIMS.some((re) => { re.lastIndex = 0; return re.test(verbless); }), `the combined guard no longer catches: ${verbless}`);

  // TRUE sentences the guard must leave alone.
  //
  // "Rebalances happen only through a member vote." has no universal quantifier over the subject
  // (rebalances is a noun, not "nothing"/"no X"/"every X"/"all X") and no "without" clause, so it
  // never reaches the structural check.
  //
  // "Nothing is traded without a vote; deposits and exits are yours." pairs "nothing" with
  // "traded" — deliberately OUTSIDE the verb set above — and is true for exactly that reason: the
  // swap path is the one member-value-moving path that IS gated by a passed proposal (guard 7b
  // re-derives that from VaultCore.sol on every run), and the clause after the semicolon says the
  // other seven paths (deposits and exits among them) are explicitly NOT covered by that
  // requirement. Scoping the verb set to state-change verbs and leaving trade to TRADE_VOTE_CLAIMS
  // is what keeps this sentence out of the blanket-claim guard.
  for (const ok of [
    'Rebalances happen only through a member vote.',
    'Nothing is traded without a vote; deposits and exits are yours.',
  ]) {
    assert.equal(
      sentencesOf(ok).some(isBlanketVoteSentence),
      false,
      `the structural check reds true prose: ${ok}`,
    );
  }
});

test('a surface may say trades need a vote only while the contract still makes that true', () => {
  const claiming = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    for (const re of TRADE_VOTE_CLAIMS) {
      for (const m of hay.matchAll(re)) claiming.push({ file, quote: m[0] });
    }
  }

  // THE TRUTH CONDITION, RE-DERIVED FROM THE CONTRACT ON EVERY RUN rather than pinned as a verdict.
  const vault = readFileSync(path.join(REPO, 'contracts/src/VaultCore.sol'), 'utf8');

  // Split into function bodies by brace depth, so "is this call inside a gated function" is a
  // structural question rather than a proximity guess. A regex over N lines of context would
  // answer differently the moment someone reorders the file.
  const fns = [];
  const sigRe = /function\s+(\w+)\s*\([^)]*\)[^{;]*\{/g;
  for (const m of vault.matchAll(sigRe)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    const start = i;
    for (; i < vault.length; i++) {
      if (vault[i] === '{') depth++;
      else if (vault[i] === '}') { depth--; if (depth === 0) break; }
    }
    fns.push({ name: m[1], body: vault.slice(start, i + 1), at: vault.slice(0, m.index).split('\n').length });
  }

  // Matched by SHAPE — the identifier, not the interface-cast text — because a low-level
  // `adapter.call(abi.encodeCall(IExecutionAdapter.executeSwap, (o)))` reaches the exact same
  // selector as `IExecutionAdapter(adapter).executeSwap(o)` and is a live evasion of a guard
  // anchored to the cast form: a function calling `executeSwap` only through `.call(...)` was
  // never even added to `swapSites`, so it was never checked for a governance gate at all
  // (Security, PR #428). `abi.encodeWithSelector(IExecutionAdapter.executeSwap.selector, ...)`
  // reaches it the same way and matches for the same reason.
  const swapSites = fns.filter((f) => /\bexecuteSwap\b/.test(f.body));

  // FLOOR. If the call moves or is renamed, this check would otherwise pass over ZERO sites and
  // report a green — the self-disarming shape four guards in this repo had on 2026-09-18.
  assert.ok(
    swapSites.length > 0,
    'Found NO call to IExecutionAdapter.executeSwap in VaultCore.sol, so this guard just checked\n' +
      'nothing. The swap path moved, was renamed, or the parse above stopped matching. Re-point it;\n' +
      'do not delete it. A pass over zero call sites is indistinguishable from a pass over all of them.',
  );

  const ungated = swapSites.filter(
    (f) => !/require\(\s*msg\.sender\s*==\s*address\(governance\)\s*,\s*OnlyGovernance\(\)\s*\)/.test(f.body),
  );

  assert.deepEqual(
    ungated.map((f) => `${f.name}() at VaultCore.sol:${f.at}`),
    [],
    'THE CONTRACT NO LONGER MAKES THE TRADE CLAIM TRUE, and prose in this repository still asserts\n' +
      'it. A swap path exists that is NOT gated by\n' +
      '  require(msg.sender == address(governance), OnlyGovernance())\n' +
      'so the vault can now trade without a passed proposal.\n' +
      'THIS IS THE EXPECTED FAILURE WHEN THE EXIT-SWAP CHANGE LANDS. It is not a broken test: it is\n' +
      'the copy and the code disagreeing, which is what this file exists to catch. Fix the COPY in\n' +
      'the same commit as the contract change — do not relax this guard to make it pass.\n' +
      `Surfaces currently making the claim:\n${claiming.length ? report(claiming) : '  (none — but the claim is now false if one is added)'}`,
  );
});

test('probe: the swap-site guard catches a low-level .call() reaching executeSwap, not only the interface-cast shape', () => {
  // Card 221 / Security's PR #428 gap, reproduced as a fixture rather than a real contract change:
  // an ungated function that never writes `IExecutionAdapter(x).executeSwap(` survived the old
  // regex outright — it was never even enumerated into swapSites, so `ungated` never saw it.
  const parseFns = (src) => {
    const fns = [];
    const sigRe = /function\s+(\w+)\s*\([^)]*\)[^{;]*\{/g;
    for (const m of src.matchAll(sigRe)) {
      let depth = 0;
      let i = m.index + m[0].length - 1;
      const start = i;
      for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) break; }
      }
      fns.push({ name: m[1], body: src.slice(start, i + 1) });
    }
    return fns;
  };
  const fixture = `
contract Fixture {
    function gated() external {
        require(msg.sender == address(governance), OnlyGovernance());
        IExecutionAdapter(adapter).executeSwap(o);
    }
    function evadesInterfaceCastShape() external {
        // No governance require, and no \`IExecutionAdapter(x).executeSwap(\` text either — the
        // exact evasion Security found in PR #428.
        adapter.call(abi.encodeCall(IExecutionAdapter.executeSwap, (o)));
    }
}
`;
  const fns = parseFns(fixture);
  const swapSites = fns.filter((f) => /\bexecuteSwap\b/.test(f.body));
  assert.deepEqual(
    swapSites.map((f) => f.name).sort(),
    ['evadesInterfaceCastShape', 'gated'],
    'the shape match must enumerate a low-level .call() reaching executeSwap, not only the cast form',
  );
  const ungated = swapSites.filter(
    (f) => !/require\(\s*msg\.sender\s*==\s*address\(governance\)\s*,\s*OnlyGovernance\(\)\s*\)/.test(f.body),
  );
  assert.deepEqual(
    ungated.map((f) => f.name),
    ['evadesInterfaceCastShape'],
    'an ungated executeSwap reached through a low-level .call() must be caught',
  );
});

test('no public surface claims the contracts screen who may deposit', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    for (const m of hay.matchAll(ONCHAIN_MEMBER_GATE)) {
      // An allowlist named for the thing it gates is that thing's allowlist, whatever noun happens
      // to sit near it: "the construction-time adapter allowlist in VaultCore (EX-1: members ...)"
      // is a correct description of EX-1, not a claimed member gate.
      if (/\b(?:adapter|oracle|venue|target|selector|factory|token|asset)s?\s+(?:allowlist|allow-list|whitelist)/i.test(m[0])) {
        continue;
      }
      hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    '`VaultCore._deposit` gates on amount only — minDepositUsdc and capacityCapUsdc — with no\n' +
      'depositor allowlist, and `VaultFactory.createVault` carries no msg.sender gate. The only\n' +
      'allowlists in contracts/src are for ADAPTERS and ORACLES. Vault #1\'s member allowlist is\n' +
      'frontend-only, the same class as the geofence: never imply the contracts enforce it.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 7 — RWLY is never the object of a protocol transfer verb, and never a governance or
// entitlement subject. Legs 47/48 of the 2026-09-05 copy deck v2 (its own legs D and E).
//
// Landed NOW, before RWLY exists, on the same reasoning `claims-robinhood-deployment.test.mjs`
// applies to the record it guards: landing the ban before the false sentence can be written stops
// it being written at all, rather than being caught the day of a token launch when everyone is
// busy. `vision.html` is a whole page of sentences about fees, treasuries and a token — precisely
// where "the protocol routes fees to RWLY" gets written by accident — which is why this deck is the
// occasion for it.
//
// Matched by SHAPE, permanently, exempting nothing (unlike guard 4's dated-record exemption): this
// is the claim a well-meaning editor writes by accident once RWLY is on the page, and no register —
// design intent included — makes it true. `grep -ci rwly` returns 0 in Governance.sol, FeeEngine.sol
// and VaultCore.sol; `FeeEngine.claimFees` pays `claimableFees[msg.sender]` to the CALLER, and the
// caller is the operator address, not a token. Approved register: "the treasury intends to",
// "is designed to", "a multisig moves" — all SUBJECT-first with RWLY or the treasury as the actor,
// never the protocol/contracts/vault/governance/FeeEngine as the actor moving something TO RWLY.
// ---------------------------------------------------------------------------------------------
// sentencesOf, RWLY_ATTRIBUTION and RWLY_BACKED_BY_VAULT are imported from
// `../lib/claims-shapes.mjs` — see this file's header. Their reasoning:
//   - A protocol-ish subject, a transfer verb, then RWLY as the object -- in either order the
//     deck's leg D regex was written for. The subject/verb gap and the verb/RWLY gap are both
//     capped so an unrelated RWLY three sentences later cannot complete the shape.
//   - RWLY holders as the subject of a governance or entitlement verb.
//   - RWLY as a weighting term, or as something staked/locked/required to participate.
//   - "backed by the vault(s)" as a description of RWLY -- sentence-scoped, on the deck's own
//     instruction ("near RWLY" rather than a fixed-shape regex), the same scoping `sentencesOf`
//     already gives guard 6's neighbours in `site.test.mjs`.

test('no public surface says the protocol pays, routes or accrues anything to RWLY, or makes RWLY a governance or entitlement subject', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    for (const re of RWLY_ATTRIBUTION) {
      for (const m of hay.matchAll(re)) hits.push({ file, quote: m[0] });
    }
    for (const s of sentencesOf(text)) {
      if (/\bRWLY\b/.test(s) && RWLY_BACKED_BY_VAULT.test(s)) hits.push({ file, quote: s.trim().slice(0, 160) });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    '`grep -ci rwly` returns 0 in Governance.sol, FeeEngine.sol and VaultCore.sol. `FeeEngine.claimFees`\n' +
      'pays `claimableFees[msg.sender]` to the CALLER, which is the operator address, not a token.\n' +
      'RWLY is design intent only: say "the treasury intends to", "is designed to" or "a multisig\n' +
      'moves" with RWLY or the treasury as the actor — never that the protocol, the contracts, the\n' +
      'vault, Governance or FeeEngine routes, pays, distributes, accrues, credits, sends or allocates\n' +
      'anything TO RWLY; never RWLY holders as a governance or entitlement subject; never RWLY as a\n' +
      'weighting term or as something staked to participate; never RWLY described as backed by a vault.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('probe: the RWLY attribution ban catches the shape and spares the approved register', () => {
  const caught = (s) => {
    const hay = flat(s);
    const shapeHit = RWLY_ATTRIBUTION.some((re) => {
      re.lastIndex = 0; // these patterns carry /g and are reused across probe cases
      return re.test(hay);
    });
    if (shapeHit) return true;
    return sentencesOf(s).some((sentence) => /\bRWLY\b/.test(sentence) && RWLY_BACKED_BY_VAULT.test(sentence));
  };
  // The banned shape, in the forms an editor reaches for once RWLY is on the page.
  for (const bad of [
    'The protocol routes fees to RWLY.',
    'FeeEngine accrues the performance fee to RWLY holders.',
    'RWLY holders vote on every rebalance.',
    'Governance is RWLY-weighted.',
    'You have to stake RWLY to participate.',
    'RWLY is backed by the vaults.',
  ]) {
    assert.equal(caught(bad), true, `the guard no longer catches: ${bad}`);
  }
  // The deck's own approved register, subject-first with RWLY or the treasury as the actor —
  // this is the register guard 7 exists to leave alone, not the shape it exists to catch.
  for (const ok of [
    'RWLY is designed to pair with stock tokens on the chain’s Uniswap.',
    '10% is designed to buy RWLY back, hourly, as a TWAP rather than in one order.',
    'The fees those pools generate are designed to flow to the treasury and buy stock into vault 1.',
    'The treasury intends to use the protocol’s fees to acquire official Robinhood Stock Tokens.',
  ]) {
    assert.equal(caught(ok), false, `the guard reds the deck's own approved copy: ${ok}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Guard 9 — nothing is said to bypass the operator AS A PERSON. The operator is a member (the
// creator's >=5% stake lock, THREAT-MODEL CM-1), so the exit fee reaches it pro rata through its
// own shares (EE-9). The ROUTING form stays legal and is how the engineering docs say it; see
// FEE_BYPASSES_OPERATOR in `../lib/claims-shapes.mjs` for exactly what is spared and why.
// ---------------------------------------------------------------------------------------------
test('no public surface says a fee never reaches the operator, who is a member', () => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    const hay = flat(text);
    for (const re of FEE_BYPASSES_OPERATOR) {
      for (const m of hay.matchAll(re)) hits.push({ file, quote: m[0] });
    }
  }
  assert.deepEqual(
    hits.map((h) => h.file),
    [],
    'The exit fee stays in the vault and lifts the value of every remaining share (VaultCore\n' +
      '_settleExit burns the full share amount but pays out only burnShares * keepBps). The\n' +
      'operator holds a position — the creator has a >=5% stake lock, THREAT-MODEL CM-1 — so it\n' +
      'receives the fee pro rata like any member who stays (EE-9). "Never to the operator" is false.\n' +
      'Say the mechanism instead: "it stays in the vault, adding to the value of every remaining\n' +
      'share". If you mean that no code path transfers it to the operator\'s ADDRESS, say "never\n' +
      'routed to the operator" — that form is true and this guard leaves it alone.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

test('probe: the fee-bypass ban catches the shipped forms and spares the routing form', () => {
  const caught = (s) =>
    FEE_BYPASSES_OPERATOR.some((re) => {
      re.lastIndex = 0; // /g patterns reused across probe cases
      return re.test(flat(s));
    });
  // Every form that actually shipped on a member-facing surface, verbatim, plus the obvious variants.
  for (const bad of [
    'It goes to the members who stay, never to the operator.',
    'Paid to the members who stay, never to the operator.',
    'This stays in the vault and raises NAV/share for the members who remain. It never goes to the operator.',
    'stays in the vault, never goes to the operator',
    'exit fees accrue to members, not the operator',
    'The exit fee is never paid to the operator.',
    'The fee never reaches the operator.',
  ]) {
    assert.equal(caught(bad), true, `the guard no longer catches: ${bad}`);
  }
  // The true routing form the engineering docs rely on, and the replacement wording now shipped.
  for (const ok of [
    'Never routed to the operator; waived when the redeemer is the last member.',
    'Exit fees never route to the operator at all.',
    'it accrues to the members who remain, and can never be routed to the operator.',
    'It stays in the vault, so it adds to the value of the shares every remaining member holds, including the operator if it holds a position.',
    'The 10% performance fee goes to the operator.',
  ]) {
    assert.equal(caught(ok), false, `the guard reds true copy: ${ok}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Guard 8 — RWLY stays absent from contracts/src, permanently. Leg 48 (v1 leg E).
//
// Cheap, and it is the fact every "is designed to" / "does not exist yet" sentence about RWLY
// across the whole site rests on. If this ever goes red, every one of those sentences is false and
// has to be rewritten — which is the correct outcome for a guard to force, not a nuisance.
// ---------------------------------------------------------------------------------------------
const RWLY_ABSENT_FROM = ['contracts/src/Governance.sol', 'contracts/src/FeeEngine.sol', 'contracts/src/VaultCore.sol'];

test('RWLY is absent from contracts/src entirely', () => {
  for (const f of RWLY_ABSENT_FROM) {
    const text = readFileSync(path.join(REPO, f), 'utf8');
    assert.equal(
      (text.match(/rwly/gi) ?? []).length,
      0,
      `${f}: contains "RWLY" — every design-intent sentence about RWLY on every public surface assumes ` +
        'grep -ci rwly returns 0 here. If a future design wires the token into a contract, this leg is ' +
        'meant to go red and every RWLY sentence in the repository has to be rewritten to match.',
    );
  }
});

// ---------------------------------------------------------------------------------------------
// COVERAGE, NOT A GUARD — the walk must actually REACH the site's prerendered pages.
//
// The header draws this file's scope on two axes, the STORE (repo vs vault) and the FILE TYPE
// (`PUBLIC_EXT`). There is a third, and it is the one that made every guard above vacuous over the
// site once already: TIME. The walk enumerates from disk, and `apps/site/.gitignore` ignores
// `dist/` on its first line, so the prerendered pages exist only after
// `npm run build --workspace apps/site` has run. Order that build AFTER `npm run test:backend`
// — which is where `.github/workflows/ci.yml` had it until this test was written — and on a fresh
// checkout every guard above walks zero rendered pages and reports a pass. A pass over nothing is
// indistinguishable from a pass over everything, which is the failure this whole file exists to
// refuse; the header makes the same point about the vault, for the same reason.
//
// `dist` IS WALKED AND `dist-ssr` IS NOT A SECOND CASE OF IT, so do not read this as "build outputs
// are walked here". `dist` is walked because the site publishes its prose ONLY as build output:
// skip it and the pages a reader receives are guarded by nothing. `dist-ssr` is the SSR bundle
// written by the `vite build --ssr` half of `apps/site/package.json`'s build script; it contains no
// HTML at all, and its only two prose files, `llms.txt` and `robots.txt`, are byte-identical copies
// of `apps/site/public/`'s, which are walked whether or not anything has been built (checked
// 2026-09-18 with `diff`). So it is walked today, it costs no coverage either way, and neither
// `SKIP_DIRS` here nor the near-identical one in `config-doc-truth.test.mjs` lists it. Adding it
// belongs in a change that edits both, since a skip list that two sibling guards disagree on is its
// own drift.
//
// So the ordering is ASSERTED here rather than only documented there. This is the one test in this
// file that MAY name its files: it is a POSITIVE requirement, and by the rule quoted in the header,
// requiring too little never lets a falsehood through.
//
// THE PAGE LIST IS READ FROM `apps/site/src/pages.ts`, NOT COPIED HERE, and that is a deliberate
// reversal of how this test was first written. A copied list is a second place to edit, and its
// two failure modes are not symmetric: longer than reality reds honestly, shorter than reality goes
// silent, which is the under-coverage this test exists to catch. `PAGE_IDS` has been nine entries,
// then two, and is whatever `pages.ts` says today, so a copy has been wrong on some branch for most
// of this file's life. `pages.ts` is the same declaration the build itself follows: `entry-server
// .tsx` re-exports it as `pages` (grep `export const pages`) and `apps/site/scripts/prerender.mjs`
// loops over that (grep `for (const page of pages)`), writing one `dist/<page>` per entry. Those
// citations are grep-able phrases rather than line numbers: a line number in a comment goes stale
// silently, and this one already had.
//
// READING THE SOURCE RATHER THAN `dist` IS WHAT KEEPS THIS INDEPENDENT. Enumerating the expectation
// from the build output would make the test agree with whatever the build happened to produce: a
// prerender that wrote four of five pages would pass. Read from `pages.ts`, it reds.
//
// THE FLOOR IS WHAT STOPS THE DERIVATION GOING VACUOUS. Deriving an expectation from a file means a
// gutted `PAGE_IDS` shrinks the expectation to nothing and passes — the same false green by another
// route. `MIN_PAGES` refuses that, and the parse throws rather than returning empty if the
// declaration stops matching.
//
// IT DOES NOT SKIP WHEN THE BUILD IS MISSING, and that is the deliberate break with the two
// neighbouring suites that read build artefacts: `apps/site/test/site.test.mjs` skips its
// dist-reading tests (its `BUILT`/`SKIP` pair), and `packages/indexer/test/abis.test.mjs` skips on
// `contracts/out` absent. Both are right to — they have nothing to say without their input. This
// test's whole subject IS the missing input, so a skip would reproduce the defect it catches. It
// does not skip on a missing `apps/site` either: the site is not optional, and an early return on
// an absent directory is exactly how this test spent the life of `apps/site-next`'s deletion
// reporting a pass over zero assertions.
// ---------------------------------------------------------------------------------------------
const SITE = 'apps/site';

/**
 * The fewest pages any shape of this site has published: `index.html`, `disclaimers.html` and the
 * `404.html` below. A `PAGE_IDS` that parses to less than this is a gutted declaration rather than
 * a smaller site, and the expectation derived from it would be too weak to mean anything.
 *
 * IT IS A TRIPWIRE, NOT A FACT ABOUT THE SITE, and it sits at `protocol/main`'s exact reality with
 * no margin on purpose. If the site legitimately drops to one page this reds, and the obvious next
 * move — lowering the number until it goes quiet — is the relax-until-green shape this whole file
 * exists to refuse. Re-point it or delete it deliberately, in a change that says which.
 */
const MIN_PAGES = 3;

/**
 * Every prerendered page, read from the site's own declaration.
 *
 * `404.html` IS NOT A PageId AND IS HERE ANYWAY. It is in no nav, no sitemap and none of the
 * per-page guards in `apps/site/test/site.test.mjs`, because it is a document the site is never
 * navigated TO — `pages.ts` carries the reason under `NOT_FOUND_ID`: without it in the build
 * output, Cloudflare Pages serves `/index.html` with a 200 for every path matching no asset, which
 * is the soft-404 measured on the live site on 2026-09-09.
 *
 * It belongs here because THIS test asks a different question from that one. Not "is it a page of
 * the site" but "did the guards above read the prose a reader receives" — and a reader receives
 * this document at every address that does not exist, so its sentences are public surface with
 * exactly the standing of the homepage's. Being outside `PAGE_IDS` is precisely what would have
 * made it the silent omission.
 */
const prerenderedPages = () => {
  const src = path.join(REPO, SITE, 'src', 'pages.ts');
  assert.ok(
    existsSync(src),
    `${SITE}/src/pages.ts is missing, so the pages this guard must reach cannot be named.\n` +
      'This throws rather than skipping: the site is not optional, and an early return here is\n' +
      'how this test reported a pass over zero assertions for the whole life of the previous\n' +
      "site directory's deletion.",
  );
  const text = readFileSync(src, 'utf8');

  const ids = /export const PAGE_IDS\s*=\s*\[([\s\S]*?)\]/.exec(text);
  assert.ok(ids, `could not parse PAGE_IDS out of ${SITE}/src/pages.ts — the declaration moved`);
  const pages = [...ids[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);

  const notFound = /export const NOT_FOUND_ID\s*=\s*['"]([^'"]+)['"]/.exec(text);
  assert.ok(notFound, `could not parse NOT_FOUND_ID out of ${SITE}/src/pages.ts`);

  const all = [...pages, notFound[1]];
  assert.ok(
    all.length >= MIN_PAGES,
    `${SITE}/src/pages.ts declares ${all.length} prerendered page(s), fewer than the ${MIN_PAGES}\n` +
      'this site has ever published. Either the declaration was gutted, or the parse above has\n' +
      'stopped matching it. Both make the assertion below too weak to mean anything.',
  );
  return all.map((page) => `${SITE}/dist/${page}`);
};

test('every prerendered page is inside the walk', () => {
  const PRERENDERED = prerenderedPages();
  const walked = new Set(publicSurfaces());
  const missing = PRERENDERED.filter((f) => !walked.has(f));
  assert.deepEqual(
    missing,
    [],
    'The guards above walked none of these pages, so they reported a pass over prose they never\n' +
      'read. Two things cause that, and both are silent:\n' +
      '  1. THE BUILD HAS NOT RUN. `apps/site/.gitignore` ignores `dist/`, so the pages exist\n' +
      '     only after:  npm run build --workspace apps/site\n' +
      '     `.github/workflows/ci.yml` and `scripts/gate.mjs` both run that step BEFORE\n' +
      '     `npm run test:backend`, and each carries the reason at the step. Keep it there.\n' +
      '  2. `dist` WAS ADDED TO SKIP_DIRS. It is deliberately not on that list. The site\n' +
      '     publishes its prose only as build output, so skipping build outputs wholesale would\n' +
      '     exempt the pages the reader actually receives.\n' +
      `Not walked:\n  ${missing.join('\n  ')}`,
  );
});
