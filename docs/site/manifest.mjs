// @ts-check
/**
 * The docs-site navigation — and the only place the site's page set is defined.
 *
 * Every entry points at a markdown file that already exists in the repo. The site RENDERS those
 * files at runtime; it never holds a second copy of the prose. That is the whole design constraint:
 * a docs site that duplicates its source drifts the first time someone edits one of the two copies,
 * and the drift is invisible until a developer follows an instruction that is no longer true.
 *
 * Consumed by `app.mjs` (the browser) and by `scripts/test/docs-site.test.mjs` (the gate), which
 * asserts every `path` here exists on disk and that every link inside those files resolves.
 */

/**
 * @typedef {Object} Page
 * @property {string} path   repo-root-relative path to the markdown source
 * @property {string} title  nav label (the site does not read the file's own H1 for this)
 * @property {string} blurb  one line, shown on the landing page
 */

/** @type {Array<{section:string, pages:Page[]}>} */
export const NAV = [
  {
    section: 'Start here',
    pages: [
      { path: 'docs/site/HOME.md', title: 'Overview', blurb: 'What this protocol is and where the agent surface begins.' },
      { path: 'docs/AGENT-QUICKSTART.md', title: 'Agent quickstart', blurb: 'Zero to an agent reading vault state over x402. PowerShell, copy-pasteable, executed.' },
      { path: 'docs/LIMITS.md', title: 'Limits and honest risks', blurb: 'What is beta, what is unaudited, and what can freeze your exit.' },
    ],
  },
  {
    section: 'The x402 flow',
    pages: [
      { path: 'docs/X402-FLOW.md', title: 'x402 explained', blurb: 'The 402 challenge, EIP-3009 authorization, facilitator settlement, and nonce burn.' },
    ],
  },
  {
    section: 'Reference',
    pages: [
      { path: 'docs/SDK-REFERENCE.md', title: 'Agent SDK reference', blurb: 'Every public method, with an example the gate executes.' },
      { path: 'docs/REFERENCE-AGENT.md', title: 'Reference agent', blurb: 'The worked example: perceive, decide, act — dry-run by default.' },
    ],
  },
  {
    section: 'Protocol',
    pages: [
      { path: 'docs/ARCHITECTURE.md', title: 'Architecture', blurb: 'NAV and share math, two-mode exits, governance, sub-vaults, safety.' },
      { path: 'docs/THREAT-MODEL.md', title: 'Threat model', blurb: 'Each mechanic mapped to its attack vector, mitigation, and accepted risk.' },
    ],
  },
  {
    section: 'Operate',
    pages: [
      { path: 'docs/RUNTIME.md', title: 'Running the stack', blurb: 'Indexer, API and web, plus the operational signals.' },
      { path: 'docs/DEPLOYMENT.md', title: 'Deployment', blurb: 'Deploy semantics and wiring order.' },
    ],
  },
];

/** Flat page list, in nav order. */
export const PAGES = NAV.flatMap((s) => s.pages);

/** The page shown when no route is given. */
export const HOME = 'docs/site/HOME.md';

/** @param {string} path @returns {Page|undefined} */
export const pageFor = (path) => PAGES.find((p) => p.path === path);
