/**
 * The seam between Shell and Integrate.
 *
 * Integrate owns `src/pages/*.tsx` and nothing else; Shell owns the entries and
 * must build before those files exist. So the entries do not `import` a page
 * directly — they hand this module an `import.meta.glob` record and take back
 * whatever page component is in it, or `null` if Integrate has not landed that
 * page yet. Nobody has to edit a file they do not own for a page to appear.
 *
 * WHY A GLOB PER ENTRY RATHER THAN ONE GLOB FOR ALL EIGHT. The client entries
 * glob their own page only. An eager glob over `*Page.tsx` in a client entry
 * would pull all eight pages into every bundle, and the per-page chunks are
 * what keep a section's cost on the page that uses it: GSAP and ScrollTrigger
 * reach one section — `src/sections/hiw-lifecycle/StepRail.tsx`, on
 * how-it-works — and the WebGL hero reaches only the index page. Both are
 * visible in `dist/assets`, where `gsap-*.js` and `ScrollTrigger-*.js` are
 * named by `how-it-works-*.js` alone and `HeroCanvas-*.js` by `index-*.js`
 * alone. One glob would put both on all eight. The server entry may glob all
 * eight, because the SSR bundle is never shipped to a reader.
 */
import type { ComponentType } from 'react';
import { type PageId } from './pinned';

/** The component filename Integrate owns for each page, without extension. */
export const PAGE_COMPONENT: Record<PageId, string> = {
  'index.html': 'IndexPage',
  'how-it-works.html': 'HowItWorksPage',
  'agents.html': 'AgentsPage',
  'who-its-for.html': 'WhoItsForPage',
  'operators.html': 'OperatorsPage',
  'disclaimers.html': 'DisclaimersPage',
  'faq.html': 'FaqPage',
  'vision.html': 'VisionPage',
  'status.html': 'StatusPage',
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
