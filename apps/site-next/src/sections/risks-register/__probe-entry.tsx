/**
 * SSR entry for __probe.mjs. Renders this section alone, with the same
 * renderToString the real prerender uses, so the probe asserts against the
 * bytes that will reach dist/risks.html rather than against the JSX.
 *
 * Not imported by anything that ships: it is reachable only from the probe's
 * own one-off SSR build, which writes outside the repository.
 */
import { renderToString } from 'react-dom/server';
import RisksRegister from './RisksRegister';

export function render(): string {
  return renderToString(<RisksRegister />);
}
