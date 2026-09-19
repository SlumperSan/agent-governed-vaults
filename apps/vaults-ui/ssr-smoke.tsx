/**
 * Not shipped. Renders the app once on the server and asserts what actually reaches the markup.
 *
 * THIS EXISTS BECAUSE `tsc` AND `vite build` BOTH PASS ON A PAGE THAT THROWS. The hand-written
 * declarations in src/lib/atlas-modules/ describe untyped ESM: when one of them is wrong,
 * TypeScript believes the declaration rather than the module, and the mistake surfaces only when
 * React is asked to render the value. `proposalPhase` was declared `: string` and actually returns
 * an object; the build was green and the page threw. A green build is not evidence here — this is.
 *
 * PLAN ITEM 0.7 CHANGED WHAT "REACHES THE MARKUP" MEANS. `App` now reads through `useLiveVaults`
 * (`src/lib/live-vaults.ts`), which fetches over `useEffect` — and `renderToString` never runs
 * effects, so this render is always the FIRST PAINT: `Fetched`'s `loading` state, not `ready`. The
 * old `MUST_CONTAIN` asserted fixture strings ('Base Blue-Chip 5', 'Meridian', …) reached the
 * markup; asserting that today would be asserting the exact regression plan item 0.7 closes. This
 * version asserts the loading shell renders, AND — the check that matters more than the positive
 * one — that no fixture-labelled value is anywhere in the output, matching
 * `test/csp.test.mjs`'s guard on the real build.
 */
import { renderToString } from 'react-dom/server';
import { App } from './src/App';

const html = renderToString(<App />);

const MUST_CONTAIN = [
  'Vault Atlas', // the masthead
  'commit-reveal', // the masthead's one-line explainer, unrelated to any data source
  'Reading the chain', // the loading state useLiveVaults starts in — renderToString runs no effects
];

// The same sentinels test/csp.test.mjs scans dist/ for. Listed again here
// rather than imported: this file is not built the way that test's targets are, and duplicating a
// half-dozen literal strings is cheaper than a cross-file import for a script that is not shipped.
const MUST_NOT_CONTAIN = [
  'Base Blue-Chip 5',
  'Momentum Majors',
  'Ridgeline Broad Basket',
  'Meridian',
  'Halcyon',
  '0x1111000000000000000000000000000000001111',
];

const missing = MUST_CONTAIN.filter((s) => !html.includes(s));
const present = MUST_NOT_CONTAIN.filter((s) => html.includes(s));

if (missing.length > 0 || present.length > 0) {
  console.error(`smoke FAILED — rendered ${html.length} bytes.`);
  for (const m of missing) console.error(`  missing: ${m}`);
  for (const p of present) console.error(`  fixture leaked in: ${p}`);
  process.exit(1);
}

console.log(
  `smoke: App rendered ${html.length} bytes, all ${MUST_CONTAIN.length} checks present, ` +
    `no fixture data leaked`,
);
