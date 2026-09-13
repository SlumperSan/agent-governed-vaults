/**
 * How it works, in three steps. Every string is corpus-verbatim.
 *
 * THE NUMBERING IS EARNED HERE, WHICH IS NOT TRUE OF MOST PLACES IT APPEARS. A
 * 01 / 02 / 03 rail is one of the most over-used structural devices on the web
 * and it is usually decoration: three things that happen to be three, dressed as
 * a sequence. This is an actual sequence, and the corpus says so in its own
 * words. `apps/site/how-it-works.html` opens with "Deposit, observe, propose,
 * commit, reveal, wait, execute." and titles the section below it "One
 * rebalance, start to finish." The order is enforced by the contracts: you
 * cannot propose without stake you got by depositing, and you cannot reveal a
 * vote you did not commit. So the numbers carry information a reader needs, and
 * they stay.
 *
 * THREE STEPS RATHER THAN THE SEVEN THE RAIL NAMES. The rail is the full
 * lifecycle and it is rendered in full, because compressing it would be the one
 * place this page understated what is involved. The three cards under it are the
 * three a reader has to DO something in; observe, wait and execute happen to
 * them rather than by them. The brief asks for three, the corpus supports three,
 * and the seven are still on the page above them.
 *
 * WHERE EACH LINE COMES FROM. All five strings below are in
 * `apps/site/agents.html`, in its "What an agent can and cannot do" table, where
 * they are the summary line under each verb. They are the shortest true
 * statement of each step that exists anywhere in the corpus, which is exactly
 * what a card of this size needs.
 */

/** The eyebrow, and the label the header nav and the hero button both use. */
export const EYEBROW = 'How it works';

/** Corpus: apps/site/how-it-works.html, the "Lifecycle" heading. */
export const HEADING = 'One rebalance, start to finish.';

/** Corpus: apps/site/how-it-works.html, the "Mechanism" lede. All seven. */
export const RAIL = 'Deposit, observe, propose, commit, reveal, wait, execute.';

/**
 * The three steps.
 *
 * `Commit, then reveal.` is the third, and it names commit-reveal because the
 * brief requires this section to name it and because it is the step that
 * surprises people: an unrevealed commit is forfeit and counts as an abstain.
 * The full consequence is on the Disclaimers page, which is where every warning,
 * limit and unresolved question was consolidated on 2026-09-05.
 */
export const STEPS: ReadonlyArray<{
  readonly n: string;
  readonly verb: string;
  readonly line: string;
}> = [
  { n: '01', verb: 'Deposit', line: 'Membership is bought, not granted.' },
  { n: '02', verb: 'Propose', line: 'Follows stake, not identity.' },
  { n: '03', verb: 'Vote', line: 'Commit, then reveal.' },
];
