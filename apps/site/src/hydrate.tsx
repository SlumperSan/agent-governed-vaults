/**
 * The shared client bootstrap. Each `entry-<page>.tsx` is three lines that call into this.
 *
 * IT HYDRATES, IT DOES NOT RENDER. `dist/<page>.html` already carries the finished markup because
 * `scripts/prerender.mjs` put it there, so the client's job is to attach to what is on screen
 * rather than build it. `createRoot().render()` would throw the prerendered subtree away and
 * rebuild it, losing the paint the reader already has — which is the whole point of prerendering.
 *
 * THE STYLESHEET IMPORTS LIVE HERE, in this order: the two bundled faces, then tokens (the custom
 * properties everything else reads), then base (reset and shared surfaces), then sections. One
 * stylesheet is emitted and linked from every page; there is no inline <style> anywhere, because
 * `style-src 'self'` in public/_headers forbids one.
 */
import { StrictMode, type ReactElement } from 'react';
import { hydrateRoot } from 'react-dom/client';

import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';

import './tokens.css';
import './base.css';
import './sections.css';
import './embers.css';

export function hydrate(page: ReactElement): void {
  const container = document.getElementById('root');
  if (!container) {
    // Nothing to attach to means the entry HTML was edited out from under the prerender. Fail
    // loudly in the console rather than silently leaving a blank page.
    throw new Error('site: no #root element to hydrate');
  }
  hydrateRoot(container, <StrictMode>{page}</StrictMode>);
}
