/**
 * The two curves and four durations the whole site moves on. Mirrored in
 * tokens.css as --ease-enter / --ease-exit / --dur-*; this is where JS reads
 * them, because a hand-typed cubic-bezier in a component is how a house style
 * becomes seven house styles.
 *
 * Nothing bounces and nothing overshoots. Both curves are monotonic on
 * purpose: an overshoot on a page about irreversibility reads as playfulness
 * about the wrong subject.
 */

/** Enters. Fast out of the gate, long settle. */
export const EASE_ENTER = [0.16, 1, 0.3, 1] as const;

/** Exits. Slow to leave, then gone. */
export const EASE_EXIT = [0.7, 0, 0.84, 0] as const;

/** Seconds. UI moves in the 0.24-0.8 band; only the hero is allowed 1.2. */
export const DUR = {
  fast: 0.24,
  mid: 0.5,
  slow: 0.8,
  hero: 1.2,
} as const;

/** The distance a revealed block rises. Small, and the same everywhere. */
export const RISE_PX = 16;

/** The distance hero text rises. Smaller still: display type at 96px does not need 16. */
export const RISE_HERO_PX = 8;

/** Seconds between the items of a staggered group. */
export const STAGGER = {
  tight: 0.06,
  normal: 0.08,
  loose: 0.1,
  hero: 0.12,
} as const;
