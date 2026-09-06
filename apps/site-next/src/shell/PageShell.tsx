/**
 * PageShell — the identical chrome every one of the eight pages wears.
 *
 * DOCUMENT ORDER IS LOAD-BEARING, so it is fixed here rather than left to each
 * page:
 *
 *   skip link  -> must be the first anchor in <body>
 *   masthead   -> the <nav>
 *   <main id="main">  -> the skip target, asserted by exact string
 *   footer     -> carries the four counted pinned sentences
 *
 * THERE IS NO BANNER HERE ANY MORE. It sat between the skip link and the nav on
 * all seven pages until the owner's decision of 2026-09-04; it now renders once,
 * inside <main> on status.html, from the section that owns that page. Both of
 * its sentences also open the footer's legal paragraph, so every page still
 * states each of them — the shell just states them once instead of twice.
 *
 * Integrate composes `<PageShell page="risks.html">` around the sections for
 * that page, in document order, and owns nothing else. A page never renders
 * its own nav or footer: one source for the pinned strings is the
 * whole reason they cannot drift.
 *
 * The `<h1>` is NOT here. Exactly one per page is asserted, and it belongs to
 * that page's hero section — so an empty shell has none, and every page owes
 * one.
 */
import type { JSX, ReactNode } from 'react';
import type { PageId } from './pinned';
import { Footer } from './Footer';
import { Masthead } from './Masthead';
import { SkipLink } from './SkipLink';

export function PageShell({ page, children }: { page: PageId; children?: ReactNode }): JSX.Element {
  return (
    <>
      <SkipLink />
      <Masthead page={page} />
      <main id="main">{children}</main>
      <Footer page={page} />
    </>
  );
}
