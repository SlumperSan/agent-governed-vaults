/**
 * agents-hero — the hero of agents.html, and that page's one <h1>.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SECTION OWES THE PAGE
 * ---------------------------------------------------------------------------
 *   - the page's ONE <h1>. `PageShell` deliberately carries none, so until this
 *     renders, dist/agents.html fails the exactly-one-h1 check;
 *   - the three links out of the page: llms.txt, the address ledger, and the
 *     repository.
 *
 * ---------------------------------------------------------------------------
 * COPY PROVENANCE
 * ---------------------------------------------------------------------------
 * The owner rewrote agents.html to drop the x402 / metered-read-API / free
 * discovery-call framing entirely. The page is now built around llms.txt, the
 * address ledger (contracts/config/deployments/robinhood-mainnet.json), ABIs
 * read out of contracts/out/, and permissionless deposit/propose/vote/exit —
 * contract calls on Robinhood Chain mainnet, chain id 4663. Every string below
 * is carried over from that rewrite. Nothing was rewritten, tightened or
 * re-punctuated here, and no sentence was composed for this build.
 *
 * The former LEDE_NOTE ("This describes source code and a published
 * interface. Nothing is deployed to mainnet...") has no counterpart in the
 * rewrite and is dropped rather than carried forward: the rewrite is written
 * for a protocol that is live on Robinhood Chain mainnet, so a sentence
 * asserting nothing is deployed to mainnet would now be false. See the task
 * report for the sibling exemption fragments this same rewrite retires.
 *
 * ---------------------------------------------------------------------------
 * ESCAPING — CHECKED PER STRING, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * `renderToString` escapes `'`, `&`, `<`, `>` and `"` in text children, and a
 * guard doing `html.includes(SENTENCE)` against the raw file fails on an
 * escaped apostrophe that looks perfect in a browser. That is why pinned prose
 * elsewhere on the site goes through `<Pinned>`.
 *
 * The hero block is pure ASCII and contains none of those five characters, so
 * plain JSX text children reach dist/agents.html byte-for-byte and `<Pinned>`
 * would add nothing but an opportunity to write raw HTML.
 *
 * ---------------------------------------------------------------------------
 * NO CANVAS, AND THAT IS THE SPEC RATHER THAN A SHORTFALL
 * ---------------------------------------------------------------------------
 * The build brief gives the one WebGL field and the one scroll timeline to
 * index.html — "the only page carrying a canvas" — and gives the six deep
 * pages "a restrained typographic hero (no canvas, no pin, no parallax)". This
 * section's own motion line reads "Text enter only … A monospace caret blink on
 * the eyebrow is permitted; nothing else." sections/hiw-hero and
 * sections/ops-hero both arrived at the same reading and say so in their
 * headers.
 *
 * Two reasons, and both bite here specifically. There is nothing true for a
 * field on this page to render: this section fetches no chain state at
 * render time, so any drawn state would be invented rather than fetched, and
 * this is the page an autonomous integrator reads. And the six deep pages
 * must not carry a three.js chunk — the shared initial-JS ceiling is 180 KB
 * gzip, React alone is 60.6 KB of it, and a page whose whole job is to be
 * read by a machine should be the lightest on the site rather than the
 * heaviest.
 *
 * ---------------------------------------------------------------------------
 * MOTION
 * ---------------------------------------------------------------------------
 * Opacity and an eight-pixel rise, 0.6s on the shared enter curve, staggered
 * 80ms, plus the finite caret blink — all of it in AgentsHero.module.css, with
 * an explicit reduced-motion branch. Not `<Reveal>`: that primitive returns
 * early for anything already on screen, which a hero always is. See the
 * stylesheet header for the caret's timing and why its resting state is solid.
 */
import type { JSX } from 'react';
import { REPO_URL } from '../../shell/pinned';
import { Backdrop } from '../../assets/Backdrop';
import s from './AgentsHero.module.css';

/* --- copy, verbatim from the .hero block of the rewritten agents.html ----- */

const EYEBROW = 'The machine-readable path';

const TITLE = 'Every page here is for a person. This one is not.';

// REPOINTED 2026-09-05, copy deck v2: gains a first sentence, "The hive is
// permissionless. Stake and you are in." Rest of the lede unchanged.
const LEDE =
  'The hive is permissionless. Stake and you are in. An agent does not need the rest of this site. It needs the chain id, the contract addresses, and an ABI. That is the whole integration surface. There is no key to request, no allowlist to join, and no gateway between an agent and a vault.';

/**
 * The three links, with the labels and hrefs the rewritten agents.html
 * carries.
 *
 * `llms.txt` is RELATIVE and stays relative. It resolves to public/llms.txt,
 * which is pinned byte-identical to the repository-root copy, and it is the
 * primary link because it is the one call an agent makes before any other.
 *
 * `status.html` is "The address ledger" — the page carrying the deployed
 * addresses. The repository link is built from `REPO_URL` rather than typed
 * out, so the origin has one definition on the site.
 */
const ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: true }> = [
  { href: 'llms.txt', label: 'llms.txt', primary: true },
  { href: 'status.html', label: 'The address ledger' },
  { href: REPO_URL, label: 'Contracts and docs' },
];

export function AgentsHero(): JSX.Element {
  // A <div> rather than a <section>, matching hiw-hero and ops-hero. A section
  // is a landmark and a landmark wants an accessible name, which would be
  // either an aria-label — a string that exists nowhere in the reviewed source
  // — or the <h1>, which already names the page through <main>. The brief
  // permits landmark labels as new copy; the two sibling heroes declined for a
  // stated reason, and a third answer to the same question is worse than
  // consistency.
  return (
    <div className={s.hero}>
      <Backdrop slot="agents" />
      <div className="wrap">
        <p className={s.eyebrow}>{EYEBROW}</p>
        <h1 className={s.title}>{TITLE}</h1>
        <p className={s.lede}>{LEDE}</p>

        <div className={s.actions}>
          {ACTIONS.map((a) => (
            <a
              key={a.href}
              className={a.primary ? `${s.action} ${s.actionPrimary}` : s.action}
              href={a.href}
            >
              {a.label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

export default AgentsHero;
