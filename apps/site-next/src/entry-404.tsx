/**
 * Client entry for `404.html`.
 *
 * A PLAIN IMPORT, NOT THE GLOB the other two entries use. That glob is the seam
 * `src/shell/pageBody.ts` describes: Integrate owns the page bodies, Shell owns
 * the entries, and the build has to succeed in the window where a page file
 * does not exist yet. That window never applies here — the body landed in the
 * same commit as this entry, and `404.html` is not a page Integrate is asked to
 * fill — so the import says what it means and the type checker sees it.
 */
import { hydrate } from './main';
import NotFoundPage from './pages/NotFoundPage';
import { NOT_FOUND_ID } from './shell/pinned';

hydrate(NOT_FOUND_ID, NotFoundPage);
