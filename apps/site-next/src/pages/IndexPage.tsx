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
import IndexLosses from '../sections/index-losses/IndexLosses';
import IndexStatus from '../sections/index-status/IndexStatus';
import IndexNext from '../sections/index-next/IndexNext';

// ORDER MATCHES apps/site/index.html, copy deck v2 (2026-09-05): the hero,
// then the two doors, then the design-intent promise, then the rest unchanged.
export default function IndexPage() {
  return (
    <>
      <IndexHero />
      <IndexDoors />
      <IndexPromise />
      <IndexWhy />
      <IndexWhat />
      <IndexImmutability />
      <IndexLosses />
      <IndexStatus />
      <IndexNext />
    </>
  );
}
