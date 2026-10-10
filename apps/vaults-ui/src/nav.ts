/**
 * The workspace's own chrome links, defined once.
 *
 * THIS IS A DIFFERENT ORIGIN FROM THE MARKETING SITE, so every link that leaves the workspace is
 * absolute. `apps/site/src/nav.ts` is the mirror of this file and carries the reverse link: its
 * header's "Open app" button is the only way a reader reaches this surface, and the button below
 * is the only way back. Neither may be removed without the other growing a replacement.
 *
 * NO LEGAL PROSE LIVES HERE. The site's footer carries a load-bearing legal paragraph that
 * Marketing owns; restating it in a second place is how two versions of a disclosure start to
 * differ. This footer links to the page that holds it instead.
 */

export const SITE_URL = 'https://rwally.com';
export const DISCLAIMERS_URL = `${SITE_URL}/disclaimers.html`;
export const DOCS_URL = `${SITE_URL}/docs.html`;
export const HOW_IT_WORKS_URL = `${SITE_URL}/how-it-works.html`;
export const GITHUB_URL = 'https://github.com/SlumperSan/agent-governed-vaults';

/**
 * The header bar, left to right. `current` is matched against `href`, so an in-workspace view that
 * wants `aria-current="page"` must appear here with the same string it passes to `Page`.
 */
export const NAV: ReadonlyArray<{ label: string; href: string; external?: true }> = [
  { label: 'Vaults', href: '/' },
  { label: 'How it works', href: HOW_IT_WORKS_URL, external: true },
  { label: 'Docs', href: DOCS_URL, external: true },
];

export const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string; external?: true }> = [
  { label: 'Disclaimers', href: DISCLAIMERS_URL, external: true },
  { label: 'Docs', href: DOCS_URL, external: true },
  { label: 'GitHub', href: GITHUB_URL, external: true },
];
