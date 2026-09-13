/**
 * `404.html`: one section, and the shell around it.
 *
 * NOT ONE OF THE `PageId` PAGES, and `src/pages/README.md`'s table does not
 * list it, deliberately. That table maps each id in `PAGE_IDS` to the file
 * `src/shell/pageBody.ts` resolves for it; this document is not in `PAGE_IDS`
 * and is not resolved through `PAGE_COMPONENT`, because it is a document the
 * site is never navigated TO — see `NOT_FOUND_ID` in `src/shell/pinned.ts`.
 * `src/entry-404.tsx` imports it directly, and `src/entry-server.tsx` renders
 * it through `renderNotFound()` rather than through the `pages` loop.
 *
 * COMPOSITION ONLY, the same as every other file here. The masthead,
 * `<main id="main">` and the footer come from PageShell; the page's single
 * `<h1>` comes from its one section.
 */
import NotFound from '../sections/not-found/NotFound';

export default function NotFoundPage() {
  return <NotFound />;
}
