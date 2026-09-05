/**
 * disclaimers.html — risks.html's replacement, the fifteen-entry register
 * plus the standing disclosures the other seven pages used to repeat, in
 * document order.
 *
 * RisksContents' heading AND its own closing paragraph are both COMPUTED by
 * the guard from RisksRegister's markup ("All fifteen." from the article
 * count, "Seven of these have no mitigation" from the count of "What is done"
 * cells opening with "Nothing"). CHANGED 2026-09-05: both derived sentences
 * used to live one apiece in RisksContents (the heading) and RisksHero (the
 * lede); the corpus now puts both in RisksContents, immediately after the
 * jump list, and RisksHero's lede is a fixed sentence instead — see that
 * file's own comment. The two derived sentences still travel together; a
 * change in the register reds both.
 */
import RisksHero from '../sections/risks-hero/RisksHero';
import RisksContents from '../sections/risks-contents/RisksContents';
import RisksRegister from '../sections/risks-register/RisksRegister';
import RisksReviewStatus from '../sections/risks-review-status/RisksReviewStatus';
import RisksVerify from '../sections/risks-verify/RisksVerify';

export default function DisclaimersPage() {
  return (
    <>
      <RisksHero />
      <RisksContents />
      <RisksRegister />
      <RisksReviewStatus />
      <RisksVerify />
    </>
  );
}
