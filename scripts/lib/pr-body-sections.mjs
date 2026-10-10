// @ts-check
/**
 * Card 190 / Chairman directive 13. Extract and grade the two PR-body sections a `feat/` PR must
 * carry: `## Buy / borrow / build` and `## Standards`. The skeleton both `/dept-engineering` and
 * `/dept-security` post into a new PR body looks like this:
 *
 *     ## Buy / borrow / build
 *     - **Searched:** <what you grepped in this repo, and what you found or did not>
 *     - **Existing options:** <library, standard, or upstream contract - with a link - or "none found">
 *     - **Why we built:** <the reason the existing option does not fit, in one sentence>
 *     - **If vendored:** <what it pulls in, what runs at install, whether it phones anywhere>
 *
 *     ## Standards
 *     - **Conforms to:** <ERC / EIP / RFC / OpenZeppelin pattern, with the section> or **"none applies"**
 *     - **Deviates:** <where and why, or "no deviation">
 *
 * "None found" is a real answer and must pass; a missing section or one nobody has filled in reads
 * identically to a real search in a diff, and that is the failure this rule exists to stop.
 *
 * These are pure functions over a PR body string, independent of `gh` — see
 * `scripts/lib/verdicts.mjs`'s `buy-borrow-build-declared` rule for how they are wired into the
 * merge decision, and `scripts/lib/merge-policy.json` for why the requirement exists.
 */

/**
 * The two required sections, matched loosely on wording (spacing and slashes vary: "Buy / borrow /
 * build" vs "Buy/borrow/build") but not on the words themselves — a section named anything else is
 * not this section.
 * @type {{id: string, label: string, heading: RegExp}[]}
 */
export const BBB_SECTIONS = [
  { id: 'buy-borrow-build', label: 'Buy / borrow / build', heading: /^##\s*Buy\s*\/\s*borrow\s*\/\s*build\s*$/i },
  { id: 'standards', label: 'Standards', heading: /^##\s*Standards\s*$/i },
];

/**
 * The text under a `## <heading>` line, up to the next level-1-or-2 heading or the end of the body.
 * `null` when the heading is not present at all — a MISSING section, distinct from a present but
 * BLANK one, because the two are reported with different detail.
 * @param {string} body
 * @param {RegExp} headingRe tested against one line at a time
 * @returns {string | null}
 */
export function extractSection(body, headingRe) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{1,2}\s+\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

const HTML_COMMENT = /<!--[\s\S]*?-->/g;

/**
 * A single unfilled template token, and nothing else — the shape both skeletons above use for a
 * field nobody has filled in yet ("<what you grepped ...>"), or the handful of generic stand-ins an
 * author reaches for instead of writing one ("TBD", "TODO", "N/A", ...). Matched only when it is the
 * WHOLE remaining content: a section that names its own search plus a leftover placeholder
 * elsewhere is real content, not this shape, and passes.
 */
const WHOLE_SECTION_PLACEHOLDER = /^(?:<[^<>]*>|\[[^[\]]*\]|TBD|TODO|N\/A|FILL[\s-]?IN|PLACEHOLDER|XXX)$/i;

/**
 * Whether a section's content is BLANK: only whitespace, only an HTML comment (or several), or
 * nothing but one unfilled placeholder token. `"None found"` and any other real prose are NOT this
 * shape and return `false` — that distinction is the whole guard (card 190).
 * @param {string} text
 * @returns {boolean}
 */
export function isBlankSection(text) {
  const stripped = String(text ?? '').replace(HTML_COMMENT, ' ').trim();
  if (stripped === '') return true;
  return WHOLE_SECTION_PLACEHOLDER.test(stripped);
}

/**
 * Grade a PR body against both required sections.
 * @param {string} body
 * @returns {{id: string, label: string, state: 'ok' | 'missing' | 'blank'}[]}
 */
export function gradeSections(body) {
  return BBB_SECTIONS.map(({ id, label, heading }) => {
    const section = extractSection(body, heading);
    if (section === null) return { id, label, state: /** @type {const} */ ('missing') };
    if (isBlankSection(section)) return { id, label, state: /** @type {const} */ ('blank') };
    return { id, label, state: /** @type {const} */ ('ok') };
  });
}
