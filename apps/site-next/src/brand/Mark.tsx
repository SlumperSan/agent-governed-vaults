/**
 * The mark, inline in the document.
 *
 * INLINE RATHER THAN `<img src="mark.svg">`, for one reason that decides it: an
 * SVG loaded through `<img>` is an isolated document. It cannot see the page's
 * `currentColor`, so the mark could not take the link's colour or its hover
 * state, and it could not see the page's loaded faces either — which is the
 * trap an SVG wordmark set in live text falls into. Inline, the
 * `stroke="currentColor"` below resolves against whatever colour the element
 * around it is using, and one CSS rule moves the whole brand on hover.
 *
 * NO `<style>` AND NO `style=`. `public/_headers` sends `style-src 'self'`, and
 * `test/site.test.mjs` refuses both an inline `<style>` element and a `style=`
 * attribute anywhere in the built markup. Size comes from a class; colour comes
 * from inheritance; everything else is a presentation attribute.
 *
 * DECORATIVE BY DEFAULT. With no `title` prop the mark is `aria-hidden`: in the
 * masthead the link already carries the site name as live text beside it, and a
 * mark that also announced a name would give that one link two. Pass a title
 * where the mark stands alone.
 */
import type { JSX } from 'react';
import { MARK_PATH, MARK_STROKE_WIDTH, MARK_VIEWBOX_TIGHT } from './markPath';

export function Mark({ className, title }: { className?: string; title?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox={MARK_VIEWBOX_TIGHT}
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      <path
        d={MARK_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={MARK_STROKE_WIDTH}
        strokeLinecap="butt"
        strokeLinejoin="miter"
      />
    </svg>
  );
}
