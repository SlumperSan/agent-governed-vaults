/**
 * <Pinned> — render a pinned sentence as the exact bytes the guards read.
 *
 * WHY THIS EXISTS. React escapes text children: an apostrophe becomes `&#x27;`
 * and an ampersand becomes `&amp;` in the prerendered HTML. Every guard in
 * `apps/site/test/site.test.mjs` checks `html.includes(THE_SENTENCE)` against
 * the raw file, so an escaped apostrophe is a failed check on a sentence that
 * looks perfect in the browser — the worst kind of failure to debug, because
 * the page is visibly correct.
 *
 * This component writes the stored bytes straight onto the semantic element.
 * There is no wrapper: `<Pinned as="p">` renders one `<p>` and nothing else,
 * because a guard that matches `<p class="tight">SENTENCE</p>` would not match
 * a sentence nested one element deeper.
 *
 * WHAT MAY BE PASSED AS `html`. Only a constant from `src/shell/pinned.ts`, or
 * a section's own reviewed copy held as HTML source bytes in that section's
 * directory. Never a runtime value, never anything assembled from input: there
 * is no input on this site, and the day there is, this component is the first
 * place a reviewer will look.
 *
 * HYDRATION. React does not attempt to reconcile the children of an element
 * carrying `dangerouslySetInnerHTML`, so the prerendered bytes survive
 * hydration untouched. That is the second reason to use it here rather than
 * splitting pinned prose into JSX fragments.
 */
import type { JSX } from 'react';

type PinnedElement = 'p' | 'dd' | 'dt' | 'li' | 'span' | 'h2' | 'h3' | 'caption' | 'div' | 'td';

export function Pinned({
  as = 'p',
  html,
  className,
  id,
}: {
  /** The semantic element the sentence belongs in. Defaults to a paragraph. */
  as?: PinnedElement;
  /** HTML source bytes — see pinned.ts for why these are bytes and not text. */
  html: string;
  className?: string;
  id?: string;
}): JSX.Element {
  const Tag = as;
  return <Tag id={id} className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}
