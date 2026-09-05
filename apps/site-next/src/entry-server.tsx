/**
 * The SSR entry. `scripts/prerender.mjs` imports this once at build time and
 * calls `render()` for each of the eight pages.
 *
 * THIS IS THE INTERFACE INTEGRATE BUILDS AGAINST. `render(pageId)` returns the
 * inner HTML of `<div id="root">` for that page. It is defined now, while the
 * page bodies are still null, precisely so the shape cannot change later.
 */
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { App } from './shell/App';
import { PAGE_COMPONENT, pickPage } from './shell/pageBody';
import { PAGE_IDS, type PageId } from './shell/pinned';

// All eight pages in one eager glob. Allowed here and nowhere else: the SSR
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

/** Which pages Integrate has landed. The prerender log prints this. */
export function landedPages(): PageId[] {
  return PAGE_IDS.filter((id) => pickPage(pageModules, PAGE_COMPONENT[id]) !== null);
}
