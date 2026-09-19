/**
 * Exit-mechanics truth pins — what can delay an exit, who may call it, what you are paid, and
 * what it costs.
 *
 * Two false exit claims shipped on the public site and no guard covered either.
 * `claims-lede-truth.test.mjs` guards WHO DOES WHAT and HOW A VOTE IS WEIGHTED, and says nothing
 * about redemption; `apps/site/test/site.test.mjs` asserts that copy REACHED the page, which is a
 * different question from whether it is true. The two sentences, both replaced in `apps/site/src/
 * copy.ts` on 2026-09-18 and both recoverable with `git log -S`:
 *
 *     "Withdrawing is unconditional. It cannot be queued, gated or vetoed."
 *     "Members exit pro-rata without permission. Redemption cannot be blocked by an operator or
 *      by a pending proposal."
 *
 * ## THE CLAIM SPLITS INTO TWO HALVES WITH OPPOSITE TRUTH VALUES, AND THAT IS THE WHOLE DESIGN
 *
 * Both sentences fuse a true half to a false one, which is why they survived review: the reader
 * checks the half they already believe and stops.
 *
 *   - TRUE — NOBODY CAN REFUSE AN EXIT. `settleQueuedExit(address member)` takes the member as a
 *     parameter and its body contains no `msg.sender` at all, so anyone may settle anyone's queued
 *     exit; there is no operator, creator or governance gate anywhere on the exit path. "Nobody can
 *     refuse, gate or veto your exit" is checkable and correct.
 *   - FALSE — NOTHING CAN DELAY ONE. `requestExit` branches on `_pendingExecution()`: with an
 *     execution pending it does NOT settle, it queues (Mode F) and settles later at post-execution
 *     NAV. The trigger is any active proposal past reveal start, so a proposal that is ultimately
 *     DEFEATED still queued every exit requested while it was live. And `_settleExit` prices the
 *     basket through `_assetValueWad` → `oracle.priceWad`, so a tripped staleness breaker freezes
 *     exits outright (K-4, and `navWad`'s own NatSpec says so: "freezing everything, including
 *     exits, by design").
 *
 * So the guards below ban the SHAPE of the reassurance — an exit asserted to be unconditional,
 * guaranteed, or impossible to delay — and leave the refusal half alone. They do NOT ban the exit
 * vocabulary: `apps/site/src/disclaimers-copy.ts` exists to state the pessimistic truth in detail
 * ("An oracle freeze traps every exit", "Forward-settled exits are irrevocable"), `docs/vault/
 * c5-vote-after-exit.md` is a whole document on the subject, and a guard that reddens honest
 * risk prose gets weakened by the next author rather than obeyed.
 *
 * ## EVERY "TRUE" HALF IS RE-DERIVED FROM `VaultCore.sol`, NEVER ENCODED AS A PERMISSION
 *
 * `exitMechanics()` parses `contracts/src/VaultCore.sol` and asserts each property it needs, naming
 * the call site when one is missing. Nothing below says "this is true today"; each guard reads a
 * derived fact and its failure message quotes the code the ban rests on. Three consequences that
 * are the point rather than a side effect:
 *
 *   - **The exit-swap change is coming, and guard 5 INVERTS when it lands.** Today `_settleExit`
 *     pays `_payOrEscrow(a, member, memberPart)` per basket asset and the exit path calls no
 *     adapter, so redemption is in kind and the banned shape is the cash framing ("your position is
 *     sold for USDC"). The moment a swap appears on the exit path that fact flips and the guard bans
 *     the OTHER shape — every surface still promising in-kind settlement reds. It does not go quiet.
 *   - **Remove the property and the guard reds naming the function.** Delete the sole-holder waiver,
 *     the creator gate's queue-time call site, or `settleQueuedExit`'s address parameter, and
 *     `exitMechanics()` fails with the symbol, not with a diff of the prose.
 *   - **The fee ceiling is a number read from the contract.** Guard 6 compares every stated exit-fee
 *     ceiling against `EXIT_FEE_CAP_BPS`, so raising the constant and leaving the copy alone is
 *     caught, and so is copy inflating the figure.
 *
 * ## MECHANICS ESTABLISHED FROM THE SOURCE, SEVERAL THE OPPOSITE OF THE OBVIOUS GUESS
 *
 *   1. `requestExit(uint256 shares)` takes NO address: only a member may request their own exit.
 *      `settleQueuedExit(address member)` takes one and gates on nothing, so settlement is
 *      permissionless. The two halves of "the exit path" have opposite access rules.
 *   2. Immediate is the DEFAULT and queueing is the exception, and the exception is a LIVE
 *      GOVERNANCE ROUND — which delays the exit rather than granting it an escape. Queued shares
 *      stay outstanding, lose voting eligibility, and the request is irrevocable: no function clears
 *      `queuedExitShares` except `settleQueuedExit`.
 *   3. Settlement is IN KIND — a pro-rata slice of every basket asset, plus the pro-rata cash leg
 *      drawn from `idleUsdc` first (SV-5). The vault sells nothing on your behalf.
 *   4. Settlement is NOT a side effect of execution: `executeRebalance` never calls `_settleExit`.
 *      Someone must call `settleQueuedExit`, and anyone may.
 *   5. The exit fee is capped at `EXIT_FEE_CAP_BPS` (1%), decays LINEARLY to zero at
 *      `exitFeeDecayPeriod`, and the clock is `lastDepositTime`, which `_mintShares` RESETS on every
 *      deposit — so topping up re-maxes the fee. It is waived for a SOLE holder only (not the
 *      creator, not a large holder), and it is retained through `keepBps` rather than transferred:
 *      it stays in the vault for the members who remain and can never reach the operator. The 10%
 *      performance fee is a different fee and it DOES reach `FeeEngine` on exit, so "no fees when
 *      you leave" is false even where the exit fee has decayed to zero.
 *   6. The creator's 5% floor (`CREATOR_MIN_STAKE_BPS`) binds only while `nonCreatorMemberCount > 0`,
 *      and for a queued exit it is checked at REQUEST time and deliberately NOT re-checked at
 *      settlement (`if (!fromQueue) _checkCreatorGate(...)`, the L-1 fix). The intuitive reading —
 *      a floor verified when the money moves — is the one the code refuses.
 *   7. An oracle freeze is asymmetric, and both directions have been claimed wrongly. It blocks
 *      exits, because the exit path prices the basket. It does NOT block `cancelPending`, whose body
 *      reads no oracle — un-activated observation-window capital is the one thing still reclaimable.
 *
 * ## SCOPE, ON THE SAME TWO AXES `claims-lede-truth.test.mjs` NAMES
 *
 * STORE: this file walks the repository only. The Obsidian vault holds the counsel pack, the ToS
 * draft and the outreach templates, has no CI, and is a named open item in
 * `Rules/claims-surface-spans-two-stores.md` — not a gap this file closes. FILE TYPE: coverage is
 * bounded by `PUBLIC_EXT`, and `.ts` is not in it, so the walk reads `apps/site/dist/*.html` and
 * not `apps/site/src/copy.ts`. That is deliberate and it is also why the mutation probe for this
 * file plants its red cases in `copy.ts` and REBUILDS: a mutation that only proves the regex works
 * proves nothing about whether the regex reaches the page a reader receives.
 *
 * THIRD AXIS, TIME: the prerendered pages exist only after `npm run build --workspace apps/site`,
 * so the last test here asserts the walk reached every page `apps/site/src/pages.ts` declares. It
 * does not skip when the build is missing. A pass over zero pages is the failure this file exists
 * to refuse, and five self-disarming guards were found in this repository inside two days.
 *
 * ## THE ONLY THREE ESCAPES, ALL NARROW, ALL NAMED
 *
 *   - A DENIAL is not a claim. A match containing `no`/`not`/`never`/`nor`/`neither` is prose
 *     refuting the shape ("the exit fee can never route to the operator", "pending capital is never
 *     frozen"), and it is skipped. `only` is deliberately NOT in that set: "evaluated only at
 *     settlement" is a claim, and a draft that included `only` waved it through.
 *
 *     GUARD 2 DOES NOT HONOR IT, and that is the one place this escape would invert the guard: the
 *     shape guard 2 bans IS a negation ("cannot be queued", "can never be frozen"), so skipping a
 *     match containing `never` exempts every instance of the thing being banned. A draft did
 *     exactly that and went green on "Your exit can never be frozen." The true prose the escape
 *     exists for elsewhere needs no escape there: "a failing fee module can never block an exit"
 *     puts the exit AFTER the verb, and `block` is in `D_LOOSE` rather than `D_STRICT`, so neither
 *     of guard 2's patterns reaches it. That split is doing the work the escape would have done.
 *   - A CITATION is not a claim, but only when it is refuted. A match must be wholly inside a
 *     double-quoted span AND sit within `WINDOW` of a refutation marker. `docs/THREAT-MODEL.md`'s
 *     VO-8 row quotes `"exit-before-execution is always available"` in order to record that the row
 *     was false as written; a quoted claim with nothing refuting it still reds.
 *   - `RECORD_DIRS` is honored by guards 7 and 9 ONLY, matching the single-guard exemption in
 *     `claims-lede-truth.test.mjs` and `config-doc-truth.test.mjs`. It exists for exactly one file:
 *     `docs/reviews/SPRINT1-SECURITY-REVIEW.md`, whose M-1 finding recommends a cancel path and
 *     states the creator gate is "evaluated only at settlement" — true of the tree it reviewed,
 *     superseded by the L-1 fix its own status header records, and marked `historical record` with
 *     `scripts/check-doc-claims.mjs` already skipping it. Re-pointing it would falsify the record.
 *     Guards 1-6 and 8 exempt nothing.
 *
 * ## WHAT IS DELIBERATELY NOT BANNED, AND WHY EACH WOULD HAVE BEEN A MISTAKE
 *
 *   - `instant` / `instantly` / `immediately` about an exit. Mode I IS instant, and the technical
 *     register uses the word correctly in two dozen places (`docs/vault/two-mode-exits.md`,
 *     `README.md`, the audit report, the soak report). Banning it would force true prose to be
 *     rewritten into something vaguer, and `docs/RUNTIME.md` uses "exits immediately" about a
 *     process signal. Guard 3 bans the PROMISE register instead — "at any time", "on demand",
 *     "whenever you want" — which is what marketing copy reaches for and what no vault can offer.
 *   - The word `queue`. The truth is that exits queue; prose saying so is the fix, not the defect.
 *   - "escape hatch" as a phrase. The repository denies one twenty-six times. Guard 8 bans only an
 *     AFFIRMATIVE existence claim.
 *   - A stated exit-fee ceiling BELOW `EXIT_FEE_CAP_BPS`. `exitFeeMaxBps` is a per-vault immutable,
 *     so a lower figure may be a correct statement about one vault. Only a ceiling ABOVE the
 *     protocol cap is unarguably false. Stated rather than implied: this guard does not prove a
 *     quoted schedule matches any deployed vault.
 *
 * ## LIMITS, STATED RATHER THAN IMPLIED, BECAUSE NONE OF THESE IS A PROOF OF ABSENCE
 *
 *   - GUARD 3'S SCOPE IS A CHARACTER WINDOW, AND IT IS COARSE ON PURPOSE. A promise made on a page
 *     that discusses the queue or the freeze within `WINDOW` of it stays green. That was measured,
 *     not assumed: a mutation planting "Take your money out at any time." among the homepage's trust
 *     points passed, because the neighbouring point says "a live vote queues it". Tightening to the
 *     sentence would red good writing — prose that states the qualifier once and then uses the short
 *     form — and the drift actually worth catching is a NEW surface making the promise alone, which
 *     this catches. `claims-lede-truth.test.mjs`'s guard 3 makes the same trade at file scope and
 *     records the same caveat.
 *   - Guard 1 catches the WIDENED claim. A bare "you can exit" with no universal and no promise word
 *     slips through, and that is accepted for the reason guard 6 of the sibling file accepts it: the
 *     alternative reddens every true scoped sentence about redemption.
 *   - Nothing here reads the Obsidian vault, and nothing here proves a deployed vault's parameters.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------------------------
// The contract. Every "true half" below is derived from this file, never asserted.
// ---------------------------------------------------------------------------------------------
const VAULT = 'contracts/src/VaultCore.sol';

/**
 * Comments and string literals removed, so brace matching below is reliable.
 *
 * STRIPPING FIRST IS WHAT MAKES BRACE MATCHING SAFE. `VaultCore.sol` carries more comment prose
 * than code — NatSpec, audit citations, and quoted phrases containing braces — and a matcher run
 * over the raw text terminates in the wrong place silently. Strings collapse to `""` rather than
 * vanishing so that `boundedCall(abi.encodeCall(...), "label")` keeps its shape.
 */
const stripComments = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');

/**
 * One function's parameter list and body, by name.
 *
 * INTERFACE DECLARATIONS ARE SKIPPED BY LOOKING FOR `;` BEFORE `{`. `IERC20Metadata.decimals()` and
 * `.balanceOf()` are declared with no body at the top of this file; a matcher that jumps to the next
 * `{` swallows the whole interface plus whatever follows, and an early draft of this parser reported
 * `decimals` and `balanceOf` as writers of `queuedExitShares`. A parse that finds the wrong text is
 * worse than one that finds none, because it still answers.
 */
const solFunction = (src, name) => {
  const re = new RegExp(`function\\s+${name}\\s*\\(`, 'g');
  for (const m of src.matchAll(re)) {
    const semi = src.indexOf(';', m.index);
    const open = src.indexOf('{', m.index);
    if (open === -1) continue;
    if (semi !== -1 && semi < open) continue; // a declaration, not a definition
    let depth = 0;
    let i = open;
    for (; i < src.length; ++i) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    const params = /\(([^)]*)\)/.exec(src.slice(m.index, open));
    return { params: params ? params[1] : '', body: src.slice(open + 1, i) };
  }
  return null;
};

/** A required function, or a failure naming the symbol rather than the prose. */
const requireFn = (src, name) => {
  const fn = solFunction(src, name);
  assert.ok(
    fn && fn.body.trim().length > 0,
    `${VAULT}: \`${name}\` was not found, or parsed to an empty body. Every guard in this file\n` +
      'derives its "true half" from this function, so an absent one must FAIL rather than let the\n' +
      'guards below run against nothing. If the function was renamed or moved, re-point this parse\n' +
      'and re-read the prose it licenses — the rename may have changed the mechanic the copy claims.',
  );
  return fn;
};

/** An integer constant, read from the contract rather than copied here. */
const solConstant = (src, name) => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(\\d[\\d_]*)`).exec(src);
  assert.ok(m, `${VAULT}: constant \`${name}\` is gone. A guard below quotes its value as a fact.`);
  return Number(m[1].replace(/_/g, ''));
};

/**
 * The exit mechanics, parsed. Each property carries the call site it was read from, because a
 * failure message naming `_settleExit` is actionable and one quoting a sentence is not.
 */
const exitMechanics = () => {
  const src = stripComments(readFileSync(path.join(REPO, VAULT), 'utf8'));

  const requestExit = requireFn(src, 'requestExit');
  const settleQueued = requireFn(src, 'settleQueuedExit');
  const settleExit = requireFn(src, '_settleExit');
  const exitFee = requireFn(src, '_exitFeeBps');
  const creatorGate = requireFn(src, '_checkCreatorGate');
  const cancelPending = requireFn(src, 'cancelPending');
  const mintShares = requireFn(src, '_mintShares');
  const executeRebalance = requireFn(src, 'executeRebalance');
  const assetValue = requireFn(src, '_assetValueWad');

  // Everything that writes the Mode-F lock, enumerated from the file. A cancel path added anywhere
  // would show up here, and the irrevocability ban in guard 7 rests on this list.
  const lockWriters = [...new Set([...src.matchAll(/function\s+(\w+)\s*\(/g)].map((m) => m[1]))]
    .filter((n) => {
      const fn = solFunction(src, n);
      return fn && /queuedExitShares\[[^\]]+\]\s*=/.test(fn.body);
    })
    .sort();

  const facts = {
    // (1) who may call which half of the exit path
    requestIsSelfOnly: !/\baddress\b/.test(requestExit.params),
    settlementTakesMember: /\baddress\b/.test(settleQueued.params),
    settlementHasNoSenderGate: !/msg\.sender/.test(settleQueued.body),
    // (2) a live governance round queues; queueing is what prevents a pre-execution exit
    queuesOnPendingExecution:
      /if\s*\(\s*_pendingExecution\(\)\s*\)/.test(requestExit.body) &&
      /queuedExitShares\[msg\.sender\]\s*=\s*shares/.test(requestExit.body),
    settlementWaitsForExecution: /require\(\s*!_pendingExecution\(\)/.test(settleQueued.body),
    lockWriters,
    queuedExitHasNoCancelPath: lockWriters.length === 2 && lockWriters.join(',') === 'requestExit,settleQueuedExit',
    // (3)/(4) in kind, and never a side effect of execution
    paysBasketInKind: /_payOrEscrow\(\s*a\s*,\s*member\s*,\s*memberPart\s*\)/.test(settleExit.body),
    exitPathSwaps: /\b(?:swap|adapter|IExecutionAdapter)\w*/i.test(settleExit.body),
    executionNeverSettles: !/_settleExit|settleQueuedExit/.test(executeRebalance.body),
    // (5) the exit fee
    exitFeeCapBps: solConstant(src, 'EXIT_FEE_CAP_BPS'),
    exitFeeDecaysToZero:
      /tenure\s*>=\s*period\s*\)\s*return\s*0/.test(exitFee.body) &&
      /maxBps\s*\*\s*\(\s*period\s*-\s*tenure\s*\)\s*\/\s*period/.test(exitFee.body),
    soleHolderWaived: /memberShares\s*==\s*ts\s*\)\s*feeBps\s*=\s*0/.test(settleExit.body),
    exitFeeRetainedNotTransferred:
      /keepBps\s*=\s*BPS\s*-\s*feeBps/.test(settleExit.body) &&
      !/(?:_payOrEscrow|safeTransfer)\([^)]*(?:feeBps|keepBps)[^)]*\)/.test(settleExit.body),
    perfFeeChargedOnExit: /IFeeEngine\.onFeeCollected/.test(settleExit.body),
    tenureClockResetsOnDeposit: /lastDepositTime\[member\]\s*=\s*block\.timestamp/.test(mintShares.body),
    // (6) the creator gate
    creatorMinStakeBps: solConstant(src, 'CREATOR_MIN_STAKE_BPS'),
    creatorGateOnlyWhileMembersRemain: /nonCreatorMemberCount\s*>\s*0/.test(creatorGate.body),
    creatorGateAtRequestTime: /_checkCreatorGate\(\s*msg\.sender\s*,\s*shares\s*\)/.test(requestExit.body),
    creatorGateSkippedAtSettlement: /if\s*\(\s*!fromQueue\s*\)\s*_checkCreatorGate/.test(settleExit.body),
    // (7) the oracle-freeze asymmetry
    exitPricesThroughOracle: /_assetValueWad\(/.test(settleExit.body) && /oracle\.priceWad\(/.test(assetValue.body),
    cancelPendingReadsNoOracle: !/oracle|navWad|_valueWad|_assetValueWad/.test(cancelPending.body),
  };
  return facts;
};

/**
 * A derived fact, or a failure naming the call site. Every guard reads its premises through this,
 * so a contract change that removes a property reds HERE — with the symbol — instead of quietly
 * leaving a ban in place that no longer describes the code.
 */
const premise = (facts, key, why) => {
  assert.equal(
    facts[key],
    true,
    `${VAULT}: the property \`${key}\` no longer holds, and a guard in this file bans prose on the\n` +
      `strength of it. ${why}\n` +
      'Re-read the copy this licenses before re-pointing the parse: if the mechanic changed, the\n' +
      'public prose describing it is now false and has to be rewritten, which is what this failure\n' +
      'is for. Do not relax the assertion to make the suite green.',
  );
  return facts[key];
};

// ---------------------------------------------------------------------------------------------
// The walk. Enumerated from the filesystem, never a list — this is a negative guard, and the
// drift it exists to catch arrives in the file nobody added to a list.
// ---------------------------------------------------------------------------------------------
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

// `.json` is here for the same reason `claims-lede-truth.test.mjs` carries it: `contracts/config/
// *.json` holds prose a vault creator acts on. Config prose is prose.
const PUBLIC_EXT = new Set(['.md', '.html', '.txt', '.json']);

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
    .filter((f) => !f.endsWith('package-lock.json'));
};

/** Collapse hard-wrapped prose so a sentence split across two lines matches as one. */
const flat = (s) => s.replace(/\s+/g, ' ');

/**
 * The surfaces, flattened — and a floor, because a walk that returns nothing reports a pass.
 *
 * MIN_EXIT_SURFACES IS A TRIPWIRE, NOT A FACT ABOUT THE REPOSITORY. 106 surfaces mention an exit
 * today (measured 2026-09-19 at `protocol/main`). The floor sits far below that because the number
 * grows with every file added, and the failure it refuses is categorical rather than gradual: a
 * broken walk, a SKIP_DIRS entry swallowing `docs/`, or an unbuilt site returns zero or a handful,
 * never sixty. If it ever reds, find out why the walk shrank — do not lower it.
 */
const MIN_EXIT_SURFACES = 60;
const EXIT_MENTION = /\b(?:exit|exits|redeem|redemption|withdraw|withdrawal)\w*\b/i;

const surfacesWithText = () => {
  const all = publicSurfaces().map((f) => ({ file: f, text: flat(readFileSync(path.join(REPO, f), 'utf8')) }));
  assert.ok(all.length > 0, 'the public-surface walk returned nothing; every guard below would pass over zero prose');
  const mentioning = all.filter((s) => EXIT_MENTION.test(s.text)).length;
  assert.ok(
    mentioning >= MIN_EXIT_SURFACES,
    `only ${mentioning} public surface(s) mention an exit, below the floor of ${MIN_EXIT_SURFACES}.\n` +
      'Every guard in this file is negative, so too few surfaces is a silent pass rather than a\n' +
      'failure. Likely causes: the site was not built (`npm run build --workspace apps/site`), a\n' +
      'SKIP_DIRS entry now swallows a documentation tree, or PUBLIC_EXT lost an extension.',
  );
  return all;
};

const report = (hits) => hits.map((h) => `  ${h.file}: "${h.quote.trim().slice(0, 200)}"`).join('\n');

// ---------------------------------------------------------------------------------------------
// Shared vocabulary.
// ---------------------------------------------------------------------------------------------
const X =
  '(?:exit|exits|exiting|exited|redeem|redeems|redeeming|redemption|redemptions|withdraw|withdraws|withdrawing|withdrawal|withdrawals|leave|leaving|leaves)';
// The same noun, minus a following "fee" — `apps/web/index.html` labels the fee decay "Exit fee if
// you left immediately", which is a statement about the FEE and not about availability.
const XM = `${X}(?!\\s+fees?\\b)`;

// Verbs that mean DELAY and nothing else. Safe in either direction.
const D_STRICT =
  '(?:queued|queue|queues|queuing|queueing|delayed|delay|delays|frozen|freeze|freezes|postponed|postpone|deferred|defer|stalled|stall|suspended|suspend)';
// Verbs that also mean REFUSE or FAIL. Usable ONLY with the exit as the grammatical object of the
// negation ("the exit cannot be blocked"), because the active form is true and common here: "a
// failing fee module never blocks an exit" is a correct statement about the bounded-call design,
// and four such sentences reddened a draft that treated the two directions alike.
const D_LOOSE = `(?:${D_STRICT}|blocked|block|blocks|stopped|stop|stops|prevented|prevent|halted|halt|held|hold|paused|pause)`;
const NEG =
  "(?:cannot|can\\s?not|can't|could\\s+not|couldn't|will\\s+not|won't|would\\s+not|wouldn't|is\\s+never|are\\s+never|never|is\\s+not|are\\s+not|nothing\\s+can|nobody\\s+can|no\\s+one\\s+can|no\\s+vote\\s+can|no\\s+proposal\\s+can)";
const COPULA = '(?:is|are|was|were|remains?|stays?|becomes?|will\\s+be|shall\\s+be)';

/** The neighbourhood a qualifier or a refutation may live in. */
const WINDOW = 320;

/**
 * The delay mechanics, in the words the repository actually uses for them.
 *
 * MEASURED, NOT GUESSED. The one live availability promise is `index.html`'s "Ask to leave any
 * time", whose qualifier ("If a vote is live your exit queues and settles after it") lands about
 * 230 characters later once the page is rendered with its markup. WINDOW is 320 to clear that with
 * margin and no more; widen it only after measuring what stops matching.
 */
const DELAY_QUALIFIER =
  /Mode[\s-]?[IF]\b|two-mode|pending\s+execution|hasPendingExecution|queue[sd]?\b|queu(?:ing|eing)|forward[-\s]?(?:pric|settl)|post-execution|reveal|live\s+(?:vote|proposal)|active\s+proposal|stale|freeze|frozen|breaker|delay|settleQueuedExit/i;

/** Prose refuting the shape it contains. `only` is deliberately absent — see the header. */
const DENIAL_IN_MATCH = /\b(?:no|not|never|nor|neither|none)\b/i;

const REFUTATION =
  /\bFALSE\b|\bfalse\b|\bwrong\b|\bincorrect\b|not\s+true|superseded|restated|corrected|\bbanned\b|\bforbidden\b|never\s+write|do\s+not\s+(?:write|say|claim)|misleading|further\s+bounded/i;

/** Dated records. Honored by guards 7 and 9 only — see the header for the one file it is for. */
const RECORD_DIRS = ['docs/audit/', 'docs/reviews/'];
const isRecord = (file) => RECORD_DIRS.some((d) => file.startsWith(d));

/** Paired double-quote spans, so a quoted claim can be told from an asserted one. */
const quoteSpans = (text) => {
  const spans = [];
  for (const m of text.matchAll(/"[^"]{0,600}"|“[^”]{0,600}”/g)) {
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return spans;
};

/**
 * Run `patterns` over every public surface and return the hits, minus the escapes asked for.
 *
 * `opts.denial` skips a match containing its own refutation. `opts.citation` skips a match wholly
 * inside a quoted span that also sits near a refutation marker. `opts.qualifier` skips a match with
 * a delay qualifier in the window OUTSIDE the match — outside, because "cannot be queued" carries
 * the word "queued" and would otherwise exempt itself. `opts.records` skips dated records.
 */
const scan = (patterns, opts = {}) => {
  const hits = [];
  for (const { file, text } of surfacesWithText()) {
    if (opts.records && isRecord(file)) continue;
    const spans = opts.citation ? quoteSpans(text) : [];
    for (const re of patterns) {
      for (const m of text.matchAll(re)) {
        const i = m.index ?? 0;
        const j = i + m[0].length;
        const around = `${text.slice(Math.max(0, i - WINDOW), i)} ${text.slice(j, j + WINDOW)}`;
        if (opts.denial && DENIAL_IN_MATCH.test(m[0])) continue;
        if (opts.citation && spans.some(([a, b]) => a <= i && j <= b) && REFUTATION.test(around)) continue;
        if (opts.qualifier && DELAY_QUALIFIER.test(around)) continue;
        if (opts.skip && opts.skip(m[0], around)) continue;
        hits.push({ file, quote: m[0] });
      }
    }
  }
  return hits;
};

const files = (hits) => hits.map((h) => h.file);

// ---------------------------------------------------------------------------------------------
// Guard 1 — an exit is never unconditional, guaranteed, or always available.
//
// This is the first half of "Withdrawing is unconditional." Matched as a PREDICATE, because the
// attributive form appears inside true findings prose: `docs/vault/highs.md` describes a defect as
// "converting an unconditional exit right into a governance-liveness dependency", which is a
// sentence about a regression rather than a promise about redemption.
// ---------------------------------------------------------------------------------------------
const UNCONDITIONAL_EXIT = [
  new RegExp(`\\b${X}\\b[^.;:!?]{0,30}\\b${COPULA}\\s+(?:\\w+\\s+){0,2}unconditional(?:ly)?\\b`, 'gi'),
  new RegExp(
    `\\b${X}\\b[^.;:!?]{0,30}\\b${COPULA}\\s+(?:\\w+\\s+){0,2}(?:guaranteed|always\\s+(?:available|open|possible|honoured|honored))\\b|\\b(?:guaranteed|always[-\\s](?:available|open|possible))\\b[^.;:!?]{0,25}\\b${X}\\b`,
    'gi',
  ),
];

test('no public surface calls an exit unconditional, guaranteed or always available', () => {
  const facts = exitMechanics();
  premise(
    facts,
    'queuesOnPendingExecution',
    '`requestExit` no longer branches on `_pendingExecution()` to queue a Mode-F exit, which is one\n' +
      'of the two conditions that make an unconditional claim false.',
  );
  premise(
    facts,
    'exitPricesThroughOracle',
    '`_settleExit` no longer prices the basket through `_assetValueWad`/`oracle.priceWad`, which is\n' +
      'the other condition — a stale feed no longer freezes exits.',
  );
  const hits = scan(UNCONDITIONAL_EXIT, { citation: true });
  assert.deepEqual(
    files(hits),
    [],
    'An exit is conditional in two independent ways, both in `VaultCore`:\n' +
      '  requestExit  -> if (_pendingExecution()) { ... queuedExitShares[msg.sender] = shares; }\n' +
      '                  true from an active proposal\'s REVEAL START, for any proposal type, so a\n' +
      '                  proposal that is ultimately DEFEATED still queued the exit.\n' +
      '  _settleExit  -> _assetValueWad(...) -> oracle.priceWad(...), so a tripped staleness\n' +
      '                  breaker reverts the exit outright (K-4).\n' +
      'The TRUE half is about refusal, not delay: `settleQueuedExit(address member)` has no\n' +
      '`msg.sender` in its body, so nobody can refuse, gate or veto an exit. Say that instead, and\n' +
      'say what CAN delay one in the same breath.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 2 — nothing may be promised about an exit that cannot be queued, delayed or frozen.
//
// This is the second sentence Marketing replaced: "Redemption cannot be blocked by an operator or
// by a pending proposal." The operator half is true; the pending-proposal half is exactly backwards.
// ---------------------------------------------------------------------------------------------
const NO_DELAY_CLAIM = [
  // Passive, exit first: "redemption cannot be blocked", "your exit will never be held up".
  new RegExp(`\\b${X}\\b[^.;:!?]{0,50}${NEG}\\s+(?:ever\\s+)?(?:be\\s+|get\\s+|become\\s+)?${D_LOOSE}\\b`, 'gi'),
  // Active, delay-only verbs: "nothing can queue your exit", "no proposal will delay a redemption".
  new RegExp(`${NEG}\\s+(?:ever\\s+)?(?:be\\s+|get\\s+|become\\s+)?${D_STRICT}\\b[^.;:!?]{0,50}\\b${X}\\b`, 'gi'),
  // "no queue", "no lock-up", "no waiting period" on the exit. `delay` is absent on purpose:
  // `disclaimers.html` correctly says a zero timelock leaves "no delay in which to leave".
  new RegExp(
    `\\bno\\s+(?:queue|queuing|queueing|lock-?up|waiting\\s+period|holding\\s+period)\\b[^.;:!?]{0,40}\\b${X}\\b|\\b${X}\\b[^.;:!?]{0,40}\\bno\\s+(?:queue|queuing|queueing|lock-?up|waiting\\s+period|holding\\s+period)\\b`,
    'gi',
  ),
];

test('no public surface says an exit cannot be queued, delayed or frozen', () => {
  const facts = exitMechanics();
  premise(facts, 'queuesOnPendingExecution', '`requestExit` no longer queues on a pending execution.');
  premise(
    facts,
    'settlementWaitsForExecution',
    '`settleQueuedExit` no longer refuses while an execution is pending, so a queued exit is no\n' +
      'longer held until the round finishes.',
  );
  // NO DENIAL ESCAPE HERE, AND THAT IS NOT AN OVERSIGHT. The banned shape *is* a negation
  // ("cannot be queued", "can never be frozen"), so skipping a match that contains `never` would
  // exempt every instance of the thing being banned — a probe below fails if it is added back.
  // The true prose the escape exists for elsewhere is safe without it: "a failing fee module can
  // never block an exit" puts the exit AFTER the verb, and `block` is in D_LOOSE rather than
  // D_STRICT, so neither pattern reaches it.
  const hits = scan(NO_DELAY_CLAIM, { citation: true });
  assert.deepEqual(
    files(hits),
    [],
    'Both delays are real and both are in the contract:\n' +
      '  A LIVE GOVERNANCE ROUND. `requestExit` queues instead of settling while\n' +
      '  `governance.hasPendingExecution(vault)` is true, and `settleQueuedExit` reverts\n' +
      '  ExecutionStillPending until it goes false. Queueing is what PREVENTS a pre-execution exit;\n' +
      '  it is not a hatch that grants one.\n' +
      '  A STALE ORACLE. `_settleExit` prices the basket through `oracle.priceWad`, so the breaker\n' +
      '  freezes exits (K-4).\n' +
      'Distinguish refusal from delay. Nobody can REFUSE an exit — that is checkable and it is the\n' +
      'reassurance worth making. "Cannot be blocked by a pending proposal" is the opposite of what\n' +
      'the code does.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 3 — an availability PROMISE must carry the delay mechanics beside it (co-occurrence).
//
// The guard that pays for itself, and the one modelled on `claims-lede-truth`'s "stake-weighted"
// rule: it leaves the live homepage line alone ("Ask to leave any time" — which then says the exit
// queues behind a live vote) and reds the next page that makes the promise without the qualifier.
//
// It bans the PROMISE register only, never `instant`/`immediately`: Mode I is instant, and two
// dozen places in the docs say so correctly. See the header.
// ---------------------------------------------------------------------------------------------
const PROMISE =
  '(?:at\\s+any\\s+time|any\\s+time|anytime|on\\s+demand|whenever\\s+you\\s+(?:want|like|choose|wish)|at\\s+will|without\\s+delay|right\\s+away|straight\\s+away|no\\s+waiting)';
// THE PROMISE REGISTER OFTEN CARRIES NO EXIT NOUN AT ALL. "Take your money out at any time" is the
// sentence a landing page writes, and a draft of this guard that required `exit`/`redeem`/`withdraw`
// walked straight past it — which is the whole failure mode this file exists to refuse, since the
// next paraphrase is exactly where the false claim comes back.
const XP = `(?:${XM}|(?:take|get|pull|move)\\s+(?:your\\s+|the\\s+)?(?:money|funds|capital|cash|stake|position)\\s+out|cash(?:ing|es)?\\s+out|get\\s+out)`;
const AVAILABILITY_PROMISE = [
  new RegExp(`\\b${XP}\\b[^.;:!?]{0,40}\\b${PROMISE}\\b|\\b${PROMISE}\\b[^.;:!?]{0,40}\\b${XP}\\b`, 'gi'),
];

test('every "exit any time" promise names what delays an exit', () => {
  const facts = exitMechanics();
  premise(facts, 'queuesOnPendingExecution', '`requestExit` no longer queues on a pending execution.');
  const hits = scan(AVAILABILITY_PROMISE, { qualifier: true, citation: true });
  assert.deepEqual(
    files(hits),
    [],
    'An availability promise about exits is only true with the delay mechanics attached, and this\n' +
      `guard looks for them within ${WINDOW} characters of the promise. Either of these qualifies:\n` +
      '  - the Mode-F queue: a live proposal past reveal start, settling at post-execution NAV;\n' +
      '  - the staleness breaker: a stale feed freezes exits until it recovers.\n' +
      'The homepage does this correctly — "Ask to leave any time", then "If a vote is live your exit\n' +
      'queues and settles after it". Qualify in place; do not delete the promise and do not widen\n' +
      'the window to make this pass.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 4 — the two halves of the exit path have OPPOSITE access rules, and copy gets them
// backwards in both directions.
//
// `requestExit(uint256 shares)` takes no address, so only a member may ask to leave. But
// `settleQueuedExit(address member)` takes one and gates on nothing, so anyone may finish the job.
// ---------------------------------------------------------------------------------------------
const ACCESS_CLAIM = [
  // "only you can settle it", "the operator settles your exit"
  new RegExp(
    `\\b(?:only|just)\\s+(?:you|the\\s+member|the\\s+exiter|the\\s+holder|the\\s+owner)\\b[^.;:!?]{0,40}\\b(?:settle|settles|claim|claims|complete|completes|finish|finishes)\\b|\\b(?:the\\s+operator|the\\s+creator|governance|the\\s+protocol)\\b[^.;:!?]{0,30}\\b(?:settles?|must\\s+settle|has\\s+to\\s+settle|finalis\\w+|finaliz\\w+)\\b[^.;:!?]{0,30}\\byour\\s+${X}\\b`,
    'gi',
  ),
  // ...and the mirror: anyone REQUESTING an exit for someone else. `requestExit` takes no address.
  new RegExp(
    `\\b(?:anyone|anybody|any\\s+address|a\\s+third\\s+party|someone\\s+else)\\b[^.;:!?]{0,40}\\b(?:can|may|is\\s+able\\s+to)\\b[^.;:!?]{0,30}\\b(?:request|initiate|start|trigger|begin|file|submit)\\b[^.;:!?]{0,30}\\b(?:your|a\\s+member's|another\\s+member's|someone\\s+else's)\\s+${X}\\b`,
    'gi',
  ),
];

test('no public surface inverts who may request an exit and who may settle one', () => {
  const facts = exitMechanics();
  premise(facts, 'requestIsSelfOnly', '`requestExit` now takes an address, so it is no longer self-only.');
  premise(facts, 'settlementTakesMember', '`settleQueuedExit` no longer takes a member address.');
  premise(
    facts,
    'settlementHasNoSenderGate',
    '`settleQueuedExit` now reads `msg.sender`, so settlement is no longer permissionless and any\n' +
      'copy saying "anyone can settle it" has to be re-checked against the new gate.',
  );
  const hits = scan(ACCESS_CLAIM, { denial: true });
  assert.deepEqual(
    files(hits),
    [],
    'The halves are asymmetric, and a function taking a member address is callable on that\n' +
      "member's behalf by anyone:\n" +
      '  requestExit(uint256 shares)        -> no address parameter; acts on msg.sender only.\n' +
      '  settleQueuedExit(address member)   -> takes the member; ZERO occurrences of msg.sender in\n' +
      '                                        its body. Anyone may settle anyone\'s queued exit.\n' +
      'So: nobody else can ask to leave for you, and nobody has to be asked to finish it. Neither\n' +
      'the operator nor governance appears anywhere on the exit path.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 5 — settlement is IN KIND, and this guard INVERTS when the exit-swap change lands.
//
// While `_settleExit` pays a per-asset slice to the member and calls no adapter, the falsehood to
// catch is the cash framing. When a swap appears on the exit path that fact flips and the ban
// flips with it: every surface still promising in-kind settlement reds. The point of deriving it
// rather than permitting it is that the guard does not go quiet on the commit that makes the copy
// false.
// ---------------------------------------------------------------------------------------------
const CASH_ON_EXIT = [
  new RegExp(
    `\\b${XM}\\b[^.;:!?]{0,60}\\b(?:cashed\\s+out|cash\\s+out|cashes\\s+out|converted\\s+(?:to|into)\\s+(?:USDC|cash|stablecoins?|dollars?)|converts?\\s+(?:your|the)\\s+(?:basket|position|shares|holdings)|sold\\s+(?:for|into)\\s+(?:USDC|cash)|sells?\\s+(?:your|the)\\s+(?:basket|position|shares|holdings)|liquidates?\\s+(?:your|the)\\s+(?:basket|position|shares|holdings)|cash\\s+redemption|paid\\s+out\\s+in\\s+(?:cash|dollars)|redeemed?\\s+for\\s+(?:USDC|cash))\\b`,
    'gi',
  ),
];

// The claim that becomes false the moment the exit path swaps. Deliberately broad on the in-kind
// side: if the mechanic changes, over-reporting is the correct failure mode — every one of these
// sentences needs re-reading.
const IN_KIND_CLAIM = [new RegExp(`\\bin[-\\s]kind\\b[^.;:!?]{0,80}\\b${X}\\b|\\b${X}\\b[^.;:!?]{0,80}\\bin[-\\s]kind\\b`, 'gi')];

test('exit settlement is described the way the contract settles it', () => {
  const facts = exitMechanics();
  premise(
    facts,
    'paysBasketInKind',
    '`_settleExit` no longer pays `_payOrEscrow(a, member, memberPart)` per basket asset — the line\n' +
      'that makes every "paid in kind" sentence on the site true.',
  );

  if (facts.exitPathSwaps) {
    // The exit-swap change landed. The in-kind promise is now the claim under suspicion.
    const hits = scan(IN_KIND_CLAIM);
    assert.deepEqual(
      files(hits),
      [],
      '`_settleExit` now mentions a swap or an execution adapter, so the exit path no longer pays\n' +
        'the basket out untouched. Every sentence below promises in-kind redemption and has to be\n' +
        're-read against the new path — including whether a slippage bound, a minimum-out and a\n' +
        'failure mode now need describing. This guard is SUPPOSED to red on that commit: that is why\n' +
        'the in-kind half is derived from the contract instead of permitted permanently.\n' +
        `In-kind claims needing review:\n${report(hits)}`,
    );
    return;
  }

  const hits = scan(CASH_ON_EXIT, { denial: true });
  assert.deepEqual(
    files(hits),
    [],
    '`_settleExit` sells nothing. It pays a pro-rata slice of EVERY basket asset\n' +
      '(`_payOrEscrow(a, member, memberPart)`) plus the pro-rata cash leg drawn from `idleUsdc`\n' +
      'first (SV-5), and the exit path calls no execution adapter at all. Converting the basket\n' +
      'back is the member\'s own transaction, routing and cost. The cash-redemption path through\n' +
      'the adapter is described in the architecture notes and is NOT built.\n' +
      'Note what is not banned: a USDC leg IS paid, so naming USDC in an exit sentence is fine —\n' +
      'what is false is the vault converting, selling or liquidating a position on your behalf.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 6 — the exit fee: where it goes, what it is capped at, and who is actually waived.
//
// Three separate falsehoods, one guard. The fee never leaves the vault, so it can never reach the
// operator; the ceiling is read from `EXIT_FEE_CAP_BPS` rather than written here; and "no fees when
// you leave" is false even at zero exit fee, because the 10% performance fee is charged on exit.
// ---------------------------------------------------------------------------------------------
const FEE_TO_OPERATOR = [
  /\bexit\s+fee\b[^.;:!?]{0,80}\b(?:routed?|routes|paid|pays|goes|go|accrues?|credited|transferred|sent)\b[^.;:!?]{0,30}\b(?:to|for)\s+the\s+(?:operator|protocol|treasury|team|platform|manager)\b/gi,
  /\bthe\s+(?:operator|protocol|treasury|platform)\b[^.;:!?]{0,30}\b(?:receives?|collects?|keeps?|takes?|earns?|is\s+paid)\b[^.;:!?]{0,30}\bexit\s+fee\b/gi,
];

const NO_FEE_ON_EXIT = [
  new RegExp(
    `\\b(?:no|zero|free\\s+of|without)\\s+(?:exit\\s+)?(?:fees?|charges?|cost)\\b[^.;:!?]{0,40}\\b${X}\\b|\\b${X}\\b[^.;:!?]{0,40}\\b(?:no|zero|free\\s+of|without)\\s+(?:exit\\s+)?(?:fees?|charges?|cost)\\b`,
    'gi',
  ),
];

// A stated CEILING, with a ceiling word between the fee and the figure so that a performance fee
// quoted in the same breath ("10% perf + exit fee") is not read as the exit fee's cap.
// The `<=` and `≤` alternatives sit OUTSIDE the word boundary on purpose: `\b` never matches before
// `<`, so a draft written as `\b(?:up to|…|<=)` silently dropped both, and `exit fee <=1%` — the
// wording in all four `llms.txt` copies, `README.md` and `docs/AGENT-QUICKSTART.md` — was never
// parsed at all. A ceiling nobody parses is a ceiling nobody checks.
const FEE_CEILING =
  /\bexit\s+fee\b[^.!?]{0,60}?(?:\b(?:up\s+to|capped\s+at|cap\s+of|ceiling\s+of|maximum(?:\s+of)?|max(?:imum)?|at\s+most|no\s+more\s+than)\b|<=|≤|<)\s*(\d+(?:\.\d+)?)\s*%/gi;

test('no public surface routes the exit fee to the operator, or inflates its ceiling, or calls leaving free', () => {
  const facts = exitMechanics();
  premise(
    facts,
    'exitFeeRetainedNotTransferred',
    '`_settleExit` no longer withholds the exit fee through `keepBps` alone — a transfer keyed to\n' +
      'the exit fee would mean it now leaves the vault, and the destination has to be described.',
  );
  premise(
    facts,
    'soleHolderWaived',
    '`_settleExit` no longer waives the fee for a sole holder (`if (memberShares == ts) feeBps = 0`).',
  );
  premise(
    facts,
    'perfFeeChargedOnExit',
    '`_settleExit` no longer calls `IFeeEngine.onFeeCollected`, so the claim that a fee is charged\n' +
      'on exit regardless of the exit fee needs re-checking.',
  );
  premise(facts, 'exitFeeDecaysToZero', '`_exitFeeBps` no longer decays linearly to zero at `exitFeeDecayPeriod`.');

  const capPct = facts.exitFeeCapBps / 100;
  const hits = [
    ...scan(FEE_TO_OPERATOR, { denial: true }),
    ...scan(NO_FEE_ON_EXIT, { denial: false }),
    ...scan([FEE_CEILING], {
      // Only a ceiling ABOVE the protocol cap is unarguably false; `exitFeeMaxBps` is a per-vault
      // immutable, so a lower figure may be a correct statement about one vault (see the header).
      skip: (quote) => {
        const m = /(\d+(?:\.\d+)?)\s*%/.exec(quote);
        return !m || Number(m[1]) <= capPct;
      },
    }),
  ];
  assert.deepEqual(
    files(hits),
    [],
    'Three facts, all in `VaultCore`:\n' +
      `  CEILING. EXIT_FEE_CAP_BPS = ${facts.exitFeeCapBps} (${capPct}%), and every vault's\n` +
      '  `exitFeeMaxBps` is <= it. `_exitFeeBps` decays it linearly to zero over\n' +
      '  `exitFeeDecayPeriod`, off `lastDepositTime` — which `_mintShares` RESETS on every deposit,\n' +
      '  so a top-up re-maxes the fee.\n' +
      '  DESTINATION. The fee is withheld via `keepBps = BPS - feeBps` and never transferred: it\n' +
      '  stays in the vault, which is why NAVps for remaining members is non-decreasing across any\n' +
      '  redemption. It cannot reach the operator (EE-8/EE-9).\n' +
      '  WAIVER. `if (memberShares == ts) feeBps = 0` waives it for a SOLE holder. Not the creator,\n' +
      '  not a large holder.\n' +
      'And leaving is not free: `_settleExit` calls `IFeeEngine.onFeeCollected`, so the 10%\n' +
      'performance fee on realised gain is charged on exit even when the exit fee has decayed to\n' +
      'zero. Scope any zero-fee sentence ("a sole holder pays no exit fee", "no exit fee after the\n' +
      'decay period"); never say leaving costs nothing.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 7 — a queued exit is irrevocable, and settlement is not a side effect of execution.
//
// Both are the reassuring guess and both are wrong. The lock has exactly two writers in the whole
// contract, enumerated from the file rather than asserted, and neither is a cancel path.
// ---------------------------------------------------------------------------------------------
const QUEUE_REVERSIBLE = [
  /\b(?:cancel|cancels|cancelled|canceled|revoke|revokes|revoked|undo|reverse|reverses|reversed|un-?queue\w*|back\s+out|change\s+your\s+mind|amend)\b[^.;:!?]{0,50}\b(?:queued\s+(?:exit|redemption|request)|exit\s+queue|queued\s+shares)\b/gi,
  /\b(?:queued\s+(?:exit|redemption|request)|exit\s+queue)\b[^.;:!?]{0,50}\b(?:cancel\w*|revoke\w*|undo|reverse\w*|un-?queue\w*|back\s+out|change\s+your\s+mind)\b/gi,
];

const AUTO_SETTLES = [
  new RegExp(
    `\\b${XM}\\b[^.;:!?]{0,60}\\b(?:settles?|settled|settlement|settling|pays?\\s+out|completes?)\\b[^.;:!?]{0,40}\\bautomatic(?:ally)?\\b|\\bautomatic(?:ally)?\\b[^.;:!?]{0,40}\\b(?:settles?|settled|settlement|settling)\\b[^.;:!?]{0,50}\\b${XM}\\b`,
    'gi',
  ),
];

test('no public surface says a queued exit can be withdrawn, or settles by itself', () => {
  const facts = exitMechanics();
  premise(
    facts,
    'queuedExitHasNoCancelPath',
    `\`queuedExitShares\` is now written by [${facts.lockWriters.join(', ')}] rather than by\n` +
      '`requestExit` and `settleQueuedExit` alone. If one of those is a cancel path, a queued exit\n' +
      'is no longer irrevocable and the disclaimers page says otherwise in four places.',
  );
  premise(
    facts,
    'executionNeverSettles',
    '`executeRebalance` now reaches `_settleExit`/`settleQueuedExit`, so settlement may be a side\n' +
      'effect of execution after all and the "someone has to call it" prose needs re-checking.',
  );
  const hits = [...scan(QUEUE_REVERSIBLE, { denial: true, records: true }), ...scan(AUTO_SETTLES, { denial: true, records: true })];
  assert.deepEqual(
    files(hits),
    [],
    'Two mechanics, both derived from the file:\n' +
      '  IRREVOCABLE. `queuedExitShares` is written in exactly two places — `requestExit` (sets it)\n' +
      '  and `settleQueuedExit` (clears it). There is no cancel path, and a second `requestExit`\n' +
      '  reverts `ExitAlreadyQueued`. The shares stay outstanding, keep the vault\'s P&L, and lose\n' +
      '  voting eligibility.\n' +
      '  NOT AUTOMATIC. `executeRebalance` never calls `_settleExit`. `settleQueuedExit` is a\n' +
      '  separate transaction that someone has to send once `hasPendingExecution` goes false —\n' +
      '  including after a proposal is DEFEATED. Anyone may send it; nobody is obliged to.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 8 — the oracle freeze, which is asymmetric, and has been claimed wrongly in BOTH
// directions.
//
// It blocks exits: there is no hatch, and none is coming, because a hatch IS the stale-price exit
// the breaker exists to prevent. It does not block `cancelPending`, which reads no oracle — so
// un-activated observation-window capital stays reclaimable, and prose calling it trapped is the
// mirror-image falsehood.
// ---------------------------------------------------------------------------------------------
const FREEZE_HATCH = [
  // An AFFIRMATIVE existence claim only. The repository denies a hatch twenty-six times, and
  // "no escape hatch will be added" must not red — which is why `will be added` is not a trigger
  // on its own and the denial escape applies.
  /\b(?:there\s+is|there's|provides?|offers?|includes?|adds?|there\s+will\s+be)\s+(?:an?|the)\s+(?:escape\s+hatch|emergency\s+(?:exit|withdrawal|redemption)|break[-\s]glass)\b/gi,
  /\b(?:escape\s+hatch|emergency\s+(?:exit|withdrawal|redemption))\b[^.;:!?]{0,30}\b(?:exists|is\s+available|lets\s+you|allows\s+you)\b/gi,
  new RegExp(
    `\\b(?:can|may|could)\\s+still\\s+(?:${X})\\b[^.;:!?]{0,40}\\b(?:freeze|frozen|stale|breaker)\\b|\\b(?:freeze|frozen|stale|breaker)\\b[^.;:!?]{0,40}\\b(?:can|may|could)\\s+still\\s+(?:${X})\\b`,
    'gi',
  ),
];

const PENDING_TRAPPED = [
  new RegExp(
    `\\b(?:pending\\s+deposits?|pending\\s+capital|observation[-\\s]window\\s+capital|un-?activated\\s+capital)\\b[^.;:!?]{0,20}\\b${COPULA}\\s+(?:\\w+\\s+){0,2}(?:trapped|stranded|stuck|frozen|irrecoverable|unreachable)\\b`,
    'gi',
  ),
];

test('no public surface offers an exit during an oracle freeze, or calls pending capital trapped', () => {
  const facts = exitMechanics();
  premise(
    facts,
    'exitPricesThroughOracle',
    '`_settleExit` no longer prices the basket through `oracle.priceWad`, so a stale feed may no\n' +
      'longer freeze exits and the "no hatch, none needed" prose needs re-deriving.',
  );
  premise(
    facts,
    'cancelPendingReadsNoOracle',
    '`cancelPending` now touches the oracle or NAV. It was the one action guaranteed during a\n' +
      'freeze (K-4/M-2), and the disclaimers page promises exactly that.',
  );
  const hits = [...scan(FREEZE_HATCH, { denial: true }), ...scan(PENDING_TRAPPED, { denial: true })];
  assert.deepEqual(
    files(hits),
    [],
    'The freeze is asymmetric, and the asymmetry is the whole claim:\n' +
      '  EXITS STOP. `_settleExit` -> `_assetValueWad` -> `oracle.priceWad`, so a tripped staleness\n' +
      '  breaker reverts the exit. There is no hatch and none will be added: a hatch IS the\n' +
      '  stale-price exit the breaker exists to prevent (K-4). If the feed is retired rather than\n' +
      '  late the freeze does not end, because a vault\'s oracle is fixed at construction.\n' +
      '  PENDING CAPITAL DOES NOT. `cancelPending` reads no oracle and no NAV, so un-activated\n' +
      '  observation-window capital stays reclaimable throughout — the one lever the incident\n' +
      '  playbook can promise, and the reason M-2 made that transfer non-reverting.\n' +
      'Both directions have been claimed wrongly. Do not offer a frozen member an exit, and do not\n' +
      'tell a pending depositor their escrow is stuck.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// Guard 9 — the creator's stake gate: it binds only while other members remain, and for a queued
// exit it is checked at REQUEST time, not at settlement.
//
// The settlement-time reading is the intuitive one and it is what the code was BEFORE the L-1 fix,
// which is exactly why it survives in prose. `docs/reviews/SPRINT1-SECURITY-REVIEW.md` still says
// "evaluated only at settlement" — true of the tree it reviewed, and a dated record, so
// RECORD_DIRS covers it and nothing else.
// ---------------------------------------------------------------------------------------------
// NO TRAILING `\b` AFTER THE FIGURE, and this cost a silent miss: `%` is not a word character, so
// `(?:5\s*%|…)\b` cannot match "keep 5% of the vault" — the boundary needs a word char on the far
// side and there is a space there. A mutation planting "The creator must always keep 5% of the
// vault." passed the first version of this guard for exactly that reason, while the two real
// sentences in the tree matched only because they happen to end on `CREATOR_MIN_STAKE_BPS`.
//
// A PERMANENCE MARKER IS REQUIRED, and fixing the boundary is what proved it necessary. Without one,
// the pattern reddened four true mentions at once: `README.md`'s feature row "Creator locks ≥5%
// (withdrawal gate)", `docs/RESEARCH-STANDARDS.md` naming "the creator 5% withdrawal gate" in a list
// of rejected designs, `docs/vault/vaultfactory.md`'s parenthetical, and a UI state name in
// `docs/design/CONSUMER-UX-SPEC.md`. None of those claims the floor is permanent; they name the
// mechanism. The falsehood is the PERMANENCE — "must always keep 5%", "can never go below 5%" —
// because `_checkCreatorGate` does not fire at all once `nonCreatorMemberCount == 0`.
const PERMANENCE = '(?:always|at\\s+all\\s+times|permanently|forever|never|must|cannot|can\\s?not|can\'t|may\\s+not|is\\s+required\\s+to|required\\s+to|locked\\s+in)';
const CREATOR_FLOOR = [
  new RegExp(
    `\\bcreator\\b[^.;:!?]{0,60}\\b${PERMANENCE}\\b[^.;:!?]{0,60}(?:5\\s*%|five\\s+per\\s*cent|500\\s+bps|CREATOR_MIN_STAKE_BPS\\b)|\\bcreator\\b[^.;:!?]{0,60}(?:5\\s*%|five\\s+per\\s*cent|500\\s+bps|CREATOR_MIN_STAKE_BPS\\b)[^.;:!?]{0,60}\\b${PERMANENCE}\\b`,
    'gi',
  ),
];
// `withdrawal gate` is itself a qualifier, and deliberately so: it is this repository's approved
// term for "a gate on creator ACTION, not a solvency condition" (CM-1/CM-2), and `ARCHITECTURE.md`,
// `BUILD-PLAN.md` and `docs/vault/nav-and-shares.md` all use it that way. Prose that names the
// mechanism correctly is not making the permanence claim.
const MEMBERS_QUALIFIER =
  /while\s+(?:≥\s*1\s+)?(?:non-creator\s+)?members?\s+remain|members?\s+remain|non-creator\s+member|while\s+anyone\s+else|other\s+members|nonCreatorMemberCount|no\s+members\s+remain|withdrawal\s+gate|not\s+a\s+(?:solvency|top-up)/i;

const GATE_AT_SETTLEMENT = [
  // Same missing-boundary trap as CREATOR_FLOOR above: the figure alternative carries no `\b`.
  /\bcreator\b[^.;:!?]{0,120}(?:\b(?:gate|floor|minimum\s+stake)\b|5\s*%)[^.;:!?]{0,80}\b(?:at|on|during)\s+settlement\b/gi,
  /\b(?:at|only\s+at|on)\s+settlement\b[^.;:!?]{0,80}\bcreator\b[^.;:!?]{0,40}\b(?:gate|floor)\b/gi,
];

test("the creator's 5% floor is described as conditional on other members, and checked at request time", () => {
  const facts = exitMechanics();
  premise(
    facts,
    'creatorGateOnlyWhileMembersRemain',
    '`_checkCreatorGate` no longer conditions on `nonCreatorMemberCount > 0`, so the floor may now\n' +
      'bind a sole creator and every "while members remain" qualifier is wrong.',
  );
  premise(
    facts,
    'creatorGateAtRequestTime',
    '`requestExit` no longer calls `_checkCreatorGate(msg.sender, shares)` on the queueing branch\n' +
      '(the L-1 fix), so a gate-violating Mode-F request may strand again.',
  );
  premise(
    facts,
    'creatorGateSkippedAtSettlement',
    '`_settleExit` no longer guards the gate with `if (!fromQueue)`, so a queued exit IS re-checked\n' +
      'at settlement — which is the M-1 stranding shape, and inverts the timing claim below.',
  );

  const unqualified = [];
  for (const { file, text } of surfacesWithText()) {
    if (isRecord(file)) continue;
    for (const re of CREATOR_FLOOR) {
      for (const m of text.matchAll(re)) {
        const i = m.index ?? 0;
        const j = i + m[0].length;
        const around = `${text.slice(Math.max(0, i - WINDOW), i)} ${m[0]} ${text.slice(j, j + WINDOW)}`;
        if (MEMBERS_QUALIFIER.test(around)) continue;
        unqualified.push({ file, quote: m[0] });
      }
    }
  }
  const hits = [...unqualified, ...scan(GATE_AT_SETTLEMENT, { records: true })];
  assert.deepEqual(
    files(hits),
    [],
    `The floor is CREATOR_MIN_STAKE_BPS = ${facts.creatorMinStakeBps} (${facts.creatorMinStakeBps / 100}%), and two\n` +
      'things about it are counter-intuitive:\n' +
      '  IT IS CONDITIONAL. `_checkCreatorGate` fires only `if (member == creator &&\n' +
      '  nonCreatorMemberCount > 0)`. A sole creator may exit entirely, and passive dilution by\n' +
      "  others' deposits below 5% is allowed — the gate is on creator ACTION, not solvency\n" +
      '  (CM-1/CM-2). Say "while members remain" or do not state the figure.\n' +
      '  IT IS CHECKED AT REQUEST TIME. `requestExit` evaluates it on the queueing branch, and\n' +
      '  `_settleExit` deliberately skips it for a queued exit (`if (!fromQueue)`). That is the L-1\n' +
      '  fix: re-checking at settlement is what stranded a queued exit when membership grew\n' +
      '  underneath it (M-1). Settlement-time is the PRE-fix behaviour.\n' +
      `Offending text:\n${report(hits)}`,
  );
});

// ---------------------------------------------------------------------------------------------
// PROBES — the green direction, captured permanently rather than run once by hand.
//
// Guards 1 and 7 of `claims-lede-truth.test.mjs` do the same thing, for the same reason: a red
// mutation proves the regex fires, and only these prove it fires on the right sentences. The bad
// set opens with both sentences Marketing replaced, verbatim.
// ---------------------------------------------------------------------------------------------
const caught = (patterns, s, opts = {}) => {
  const text = flat(s);
  const spans = opts.citation ? quoteSpans(text) : [];
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const i = m.index ?? 0;
      const j = i + m[0].length;
      const around = `${text.slice(Math.max(0, i - WINDOW), i)} ${text.slice(j, j + WINDOW)}`;
      if (opts.denial && DENIAL_IN_MATCH.test(m[0])) continue;
      if (opts.citation && spans.some(([a, b]) => a <= i && j <= b) && REFUTATION.test(around)) continue;
      if (opts.qualifier && DELAY_QUALIFIER.test(around)) continue;
      // Guard 9's window includes the match itself, because the qualifier is usually inside the
      // same clause ("below 5% while at least one non-creator member remains").
      if (opts.members && MEMBERS_QUALIFIER.test(`${around} ${m[0]}`)) continue;
      return true;
    }
  }
  return false;
};

test('probe: the two sentences Marketing replaced are caught by shape', () => {
  assert.equal(
    caught(UNCONDITIONAL_EXIT, 'Withdrawing is unconditional. It cannot be queued, gated or vetoed.', { citation: true }),
    true,
    'guard 1 no longer catches the homepage sentence it was written for',
  );
  assert.equal(
    caught(
      NO_DELAY_CLAIM,
      'Members exit pro-rata without permission. Redemption cannot be blocked by an operator or by a pending proposal.',
      { citation: true },
    ),
    true,
    'guard 2 no longer catches the principles sentence it was written for',
  );
});

test('probe: the banned shapes are caught as SHAPES, not as those two strings', () => {
  const bad = [
    [UNCONDITIONAL_EXIT, 'Your redemption is entirely unconditional.', { citation: true }],
    [UNCONDITIONAL_EXIT, 'Exits are guaranteed.', { citation: true }],
    [UNCONDITIONAL_EXIT, 'Withdrawal is always available, whatever the vault is doing.', { citation: true }],
    [NO_DELAY_CLAIM, 'Your exit can never be frozen.', {}],
    [NO_DELAY_CLAIM, 'A withdrawal will not be held up by anything.', {}],
    [NO_DELAY_CLAIM, 'Nothing can queue a redemption.', {}],
    [NO_DELAY_CLAIM, 'There is no waiting period before an exit.', {}],
    [AVAILABILITY_PROMISE, 'Take your money out at any time.', { qualifier: true }],
    [AVAILABILITY_PROMISE, 'Redeem on demand.', { qualifier: true }],
    [AVAILABILITY_PROMISE, 'You can withdraw whenever you want.', { qualifier: true }],
    [ACCESS_CLAIM, 'Only you can settle it once the vote is done.', { denial: true }],
    [ACCESS_CLAIM, 'The operator settles your exit when the round finishes.', { denial: true }],
    [ACCESS_CLAIM, "Anyone can request another member's exit for them.", { denial: true }],
    [CASH_ON_EXIT, 'When you exit, the vault sells your position and pays you in USDC.', { denial: true }],
    [CASH_ON_EXIT, 'Redemptions are cashed out to your wallet.', { denial: true }],
    [CASH_ON_EXIT, 'Leaving converts the basket into USDC for you.', { denial: true }],
    [FEE_TO_OPERATOR, 'The exit fee is paid to the operator.', { denial: true }],
    [FEE_TO_OPERATOR, 'The treasury collects the exit fee.', { denial: true }],
    [NO_FEE_ON_EXIT, 'There are no fees when you exit.', {}],
    [NO_FEE_ON_EXIT, 'Leaving is free of charge.', {}],
    [QUEUE_REVERSIBLE, 'You can cancel a queued exit if you change your mind.', { denial: true }],
    [QUEUE_REVERSIBLE, 'A queued redemption can be reversed before it settles.', { denial: true }],
    [AUTO_SETTLES, 'Your exit settles automatically once the rebalance executes.', { denial: true }],
    [FREEZE_HATCH, 'There is an emergency withdrawal for exactly this case.', { denial: true }],
    [FREEZE_HATCH, 'You can still exit while the feed is stale.', { denial: true }],
    [PENDING_TRAPPED, 'A pending deposit is stranded until the freeze lifts.', { denial: true }],
    [GATE_AT_SETTLEMENT, 'The creator gate is evaluated at settlement.', {}],
    // The two cases a missing `\b` after `%` let through. Kept as probes so the trap stays shut.
    [CREATOR_FLOOR, 'The creator must always keep 5% of the vault.', {}],
    [GATE_AT_SETTLEMENT, 'The creator 5% is checked at settlement.', {}],
  ];
  for (const [patterns, s, opts] of bad) {
    assert.equal(caught(patterns, s, opts), true, `the guard no longer catches: ${s}`);
  }
});

test('probe: the true, scoped sentences are NOT caught — the copy must not be forced into a different falsehood', () => {
  const ok = [
    // The approved replacement register: refusal, not delay, with the delay named.
    [UNCONDITIONAL_EXIT, 'Nobody can refuse, gate or veto your exit.', { citation: true }],
    [NO_DELAY_CLAIM, 'Nobody can refuse, gate or veto your exit. It can be delayed — a live vote queues it, a stale feed freezes it.', {}],
    [NO_DELAY_CLAIM, 'A failing fee module can never block an exit.', {}],
    [NO_DELAY_CLAIM, 'Pending capital is never frozen.', {}],
    [
      AVAILABILITY_PROMISE,
      'Ask to leave any time. Nobody can refuse you. If a vote is live your exit queues and settles after it, at the price that follows.',
      { qualifier: true },
    ],
    // Mode I is instant, and two dozen true sentences say so.
    [AVAILABILITY_PROMISE, 'With no execution pending, an exit settles instantly at current NAV (Mode I).', { qualifier: true }],
    [NO_DELAY_CLAIM, 'A second signal exits immediately, and a watchdog force-exits if the hooks never fire.', {}],
    // Settlement, described the way the contract settles.
    [CASH_ON_EXIT, 'You are paid in kind: a slice of everything the vault holds, plus your share of idle USDC.', { denial: true }],
    [
      CASH_ON_EXIT,
      'Redemption in v1 is in kind: you receive the basket tokens, and converting them back is your own transaction, your own routing and your own cost.',
      { denial: true },
    ],
    // The fee, correctly scoped.
    [FEE_TO_OPERATOR, 'Up to 1%, shrinking the longer you have been in. It goes to the members who stay, never to the operator.', { denial: true }],
    [FEE_TO_OPERATOR, 'Operator-as-member receives the exit fee only via their member share like anyone else.', { denial: true }],
    [NO_FEE_ON_EXIT, 'A sole holder pays nothing.', {}],
    // Irrevocability and manual settlement, stated as the truths they are.
    [QUEUE_REVERSIBLE, 'Once queued, the request cannot be withdrawn.', { denial: true }],
    [AUTO_SETTLES, 'But settlement is not automatic in that case: settleQueuedExit has to be called, and anyone can call it.', { denial: true }],
    // The freeze, in both directions.
    [FREEZE_HATCH, 'There is no escape hatch from the staleness breaker and none will be added, because an escape hatch is exactly the stale-price exit the breaker exists to prevent.', { denial: true }],
    [FREEZE_HATCH, 'Only capital still inside an un-activated observation window stays reclaimable.', { denial: true }],
    [PENDING_TRAPPED, 'Pending capital is the only capital that stays reclaimable while the oracle is frozen.', { denial: true }],
    // The creator gate, with its two qualifiers.
    [
      GATE_AT_SETTLEMENT,
      'Creator redemptions revert if they would take creator share below 5% while at least one non-creator member remains, and the gate is checked when the exit is requested.',
      {},
    ],
    [
      CREATOR_FLOOR,
      'Creator redemptions revert if they would take creator share below 5% while at least one non-creator member remains.',
      { members: true },
    ],
  ];
  for (const [patterns, s, opts] of ok) {
    assert.equal(caught(patterns, s, opts), false, `the guard reds prose that is TRUE: ${s}`);
  }
});

test('probe: the fee ceiling is compared against the contract, not against a number written here', () => {
  const facts = exitMechanics();
  const cap = facts.exitFeeCapBps / 100;
  const stated = (s) => {
    FEE_CEILING.lastIndex = 0;
    const m = FEE_CEILING.exec(flat(s));
    return m ? Number(m[1]) : null;
  };
  // THIS ASSERTION COMES FIRST ON PURPOSE. Guard 6 only reds on a ceiling ABOVE the cap, so RAISING
  // `EXIT_FEE_CAP_BPS` makes every "up to 1%" in the repository stale WITHOUT reddening the guard —
  // the copy would then understate a fee a vault may now charge. This tripwire is the only thing
  // that catches that direction, and a draft that checked it last reported the failure as a probe
  // arithmetic error instead of naming the constant.
  assert.equal(
    facts.exitFeeCapBps,
    100,
    'EXIT_FEE_CAP_BPS is no longer 100 (1%). Every quoted exit-fee ceiling in the repository was\n' +
      'written against 1% and is now stale — and guard 6 will NOT catch it, because it only reds a\n' +
      'ceiling above the cap. Re-read every exit-fee sentence, then re-point this number.',
  );
  assert.equal(stated('Exit fee: up to 1%, shrinking the longer you have been in.'), 1);
  assert.equal(stated('exit fee <=1% decaying with tenure'), 1);
  assert.ok(stated(`The exit fee is capped at ${cap + 1.5}%.`) > cap, 'an inflated ceiling must exceed the derived cap');
  // A performance fee quoted beside the exit fee must not be read as the exit fee's ceiling.
  assert.equal(stated('10% perf + exit fee, both displayed before you sign'), null);
});

// ---------------------------------------------------------------------------------------------
// COVERAGE, NOT A GUARD — the walk must reach the site's prerendered pages.
//
// The guards above are aimed first at the marketing copy, and that copy exists on disk as prose
// only after `npm run build --workspace apps/site`. `apps/site/.gitignore` ignores `dist/` on its
// first line. Run the build after `npm run test:backend` and every guard above walks zero rendered
// pages and reports a pass — indistinguishable from a pass over everything.
//
// This test MAY name its files: it is a POSITIVE requirement, and requiring too little never lets
// a falsehood through. It does NOT skip when the build is missing; its whole subject is the
// missing input. The page list is read from `apps/site/src/pages.ts` rather than copied, for the
// reason `claims-lede-truth.test.mjs` gives at its own copy of this test: a copied list that is
// shorter than reality goes silent, which is the failure being guarded.
// ---------------------------------------------------------------------------------------------
const SITE = 'apps/site';
const MIN_PAGES = 3;

const prerenderedPages = () => {
  const src = path.join(REPO, SITE, 'src', 'pages.ts');
  assert.ok(existsSync(src), `${SITE}/src/pages.ts is missing, so the pages this guard must reach cannot be named.`);
  const text = readFileSync(src, 'utf8');
  const ids = /export const PAGE_IDS\s*=\s*\[([\s\S]*?)\]/.exec(text);
  assert.ok(ids, `could not parse PAGE_IDS out of ${SITE}/src/pages.ts — the declaration moved`);
  const pages = [...ids[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const notFound = /export const NOT_FOUND_ID\s*=\s*['"]([^'"]+)['"]/.exec(text);
  assert.ok(notFound, `could not parse NOT_FOUND_ID out of ${SITE}/src/pages.ts`);
  const all = [...pages, notFound[1]];
  assert.ok(
    all.length >= MIN_PAGES,
    `${SITE}/src/pages.ts declares ${all.length} prerendered page(s), fewer than the ${MIN_PAGES} this\n` +
      'site has ever published. Either the declaration was gutted or the parse stopped matching it,\n' +
      'and both make the assertion below too weak to mean anything.',
  );
  return all.map((page) => `${SITE}/dist/${page}`);
};

test('every prerendered page is inside the exit-claims walk', () => {
  const walked = new Set(publicSurfaces());
  const missing = prerenderedPages().filter((f) => !walked.has(f));
  assert.deepEqual(
    missing,
    [],
    'The guards above walked none of these pages, so they reported a pass over the marketing copy\n' +
      'they exist to check. Two silent causes:\n' +
      '  1. THE BUILD HAS NOT RUN. `apps/site/.gitignore` ignores `dist/`, so the pages exist only\n' +
      '     after:  npm run build --workspace apps/site\n' +
      '     `scripts/gate.mjs` and `.github/workflows/ci.yml` both run that step BEFORE\n' +
      '     `npm run test:backend`. Keep it there.\n' +
      '  2. `dist` WAS ADDED TO SKIP_DIRS. It is deliberately absent: the site publishes its prose\n' +
      '     only as build output.\n' +
      `Not walked:\n  ${missing.join('\n  ')}`,
  );
});
