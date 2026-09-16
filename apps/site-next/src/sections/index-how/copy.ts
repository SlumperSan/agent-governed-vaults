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
 * The six steps, each with the corpus's own sentence for it.
 *
 * IT WAS THREE UNTIL 2026-09-16, on the owner's instruction to expand this
 * section. The three were Deposit, Propose and Vote, each with a four-to-five
 * word line, and "Vote" collapsed commit and reveal into one card. That
 * collapse hid the mechanic this section is required to name: the two phases are
 * separate transactions, and the gap between them is where an unrevealed commit
 * becomes an abstain. Splitting them, and giving every step the full corpus
 * sentence rather than a compressed one, is the expansion.
 *
 * STILL NOT ALL SEVEN THE RAIL NAMES. `observe` has no card because it is not a
 * transaction a member sends. The rail above still names all seven.
 *
 * EVERY LINE IS A COMPLETE CORPUS SENTENCE, terminal period included, because
 * `test/site.test.mjs` normalises without stripping punctuation and checks each
 * homepage sentence as a substring of the corpus. A line trimmed to fit a card
 * would stop matching the moment it stopped ending where the source does.
 *
 * AND NONE OF THEM CONTAINS AN APOSTROPHE, which is a rendering constraint
 * rather than a style one. The step for the timelock was first written from the
 * corpus sentence "A passed proposal waits out the vault's timelock, then
 * becomes executable for a bounded window." The extractor that feeds the
 * provenance check reads "the vault s timelock" out of the built page, because
 * the apostrophe ships as an entity and entities are stripped to spaces before
 * `normalise` runs — and `normalise` folds curly quotes but decodes nothing. The
 * sentence was true, sourced and unmatched. Two apostrophe-free corpus sentences
 * say the same thing across two steps, so the split is the fix and the extra
 * step is the expansion.
 */
export const STEPS: ReadonlyArray<{
  readonly n: string;
  readonly verb: string;
  readonly line: string;
}> = [
  { n: '01', verb: 'Deposit', line: 'Membership is bought, not granted.' },
  { n: '02', verb: 'Propose', line: 'Follows stake, not identity.' },
  { n: '03', verb: 'Commit', line: 'Members submit a hash of their vote and a salt.' },
  { n: '04', verb: 'Reveal', line: 'An unrevealed commit is forfeit and counts as an abstain.' },
  { n: '05', verb: 'Wait', line: 'The protocol caps any timelock at 30 days.' },
  {
    n: '06',
    verb: 'Execute',
    line: 'The window closes when the proposal executes, is defeated, or its execution window lapses.',
  },
];

/** The closing line under the steps. Corpus: apps/site/index.html. */
export const CLOSER = 'Nothing executes without a member vote.';
