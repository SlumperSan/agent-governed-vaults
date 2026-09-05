/**
 * risks-verify — "How to check every claim on this page."
 *
 * Source passage: `apps/site/disclaimers.html`, the last section on the page,
 * whose eyebrow is "Do not take this page's word for it" (grep `How to check
 * every claim on this page`). Every string below is carried byte-for-byte.
 * Nothing here was written for this build, nothing was tightened, and nothing
 * was re-punctuated — which for this section is not merely the house rule but
 * the section's own subject: a page that tells a reader to go and check the
 * repository cannot afford to paraphrase what the repository says.
 *
 * CHANGED 2026-09-05: the h2 was "How to check this yourself."; the corpus now
 * says "How to check every claim on this page." A sixth reference entry was
 * added (the deployment record, `contracts/config/deployments/robinhood-mainnet.json`)
 * between the reference-configuration entry and the contracts entry, and the
 * section gained a closing actions block (three buttons) that did not exist
 * before — carried across here rather than left off.
 *
 * NOT CARRIED HERE: the corpus's "The limits of every claim on this site"
 * section — the one immediately BEFORE this one in document order, headed
 * "What the other seven pages leave out." — has no counterpart anywhere in
 * this redesign's disclaimers.html sections. It is a large block: a
 * seventeen-entry `<dl>` restating a caveat from each of the other seven pages
 * (grep `Immutability, read the other way` for its start), followed by a
 * "Four groups this is wrong for" four-item grid. Per the build brief, no new
 * component is invented for it here; it is reported as a corpus-only block
 * with no redesign counterpart.
 *
 * NO MOTION. The brief's motion line for this section is "None." — so there is
 * no `Reveal`, no effect and no `useReducedMotion` call in this file. The
 * prerendered markup is the finished section for every reader, which makes the
 * reduced-motion state and the JavaScript-unavailable state the same state as
 * the ordinary one. That is the strongest form of the "static branch"
 * obligation rather than an exemption from it.
 *
 * WHY EVERY TERM AND BODY GOES THROUGH <Pinned>. `renderToString` escapes text
 * children, so `the operator's share` becomes `the operator&#x27;s share` in
 * `dist/risks.html`, and every `<code>` element in a term would arrive as
 * `&lt;code&gt;`. Three cells here contain an apostrophe or an element today;
 * all eleven strings are rendered as HTML source bytes anyway, so that a later
 * edit introducing an apostrophe cannot break a guard silently on a page that
 * still looks perfect in the browser.
 *
 * THE SIX PATHS, VERIFIED RATHER THAN ASSERTED. This section states no
 * figure — there is no number in the passage that a contract could contradict —
 * so the citation obligation lands on the paths and the finding identifiers
 * instead. Every one of these files exists at `protocol/main` except the
 * deployment record, which lands separately (see status.html and the note on
 * BANNER_STATUS in src/shell/pinned.ts), and every identifier the prose
 * attributes to a document is present in that document:
 *
 *   docs/LAUNCH-READINESS.md §4      "## 4. Residual-risk register — what can
 *                                    go wrong, worst case, why we ship anyway"
 *                                    (LAUNCH-READINESS.md:207).
 *   docs/THREAT-MODEL.md             K-4, CM-2, CM-4, CM-7, EE-9, EE-10, EX-2
 *                                    and VO-7 all present.
 *   docs/audit/AI-AUDIT-REPORT.md    H-8, M-7, M-8, M-10 and M-15 all present.
 *   contracts/config/robinhood-mainnet.json   the reference configuration for
 *                                    Robinhood Chain mainnet, chain id 4663.
 *   contracts/config/deployments/robinhood-mainnet.json   the address ledger
 *                                    status.html reads out; see that page's
 *                                    own build brief for its own checkout
 *                                    caveat.
 *   contracts/src/VaultCore.sol      exists.
 *   contracts/src/Governance.sol     exists.
 *
 * TWO SENTENCES THAT ARE LOAD-BEARING EXACTLY AS WRITTEN, and that a tightening
 * pass would turn into claims violations:
 *
 *   1. The threat-model body says "the operator's share of the exit fee". The
 *      banned shape is "no share of the exit fee" (site.test.mjs:639) — the
 *      operator's mandatory 5% collects the retained fee through share value,
 *      so the negative form is false. The possessive is what keeps this
 *      sentence on the right side of that line.
 *   2. The audit-report body says "the open High at the launch configuration",
 *      NOT "remains open at the launch configuration". The latter is a pinned
 *      shape (site.test.mjs OPEN_HIGH_CLAIM) that obliges "purchasable member
 *      count" or "H-8" to sit in the SAME sentence. This cell happens to name
 *      H-8 anyway, but rewriting toward "remains open" would manufacture an
 *      obligation this passage was never written to carry.
 */
import type { JSX } from 'react';
import { Pinned } from '../../shell/PinnedText';
import { REPO_URL } from '../../shell/pinned';
import s from './RisksVerify.module.css';

/**
 * The closing actions row. Added 2026-09-05 — the corpus's disclaimers.html
 * closes this section with three buttons, verbatim: "The address ledger"
 * (primary, to status.html — the page that actually publishes addresses),
 * "The mechanism" (how-it-works.html) and "Read the code yourself" (the
 * repository).
 */
const ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: boolean }> = [
  { href: 'status.html', label: 'The address ledger', primary: true },
  { href: 'how-it-works.html', label: 'The mechanism' },
  { href: REPO_URL, label: 'Read the code yourself' },
];

/**
 * Verbatim from the corpus's disclaimers.html footer: `<p class="small">You are reading the
 * <a href="disclaimers.html">Disclaimers</a>.</p>`. See the note above where this renders for why
 * it moved out of the footer.
 */
const SELF_REFERENCE = 'You are reading the <a href="disclaimers.html">Disclaimers</a>.';

/* --- the heading block, as HTML source bytes ------------------------------ */

/** Carries an apostrophe; see the note on <Pinned> above. */
const EYEBROW = 'Do not take this page\'s word for it';

const HEADING = 'How to check every claim on this page.';

const LEDE =
  'Every entry above is recorded somewhere in the repository, usually in harsher terms than here. File paths rather than links, so they stay valid as the repository moves.';

/* --- the five references, as HTML source bytes ---------------------------- */

/**
 * `term` carries its own `<code>` elements because the source does: the path is
 * an identifier a reader types into a repository, not prose about one. The
 * section-mark suffix on the first term sits outside the element for the same
 * reason it does in the source — `§4` is a location within the file, not part
 * of its name.
 */
const REFERENCES: ReadonlyArray<{ key: string; term: string; body: string }> = [
  {
    key: 'launch-readiness',
    term: '<code>docs/LAUNCH-READINESS.md</code> §4',
    body:
      'The residual-risk register, including the curation-immobility row behind risks 2 and 15, and the record of which findings are closed by launch configuration rather than by code.',
  },
  {
    key: 'threat-model',
    term: '<code>docs/THREAT-MODEL.md</code>',
    body:
      'K-4, CM-2, CM-4, CM-7, EE-9, EE-10, EX-2 and VO-7: the high-water-mark reset, the operator\'s share of the exit fee, the readable mid-reveal tally, and the execution-slippage bound.',
  },
  {
    key: 'ai-audit-report',
    term: '<code>docs/audit/AI-AUDIT-REPORT.md</code>',
    body:
      'H-8, M-7, M-8, M-10 and M-15: the open High at the launch configuration, the Mode-F recurrence, the opaque proposal payload, and the missing exit-side slippage floor.',
  },
  {
    key: 'base-mainnet-config',
    term: '<code>contracts/config/robinhood-mainnet.json</code>',
    body:
      'Every reference value quoted on this site: the governance durations, the quorum and threshold, the minimum deposit, the exit-fee schedule, the staleness bounds and the two price bands.',
  },
  {
    key: 'deployment-record',
    term: '<code>contracts/config/deployments/robinhood-mainnet.json</code>',
    body:
      'The address ledger for chain 4663, plus the note recording how each value was read back on-chain rather than transcribed from a deploy log.',
  },
  {
    key: 'contracts',
    term:
      '<code>contracts/src/VaultCore.sol</code> and <code>contracts/src/Governance.sol</code>',
    body:
      'The mechanisms themselves: the immutable oracle reference, the creator gate, the exit queue and its trigger condition, and the rebalance slippage constant.',
  },
];

export function RisksVerify(): JSX.Element {
  return (
    <section className={s.section} aria-labelledby="verify-heading">
      <div className="wrap">
        <Pinned as="p" className={s.eyebrow} html={EYEBROW} />
        <h2 id="verify-heading" className={s.heading}>
          {HEADING}
        </h2>
        <Pinned as="p" className={s.lede} html={LEDE} />

        <dl className={s.rows}>
          {REFERENCES.map((ref) => (
            <div key={ref.key} className={s.row}>
              <Pinned as="dt" className={s.term} html={ref.term} />
              <Pinned as="dd" className={s.body} html={ref.body} />
            </div>
          ))}
        </dl>

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

        {/*
          THE PAGE'S OWN SELF-REFERENCE. Every OTHER page's footer closes with "Read the
          Disclaimers." linking here; the corpus's disclaimers.html footer closes with this exact
          self-referential form instead — "You are reading the Disclaimers." — because a reader
          already on the page does not need to be told to go somewhere.
          `src/shell/Footer.tsx` cannot render this: it is a single shared component whose Pages-list
          filter drops the current page for every page except status.html (a pre-existing special
          case written before this page existed), so disclaimers.html gets no self-link from the
          footer at all. Rather than edit that frozen file, the self-reference — and the literal
          href="disclaimers.html" a reader's own page should carry — lives here instead, as the
          close of the page's last content section.
        */}
        <Pinned as="p" className={s.selfRef} html={SELF_REFERENCE} />
      </div>
    </section>
  );
}

export default RisksVerify;
