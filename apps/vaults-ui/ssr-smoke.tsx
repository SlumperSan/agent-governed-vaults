/**
 * Not shipped. Renders the app once on the server and asserts that real fixture data reached the
 * markup.
 *
 * THIS EXISTS BECAUSE `tsc` AND `vite build` BOTH PASS ON A PAGE THAT THROWS. The hand-written
 * declarations in src/lib/atlas-modules/ describe untyped ESM: when one of them is wrong,
 * TypeScript believes the declaration rather than the module, and the mistake surfaces only when
 * React is asked to render the value. `proposalPhase` was declared `: string` and actually returns
 * an object; the build was green and the page threw. A green build is not evidence here — this is.
 */
import { renderToString } from 'react-dom/server';
import { App } from './src/App';

const html = renderToString(<App />);

const MUST_CONTAIN = [
  'Base Blue-Chip 5', // a vault name from the fixtures
  'Meridian', // its operator
  'Proposal #', // the proposal panel rendered
  'of eligible stake revealed', // quorumReadout.text, not a reassembled sentence
  'Reveal closes', // proposalPhase.deadlineLabel — the field that was wrong
  'WETH', // a basket leg
  'Idle USDC', // the idle row
];

const missing = MUST_CONTAIN.filter((s) => !html.includes(s));
if (missing.length > 0) {
  console.error(`smoke FAILED — rendered ${html.length} bytes but these never appeared:`);
  for (const m of missing) console.error(`  - ${m}`);
  process.exit(1);
}

console.log(`smoke: App rendered ${html.length} bytes, all ${MUST_CONTAIN.length} checks present`);
