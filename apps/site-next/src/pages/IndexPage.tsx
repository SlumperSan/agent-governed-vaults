/**
 * index.html — the long-scroll cinematic page, in document order.
 *
 * Composition only. The banner, masthead, <main id="main"> and footer come from
 * PageShell; the page's single <h1> comes from IndexHero. Nothing is added here
 * that is not a section, and no section is wrapped in an element of its own —
 * each renders its own landmark and its own vertical rhythm.
 */
import IndexHero from '../sections/index-hero/IndexHero';
import IndexDoors from '../sections/index-doors/IndexDoors';
import IndexPromise from '../sections/index-promise/IndexPromise';
import IndexWhy from '../sections/index-why/IndexWhy';
import IndexWhat from '../sections/index-what/IndexWhat';
import IndexImmutability from '../sections/index-immutability/IndexImmutability';
import IndexStatus from '../sections/index-status/IndexStatus';
import IndexNext from '../sections/index-next/IndexNext';

// ORDER MATCHES apps/site/index.html, copy deck v2 (2026-09-05): the hero,
// then the two doors, then the design-intent promise, then the rest unchanged.
//
// `IndexLosses` WAS REMOVED HERE ON 2026-09-05, and its section directory was
// deleted with it. It rendered "Before you read anything else" / "Three ways
// this loses your money", which `apps/site/index.html` no longer carries: the
// owner's 2026-09-05 decision moves every risk, warning and caveat onto
// disclaimers.html, where those three mechanisms now render as the row headed
// `Three ways this loses your money`. The other two caveat blocks the same
// decision retired went at the same time, from index-why and
// index-immutability; both of those sections record it in their own files.
// The Disclaimers page is still reachable from this page in three places: the
// hero lede, index-promise's button, and the footer.
export default function IndexPage() {
  return (
    <>
      <IndexHero />
      <IndexDoors />
      <IndexPromise />
      <IndexWhy />
      <IndexWhat />
      <IndexImmutability />
      <IndexStatus />
      <IndexNext />
    </>
  );
}
