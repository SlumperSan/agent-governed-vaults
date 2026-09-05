/**
 * The four groups this is wrong for: the reviewed copy, held as HTML source
 * bytes. Rendered by RisksScopeAdditions, on disclaimers.html.
 *
 * IT MOVED HERE ON 2026-09-05, ROUND 8, OUT OF who-its-for.html, and the move
 * is the corpus's own rather than a judgement made here. PR #220
 * (`2faed164`, "site: Rwally, one Disclaimers page, and the guards rewritten
 * to match") deleted the `Not for you if` section from
 * `apps/site/who-its-for.html` outright and put these four groups on
 * `apps/site/disclaimers.html` under `<h3>Four groups this is wrong for</h3>`,
 * with this build's port never following. Its commit message states the rule
 * it was applying: page bodies are positive and factual, and the Disclaimers
 * page carries every risk, warning and caveat. Four headings that open "Anyone
 * who cannot..." are caveats by that rule, so they belong on the page that
 * holds them, and who-its-for keeps the factual half: what the design assumes,
 * what the deal is, and that nothing is capped because nothing is created.
 *
 * NO POINTER SENTENCE WAS ADDED TO who-its-for TO REPLACE THEM. It already
 * closes on `who-decide` ("Read the Disclaimers in full, then decide." with
 * the Disclaimers link as its lead action), which is the pointer, and it is
 * the pointer `apps/site/who-its-for.html` itself closes on. Writing a second
 * one here would put a sentence in this build that the corpus does not carry,
 * and text-for-text sync with that corpus is the point of the pairing.
 *
 * WHERE IT CAME FROM. Every string below is lifted byte-for-byte from the
 * `Four groups this is wrong for` grid of `apps/site/disclaimers.html`.
 * Nothing here was rewritten, re-punctuated or tightened, and nothing here is
 * new: this section writes no sentence the current site does not already carry.
 *
 * WHY BYTES RATHER THAN TEXT. `renderToString` escapes text children, so an
 * apostrophe reaches `dist/disclaimers.html` as `&#x27;` and a byte-comparison
 * against the reviewed original fails on markup that looks perfect in a
 * browser. These are rendered through `<Pinned>` (src/shell/PinnedText.tsx),
 * which writes them straight onto the semantic element. Two of the four bodies
 * need it outright — the first carries both an apostrophe and an inline
 * `<em>`, the fourth carries an em-dash — and the other two are held the same
 * way so the section has one rule rather than an exception nobody remembers.
 *
 * THE CLAUSE THAT MUST NOT BE TOUCHED. `CARD_4_BODY` contains
 * `a good-faith measure and not a guarantee`, which is one of the exact
 * fragments the claims suite exempts and which it separately asserts is in
 * actual use on the site. It is exempt as a whole clause, so shortening it,
 * re-punctuating it or splitting it across two elements turns the sentence
 * into a banned word standing on its own. Leave it exactly as it reads.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBERS, EACH READ OUT OF THE REPOSITORY RATHER THAN OUT OF A DOCUMENT
 * ---------------------------------------------------------------------------
 *   50,000 USDG first-vault capacity cap
 *     contracts/config/robinhood-mainnet.json:164  `"capacityCapUsdc": "50000000000"`
 *       — the same six-decimal value as contracts/config/base-mainnet.json:221;
 *       only the unit name changes. The field is still called `capacityCapUsdc`
 *       and the note text on the stated target chain still says USDC, because
 *       that block is a verbatim copy of base-mainnet.json's — but the units on
 *       Robinhood Chain (chain id 4663) are USDG, not Circle USDC
 *       (robinhood-mainnet.json:163, `smokeParametersProvenanceNote`), so
 *       50_000_000_000 units is 50,000 USDG there.
 *
 *   "a capacity cap is immutable per vault"
 *     contracts/src/VaultCore.sol:81   `uint256 public immutable capacityCapUsdc;`
 *     contracts/src/VaultCore.sol:279  set once, in the constructor
 *     contracts/src/VaultCore.sol:409-410  the only read: a deposit reverts with
 *       `CapacityExceeded()` once NAV plus pending plus the new amount would
 *       cross it. There is no setter, so "will not be raised" is a property of
 *       the deployed bytecode rather than a policy.
 *
 *   "a second, larger vault of at least 250,000 USDG after at least 30
 *    incident-free days"
 *     docs/LAUNCH-READINESS.md:128  "Raise by deploying a second vault (>=250k)
 *       only after >=30 incident-free days with the canary clean."
 *       That line is a recorded plan, which is why the copy says so in the same
 *       breath: a different deployment on a later date, and a plan rather than
 *       a commitment.
 *
 *   "The code cannot be patched."
 *     contracts/src/VaultCore.sol — no proxy, no upgrade entry point and no
 *       pause; the same fact the index page's immutability cards state at
 *       length, restated here as an exclusion criterion.
 */

/* --- the four card headings ------------------------------------------------
   No apostrophes, ampersands and no inline markup, so these survive text
   rendering unescaped — but they are held here beside their bodies so one file
   is the whole passage. */

export const CARD_1_TITLE = 'DAO treasuries and larger allocators';
export const CARD_2_TITLE = 'Anyone who wants set-and-forget';
export const CARD_3_TITLE = 'Anyone who cannot survive a total loss';
export const CARD_4_TITLE = 'Anyone in a restricted jurisdiction';

/* --- the four card bodies --------------------------------------------------
   CARD_1_BODY carries `<em>this</em>`, and the emphasis is load-bearing: it is
   what restricts "will not be raised" to the first vault rather than letting it
   read as a statement about every vault the factory can ever deploy. It also
   REPOINTED 2026-09-05, copy deck v2. Owner: "I haven't created the safe
   vault yet. I want the pivot to the all-stocks index." CARD_1_BODY used to
   carry the page-level 50,000/"planned" pairing on its own; that figure
   described a vault that will not be created, so it comes out entirely
   rather than being requalified. Carried verbatim from the "DAO treasuries
   and larger allocators" entry of the "Four groups this is wrong for" list
   on `apps/site/disclaimers.html` as of this deck — apps/site consolidated
   this list onto the Disclaimers page in an earlier round (PR #220) while
   this build still renders the equivalent four cards on who-its-for.html;
   that page placement predates this change and is not something this pass
   relocates, but the sentence itself is the reviewed, current wording either
   way.

   CARD_1_BODY is also why this section is the one that must not be
   summarised. Every clause in it is a scope limit on the clause before it. */

export const CARD_1_BODY =
  'A capacity cap is a per-vault parameter, chosen by whoever creates a vault and frozen when it is funded. No vault exists yet, so there is no cap sized for a treasury to check against, and no vault this site can point to as able to absorb one.';

export const CARD_2_BODY =
  'There is no autopilot. Skipping votes does not park your position neutrally: it moves quorum and wastes your commit; it hands the outcome to whoever did turn up.';

export const CARD_3_BODY =
  'Spot crypto assets fall. The code cannot be patched. There is no insurance fund and no backstop. Nobody makes anyone whole. Deposit only what you can lose entirely.';

export const CARD_4_BODY =
  'Interests in these vaults may be treated as securities or as collective investment scheme interests where you live. Front-end geofencing is intended, but it is a good-faith measure and not a guarantee. The contracts are permissionless and can be called directly by anyone. Take your own advice about your own jurisdiction.';
