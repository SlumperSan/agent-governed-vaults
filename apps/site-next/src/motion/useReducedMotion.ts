/**
 * Reduced motion, read the one way that is allowed here.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: never branch the RENDER TREE on
 * `prefers-reduced-motion`. The server cannot know the answer, so a component
 * that returns different JSX for the two cases produces a client tree that
 * differs from the prerendered one, React discards the mismatched subtree, and
 * the discarded subtree is the markup the claims guards verified.
 *
 * `useSyncExternalStore` is the mechanism that makes this checkable rather
 * than merely intended. Its third argument is the SERVER snapshot, and React
 * uses that same value for the client's hydration render before switching to
 * the live one. The server snapshot here is `true` — the state in which
 * nothing moves — so the resting state is what both sides render at hydration
 * time, for everybody, and the animated path is the thing that gets added
 * afterwards. That is the right way round for accessibility as well as for
 * hydration.
 *
 * A component uses this to decide whether to START an animation, inside an
 * effect. It must not use it to decide what to render.
 */
import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

const subscribe = (onChange: () => void): (() => void) => {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
};

const getSnapshot = (): boolean => window.matchMedia(QUERY).matches;

/** What the server renders, and what the client renders while hydrating. */
const getServerSnapshot = (): boolean => true;

export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** The same question outside React, for effects and one-shot setup. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia(QUERY).matches;
}
