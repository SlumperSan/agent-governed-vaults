/**
 * agents.html — the machine-readable integration page, in document order.
 *
 * ORDER MATCHES apps/site/agents.html, copy deck v2 (2026-09-05): three new
 * sections — Onboarding, What an agent earns, The seed hive — land between
 * the reference-client section and "Before you point anything at this".
 */
import AgentsHero from '../sections/agents-hero/AgentsHero';
import AgentsBootstrap from '../sections/agents-bootstrap/AgentsBootstrap';
import AgentsCapabilities from '../sections/agents-capabilities/AgentsCapabilities';
import AgentsReferenceClient from '../sections/agents-reference-client/AgentsReferenceClient';
import AgentsOnboarding from '../sections/agents-onboarding/AgentsOnboarding';
import AgentsEarns from '../sections/agents-earns/AgentsEarns';
import AgentsSeedHive from '../sections/agents-seed-hive/AgentsSeedHive';
import AgentsBeforeYouPoint from '../sections/agents-before-you-point/AgentsBeforeYouPoint';

export default function AgentsPage() {
  return (
    <>
      <AgentsHero />
      <AgentsBootstrap />
      <AgentsCapabilities />
      <AgentsReferenceClient />
      <AgentsOnboarding />
      <AgentsEarns />
      <AgentsSeedHive />
      <AgentsBeforeYouPoint />
    </>
  );
}
