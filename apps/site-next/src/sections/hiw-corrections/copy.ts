/**
 * hiw-corrections — the section's reviewed copy, held as HTML source bytes.
 *
 * WHY THE BODIES ARE BYTES AND NOT JSX TEXT. React escapes text children, so an
 * apostrophe reaches the prerendered file as `&#x27;`. Both row bodies here
 * carry one — "the standard's semantics" — and the claims suite reads the raw
 * bytes of `dist/how-it-works.html`, not the rendered page. A sentence that
 * looks perfect in the browser and is escaped in the file is the worst kind of
 * drift to chase, so these strings go through `<Pinned>`, which writes them
 * onto the element untouched.
 *
 * EVERY STRING BELOW IS CARRIED VERBATIM from the section headed "Two things
 * people assume" in `apps/site/how-it-works.html` (grep "Corrections, before
 * you assume them."). Nothing in this file was composed. If one of these
 * sentences needs to change, it changes on the current site first, under
 * review, and is copied across afterwards.
 *
 * THE TWO CLAIMS, VERIFIED AGAINST THE SOURCE RATHER THAN AGAINST A DOCUMENT:
 *   - "not ERC-4626 compliant … 4626-shaped read-only views … indicative only"
 *     is `contracts/src/VaultCore.sol:25-26` ("NOT ERC-4626 (commitment C-1):
 *     in-kind redemption, forward pricing and swing pricing break preview
 *     round-trips; 4626-shaped views are indicative only") and again at
 *     `contracts/src/VaultCore.sol:1067` and `:1070`, where the indicative-only
 *     views are marked as carrying no compliance claim.
 *   - "Every state change goes to the contracts" is the site-holds-no-wallet
 *     claim: there is no wallet connection, no form and no transaction path
 *     anywhere in apps/site.
 */

/** Row 1 term. */
export const ERC4626_TERM = 'Not ERC-4626';

/** Row 1 body. Carries the apostrophe this module exists for. */
export const ERC4626_BODY =
  "The vault is not ERC-4626 compliant and makes no ERC-4626 claim. It exposes 4626-shaped read-only views for convenience; treat them as indicative only and do not integrate against them as if the standard's semantics hold.";

/** Row 2 term. */
export const FRONTEND_TERM = 'Not a front end';

/** Row 2 body. */
export const FRONTEND_BODY =
  'This site holds no wallet connection, no form and no transaction path. Every state change goes to the contracts.';

/** The eyebrow and heading, both carried over word for word. */
export const EYEBROW = 'Two things people assume';
export const HEADING = 'Corrections, before you assume them.';

/**
 * The three closing links, carried over with their labels unchanged. New CTA
 * wording is not this section's to invent: the conversion vocabulary a redesign
 * reaches for first is banned outright, and these three labels have already
 * been through review on the current page.
 */
export const CTA_RISKS = 'What can go wrong';
export const CTA_OPERATORS = 'Running a vault';
export const CTA_SOURCE = 'Read the contracts';
