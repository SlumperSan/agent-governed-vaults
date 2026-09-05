/**
 * THE MARK, AS DATA. One path, declared once, read by everything that draws it.
 *
 * PROVENANCE, AND WHY THIS IS STILL THE MARK AFTER THE BRAND PASS. The letter
 * is a capital R drawn as one unbroken stroke: up the stem, round the bowl, in
 * to the throat, then out along a leg that steps once and drops square onto the
 * baseline in the same column as the bowl's right side. There is no fill and no
 * container tile. Cap line y = 44, baseline y = 228, ledger rule y = 122.
 *
 * It was chosen on 2026-09-05 out of a generated panel, and later the same day
 * the brand pass replaced that panel with an illustrated comic logo family
 * (`C:\Users\Micha\desktop\Rwally Brand\logo\final\`). This path SURVIVED
 * that replacement rather than being left behind by it: the brand set carries
 * exactly these path data in its own `assets/favicon/favicon.svg`, and the
 * owner's rule of the same date is that the comic mark collapses below 48
 * pixels, so the ledger R is the mark at favicon and small-avatar sizes and the
 * comic lockup is the mark everywhere else.
 *
 * THE MASTHEAD IS A SMALL SIZE BY THAT RULE, which is why it draws this and not
 * the lockup: `.brand-mark` in `src/index.css` sets `height: 1.06em` against a
 * 17px brand font size, so the mark renders about 18 CSS pixels tall — well
 * under 48. It is paired there with the site name set in the page's own display
 * face, live text rather than artwork. The comic lockup is a 33 KB traced
 * outline; inlined into eight pages it would cost about 264 KB of markup to
 * draw a logo smaller than the size it stops reading at.
 *
 * WHY THE PATH LIVES IN TYPESCRIPT AND NOT ONLY IN AN .svg FILE. Three places
 * draw it and they cannot share a file: `Mark.tsx` needs it inline in the DOM
 * so it inherits `currentColor` from the link around it, `brand/mark.svg` is
 * the standalone artwork anyone can open, and `public/favicon.svg` is a
 * separate document the browser loads on its own and which therefore has to
 * carry hardcoded colours. Three copies of a path is three chances to edit one
 * and not the others, so the test named `the brand mark is one path, drawn the
 * same in all three files` in `test/site.test.mjs` reds when they disagree.
 */

/** The panel's own coordinate box, kept for `brand/mark.svg`, the standalone artwork. */
export const MARK_VIEWBOX = '0 0 256 256';

/**
 * THE SAME DRAWING, CROPPED TO ITS INK. Used everywhere the mark shares a line
 * with something else — the masthead, the footer, the favicon — because in the
 * 256 box the letter is 136 units wide inside 256 and pays 60 units of empty
 * air on each side, which at a 16-pixel favicon is 3.75 pixels of nothing.
 *
 * THE INK BOUNDS ARE ARITHMETIC, not a guess. The path's own extremes are
 * x 76..179 and y 44..228 at a stroke width of 33, so half a stroke is 16.5.
 * Left and right are stem edges: 76 - 16.5 = 59.5 and 179 + 16.5 = 195.5. The
 * top is a miter corner, so it extends: 44 - 16.5 = 27.5. The bottom is two
 * butt caps, which do not extend at all: 228. Ink is therefore 59.5..195.5 by
 * 27.5..228, or 136 by 200.5.
 *
 * This box is that, plus 8 units on every side: x 51.5, y 19.5, 152 by 216.5.
 */
export const MARK_VIEWBOX_TIGHT = '51.5 19.5 152 216.5';

/**
 * The whole letter. Stroke geometry, so weight is one number rather than a
 * redraw. Byte-identical to the `d` attribute in the brand set's own
 * `Rwally Brand/assets/favicon/favicon.svg`.
 */
export const MARK_PATH = 'M76 228V44H179V122H139L179 190V228';

/** 33 of 256. At the 16px favicon that is 2.06 device pixels at 1x. */
export const MARK_STROKE_WIDTH = 33;

/**
 * The accessible name when the mark stands alone. In the masthead it does not:
 * the link is labelled by the site name beside it and the mark is decorative
 * there, which is why `Mark` takes the title as a prop rather than always
 * emitting one. Two names on one link is one name too many.
 */
export const MARK_TITLE = 'Rwally';
