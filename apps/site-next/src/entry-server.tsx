/**
 * The SSR entry. `scripts/prerender.mjs` imports this once at build time and
 * calls `render()` for each public page.
 *
 * THIS IS THE INTERFACE INTEGRATE BUILDS AGAINST. `render(pageId)` returns the
 * inner HTML of `<div id="root">` for that page. It is defined now, while the
 * page bodies are still null, precisely so the shape cannot change later.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { App } from './shell/App';
import NotFoundPage from './pages/NotFoundPage';
import { PAGE_COMPONENT, pickPage } from './shell/pageBody';
import { NOT_FOUND_ID, PAGE_IDS, type PageId } from './shell/pinned';

// Every page in one eager glob. Allowed here and nowhere else: the SSR
// bundle is never sent to a reader, so there is no budget to blow. The client
// entries glob their own page only — see pageBody.ts.
const pageModules = import.meta.glob('./pages/*Page.{tsx,jsx}', { eager: true });

/** The eight page ids, in build order. */
export const pages: readonly PageId[] = PAGE_IDS;

/** Markup for one page, to be spliced into `<div id="root">…</div>`. */
export function render(page: PageId): string {
  const Body = pickPage(pageModules, PAGE_COMPONENT[page]);
  return renderToString(
    <StrictMode>
      <App page={page} Body={Body} />
    </StrictMode>,
  );
}

/**
 * Markup for `404.html`, which is NOT one of `pages` and must not become one.
 *
 * It is rendered through its own function rather than through the loop above
 * because it is not a `PageId`: it is in no nav, in no sitemap, and in none of
 * the per-page guards that iterate the two public documents. `NOT_FOUND_ID` in
 * `src/shell/pinned.ts` carries the full reason, including what `site.test.mjs`
 * would demand of the two real pages if this id joined `PAGE_IDS`.
 *
 * It also takes its body by plain import rather than through `pickPage`. The
 * glob machinery exists so the build survives a page file that has not been
 * written yet; this one was written in the same commit, so there is nothing to
 * survive, and a body that silently resolved to `null` here would ship an empty
 * 404 page with a masthead and a footer around it.
 */
export function renderNotFound(): string {
  return renderToString(
    <StrictMode>
      <App page={NOT_FOUND_ID} Body={NotFoundPage} />
    </StrictMode>,
  );
}

/** Which pages Integrate has landed. The prerender log prints this. */
export function landedPages(): PageId[] {
  return PAGE_IDS.filter((id) => pickPage(pageModules, PAGE_COMPONENT[id]) !== null);
}
