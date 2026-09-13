/**
 * Client entry for disclaimers.html. One of eight; each is loaded by exactly one entry
 * HTML and pulls in exactly one page body.
 *
 * The glob rather than a plain import is the seam described in
 * src/shell/pageBody.ts: Integrate owns src/pages/DisclaimersPage.tsx, Shell owns this
 * file, and the build has to succeed before that page exists. An eager glob
 * over one filename resolves to that module when it is there and to an empty
 * record when it is not — so the page appears the moment Integrate lands it,
 * with no edit to a file they do not own.
 *
 * It globs ITS OWN PAGE ONLY. Globbing all eight here would bundle all eight
 * page graphs into this entry, which is how the index page's scroll libraries
 * end up shipping to the seven deep pages that have no scroll sequence.
 */
import { hydrate } from './main';
import { pickPage } from './shell/pageBody';

const modules = import.meta.glob('./pages/DisclaimersPage.{tsx,jsx}', { eager: true });

hydrate('disclaimers.html', pickPage(modules, 'DisclaimersPage'));
