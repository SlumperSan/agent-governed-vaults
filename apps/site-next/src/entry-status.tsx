/**
 * Client entry for status.html. One of eight; each is loaded by exactly one entry
 * HTML and pulls in exactly one page body.
 *
 * The glob rather than a plain import is the seam described in
 * src/shell/pageBody.ts: Integrate owns src/pages/StatusPage.tsx, Shell owns this
 * file, and the build has to succeed before that page exists. An eager glob
 * over one filename resolves to that module when it is there and to an empty
 * record when it is not — so the page appears the moment Integrate lands it,
 * with no edit to a file they do not own.
 *
 * It globs ITS OWN PAGE ONLY. Globbing all eight here would bundle all eight
 * page graphs into this entry, which is how the index page's scroll libraries
 * end up shipping to the seven deep pages that have no scroll sequence.
 *
 * THIS FILE WAS BRIEFLY A CSS-ONLY ENTRY, and the failure is worth recording so
 * it is not repeated. On 2026-09-04 it was rewritten to import no React — the
 * page has no interactive element, and the prerender had already written the
 * markup — leaving nothing in it but side-effect stylesheet imports. Rolldown
 * emits no JavaScript chunk for such an entry, and with no chunk Vite injected
 * neither the `<script>` nor the `<link rel="stylesheet">` for the CSS those
 * imports pulled in: the built page carried 0 script tags and 1 of its 6
 * stylesheets, so all five section sheets were missing and the page shipped
 * unstyled (measured 2026-09-05 on the 02:34 build: 35 of 46 classes in
 * dist/status.html resolved to no rule in any sheet the page linked). It is now
 * the same three lines as the other seven, so status.html is built the same way
 * every other page is, and `test/site.test.mjs` has a guard — "every CSS-module
 * class in a built page is defined in a stylesheet that page links" — that reds
 * on that whole failure mode rather than on this one file.
 */
import { hydrate } from './main';
import { pickPage } from './shell/pageBody';

const modules = import.meta.glob('./pages/StatusPage.{tsx,jsx}', { eager: true });

hydrate('status.html', pickPage(modules, 'StatusPage'));
