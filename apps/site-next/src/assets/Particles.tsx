/**
 * The star field. A drift of small points behind the hero and the live panel.
 *
 * WHY IT IS DOM AND NOT A CANVAS. Forty absolutely positioned spans animated on
 * `transform` and `opacity` are forty compositor layers and zero main-thread
 * work per frame. A canvas would be one element and a `requestAnimationFrame`
 * loop that runs whether or not the section is on screen, on a page whose whole
 * argument is that it does the smallest honest amount of work. The DOM version
 * also stops for free under `prefers-reduced-motion`, and it is inert while the
 * tab is backgrounded because CSS animations are, which an rAF loop is not
 * unless somebody remembers to write the visibility handler.
 *
 * THE POSITIONS ARE DETERMINISTIC, NOT RANDOM, and that is a build requirement
 * rather than an aesthetic one. This component renders during the prerender and
 * again during hydration, and `Math.random()` produces different numbers in the
 * two passes, which React reports as a hydration mismatch and repairs by
 * throwing the server's markup away. The hash below is a cheap integer scramble
 * over the particle's own index: the same input gives the same output on the
 * server, in the browser, and in every screenshot taken of either.
 *
 * IT IS DECORATION AND IT SAYS SO. `aria-hidden` on the container, no text, no
 * focusable child. Nothing in this file carries meaning that is not repeated in
 * words somewhere the assistive tree can reach.
 *
 * IT RENDERS ONLY AFTER MOUNT, AND THE CONTENT SECURITY POLICY IS THE REASON.
 * Each point carries its position and timing as inline custom properties, which
 * React writes as a `style` attribute when it renders to a STRING and sets
 * through the CSSOM when it renders in a BROWSER. `public/_headers` ships
 * `style-src 'self'` with no `'unsafe-inline'`, so a `style` attribute in the
 * prerendered markup is refused by the browser: the field would be forty points
 * stacked in the top left corner, with nothing in the console that names this
 * file. The CSSOM path is not governed by that directive, so gating the whole
 * field behind a mount latch is what makes it work at all. It is also correct
 * for a second reason: the field is decoration, and decoration has no business
 * in the document a reader gets before any script runs.
 */
import { useEffect, useState, type CSSProperties, type JSX } from 'react';
import styles from './particles.module.css';

/** Matches --particle-count in tokens.css, where the budget is explained. */
const COUNT = 40;

/**
 * A deterministic scramble. Three rounds of xor-shift over the index, which is
 * enough to break up the visible lattice a plain `i * k % n` leaves behind.
 * Returns a fraction in [0, 1).
 */
function scatter(i: number, salt: number): number {
  let x = (i + 1) * 2654435761 + salt * 40503;
  x = (x ^ (x >>> 15)) >>> 0;
  x = (x * 2246822519) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return (x >>> 8) / 16777216;
}

export function Particles({ className }: { className?: string }): JSX.Element | null {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  const points = [];
  for (let i = 0; i < COUNT; i++) {
    // Every particle carries its own geometry and timing as custom properties.
    // The stylesheet owns the animation; this owns where each one is and when it
    // starts, which is the split that keeps the keyframes to one rule.
    const style = {
      '--x': scatter(i, 1) * 100 + '%',
      '--y': scatter(i, 2) * 100 + '%',
      '--size': (0.9 + scatter(i, 3) * 1.6).toFixed(2) + 'px',
      '--drift': (14 + scatter(i, 4) * 20).toFixed(1) + 's',
      '--delay': (scatter(i, 5) * -30).toFixed(1) + 's',
      '--rise': (18 + scatter(i, 6) * 34).toFixed(0) + 'px',
      // One point in four is lit in the accent; the rest are dim ink. A field
      // that is all accent reads as a gradient, and a field that is all ink
      // reads as dust.
      '--tone': i % 4 === 0 ? 'var(--particle-lit)' : 'var(--particle-dim)',
    } as CSSProperties;
    points.push(<span key={i} className={styles.point} style={style} />);
  }

  return (
    <div className={className ? className + ' ' + styles.field : styles.field} aria-hidden="true">
      {points}
    </div>
  );
}
