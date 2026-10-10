/**
 * One nav, one footer, defined once.
 *
 * `PAGE_IDS` in pages.ts is what the build prerenders; this is what a reader can click. They are
 * deliberately separate lists: the App and the X link leave this origin, so they are not pages this
 * site builds, and typing them as PageIds would put them in the sitemap and the prerender count.
 */

export const APP_URL = 'https://app.rwally.com';
export const X_URL = 'https://x.com/RWAllyVault';
export const GITHUB_URL = 'https://github.com/SlumperSan/agent-governed-vaults';

/** The header bar, left to right. `external` items open off-site. */
export const NAV: ReadonlyArray<{ label: string; href: string; external?: true }> = [
  { label: 'How it works', href: '/how-it-works.html' },
  { label: 'About', href: '/about.html' },
  { label: 'Docs', href: '/docs.html' },
  { label: 'X', href: X_URL, external: true },
];

/**
 * Disclaimers and Terms are FOOTER links, small, by owner decision (card #214 for Terms, matching
 * the standing Disclaimers decision). Neither is hidden — every page carries both and the legal
 * text is unchanged — they simply don't compete with the product nav for attention.
 */
export const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Terms of Use', href: '/terms.html' },
  { label: 'Disclaimers', href: '/disclaimers.html' },
  { label: 'Docs', href: '/docs.html' },
  { label: 'GitHub', href: GITHUB_URL },
  { label: 'For agents', href: '/llms.txt' },
];

export const FOOTER_LEGAL =
  'Nothing here is investment advice, a recommendation, a performance claim or a forecast. ' +
  'Spot crypto falls, and nobody in this system makes anyone whole. Read the disclaimers.';
