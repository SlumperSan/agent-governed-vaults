/**
 * The documents this site builds, in one list.
 *
 * `404.html` IS DELIBERATELY NOT A PageId. A PageId is a document the site NAVIGATES TO — it
 * appears in nav, in the sitemap, and in the prerender count. The 404 is served by the host for
 * paths that match nothing; nobody links to it. Keeping it out of `PAGE_IDS` is what stops it being
 * treated as a page the site offers, while `vite.config.ts` still builds it so Cloudflare Pages has
 * a real 404 to serve instead of soft-404ing the homepage with a 200.
 */
export const PAGE_IDS = ['index.html', 'disclaimers.html'] as const;
export type PageId = (typeof PAGE_IDS)[number];

export const NOT_FOUND_ID = '404.html';
export type ShellPage = PageId | typeof NOT_FOUND_ID;
