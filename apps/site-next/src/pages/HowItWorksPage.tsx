/**
 * how-it-works.html — the mechanism reference, in document order.
 *
 * ORDER IS LOAD-BEARING BETWEEN TWO OF THESE. HiwLifecycle's seventh step ends
 * "That is forward settlement, described below.", and the passage it points at
 * is HiwExit. Reordering those two makes a carried sentence false.
 */
import HiwHero from '../sections/hiw-hero/HiwHero';
import HiwInvariant from '../sections/hiw-invariant/HiwInvariant';
import HiwLifecycle from '../sections/hiw-lifecycle/HiwLifecycle';
import HiwExit from '../sections/hiw-exit/HiwExit';
import HiwFees from '../sections/hiw-fees/HiwFees';
import HiwPricing from '../sections/hiw-pricing/HiwPricing';
import HiwReferenceConfig from '../sections/hiw-reference-config/HiwReferenceConfig';
import HiwCorrections from '../sections/hiw-corrections/HiwCorrections';

export default function HowItWorksPage() {
  return (
    <>
      <HiwHero />
      <HiwInvariant />
      <HiwLifecycle />
      <HiwExit />
      <HiwFees />
      <HiwPricing />
      <HiwReferenceConfig />
      <HiwCorrections />
    </>
  );
}
