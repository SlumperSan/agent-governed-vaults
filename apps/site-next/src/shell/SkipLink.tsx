/**
 * The skip link. It must be the FIRST anchor in <body> on every page — the
 * guard measures the distance from the first `<a ` to the first `href="#main"`
 * and fails if anything else got there first. Nothing may be rendered above
 * it, including a decorative wrapper that happens to contain a link.
 *
 * It is positioned off-screen rather than hidden: `display: none` and
 * `visibility: hidden` both remove an element from the focus order, which
 * would leave a keyboard reader tabbing through the whole masthead on every
 * page. See `.skip` in index.css.
 */
import type { JSX } from 'react';

export function SkipLink(): JSX.Element {
  return (
    <a className="skip" href="#main">
      Skip to content
    </a>
  );
}
