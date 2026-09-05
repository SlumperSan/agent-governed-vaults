/**
 * index.html: one cinematic scroll page, in document order.
 *
 * SIX SECTIONS WHERE THERE WERE EIGHT, AND SEVEN OTHER PAGES BESIDE THEM. The
 * v3 brief of 2026-09-05 collapsed the site to "ONE cinematic scroll page + the
 * app button + a serious Disclaimers page." Revision 2 of that brief, the same
 * evening, named artificialinu.com as the reference and mapped the scroll
 * section by section. The order below is that mapping.
 *
 *   IndexHero     the film-title card: the headline, two true sentences, the
 *                 two doors, and the two addresses a reader can check.
 *   IndexMarquee  the seam. Four claims in solid accent, moving.
 *   IndexLive     the page's signature. Five figures read from chain 4663 in
 *                 the reader's own browser, each stamped with the call that
 *                 produced it and the instant it was true.
 *   IndexHive     the narrative beat, and the mascot as a character.
 *   IndexHow      the lifecycle: seven steps named, three of them numbered.
 *   IndexNext     what is designed and not built, and the way to Disclaimers.
 *
 * WHAT WENT, AND WHERE IT WENT. The first v3 pass composed `IndexHero`,
 * `LegendBeat`, `HiveBeat`, `IndexRecord` and `IndexNext`, which was the brief's
 * pre-revision structure: two trailer clips as section breaks and a record band
 * carrying the address book. `index-beats` and `index-record` are deleted with
 * their stylesheets and their video assets. Nothing in them is lost: the two
 * trailer beats' argument is the hive section's, the record band's addresses are
 * the hero's two copy chips, and its deployment facts are now READ FROM THE
 * CHAIN by `IndexLive` rather than written down. That last substitution is the
 * whole point of the redesign and not a side effect of it.
 *
 * `IndexDoors`, `IndexPromise`, `IndexWhy`, `IndexWhat`, `IndexImmutability` and
 * `IndexStatus` went in the earlier pass and have not come back. Everything that
 * was a risk, a limit or a caveat was consolidated onto disclaimers.html by the
 * copy decision of 2026-09-05, which this change does not touch.
 *
 * COMPOSITION ONLY. The masthead, `<main id="main">` and the footer come from
 * PageShell; the page's single `<h1>` comes from IndexHero.
 */
import IndexHero from '../sections/index-hero/IndexHero';
import IndexMarquee from '../sections/index-marquee/IndexMarquee';
import IndexLive from '../sections/index-live/IndexLive';
import IndexHive from '../sections/index-hive/IndexHive';
import IndexHow from '../sections/index-how/IndexHow';
import IndexNext from '../sections/index-next/IndexNext';

export default function IndexPage() {
  return (
    <>
      <IndexHero />
      <IndexMarquee />
      <IndexLive />
      <IndexHive />
      <IndexHow />
      <IndexNext />
    </>
  );
}
