/**
 * THE LIVE PANEL. Five reads, each stamped with where it came from.
 *
 * THIS IS THE PAGE'S SIGNATURE, AND THE THING IT IS SIGNING IS PROVENANCE. Every
 * other number on this site is a claim: written here, checked by a guard,
 * believed by a reader. These five are fetched by the reader's own browser while
 * they are looking at the page. So the section is not built like a dashboard,
 * where a figure appears and you take it; it is built like a ledger page, where
 * every figure carries the call that produced it and the instant it was true.
 *
 * THE RISK IT TAKES, DELIBERATELY. Two of the five are Chainlink prices, and one
 * of them is an equity feed that stops printing when the stock market closes. On
 * a Saturday it is thirty hours old; over a long weekend it reaches fifty. Every
 * other site with a price on it would hide that, or poll until it looked fresh,
 * or quietly show only the crypto feed. This one puts the stale price on the
 * page at the same size as the fresh one, with the exact minute it last printed
 * underneath and the words "past 24h" beside it. That is the whole argument of
 * the protocol rendered as a design decision: a number you can check is worth
 * more than a number that flatters.
 *
 * WHAT THE SERVER RENDERS, AND WHY IT IS THE LABELS AND NOT THE VALUES.
 *
 *   THE LABELS SHIP IN THE HTML. A reader with no JavaScript gets a complete,
 *   legible panel that says what would have been read and from which call. That
 *   is a working section, not a degraded one, and it is what the word counter in
 *   `test/site.test.mjs` counts.
 *
 *   THE VALUES DO NOT. A figure baked into HTML at build time carries a stamp
 *   from whenever the build ran. `55,447,043` prerendered into a file and served
 *   for a week is exactly the misstatement this panel exists to prevent, and it
 *   would be indistinguishable, in a screenshot, from a live one.
 *
 * NOTHING HERE ANIMATES INTO VIEW FROM opacity: 0. Not one rule in the
 * stylesheet hides text pending a script. A scroll reveal implemented in shipped
 * CSS is a section that is blank in a screenshot, blank to a crawler, and blank
 * to a reader whose script did not run, and it is invisible to a word counter
 * that reads the markup rather than the pixels.
 */
import type { JSX, ReactNode } from 'react';
import { Particles } from '../../assets/Particles';
import { groups, usd, utc } from '../../live/chain';
import { age, useLive, withinHeartbeat } from '../../live/useLive';
import {
  BLOCK_LABEL,
  EXPECT_ETH,
  EXPECT_SPY,
  EYEBROW,
  FAILED,
  FEED_LABEL,
  FRESH,
  INTRO,
  READ_AT,
  READING,
  STALE,
  SUBVAULTS_CALL,
  SUBVAULTS_LABEL,
  VAULTS_CALL,
  VAULTS_LABEL,
} from './copy';
import styles from './IndexLive.module.css';

/**
 * One cell of the read-out.
 *
 * `value` is a node rather than a string because two of the four carry a price
 * and a freshness verdict together, and splitting that pair across two cells
 * would be the one arrangement where a price can be read without its stamp.
 */
function Cell({
  label,
  source,
  value,
}: {
  label: string;
  source: string;
  value: ReactNode;
}): JSX.Element {
  return (
    <div className={styles.cell}>
      <p className={styles.cellLabel}>{label}</p>
      <p className={styles.cellValue}>{value}</p>
      <p className={styles.cellSource}>{source}</p>
    </div>
  );
}

/** A price with the minute its feed printed and the verdict on that minute. */
function Price({
  price,
  updatedAt,
  now,
}: {
  price: number;
  updatedAt: number;
  now: number;
}): JSX.Element {
  const fresh = withinHeartbeat(updatedAt, now);
  return (
    <>
      <span className={styles.price}>{usd(price)}</span>
      <span className={fresh ? styles.fresh : styles.stale}>
        <span className={styles.verdictDot} aria-hidden="true" />
        {fresh ? FRESH : STALE}
      </span>
      <span className={styles.aged}>{age(updatedAt, now)}</span>
    </>
  );
}

export default function IndexLive(): JSX.Element {
  const live = useLive();
  const ok = live.status === 'ok' ? live.data : null;

  // The stamp. Three different sentences for three different states, and the
  // failed one names the error rather than going blank: the honest version of a
  // failed read is a reader who can see that it failed.
  let stamp: string = INTRO;
  if (live.status === 'reading') stamp = READING;
  if (live.status === 'failed') stamp = FAILED + ' ' + live.message;
  if (ok) {
    stamp = READ_AT + ' ' + new Date(ok.readAt * 1000).toTimeString().slice(0, 8) + ' local time.';
  }

  return (
    <section className={styles.live} id="live" aria-labelledby="live-h">
      <Particles />

      <div className={styles.inner}>
        <p className={styles.eyebrow} id="live-h">
          <span className={styles.pulse} aria-hidden="true" />
          {EYEBROW}
        </p>

        {/* The giant figure. `tabular-nums` in the stylesheet is what lets a
            number that changes every few seconds sit in a display size without
            the line reflowing under it. */}
        <p className={styles.figure}>
          <span className={styles.figureGlow} aria-hidden="true" />
          <span className={styles.figureValue}>{ok ? groups(ok.blockNumber) : null}</span>
        </p>

        <p className={styles.figureLabel}>{BLOCK_LABEL}</p>

        <p
          className={live.status === 'failed' ? styles.stampBad : styles.stamp}
          role="status"
          aria-live="polite"
        >
          {stamp}
        </p>

        <div className={styles.grid}>
          <Cell
            label={VAULTS_LABEL}
            source={VAULTS_CALL}
            value={ok ? <span className={styles.plain}>{groups(ok.vaultCount)}</span> : null}
          />
          <Cell
            label={SUBVAULTS_LABEL}
            source={SUBVAULTS_CALL}
            value={
              ok ? <span className={styles.plain}>{String(ok.allowSubVaults)}</span> : null
            }
          />
          <Cell
            label={ok ? ok.eth.description : EXPECT_ETH}
            source={ok ? FEED_LABEL + ' ' + utc(ok.eth.updatedAt) : FEED_LABEL}
            value={
              ok ? (
                <Price price={ok.eth.price} updatedAt={ok.eth.updatedAt} now={ok.readAt} />
              ) : null
            }
          />
          <Cell
            label={ok ? ok.spy.description : EXPECT_SPY}
            source={ok ? FEED_LABEL + ' ' + utc(ok.spy.updatedAt) : FEED_LABEL}
            value={
              ok ? (
                <Price price={ok.spy.price} updatedAt={ok.spy.updatedAt} now={ok.readAt} />
              ) : null
            }
          />
        </div>
      </div>
    </section>
  );
}
