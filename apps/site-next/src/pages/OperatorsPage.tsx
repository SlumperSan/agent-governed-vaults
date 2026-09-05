/**
 * operators.html — the capital-obligation page, in document order.
 *
 * OpsObligation supplies the page's "2,500 USDG" / "proposal threshold" /
 * "withdrawal gate" obligations, and its own "50,000" is paired with
 * "planned" in the same sentence. OpsEconomics carries a second, independent
 * "50,000" / "planned" pairing (the fee is quantified "on a vault at the
 * planned 50,000 USDG cap"). Both sections satisfy the pairing on their own,
 * so neither may drop its wording on the assumption that the other holds it up.
 */
import OpsHero from '../sections/ops-hero/OpsHero';
import OpsObligation from '../sections/ops-obligation/OpsObligation';
import OpsPowers from '../sections/ops-powers/OpsPowers';
import OpsEconomics from '../sections/ops-economics/OpsEconomics';
import OpsReferenceAgent from '../sections/ops-reference-agent/OpsReferenceAgent';

export default function OperatorsPage() {
  return (
    <>
      <OpsHero />
      <OpsObligation />
      <OpsPowers />
      <OpsEconomics />
      <OpsReferenceAgent />
    </>
  );
}
