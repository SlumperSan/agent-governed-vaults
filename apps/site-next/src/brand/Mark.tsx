/**
 * The mark, linked into the document.
 *
 * AN `<img>` RATHER THAN INLINE SVG, WHICH IS THE OPPOSITE OF WHAT THIS FILE
 * SAID UNTIL 2026-09-05. The reason it gave then was colour: the ledger R was
 * one monochrome path, it had to follow the link's colour and its hover state,
 * and an SVG loaded through `<img>` is an isolated document that cannot see
 * `currentColor`. The owner replaced that mark with the comic R the same day.
 * The comic R is five traced layers carrying five fixed colours, one artwork
 * rather than a shape to tint, so there is nothing left for it to inherit and
 * the reason to inline it went with the letter it was about. `markAsset.ts`
 * carries the long version of that argument, including what linking buys.
 *
 * THE DIMENSIONS ARE ON THE ELEMENT, NOT ONLY IN THE STYLESHEET. `width` and
 * `height` give the browser the aspect ratio before the file arrives, so the
 * masthead reserves the mark's box on first paint and does not reflow when it
 * lands. The stylesheets then set a height and leave the width to follow.
 *
 * NO `<style>` AND NO `style=`. `public/_headers` sends `style-src 'self'`, and
 * `test/site.test.mjs` refuses both an inline `<style>` element and a `style=`
 * attribute anywhere in the built markup. Size comes from a class and nothing
 * else. `img-src 'self'` is what permits the file itself, and the file is
 * served from this origin.
 *
 * DECORATIVE BY DEFAULT. With no `title` prop the alt text is empty, which is
 * how a screen reader is told to skip a picture rather than to describe it: in
 * the masthead and the footer the link already carries the site name as live
 * text beside it, and a mark that also announced a name would give that one
 * link two. Pass a title where the mark stands alone.
 */
import type { JSX } from 'react';
import { MARK_HEIGHT, MARK_SRC, MARK_WIDTH } from './markAsset';

export function Mark({ className, title }: { className?: string; title?: string }): JSX.Element {
  return (
    <img
      className={className}
      src={MARK_SRC}
      alt={title ?? ''}
      width={MARK_WIDTH}
      height={MARK_HEIGHT}
      decoding="async"
    />
  );
}
