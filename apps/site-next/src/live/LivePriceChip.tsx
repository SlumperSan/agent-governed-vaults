/**
 * The header's live price chip. Three tokens, never two.
 *
 * THE PAIR, THE PRICE, AND HOW OLD THE PRINT IS. The age is not an enhancement
 * and it is not hidden behind a breakpoint: a price rendered alone in a header
 * is read as a quote from now, and for an equity feed on a Saturday that reading
 * is false. This chip reads the ETH/USD proxy, which is the fresher of the two
 * feeds the page reads, and it still carries its age, because the rule is about
 * what a price rendered alone MEANS rather than about which feed happens to be
 * fresh this afternoon.
 *
 * ON THE DISCLAIMERS PAGE IT LINKS OFF-PAGE, and that is a deliberate branch
 * rather than a bug. `#live` is a section of index.html. From index.html the
 * chip is a same-page jump; from disclaimers.html the same href would scroll to
 * nothing, so it resolves to `index.html#live`. The header is identical across
 * both pages, which is the brief's requirement, and the one link inside it that
 * points at a place still points at that place from either page.
 *
 * IT RENDERS NOTHING UNTIL THERE IS SOMETHING TRUE TO RENDER. No zero, no dash,
 * no shimmering rectangle shaped like a price. The slot holds its width from the
 * first paint so the header does not jump when the read lands, and until then it
 * is empty. A number that appears before it is true is a number somebody
 * screenshots.
 */
import type { JSX } from 'react';
import { usd } from './chain';
import { age, useLive } from './useLive';
import type { PageId } from '../shell/pinned';
import styles from './live-chip.module.css';

export function LivePriceChip({ page }: { page: PageId }): JSX.Element {
  const live = useLive();
  const href = page === 'index.html' ? '#live' : 'index.html#live';

  if (live.status !== 'ok') {
    // The reserved slot. `aria-hidden` because there is nothing here to
    // announce, and an empty labelled region is noise in a screen reader.
    return <span className={styles.slot} aria-hidden="true" />;
  }

  const { eth, readAt } = live.data;
  const old = age(eth.updatedAt, readAt);

  return (
    <a className={styles.chip} href={href}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.pair}>{eth.description}</span>
      <span className={styles.price}>{usd(eth.price)}</span>
      <span className={styles.sep} aria-hidden="true" />
      <span className={styles.age}>{old}</span>
      <span className="sr-only">
        {' old. This is the feed’s own last print, not a quote from now. Open the live reads.'}
      </span>
    </a>
  );
}
