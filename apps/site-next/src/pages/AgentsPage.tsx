/**
 * agents.html — the machine-readable integration page, in document order.
 */
import AgentsHero from '../sections/agents-hero/AgentsHero';
import AgentsBootstrap from '../sections/agents-bootstrap/AgentsBootstrap';
import AgentsCapabilities from '../sections/agents-capabilities/AgentsCapabilities';
import AgentsReferenceClient from '../sections/agents-reference-client/AgentsReferenceClient';
import AgentsBeforeYouPoint from '../sections/agents-before-you-point/AgentsBeforeYouPoint';

export default function AgentsPage() {
  return (
    <>
      <AgentsHero />
      <AgentsBootstrap />
      <AgentsCapabilities />
      <AgentsReferenceClient />
      <AgentsBeforeYouPoint />
    </>
  );
}
