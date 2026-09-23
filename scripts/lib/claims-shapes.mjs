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
