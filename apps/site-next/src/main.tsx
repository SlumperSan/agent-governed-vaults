/**
 * The shared client bootstrap. Each of the eight `entry-<page>.tsx` files is
 * three lines that call into this.
 *
 * IT HYDRATES, IT DOES NOT RENDER. `dist/<page>.html` already contains the
 * finished markup — `scripts/prerender.mjs` put it there — so the client's job
 * is to attach to what is on screen, not to build it. `createRoot().render()`
 * would throw the prerendered subtree away and rebuild it, which loses the
 * paint the reader already has and defeats the whole point of prerendering.
 *
 * THE STYLESHEET IMPORTS LIVE HERE, in this order:
 *   tokens  -> the custom properties everything else reads
 *   fonts   -> the three @font-face rules, which reference nothing above
 *   base    -> the reset, element defaults and shared surfaces
 * A section's own module CSS is imported by the section and lands after these.
 * The bundler emits one stylesheet and injects the <link> into all eight
 * pages; there is no inline <style> anywhere, because the CSP forbids one.
 */
import { StrictMode, type ComponentType } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { App } from './shell/App';
import type { PageId } from './shell/pinned';

import './tokens.css';
import './fonts.css';
import './index.css';

export function hydrate(page: PageId, Body: ComponentType | null): void {
  const container = document.getElementById('root');
  if (!container) {
    // Nothing to attach to means the entry HTML was edited out from under the
    // prerender. Fail loudly in the console rather than silently blank.
    throw new Error('site-next: no #root element to hydrate');
  }

  hydrateRoot(
    container,
    <StrictMode>
      <App page={page} Body={Body} />
    </StrictMode>,
  );
}
