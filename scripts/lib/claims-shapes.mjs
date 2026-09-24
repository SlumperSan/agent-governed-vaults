/**
 * The banned claim SHAPES, factored out of `scripts/test/claims-lede-truth.test.mjs` so a second
 * guard can reuse them without a second, independently-maintained copy — two copies of the same
 * rule drift, and this repo has already paid for that once (see that file's header).
 *
 * THIS MODULE IS NOT IMPORTED BY THE TEST FILE FOR ITS OWN SAKE. It exists because
 * `claims-web-prose-truth.test.mjs` (the guard scoped to `apps/web/src/*.mjs`, card #68) needs
 * these exact regexes, and importing `claims-lede-truth.test.mjs` directly would re-execute every
 * `test()` registration in that file inside the importing process — under `node --test`, each test
 * file runs in its own process, so `claims-lede-truth.test.mjs`'s eleven tests would run once for
 * itself and once again, silently, as a side effect of the import. Factoring the shapes here avoids
 * that: `claims-lede-truth.test.mjs` imports from here too, so this file — not either test file —
 * is the single source of truth, and neither test file executes the other's assertions.
 *
 * The FULL reasoning for each shape (why it is banned, what the approved replacement wording is,
 * which contract read backs the claim) lives in `claims-lede-truth.test.mjs`'s header and inline
 * comments, next to the guard tests that use these shapes over the repo's public surfaces. Read it
 * there; this file intentionally does not repeat it.
 */

/** Collapse hard-wrapped prose so a sentence split across two lines still matches as one. */
export const flat = (s) => s.replace(/\s+/g, ' ');

/** Sentence-scoped, on the same rule `flat` applies: a mention and its status split across a line
 * break still count as one sentence. */
export const sentencesOf = (text) => text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/);

// ---------------------------------------------------------------------------------------------
// Guard 1 shape — an AI agent does NOT pool, and does NOT govern.
// ---------------------------------------------------------------------------------------------
export const AGENT_ACTS = [
  /\b(?:AI\s+)?agents?\b(?:\s+(?:also|only|then|now|actually|jointly|collectively|therefore))*\s+\b(?:pool|pools|pooling|govern|governs|governing|manage|manages|managing|trade|trades|trading|rebalance|rebalances|rebalancing)\b/gi,
  /\b(?:governed|pooled|managed|traded|controlled)\s+by\s+(?:\w+\s+){0,2}(?:AI\s+)?agents?\b/gi,
  /\bagent-governed\s+(?:\w+\s+){0,2}baskets?\b/gi,
];

/** Product names, permitted BY NAME rather than by an accident of the alternation above. */
export const PRODUCT_PHRASES = /\bAI agent trading index\b/gi;

/** The text with every permitted product phrase blanked to the same length, so offsets survive. */
export const maskProductPhrases = (s) => s.replace(PRODUCT_PHRASES, (m) => ' '.repeat(m.length));

// ---------------------------------------------------------------------------------------------
// Guard 2 shape — no universal "weighted vote" claim in a lede.
// ---------------------------------------------------------------------------------------------
export const UNIVERSAL_WEIGHTED = [
  /\b(?:govern|governs|governed|ratify|ratifies|decide|decides|vote|votes|voting)\b(?:\s+\w+){0,4}\s+by\s+(?:\w+[- ]){0,2}weighted\s+vote\b/gi,
  /\bcommit-reveal\s+weighted\s+vote\b/gi,
];

// ---------------------------------------------------------------------------------------------
// Guard 3 shape — "stake-weighted" is allowed ONLY beside its sub-five qualifier (co-occurrence).
// ---------------------------------------------------------------------------------------------
export const STAKE_WEIGHTED = /\bstake-weighted\b/i;
export const SUB_FIVE_QUALIFIER =
  /SIGNER_REGIME_BELOW|below\s+five|fewer\s+than\s+five|under\s+five|five\s+or\s+more|<\s*5\b|sub-five|small-member\s+regime/i;

// ---------------------------------------------------------------------------------------------
// Guard 4 shape — the sub-five regime is NOT stake-blind (the risks page had this backwards).
// `de-stake-blind` is the NAME OF THE FIX (PR #44); the lookbehind stops it matching as a claim.
// ---------------------------------------------------------------------------------------------
export const STAKE_BLIND = [
  /(?<!de-)\bstake-blind\b/gi,
  /\babsolute\s+signer\s+counts?\b/gi,
  /\bpure\s+head\s*-?\s*counts?\b/gi,
];

/** Prose that names the old behaviour AND its remediation status in one breath is a RECORD of a
 * finding, not a claim about today. */
export const REMEDIATION_STATUS = /\bfixed\b|\bremediated\b|\bpartially\b|\bclosed\b|\bresolved\b|\bde-stake-blind\b/i;

/** Prose that DENIES the phrase is the correction, not the claim — "neither is a pure head
 * count". Deliberately narrow: an explicit negation in the ~40 characters immediately BEFORE the
 * match. */
export const DENIED = /\b(?:not|never|neither|nor|no longer|rather than|instead of|stops? being)\b[^.]{0,40}$/i;

// ---------------------------------------------------------------------------------------------
// Guard 5 shape — "permissionless" must not be paired with a claimed on-chain member gate.
// ---------------------------------------------------------------------------------------------
export const ONCHAIN_MEMBER_GATE =
  /\b(?:contracts?|protocol|vault|on-chain)\b[^.]{0,80}\b(?:allowlist|allow-list|whitelist)s?\b[^.]{0,40}\b(?:members?|depositors?|participants?|users?|deposits?)\b|\b(?:members?|depositors?|participants?)\b[^.]{0,40}\b(?:allowlist|allow-list|whitelist)s?\b|\b(?:approved|vetted|permitted)\s+(?:members?|depositors?|participants?)\b/gi;

// ---------------------------------------------------------------------------------------------
// Guard 6 shape — the operator's powerlessness must be ENUMERATED, never claimed as a universal.
// ---------------------------------------------------------------------------------------------
export const POWER_CLAIM =
  /\bno\s+(?:privileged|special|on-chain|onchain|protocol-level|inherent|real|actual|meaningful|extra|additional|blanket)(?:\s+[A-Za-z][A-Za-z-]*){0,2}\s+(?:privileges?|powers?|authority|authorities|control|rights?)\b/gi;

/** The one form that is NOT a universal: an ENUMERATION ("to vote, execute, pause, ..."). */
export const ENUMERATION_FOLLOWS = /^\s*to\s+[a-z][\w'-]*(?:\s+[\w'-]+){0,3}\s*,/i;

// ---------------------------------------------------------------------------------------------
// Guard 7 shape — RWLY is never the object of a protocol transfer verb, and never a governance or
// entitlement subject.
// ---------------------------------------------------------------------------------------------
export const RWLY_ATTRIBUTION = [
  /\b(?:the\s+)?(?:contracts?|protocol|vault|governance|feeengine|fee\s+engine)\b[^.;:!?]{0,60}\b(?:routes?|pays?|distributes?|accrues?|credits?|sends?|allocates?)\b[^.;:!?]{0,40}\bRWLY\b/gi,
  /\bRWLY\s+holders?\s+(?:votes?|governs?|decides?|receives?|earns?|claims?)\b/gi,
  /\bRWLY-weighted\b/gi,
  /\bstake\s+RWLY\b/gi,
];

/** "backed by the vault(s)" as a description of RWLY — sentence-scoped. */
export const RWLY_BACKED_BY_VAULT = /\bbacked\s+by\s+the\s+vaults?\b/i;

// ---------------------------------------------------------------------------------------------
// Guard 9 shape — never claim a fee (or anything else) bypasses the operator AS A PERSON.
//
// The operator is a member: the creator holds a >=5% stake lock (THREAT-MODEL CM-1), so it receives
// the exit fee pro rata through its own shares like anyone who stays (EE-9). "Never to the operator"
// is therefore false, and it shipped on four member-facing surfaces before this guard existed.
//
// WHAT IT SPARES, deliberately: the ROUTING form. "never routed to the operator" / "never routes to
// the operator" is true (no code path transfers the fee to the operator's address) and is how
// EE-9, CANARY.md and the engineering docs say it. The identity form — "never goes to", "never to",
// "members, not the operator" — is the misreading EE-9 was written to prevent.
// ---------------------------------------------------------------------------------------------
export const FEE_BYPASSES_OPERATOR = [
  // "never to the operator", "never goes to the operator", "is never paid to the operator"
  /\bnever\s+(?:(?:goes|go|is\s+paid|paid|given|sent|flows)\s+)?to\s+(?:the\s+)?operator\b/gi,
  // "never reaches the operator", "does not reach the operator"
  /\b(?:not|never)\s+reach(?:es)?\s+(?:the\s+)?operator\b/gi,
  // "paid to the members who stay, not the operator", "accrues to members, never the operator"
  /\b(?:accrues?|accrue|goes|paid|flows?)\s+to\s+(?:the\s+)?(?:remaining\s+)?members?\b[^.;]{0,50}?,\s*(?:not|never)\s+(?:to\s+)?(?:the\s+)?operator\b/gi,
];

// ---------------------------------------------------------------------------------------------
// Card #133 (P-O21) shape A — no shipped surface may claim exits pay USDC unconditionally.
//
// `VaultCore._settleExit` pays pro rata from whatever the vault actually holds: idle USDC FIRST
// (SV-5), the basket-asset slice goes out IN KIND, and only a residual CASH shortfall unwinds
// CHILD vault positions (never the basket itself) — never a swap. `grep -c exitSwap
// contracts/src` is 0 today; Design B's exit-swap-to-USDC has no contract at all (exit-payout-
// copy-2026-09-18.md: "Design A is not a fallback — it is what contracts/src does today ... never
// render B's copy against an A contract"). So an exit described as paying USDC with no qualifier
// is false today. The true forms are "in kind" / "cirBTC and USDC" (Design A, live) or a NAMED
// CONDITION ("in ordinary conditions", "unless the market is stressed" — Design B, written and
// held, not shipped). Matched by SHAPE; a NEARBY occurrence of the in-kind leg or the condition
// (EXIT_USDC_QUALIFIER, checked by the guard test in a SHORT, bounded character window around the
// match) makes it exempt — not a "sentence": `.` and `?` inside TSX/JS source do not mark prose
// sentence boundaries the way they do in a `.md` file, so a punctuation-based split can hand back
// one "sentence" that is an entire minified line or a whole render function, and a qualifier word
// anywhere in THAT would count as cover for an unrelated claim far away from it. The window has to
// stay SHORT for the opposite reason a sibling guard's window is wide: a wide window over a
// vocabulary-dense exit panel — `exit-preview.mjs`'s own docstrings say "in-kind" and "pro rata"
// repeatedly, explaining the math rather than qualifying any claim — would let that vocabulary
// cover an unrelated, unqualified claim written nearby in the same file, which is exactly the file
// this claim is most likely to be written in. Every true instance in exit-payout-copy-2026-09-18
// .md carries its qualifier in the SAME clause or the one immediately following (", not cash
// alone", ", not a promise" — a few characters away, never a separate paragraph), so a short
// window loses nothing true while closing that laundering path. `stripTags` (below) runs first so
// a claim split by inline markup — "Exits pay <strong>USDC</strong>." — still reads as one run of
// text before either regex sees it.
// ---------------------------------------------------------------------------------------------
// The word-gap unit is `[\w$.,%{}()]+`, not bare `\w+`: a bare `\w+` cannot cross a decimal
// point, so "You will receive 140.50 USDC" (a REAL instance of the banned shape) silently failed
// to match with `\w+` — the "." in "140.50" breaks the token and the gap quantifier has nowhere
// to continue from. Rendered money amounts routinely carry a decimal, a thousands comma, or a
// leading "$", so the gap has to tolerate them.
//
// `{}()` were added second, and the reason is worth recording because the first version already
// looked complete: in the SOURCE FILES this guard walks, a rendered amount is not usually a
// literal number at all — it is an interpolation, `You will receive {usdcOut} USDC.` in JSX or
// `` `Exits pay ${fmt(x)} USDC` `` in a template literal. Verified with `node` before this was
// added: neither matched ANY shape in EXIT_PAYS_USDC_UNCONDITIONALLY, because `{`, `}`, `$`
// (already covered) and `(` `)` broke the gap exactly the way `.` did for decimals. `$` alone is
// not enough for a template literal — `${fmt(x)}` needs `{`, `(`, `)` and `}` all four to stay
// inside one gap token. This is not a hypothetical: it is the shape a real Engineering plant would
// take, and the mutation test below exercises exactly that string in a real component.
const GAP = '[\\w$.,%{}()]+';
// "settle(s/d/ing)" is in the verb alternation below for a reason worth recording: the L1 vault
// row chip's LIVE, TRUE copy is "Settles in kind" (exit-payout-copy-2026-09-18.md §7.2), and its
// one-word flip — "Settles in USDC" — is the single most likely plant on this card, because it
// reuses the exact verb the true chip already ships with. Verified with `node` before this was
// added: neither "Settles in USDC" nor "Your exit settles in USDC." matched any shape here, since
// "settle" was in no verb list and the bare form has no "exit"/"you" subject for pattern 1 to
// anchor on at all. Two fixes, not one: the verb alternation below catches "exit ... settles ...
// USDC" (a subject present), and the bare `/\bsettles?\s+in\s+USDC\b/gi` two lines down catches
// the chip's own subjectless form.
export const EXIT_PAYS_USDC_UNCONDITIONALLY = [
  new RegExp(`\\bexits?\\b(?:\\s+${GAP}){0,4}\\s+(?:pay|pays|paying|paid|settle|settles|settled|settling)\\b(?:\\s+${GAP}){0,3}\\s+(?:in\\s+|out\\s+in\\s+)?USDC\\b`, 'gi'),
  new RegExp(`\\b(?:redeem|redeems|redeeming|redeemed|redemptions?|withdraw|withdraws|withdrawing|withdrawn|withdrawals?)\\b(?:\\s+${GAP}){0,4}\\s+(?:for|in|into|to)\\s+USDC\\b`, 'gi'),
  new RegExp(`\\bcash(?:es|ing)?\\s+out\\b(?:\\s+${GAP}){0,3}\\s+(?:in|for|into)\\s+USDC\\b`, 'gi'),
  new RegExp(`\\byou\\s+(?:will\\s+)?(?:receive|get|are\\s+paid|are\\s+given)\\b(?:\\s+${GAP}){0,3}\\s+USDC\\b`, 'gi'),
  /\bUSDC[- ]settled\b/gi,
  /\bpaid\s+(?:out\s+)?in\s+USDC\b/gi,
  // "Deposits are USDC-only and always were" (exit-swaps-to-usdc-puts-three-claims-on-notice.md)
  // is TRUE and unconditional — a deposit really does settle in USDC, always, no qualifier
  // needed. A bare subject-free "settles in USDC" pattern cannot tell that sentence from the
  // banned exit claim by shape alone, so the exclusion is a NEGATIVE LOOKBEHIND scoped to this
  // one pattern (not a general EXIT_USDC_QUALIFIER entry): adding "deposit" as a qualifier
  // anywhere in the window would let an EARLIER, unrelated deposit sentence exempt a LATER, real
  // exit claim within 40 characters of it — the same laundering shape "queued" was removed for
  // above. Scoping the exclusion to immediately before THIS match closes the deposit false
  // positive without reopening that hole.
  /(?<!deposits?\s{0,4})\bsettles?\s+in\s+USDC\b/gi,
];

/** Blank out HTML/JSX tags (opening, closing, self-closing) to a single space so a claim split
 * across a tag boundary — "Exits pay <strong>USDC</strong>." in a `.tsx` source file — still
 * reads as one run of text to the regexes above and to EXIT_USDC_QUALIFIER below.
 *
 * The attribute portion is matched as a real HTML/JSX attribute LIST — zero or more
 * `name`, `name="value"`, `name='value'` or `name={expr}` groups — rather than "any characters
 * that are not `<`/`>`". An earlier version used the permissive form and had a real hole, found
 * in review and verified with `node`, not assumed: `n<max ? 'Exits pay USDC' : n>0` matched as one
 * "tag" — `<max ...>` — because the permissive attribute span happily swallowed
 * ` ? 'Exits pay USDC' : n` up to the next `>`, and the banned claim SITTING INSIDE A STRING
 * LITERAL disappeared from the matching haystack entirely. The attribute-list form fixes THAT
 * shape: the comparison's `? 'Exits pay USDC' : n` is not a `\s+name(=value)?` sequence, so the
 * match fails at "max" and the whole span is left untouched — verified with the same
 * `n<max ? ... : n>0` input, which now passes through unchanged.
 *
 * THIS FUNCTION DOES HIDE A CLAIM SITTING INSIDE A REAL ATTRIBUTE VALUE, and that is NOT a fixed
 * hole, it is a STATED LIMIT the caller must design around. `<span title="Exits pay USDC">x</span>`
 * becomes `" x "` — the whole tag, value included, is blanked, because the value is genuinely
 * part of the tag's own syntax this time, not a mismatch this function can detect. `title`,
 * `aria-label`, `alt` and `placeholder` are member-facing attributes, not decoration, and
 * `apps/web/index.html` is exactly the kind of large hand-written HTML file where one is likely.
 * VERIFIED with `node`, both directions — this is not a hypothetical:
 *   stripTags('<span title="Exits pay USDC">x</span>')                    -> ' x '
 *   stripTags('<p aria-label="The exit swap replaced the deposit cap">')  -> ' '
 * BECAUSE OF THIS, no caller may use `stripTags`'s output as the ONLY text a shape is matched
 * against. The guard test in `claims-exit-usdc-truth.test.mjs` matches every shape against BOTH
 * the raw text and the `stripTags`-processed text and takes the union of what either one catches
 * — raw text catches a claim inside an attribute value (or anywhere untouched by markup); the
 * processed text catches a claim tag-split in ordinary text. Never call this function and treat
 * its output as authoritative on its own.
 *
 * LIMIT, lower stakes, stated rather than implied: a single-word TypeScript generic is also
 * blanked — `Array<string>` becomes `Array ` — because a bare type name reads as a valid
 * zero-attribute tag. `Record<Asset, bigint>` is left untouched (the comma cannot start an
 * attribute). Neither behaviour is a rule worth relying on, and both are lower-stakes than the
 * attribute-value limit above: the raw-text pass covers this one too, since a generic never
 * carries a claim of its own that only the stripped pass could see.
 *
 * ALSO NORMALIZES JSX'S EXPLICIT-SPACE IDIOM, `{' '}` / `{" "}`, to a real space. `apps/vaults-ui`
 * uses it repeatedly (`{v.frozen ? '...' : ...} ·{' '}`) to force whitespace JSX would
 * otherwise collapse between two elements — a claim split as "Exits pay{' '}<strong>USDC</strong>"
 * would read as "Exits pay" + "USDC" with no space between "pay" and the tag at all once the tag
 * itself is stripped, and `\s+` in the shapes above requires a REAL whitespace character to cross
 * that gap. Same JOIN-only reasoning as the tag stripping above: this can only turn two runs of
 * text markup split into one, never hide anything, so it is applied unconditionally alongside it. */
export const stripTags = (s) =>
  s
    .replace(/\{\s*(['"])(\s+)\1\s*\}/g, ' ')
    .replace(/<\/?[A-Za-z][\w.-]*(?:\s+[A-Za-z][\w-]*(?:=(?:"[^"]*"|'[^']*'|\{[^{}]*\}))?)*\s*\/?>/g, ' ');

/** Co-occurring qualifier that makes a matched claim TRUE: names the in-kind leg, or the
 * condition Design B's held copy would need before it could name USDC without qualification.
 * Checked by the guard test in a bounded character WINDOW around the match, not file- or
 * sentence-scoped — see the note above EXIT_PAYS_USDC_UNCONDITIONALLY for why sentence-scoping is
 * the wrong tool over source files. Deliberately narrow, and two generic words that would rot
 * into a blanket exemption were tried and removed: "instead" (appears in unrelated code far more
 * than in the degrade copy) and "queued" (queuing is a TIMING mechanic, Mode F, and says nothing
 * about which currency pays — "Exits are queued and pay USDC." is still the unconditional claim,
 * not a qualified one, and a guard that reads "queued" as cover would wave it through). */
export const EXIT_USDC_QUALIFIER =
  /\bin[- ]kind\b|\bcirBTC\b|\bnot\s+cash(?:\s+alone)?\b|\bnot\s+a\s+promise\b|\bestimat(?:e|ed|ion)\b|\b(?:if|when|unless)\s+the\s+market\b|\bordinary\s+conditions\b|\bshare\s+of\s+what\s+it\s+(?:actually\s+)?holds\b|\bdepend(?:s|ing)?\s+on\b|\bnot\s+(?:always|guaranteed|unconditional(?:ly)?)\b|\bpro[- ]rata\b/i;

// ---------------------------------------------------------------------------------------------
// Card #133 (P-O21) shape B — the exit swap never replaced the deposit cap.
//
// `No deposit cap 2026-09-18.md`, verified against contracts/src: `capacityCapUsdc` bounded the
// POSITION; an exit swap (unshipped — see shape A, `grep -c exitSwap contracts/src` is 0) would
// only ever bound the PRICE of converting one. A member holding a position past the pool's usable
// depth still degrades to in-kind every time, swap or no swap — "no improvement at all for the
// largest one". Never claim the swap replaces, closes, supersedes, or removes the need for the
// cap. Split into two groups because they need OPPOSITE treatment for the correction sentence
// ("the exit swap did NOT replace the cap"):
//
//   - EXIT_SWAP_REPLACED_CAP_VERB: a REPLACE-ish verb between "exit swap" and "cap". A negation
//     can sit INSIDE this span ("exit swap did NOT replace ... cap"), so the guard test checks the
//     matched text itself for EXIT_SWAP_REPLACED_CAP_NEGATED and exempts it — DENIED's fixed
//     lookback in claims-shapes' guard-4 style would miss it, since the negation is mid-span here,
//     not before the match.
//   - EXIT_SWAP_REPLACED_CAP_NO_NEED: "no (longer) need for a cap ... exit swap". This is already
//     the negative form ("no need") — the same negation filter would wrongly exempt every real hit
//     ("no longer" trips EXIT_SWAP_REPLACED_CAP_NEGATED too), and there is no correction sentence
//     shaped like this one to spare: denying it reads as "there is still a need for a cap", which
//     does not match this shape at all. So the guard test applies NO negation filter here.
// ---------------------------------------------------------------------------------------------
export const EXIT_SWAP_REPLACED_CAP_VERB = [
  /\bexit\s+swap\b[^.;:!?]{0,60}\b(?:replace(?:s|d|ing)?|eliminat(?:es?|ed|ing)|remov(?:es?|ed|ing)|obviat(?:es?|ed|ing)|supersede(?:s|d)?|does\s+away\s+with)\b[^.;:!?]{0,40}\b(?:deposit\s+)?cap\b/gi,
  /\b(?:deposit\s+)?cap\b[^.;:!?]{0,60}\b(?:replaced|superseded|obviated)\s+by\b[^.;:!?]{0,40}\bexit\s+swap\b/gi,
];

export const EXIT_SWAP_REPLACED_CAP_NO_NEED = [
  /\bno\s+(?:longer\s+)?(?:a\s+)?(?:need|needs|needed)\s+(?:for\s+)?(?:a\s+)?(?:deposit\s+)?cap\b[^.;:!?]{0,80}\bexit\s+swap\b/gi,
  /\bexit\s+swap\b[^.;:!?]{0,80}\bmakes?\s+(?:the\s+)?(?:deposit\s+)?cap\s+unnecessary\b/gi,
];

/** The negation that turns an EXIT_SWAP_REPLACED_CAP_VERB match into the correction rather than
 * the claim — checked against the MATCHED TEXT ITSELF by the guard test, not a fixed window
 * before it, because "did NOT replace" sits between "exit swap" and "replace" inside the match's
 * own span. Deliberately NOT applied to EXIT_SWAP_REPLACED_CAP_NO_NEED — see that export's note. */
export const EXIT_SWAP_REPLACED_CAP_NEGATED =
  /\b(?:not|never|no\s+longer|didn't|doesn't|does\s+not|did\s+not|isn't|is\s+not|wasn't|was\s+not)\b/i;
