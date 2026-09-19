import { renderToString } from 'react-dom/server';
import { About } from './About';
import { App } from './App';
import { Disclaimers } from './Disclaimers';
import { Docs } from './Docs';
import { HowItWorks } from './HowItWorks';
import { NotFound } from './NotFound';
import { PAGE_IDS, type ShellPage } from './pages';

/** Exported so the prerender loop reads the page list from here rather than keeping its own copy. */
export const pages = PAGE_IDS;

export function render(page: ShellPage): string {
  switch (page) {
    case 'index.html':
      return renderToString(<App />);
    case 'how-it-works.html':
      return renderToString(<HowItWorks />);
    case 'about.html':
      return renderToString(<About />);
    case 'docs.html':
      return renderToString(<Docs />);
    case 'disclaimers.html':
      return renderToString(<Disclaimers />);
    case '404.html':
      return renderToString(<NotFound />);
    default: {
      // A new PageId without a case here fails to compile rather than prerendering an empty page.
      const unreachable: never = page;
      throw new Error(`entry-server: no renderer for ${String(unreachable)}`);
    }
  }
}
