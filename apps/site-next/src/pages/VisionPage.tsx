/**
 * vision.html — the design-intent page, in document order.
 *
 * LANDED 2026-09-05, copy deck v2. The placeholder this file used to render
 * — a heading and one sentence saying the page was not written yet — no
 * longer applies: the owner's copy deck has landed, and every sentence below
 * it is subject to the same guards as every other page, including the ban on
 * describing an unbuilt thing in the present tense. See vision-hero and
 * vision-body for where each string comes from.
 *
 * Composition only. The masthead, `<main id="main">` and footer come from
 * PageShell.
 */
import type { JSX } from 'react';
import VisionHero from '../sections/vision-hero/VisionHero';
import VisionBody from '../sections/vision-body/VisionBody';

export default function VisionPage(): JSX.Element {
  return (
    <>
      <VisionHero />
      <VisionBody />
    </>
  );
}
