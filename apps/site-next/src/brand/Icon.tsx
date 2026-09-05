/**
 * One of the brand's eight line icons, inline in the document.
 *
 * DECORATIVE, ALWAYS, AND THAT IS ENFORCED BY THE SIGNATURE. There is no label
 * prop: every icon on this site sits beside the words it illustrates, so it
 * adds nothing an assistive technology needs and repeating the heading as an
 * image name would make every step announce itself twice. `aria-hidden` and
 * `focusable="false"` together keep it out of the accessibility tree and out of
 * the tab order in every engine.
 *
 * NO `<style>` AND NO `style=`. `public/_headers` sends `style-src 'self'` and
 * `test/site.test.mjs` refuses both an inline `<style>` element and a `style=`
 * attribute anywhere in the built markup. Size comes from a class, colour from
 * `currentColor`, and the four stroke values are presentation attributes.
 */
import type { JSX } from 'react';
import { ICON_PATHS, type IconName } from './icons';

export function Icon({ name, className }: { name: IconName; className?: string }): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="butt"
      strokeLinejoin="miter"
    >
      {ICON_PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
