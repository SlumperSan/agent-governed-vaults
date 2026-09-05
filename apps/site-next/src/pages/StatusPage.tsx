/**
 * status.html — the status and claims page, in document order.
 *
 * THE EIGHTH PAGE, AND THE ONLY ONE NOT IN THE HEADER NAV. Owner decision,
 * 2026-09-04: "Claims should not be a header page, it should be a link in the
 * footer." It is reached from the "Status and claims" entry in the footer's
 * Pages list, which every page carries, and `site.test.mjs` asserts both halves
 * of that — the footer link on all eight pages, and no `status.html` inside any
 * `<nav>`.
 *
 * StatusHero renders the pre-launch status band as the first thing inside
 * `<main>`, before the page's one `<h1>`. That band is the block that stood
 * above the nav on all seven pages until the same decision moved it here.
 *
 * Composition only. The masthead, `<main id="main">` and footer come from
 * PageShell. Nothing is added here that is not a section, and no section is
 * wrapped in an element of its own — each renders its own landmark and its own
 * vertical rhythm.
 */
import StatusHero from '../sections/status-hero/StatusHero';
import StatusBoard from '../sections/status-board/StatusBoard';
import StatusTestnet from '../sections/status-testnet/StatusTestnet';
import StatusPins from '../sections/status-pins/StatusPins';
import StatusVerify from '../sections/status-verify/StatusVerify';

export default function StatusPage() {
  return (
    <>
      <StatusHero />
      <StatusBoard />
      <StatusTestnet />
      <StatusPins />
      <StatusVerify />
    </>
  );
}
