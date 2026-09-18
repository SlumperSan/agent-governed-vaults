import { renderToString } from 'react-dom/server';
import { App } from './App';
import { Disclaimers } from './Disclaimers';
import { NotFound } from './NotFound';
import { PAGE_IDS, type ShellPage } from './pages';

/**
 * Called by scripts/prerender.mjs, once per document.
 *
 * `pages` is exported so the prerender loop reads the list from here rather than keeping its own
 * copy — two lists of pages drift, and the one that drifts is always the one nobody looks at.
 */
export const pages = PAGE_IDS;

export function render(page: ShellPage): string {
  switch (page) {
    case 'index.html':
      return renderToString(<App />);
    case 'disclaimers.html':
      return renderToString(<Disclaimers />);
    case '404.html':
      return renderToString(<NotFound />);
    default: {
      // Exhaustiveness: a new PageId added without a case here fails to compile rather than
      // silently prerendering an empty page.
      const unreachable: never = page;
      throw new Error(`entry-server: no renderer for ${String(unreachable)}`);
    }
  }
}
