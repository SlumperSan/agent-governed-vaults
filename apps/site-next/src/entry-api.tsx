/**
 * Client entry for api.html. Same pattern as entry-disclaimers.tsx: it globs
 * its own page only, so this page's markup does not ship to the other two.
 */
import { hydrate } from './main';
import { pickPage } from './shell/pageBody';

const modules = import.meta.glob('./pages/ApiPage.{tsx,jsx}', { eager: true });

hydrate('api.html', pickPage(modules, 'ApiPage'));
