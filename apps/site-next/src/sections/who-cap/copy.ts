/**
 * who-cap — the section's reviewed copy, held as HTML source bytes.
 *
 * EVERY STRING BELOW IS CARRIED VERBATIM from the section headed "The cap" in
 * `apps/site/who-its-for.html` (grep for "A planned 50,000 USDG is a blast
 * radius"). Nothing in this file was composed, and nothing was re-punctuated.
 * If one of these sentences needs to change, it changes on the current site
 * first, under review, and is copied across afterwards.
 *
 * BODY now opens with the sentence that used to live only in who-not-for's
 * first card ("The first vault's planned capacity cap is 50,000 USDG, and a
 * capacity cap is immutable per vault."): the corpus merged it into this
 * paragraph and shortened the rest. `who-cap`'s heading already supplied the
 * page's 50,000/"planned" pairing on its own, so this is a second, independent
 * pairing rather than a dependency on it.
 *
 * WHY THE BODIES ARE BYTES AND NOT JSX TEXT. React escapes text children, so
 * an apostrophe reaches the prerendered file as `&#x27;` and an ampersand as
 * `&amp;`. Neither sentence here carries one today — the whole passage is
 * ASCII with no escapable character — but the guards read the raw bytes of
 * `dist/who-its-for.html`, so the day an edit introduces a possessive the
 * failure would land on a sentence that looks perfect in the browser. These
 * strings therefore go through `<Pinned>`, which writes them onto the element
 * untouched.
 *
 * THE ONE STRING THAT BITES IF IT DRIFTS. `NOTE_BODY` ends with the fragment
 * `nothing on this site to sign up for`. The two-word conversion phrase inside
 * it is on the BANNED list in `apps/site/test/site.test.mjs`, and that exact
 * fragment is the PERMITTED negation `scrubPermitted()` strips before the ban
 * runs — an exact-substring strip, not a pattern. Re-punctuating it, re-casing
 * it, or breaking it across two elements reds two separate assertions: the
 * ban, because the fragment no longer matches and the words are then counted;
 * and the in-use check, because every PERMITTED entry is separately asserted
 * to appear somewhere on the site.
 *
 * THE NUMBER, VERIFIED AGAINST THE SOURCE RATHER THAN AGAINST A DOCUMENT THAT
 * RESTATES IT:
 *
 *   - "planned 50,000 USDG" is a PLAN OF RECORD, which is what the word
 *     `planned` in the heading is carrying. `docs/LAUNCH-READINESS.md:123` —
 *     "Initial `capacityCapUsdc`: 50,000 USDC for the first vault" — is the
 *     recorded decision, argued there and reviewable there; that document's own
 *     wording still says USDC and is not changed by this file. The heading here
 *     says USDG because `apps/site/who-its-for.html` does: the stated target
 *     chain's settlement token is USDG, not Circle USDC, and the underlying
 *     figure is unchanged — see who-not-for/copy.ts for the same unit rename
 *     traced to `contracts/config/robinhood-mainnet.json`. The FIRST vault has
 *     not been created, so there is no mainnet value to read. Keep that scope:
 *     the unscoped form is false, because
 *     `contracts/config/deployments/base-sepolia.json:98` records a testnet
 *     vault at 0xb940d71b0d695e2ba2b5853bf565c69daa3e3c98 created in block
 *     46,307,218. `apps/site/how-it-works.html` (grep `a planned parameter of a vault that
 *     has not been created`) is the precedent for the
 *     scoped wording.
 *   - "the cap is the ceiling on how wrong it can be" is a contract property,
 *     not a promise: `contracts/src/VaultCore.sol:81` declares
 *     `uint256 public immutable capacityCapUsdc`, so the figure is fixed at
 *     construction and no address can raise it afterwards, and
 *     `contracts/src/VaultCore.sol:409-410` is the deposit-time enforcement —
 *     `if (capacityCapUsdc != 0) require(navUsdc + totalPendingUsdc +
 *     amountUsdc <= capacityCapUsdc, CapacityExceeded())`.
 *   - `contracts/config/base-mainnet.json:221` carries the same figure as
 *     `capacityCapUsdc` under its `smoke` key, and that is deliberately NOT
 *     cited as the launch cap: `docs/LAUNCH-READINESS.md:132-133` records that
 *     nothing mechanically carries the `smoke` block to mainnet. It is a
 *     template that happens to agree, not the parameter this sentence is about.
 */

/** The section label, carried over word for word. */
export const EYEBROW = 'The cap';

/**
 * The heading. Carries the `50,000` figure, and the guard at
 * `apps/site/test/site.test.mjs:648-650` requires any page containing that
 * figure to also contain the word `planned` — this heading is where
 * who-its-for.html supplies it, so the word is not decorative and does not
 * come out under a tightening pass.
 */
export const HEADING = 'A planned 50,000 USDG is a blast radius, not a queue.';

/** The body paragraph. */
export const BODY =
  "The first vault's planned capacity cap is 50,000 USDG, and a capacity cap is immutable per vault. A small first vault is not scarcity and it is not a signal to hurry. It is the ceiling on how much any single unknown can reach.";

/** The flat note's label. */
export const NOTE_LABEL = 'What that means in practice';

/** The flat note's body. Carries the PERMITTED conversion-phrase negation — see above. */
export const NOTE_BODY =
  'There is no allocation to claim, no queue to join, no priority to earn, and nothing on this site to sign up for. If a vault is full, it is full; the answer is a different vault, later, not a place in line.';
