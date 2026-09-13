/**
 * The seam between Shell and Integrate.
 *
 * Integrate owns `src/pages/*.tsx` and nothing else; Shell owns the entries and
 * must build before those files exist. So the entries do not `import` a page
 * directly — they hand this module an `import.meta.glob` record and take back
 * whatever page component is in it, or `null` if Integrate has not landed that
 * page yet. Nobody has to edit a file they do not own for a page to appear.
 *
 * WHY A GLOB PER ENTRY RATHER THAN ONE GLOB FOR BOTH. The client entries glob
 * their own page only, so a section's cost stays on the page that uses it. That
 * mattered more when there were nine pages and one of them carried GSAP and
 * ScrollTrigger; it still matters with two, because index.html pulls the
 * three-clip backdrop and the reveal machinery and disclaimers.html pulls
 * neither. One glob would put both on both, and the difference is visible in
 * `dist/assets`, where the backdrop chunk is named by `index-*.js` alone. The
 * server entry may glob every page, because the SSR bundle is never shipped to
 * a reader.
 */
import type { ComponentType } from 'react';
import { type PageId } from './pinned';

/** The component filename Integrate owns for each page, without extension. */
export const PAGE_COMPONENT: Record<PageId, string> = {
  'index.html': 'IndexPage',
  'disclaimers.html': 'DisclaimersPage',
};

/**
 * Find one page component in a glob record.
 *
 * @param modules an eager `import.meta.glob` result
 * @param name    the component filename, e.g. `RisksPage`
 * @returns the component, or null while that page is still unwritten
 */
export function pickPage(modules: Record<string, unknown>, name: string): ComponentType | null {
  const key = Object.keys(modules).find((k) => k.endsWith(`/${name}.tsx`));
  if (!key) return null;
  const mod = modules[key] as { default?: ComponentType } | undefined;
  return mod?.default ?? null;
}
