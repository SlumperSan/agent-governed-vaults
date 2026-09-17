/**
 * index.html: one cinematic scroll page, in document order.
 *
 * FIVE SECTIONS WHERE THERE WERE EIGHT, AND SEVEN OTHER PAGES BESIDE THEM. The
 * v3 brief of 2026-09-05 collapsed the site to "ONE cinematic scroll page + the
 * app button + a serious Disclaimers page." Revision 2 of that brief, the same
 * evening, named artificialinu.com as the reference and mapped the scroll
 * section by section. The order below is that mapping.
 *
 *   IndexHero     the film-title card: the headline, two true sentences, the
 *                 two doors, and the two addresses a reader can check.
 *   IndexMarquee WENT ON 2026-09-16, on the owner's instruction. It carried four
 *   claims in solid accent, and every one of them restated something IndexHero
 *   renders directly above it: the lede says the index moves only when the hive
 *   agrees, and the fact line reads "No proxy, no upgrade path, no pause function,
 *   no admin key." Only `No admin key.` matched that line's tail at all, and then only
 *   case-insensitively, the corpus writing it lowercase mid-sentence; `No
 *   upgrade path.` is not, because the corpus writes it mid-sentence with a comma
 *   after "path", and `The hive decides.` was a paraphrase of the lede rather than
 *   a quotation of anything. The strip's own copy file recorded that comma trap in
 *   capitals, having been caught by it once. The point stands either way and does
 *   not need the stronger version: a strip that says again, worse, what the hero
 *   said one scroll earlier has nothing of its own to say, which is why no rewrite
 *   of the phrases improved it. Removing it also removes the animation whose loop
 *   point was visible on a wide viewport.
 *   IndexLive     the page's signature. Five figures read from chain 4663 in
 *                 the reader's own browser, each stamped with the call that
 *                 produced it and the instant it was true.
 *   IndexHive     the narrative beat, and the mascot as a character.
 *   IndexHow      the lifecycle: seven steps named, three of them numbered.
 *
 * `IndexNext` WENT ON 2026-09-09. It was the closing beat, and every sentence in
 * it was about a token launch the owner retired that day as a test. A beat whose
 * only subject is retired is not reworded, it is removed, and the way to
 * Disclaimers it carried is the footer's, which every page already has.
 * `scripts/test/claims-token-absence.test.mjs` is what keeps it from coming back
 * by accident.
 *
 * WHAT WENT BEFORE THAT, AND WHERE IT WENT. The first v3 pass composed
 * `IndexHero`, `LegendBeat`, `HiveBeat`, `IndexRecord` and `IndexNext`, the brief's
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
import IndexLive from '../sections/index-live/IndexLive';
import IndexHive from '../sections/index-hive/IndexHive';
import IndexHow from '../sections/index-how/IndexHow';

export default function IndexPage() {
  return (
    <>
      <IndexHero />
      <IndexLive />
      <IndexHive />
      <IndexHow />
    </>
  );
}
