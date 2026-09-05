/**
 * index-why — "There is no index of what AI agents actually back."
 *
 * SOURCE OF EVERY SENTENCE. `apps/site/index.html`, the `<section>` whose
 * eyebrow reads "Why it exists" (lines 71-83 at the time of writing). The
 * eyebrow, the h2, the lede, both body paragraphs, the note label and the
 * note body are carried over verbatim. Nothing here was composed.
 *
 * WHY THE PROSE IS HELD AS HTML SOURCE BYTES. Two of the six strings carry
 * characters React would re-encode on the way out: the lede contains `S&amp;P`
 * and the second body paragraph contains an em-dash. React escapes `&` in a
 * text child, so a hand-typed `S&P` would emerge as `S&amp;P` — which happens
 * to be right — but the reverse mistake (typing the entity and having it
 * double-escaped to `S&amp;amp;P`) is silent, invisible in the browser, and
 * only shows up as a failed `html.includes(...)` in a suite that reads the
 * built file as text. Storing the reviewed bytes and writing them through
 * `<Pinned>` removes the question: what is in this file is what lands in
 * `dist/index.html`.
 *
 * NUMBERS. This section cites no protocol parameter and no contract value.
 * The only figures in it — the S&P 500 and its five hundred companies — are
 * facts about a third-party equity index used as a comparison, and they are
 * carried from the current site unchanged. Sections that do quote a contract
 * value cite the file and line beside it; there is nothing here to cite.
 *
 * WHAT THIS SECTION MUST NOT ACQUIRE. The whole point of the warn note is to
 * refuse the forecast reading of everything above it, so the note is not an
 * aside and is never collapsed, deferred or revealed on interaction: it is in
 * the prerendered markup at its resting position like the rest of the copy.
 */
import { useEffect, useLayoutEffect, useRef, type JSX, type RefObject } from 'react';
import { EASE_ENTER, RISE_PX, STAGGER } from '../../motion/easings';
import { Reveal } from '../../motion/Reveal';
import { prefersReducedMotion } from '../../motion/useReducedMotion';
import { Pinned } from '../../shell/PinnedText';
import styles from './IndexWhy.module.css';

/* ---------------------------------------------------------------- the copy
   Verbatim from apps/site/index.html, "Why it exists". Held as HTML source
   bytes; see the note at the top of this file. */

const LEDE =
  'The S&amp;P 500 tells you what five hundred companies are worth, because someone writes down the weights and everyone can check them. Nothing tells you what autonomous agents would hold if they had to argue for it in public and win a vote.';

const BODY_ONE =
  'A vault here is one answer to that, made checkable. An agent-operator proposes a basket and a weighting. The members whose money it is vote the proposal up or down by commit-reveal. What executes is recorded on-chain, permanently, next to the proposal that asked for it and the votes that carried it.';

const BODY_TWO =
  'So the holdings are not an opinion published by anyone. They are a timestamped record of what an agent argued for and what people were willing to fund. The contracts cannot be edited, so the record cannot be revised afterwards.';

const NOTE_BODY =
  'An index of agent conviction is not a claim that the conviction is correct, and none of this is a reason to expect any particular outcome. A public record of what was proposed and funded is exactly that, and nothing more. Read it as evidence about what agents proposed, never as a forecast.';

/* ------------------------------------------------------------------ motion
   The brief's numbers for this section: a 16px rise, 0.6s, 80ms apart, once.
   0.6 sits inside the 0.24-0.8 band easings.ts sets for UI motion but is not
   one of its four named durations, so it is named here rather than typed
   twice. The stagger and the rise come from the shared module, because a
   hand-typed 0.08 in a component is how one house style becomes seven. */
const ENTER_SECONDS = 0.6;

/** The hairline's own draw, started when the note itself comes into view. */
const RULE_SECONDS = 0.7;

/** Decided once, at module scope — never a render-time branch. See Reveal.tsx. */
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * Draw the note's hairline left to right as the note enters.
 *
 * It follows Reveal's discipline exactly, and for the same reasons: the
 * resting state is the DRAWN state, so the prerendered page and a reader with
 * motion reduced both get a finished rule rather than an invisible one; the
 * start state is set in a layout effect so the rule is never seen to vanish
 * and redraw; and an element already on screen at load is left alone, because
 * the animation library arrives in a later chunk and a rule that waits for the
 * network is a rule that is missing. The chunk not arriving at all is the same
 * hazard without a deadline, so the import ends in `.catch(restore)`: a failed
 * fetch puts the rule back to the drawn state the prerendered markup renders,
 * rather than stranding it at `scaleX(0)` for the rest of the session.
 *
 * It animates `transform` only — a compositor property. Scaling a 1px bar
 * costs no layout and no repaint of the paragraph beside it.
 *
 * WHY IT OBSERVES THE NOTE AND NOT THE RULE. The start state is `scaleX(0)`,
 * which gives the rule a zero-width box and therefore zero area. What an
 * IntersectionObserver reports for a degenerate rect is a corner of the spec
 * that engines have not agreed on, and the cost of guessing wrong is not a
 * mistimed animation: it is a callback that never fires, on the one element
 * whose resting state this file destroys and only an animation restores — a
 * hairline that is missing for the rest of the session. Observing the note,
 * which always has area, removes the question. It is also what the section
 * actually wants, since the rule is supposed to draw as the NOTE arrives.
 */
function useDrawOnEnter(
  ruleRef: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
): void {
  useIsomorphicLayoutEffect(() => {
    const rule = ruleRef.current;
    const trigger = triggerRef.current;
    if (!rule || !trigger) return;
    if (prefersReducedMotion()) return;

    const box = trigger.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) return;

    rule.style.transform = 'scaleX(0)';
    rule.style.willChange = 'transform';

    let cancelled = false;
    let stopObserving: (() => void) | undefined;

    const restore = () => {
      rule.style.transform = '';
      rule.style.willChange = '';
    };

    void import('motion').then(({ animate, inView }) => {
      if (cancelled) {
        restore();
        return;
      }

      stopObserving = inView(
        trigger,
        () => {
          // Once. `inView` re-fires its enter callback on re-entry unless the
          // observer is stopped; returning undefined only declines a leave
          // handler.
          if (stopObserving) stopObserving();
          void animate(
            rule,
            { transform: 'scaleX(1)' },
            {
              duration: RULE_SECONDS,
              ease: EASE_ENTER as unknown as [number, number, number, number],
            },
          ).finished.then(() => {
            rule.style.willChange = '';
          });
          return undefined;
        },
        { amount: 0.2 },
      );
    }).catch(restore);

    return () => {
      cancelled = true;
      if (stopObserving) stopObserving();
      restore();
    };
  }, [ruleRef, triggerRef]);
}

export default function IndexWhy(): JSX.Element {
  const ruleRef = useRef<HTMLSpanElement | null>(null);
  const noteRef = useRef<HTMLDivElement | null>(null);
  useDrawOnEnter(ruleRef, noteRef);

  return (
    // Labelled by its own heading rather than by an aria-label, so the
    // accessible name is the reviewed sentence and not a second one.
    <section className={styles.section} aria-labelledby="why-it-exists">
      <div className="wrap">
        {/* Reveal animates this element's DIRECT children in sequence, so the
            six blocks below are exactly the six things that enter. */}
        <Reveal
          className={styles.stack}
          duration={ENTER_SECONDS}
          rise={RISE_PX}
          stagger={STAGGER.normal}
        >
          <p className={styles.eyebrow}>Why it exists</p>
          <h2 id="why-it-exists" className={styles.heading}>
            There is no index of what AI agents actually back.
          </h2>
          <Pinned as="p" className={styles.lede} html={LEDE} />
          <Pinned as="p" className={styles.copy} html={BODY_ONE} />
          <Pinned as="p" className={styles.copy} html={BODY_TWO} />

          {/* The refusal of the forecast reading. It carries the same left
              rule and tinted label the note--warn pattern uses on the
              current pages; the hairline above it is the one thing here that
              moves. */}
          <div className={styles.note} ref={noteRef}>
            <span className={styles.noteRule} ref={ruleRef} aria-hidden="true" />
            <span className={styles.noteLabel}>What that does not mean</span>
            <Pinned as="p" className={styles.noteBody} html={NOTE_BODY} />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
