/**
 * The marquee strip: four claims, in the accent, moving.
 *
 * THE FOUR PHRASES ARE THE BRIEF'S, WITH ONE WORD CHANGED, and the change is
 * recorded here because it is the kind of edit that looks like drift. Revision 2
 * of the v3 brief lists them as "THE HIVE DECIDES, SEVEN IMMUTABLE CONTRACTS, NO
 * ADMIN KEY, EVERY TRADE PUT TO A VOTE". The fourth is a splice of two lines
 * from the approved promo script, which reads "Every trade argued in the open.
 * Every position put to a vote." This renders the script's own second line
 * rather than the splice, so every phrase on the strip is verbatim from a source
 * `test/site.test.mjs` can check. Both are true and the script's version is the
 * one that was approved as a sentence.
 *
 * THE STRIP IS DUPLICATED BY JAVASCRIPT AND NOT BY THE SERVER, and that is a
 * word-count decision as much as a rendering one.
 *
 *   A MARQUEE NEEDS TWO COPIES OF ITS CONTENT to loop without a gap: the track
 *   translates by exactly half its width, and at the moment it snaps back the
 *   second copy is sitting where the first one started. That is the whole
 *   technique and there is no version of it with one copy.
 *
 *   BUT THE SECOND COPY IS NOT CONTENT. The v3 brief caps this page at 150 to
 *   250 visible words and `test/site.test.mjs` counts them out of the
 *   prerendered HTML. Fifteen words of decorative repetition baked into that
 *   document would be six per cent of the entire page budget spent saying the
 *   same four things twice. So the server renders ONE track, which is what a
 *   reader with no JavaScript sees and what the counter counts, and the clone is
 *   appended on mount. It is `aria-hidden`, because a screen reader has no use
 *   for the second reading either.
 *
 *   THE NO-SCRIPT RENDER IS COMPLETE, NOT DEGRADED. One static strip carrying
 *   four legible claims is a correct strip. Nothing is hidden waiting for a
 *   script to reveal it, which is the failure mode this build is careful about
 *   everywhere: a section whose text ships at opacity zero is a section that is
 *   blank in a screenshot and blank to a reader whose script never ran.
 */
import { useEffect, useState, type JSX } from 'react';
import { PHRASES } from './copy';
import styles from './IndexMarquee.module.css';

function Track({ hidden }: { hidden?: boolean }): JSX.Element {
  return (
    <div className={styles.track} aria-hidden={hidden ? 'true' : undefined}>
      {PHRASES.map((phrase) => (
        <span className={styles.phrase} key={phrase}>
          {phrase}
        </span>
      ))}
    </div>
  );
}

export default function IndexMarquee(): JSX.Element {
  const [looping, setLooping] = useState(false);
  useEffect(() => setLooping(true), []);

  return (
    <div className={styles.strip}>
      <div className={looping ? styles.rail + ' ' + styles.moving : styles.rail}>
        <Track />
        {looping ? <Track hidden /> : null}
      </div>
    </div>
  );
}
