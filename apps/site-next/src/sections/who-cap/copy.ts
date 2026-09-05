/**
 * who-cap — the section's reviewed copy, held as HTML source bytes.
 *
 * REPOINTED 2026-09-05, copy deck v2. Owner: "I haven't created the safe vault
 * yet. I want the pivot to the all-stocks index." The whole section used to be
 * about a planned 50,000 USDG pilot vault that will not be created, so it is
 * rewritten rather than trimmed. Every string below is carried verbatim from
 * the section headed "The cap" in `apps/site/who-its-for.html` (grep "Nothing
 * is capped, because nothing is created"), the reviewed source of truth.
 *
 * THE 50,000 FIGURE IS GONE FROM THIS SECTION ENTIRELY, and that is
 * deliberate rather than an oversight: it was a claim about a vault that does
 * not exist and will not be created, and the honest version of this section is
 * that there is no cap to describe because there is no vault to carry one.
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
 * to appear somewhere on the site. It is kept verbatim here for exactly that
 * reason — this section is its only occurrence on the site.
 */

/** The section label, carried over word for word. */
export const EYEBROW = 'The cap';

/** The heading. No figure, because there is no vault to carry one. */
export const HEADING = 'Nothing is capped, because nothing is created.';

/** The first body paragraph. */
export const BODY =
  'The contracts are on chain and the factory is open. <code>factory.vaultCount()</code> returns 0.';

/** The second body paragraph. */
export const BODY_TWO =
  'A capacity cap is a per-vault parameter, chosen by whoever creates a vault and frozen when it is funded. There is no protocol-wide cap and no vault to carry one.';

/** The flat note's label. */
export const NOTE_LABEL = 'What that means in practice';

/** The flat note's body. Carries the PERMITTED conversion-phrase negation — see above. */
export const NOTE_BODY =
  'There is no allocation to claim, no queue to join, no priority to earn, and nothing on this site to sign up for. If a vault is full, it is full; the answer is a different vault, later, not a place in line.';
