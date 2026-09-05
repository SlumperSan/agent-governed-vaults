/**
 * The live Lenis instance, held in one module-level slot, with a subscription.
 *
 * A React context would be the idiomatic answer and is the wrong one here: the
 * only consumer is useScrollTimeline, which runs inside an effect and needs the
 * instance imperatively, and adding a context Provider would put a component
 * boundary into the tree that the server and client both have to agree on for
 * no benefit. A slot set by the provider's effect and read by another effect
 * has neither problem.
 *
 * WHY A SUBSCRIPTION AND NOT JUST A GETTER. Two dynamic imports race, and until
 * 2026-09-04 the loser was silently dropped. `LenisProvider` fetches `lenis`
 * from its own effect; `useScrollTimeline` fetches `gsap` and
 * `gsap/ScrollTrigger` from a child's effect. React runs child effects before
 * parent effects, so the gsap request STARTS first — and with both chunks in
 * cache it routinely settles first too. The old code read `getLenis()` once, at
 * that moment, and if the slot was still empty it never attached ScrollTrigger
 * to Lenis's scroll event at all. The failure had no symptom a screenshot could
 * show: two scroll loops instead of one, triggers firing a few pixels early on
 * some frames, and only on the runs where gsap happened to win.
 *
 * `subscribeLenis` closes that by delivering the instance whenever it arrives,
 * and by delivering null when the provider tears it down, so a listener detaches
 * instead of being left holding a destroyed object.
 *
 * The type is deliberately structural rather than an import of Lenis's own
 * type: importing the type from 'lenis' here would pull the module into every
 * bundle that reads this slot, which defeats the dynamic import that put it in
 * its own chunk. `off` is part of that structure because a subscriber that can
 * attach must be able to detach; `lenis/dist/lenis.d.ts:391` declares it.
 */

export type ScrollDriver = {
  raf(time: number): void;
  on(event: 'scroll', handler: () => void): void;
  off(event: 'scroll', handler: () => void): void;
  scrollTo(target: number | string | HTMLElement, options?: Record<string, unknown>): void;
};

/** Called with the instance when one arrives, and with null when it goes away. */
export type LenisSubscriber = (instance: ScrollDriver | null) => void;

let current: ScrollDriver | null = null;
const subscribers = new Set<LenisSubscriber>();

export function setLenis(instance: ScrollDriver | null): void {
  current = instance;
  // Iterate a copy: a subscriber is allowed to unsubscribe from inside its own
  // callback, which is exactly what the teardown path does.
  for (const notify of [...subscribers]) notify(instance);
}

export function getLenis(): ScrollDriver | null {
  return current;
}

/**
 * Observe the slot.
 *
 * The subscriber is called SYNCHRONOUSLY on subscribe with whatever is in the
 * slot right now — which may be null — and again on every change. That first
 * call is what makes the two orderings identical: whether Lenis landed before
 * this subscriber or after it, the subscriber sees it exactly once either way,
 * and has no reason to know which happened.
 *
 * @returns an unsubscribe function. Call it from the effect's cleanup.
 */
export function subscribeLenis(notify: LenisSubscriber): () => void {
  subscribers.add(notify);
  notify(current);
  return () => {
    subscribers.delete(notify);
  };
}
