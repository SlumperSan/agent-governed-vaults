import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

/**
 * STYLESHEET ORDER IS LOAD-BEARING, and it is the same order apps/site/src/hydrate.tsx uses: the
 * two bundled faces, then the tokens every later rule reads, then the chrome, then this surface.
 *
 * THE FACES ARE npm PACKAGES, NOT A LINK TO GOOGLE. @fontsource ships the woff2 files into this
 * build, so they serve from this origin and `font-src 'self'` in public/_headers holds. One request
 * to fonts.googleapis.com would contradict the no-external-request property that file establishes,
 * and would be refused by the browser rather than degrading quietly.
 */
import '@fontsource-variable/ibm-plex-sans';
import '@fontsource/ibm-plex-mono/400.css';

import './styles.css';
import './chrome.css';

const container = document.getElementById('root');
if (!container) throw new Error('vaults-ui: no #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
