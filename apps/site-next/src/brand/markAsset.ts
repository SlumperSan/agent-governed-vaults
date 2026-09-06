/**
 * THE MARK, AS A LINKED FILE. One artwork, shipped once per surface, pointed at
 * by everything that draws it.
 *
 * WHAT REPLACED WHAT, AND ON WHOSE DECISION. Until 2026-09-05 this module was
 * `markPath.ts` and held a single path string: the ledger R, a capital R drawn
 * as one unbroken stroke, inlined into the masthead, the footer and the favicon
 * so it could inherit `currentColor`. The brand pass earlier that day delivered
 * an illustrated comic logo family
 * (`C:\Users\Micha\desktop\Rwally Brand\logo\final\`) and its README recommended
 * keeping the ledger R below 48 pixels, where the comic mark's halftone
 * collapses. That recommendation was written down as question 1 of the brand
 * set's own `DIRECTION.md`, explicitly the owner's call and not the brand pass's.
 * The owner answered it later the same day: the comic R is the mark, in the
 * header, the footer, the app masthead and the tab icon on both surfaces. So the
 * ledger R is gone from this site and the marks are drawn at a size the halftone
 * survives, which is what `MIN_MARK_PX` below records.
 *
 * WHY IT IS LINKED NOW AND WAS INLINE BEFORE. The old argument for inlining was
 * colour: a one-path monochrome letter has to follow the link's colour and its
 * hover state, and an SVG loaded through `<img>` is an isolated document that
 * cannot see `currentColor`. That argument does not survive the swap, because
 * the comic mark is not monochrome. It is five traced layers carrying five fixed
 * colours, one artwork rather than a shape to tint, and the brand set's README
 * says in terms not to recolour the layers individually. Nothing about it wants
 * to inherit, so nothing is lost by linking it.
 *
 * WHAT IS GAINED IS SIZE. The traced artwork is about 14 KB. The masthead and
 * the footer both draw it, on both pages, so inlining would cost roughly 56 KB
 * of markup across the build to draw a logo the browser would otherwise fetch
 * once and cache. Linked, it is one request, one entry in the cache, and the
 * same bytes on both surfaces.
 *
 * THE FILE IS SHIPPED TWICE, ONCE PER ORIGIN, AND THE TWO COPIES ARE GUARDED.
 * rwally.com serves `apps/site-next/public/brand/mark-comic.svg`;
 * app.rwally.com serves `apps/app/src/brand/mark-comic.svg`, which
 * `apps/app/build.mjs` copies to `dist/brand/`. They are separate origins, so
 * neither can link the other's file without making a cross-origin request this
 * project's `_headers` refuse by design. The test named `the brand mark is one
 * artwork, byte-identical on both surfaces` in `test/site.test.mjs` reds when
 * they disagree, which is what stops the two surfaces drifting into two logos.
 */

/** Where each origin serves the artwork. The same path on both, by construction. */
export const MARK_SRC = '/brand/mark-comic.svg';

/**
 * The artwork's own box, `viewBox="196.00 339.00 385.50 291.50"` in the file.
 *
 * WRITTEN OUT AS TWO NUMBERS BECAUSE THEY GO IN THE MARKUP. `width` and
 * `height` attributes on the `<img>` give the browser the aspect ratio before a
 * byte of the SVG arrives, so the header reserves the mark's box and does not
 * reflow when it lands. The stylesheets set `height` and leave `width: auto`,
 * so these two are what decide how wide the mark actually draws.
 *
 * NOTE THE ORIENTATION CHANGED WITH THE MARK. The ledger R was portrait, 152 by
 * 216.5. The comic R is landscape, 385.5 by 291.5, because its leg kicks out to
 * the right. A stylesheet that pinned both dimensions from the old ratio would
 * squash it, which is why neither of them does any more.
 */
export const MARK_WIDTH = 385.5;
export const MARK_HEIGHT = 291.5;

/**
 * The floor, in CSS pixels, measured rather than assumed.
 *
 * The brand set's README records rendering the full-colour mark at 32 and
 * reading it: the speed lines inside the R collapse into noise and the letter
 * barely reads. Its measured floor is 48. Both stylesheets that draw this mark
 * set a height at or above that number, and the test named `the comic mark is
 * drawn at a size its halftone survives` in `test/site.test.mjs` reads them and
 * reds below it.
 */
export const MIN_MARK_PX = 48;

/**
 * The accessible name when the mark stands alone. In the masthead and the
 * footer it does not: the link is labelled by the site name beside it and the
 * mark is decorative there, which is why `Mark` takes the title as a prop
 * rather than always emitting one. Two names on one link is one name too many.
 */
export const MARK_TITLE = 'RWAlly';
