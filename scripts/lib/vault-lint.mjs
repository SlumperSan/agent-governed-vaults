// @ts-check
/**
 * `Tasks/*.md` corruption checks — card 135's post-mortem, made mechanical.
 *
 * WHAT THIS IS NOT. Directive 6 (`Chairman-directives-2026-09-19.md`) asked for a broader vault
 * lint: every note has `type`/`date`/`summary`, every `Rules/*.md` is indexed in `RULES.md`, every
 * `[[wikilink]]` resolves, alongside the closed vocabularies. This file is card 189's narrower,
 * MEASURED scope only: the three corruption checks that found card 135, plus the `owner` free-text
 * carve-out `[[Task vocabularies are closed sets 2026-09-19]]` requires. The broader checks are a
 * separate, larger piece of work — not started here, and this file's existence should not be read
 * as directive 6 being closed.
 *
 * WHY THREE NARROW RULES INSTEAD OF ONE WIDE ONE. A first draft tested every character shape
 * ("contains a source path", "contains an unbalanced quote") against every frontmatter value in
 * every field. Measured against the real corpus (198 cards): 26 hits, 22 false — `title:` and
 * `note:` are prose and legitimately carry file paths, backticks and quoted claims (`title:
 * \`scripts/vault-lint.mjs\`` is this very card), and testing the RAW value instead of the
 * quote-stripped one added 23 more false positives from ordinary `plan_item: "0.1"` fields.
 * Scoping to identity/closed-set fields and stripping matching quotes first took it to what ships
 * here: 4 hits, all 4 genuinely corrupt, zero false positives. **Do not widen this back** without
 * re-measuring against the corpus the same way.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

/** The only fields a shell-quoting accident could plausibly land in: identity and closed-set
 *  scalars. `title` and `note` (and everything else in the body) are prose and are NOT scoped --
 *  they legitimately carry backticks, quotes and file paths. */
export const SCOPED_FIELDS = Object.freeze([
  'num', 'type', 'status', 'priority', 'department', 'owner', 'phase', 'plan_item', 'updated', 'created',
]);

/** `Tasks/` status and priority are closed sets — [[Task vocabularies are closed sets 2026-09-19]]. */
export const STATUS_SET = Object.freeze(['backlog', 'doing', 'review', 'done', 'goal', 'suggestion']);
export const PRIORITY_SET = Object.freeze(['critical', 'high', 'medium', 'low']);
/** `department` is single-valued and closed on the `Departments.md` roster, `Tech` being the board
 *  label for CTO/Engineering. `owner` shares this set but keeps a free-text tail (see `lintOwner`). */
export const DEPARTMENT_SET = Object.freeze([
  'Chairman', 'CEO', 'Tech', 'Product', 'Security', 'Design', 'Marketing', 'Finance', 'Legal', 'BD', 'Data', 'Owner',
]);

/**
 * Extract the frontmatter block's `key: value` lines, RAW -- no quote-stripping, no list parsing.
 * Deliberately not `scripts/lib/project-status.mjs`'s `frontmatter()`: that one strips a leading
 * and trailing quote independently of whether they MATCH, which is exactly the imprecision this
 * lint cannot afford (a value opening with `"` and ending on an unrelated `'` inside a shell
 * fragment must still register as suspicious). Only the FIRST occurrence of each key is read,
 * matching the migration script's own convention -- a later line in the body is prose, not a field.
 */
export function frontmatterLines(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    if (key in out) continue; // first occurrence wins
    out[key] = kv[2];
  }
  return out;
}

/** Strip a leading and trailing quote ONLY when they match (both `"` or both `'`). An unmatched
 *  pair is left in place -- it is itself evidence for the unbalanced-quote check below. */
function stripMatchingQuotes(v) {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
}

const PATH_LIKE = /^scripts\/|\.mjs$/;

/**
 * Rule 1 — a scoped field carrying a shell fragment rather than a value.
 * Returns the reason string, or null if the value is clean.
 */
export function shellFragmentReason(rawValue) {
  const v = stripMatchingQuotes(rawValue.trim());
  if (v.endsWith('\\')) return 'ends in a backslash';
  if (v.includes('`')) return 'contains a backtick';
  // DOUBLE quotes only. A single quote is an apostrophe in ordinary English at least as often as
  // it is a shell quote -- "Owner's call on timing" is real content from the live corpus and was
  // the one false positive this rule produced before this narrowing (measured, not argued: run
  // `node scripts/vault-lint.mjs` against the vault and it is the only FAIL this rule ever gave).
  // A literal `"` inside a scoped field has no such legitimate use and stays a strong signal.
  const dq = (v.match(/"/g) ?? []).length;
  if (dq % 2 !== 0) return 'contains an unbalanced double quote';
  if (v.includes('$(')) return 'contains a command substitution ($()';
  if (v.includes('&&')) return 'contains a shell AND (&&)';
  if (v.includes('||')) return 'contains a shell OR (||)';
  if (v.includes('>')) return 'contains a redirection (>)';
  if (PATH_LIKE.test(v)) return 'names a source path where a seat, a date or an index belongs';
  return null;
}

/**
 * Lint one card's parsed frontmatter. Returns `{ fails: string[], warns: string[] }`.
 */
export function lintCard(fm) {
  const fails = [];
  const warns = [];

  for (const field of SCOPED_FIELDS) {
    if (!(field in fm)) continue;
    const reason = shellFragmentReason(fm[field]);
    if (reason) fails.push(`${field}: ${reason} (value: ${JSON.stringify(fm[field])})`);
  }

  if ('status' in fm) {
    const v = stripMatchingQuotes(fm.status.trim());
    if (!STATUS_SET.includes(v)) fails.push(`status: "${v}" is not in the closed set (${STATUS_SET.join(' | ')})`);
  }
  if ('priority' in fm) {
    const v = stripMatchingQuotes(fm.priority.trim());
    if (!PRIORITY_SET.includes(v)) fails.push(`priority: "${v}" is not in the closed set (${PRIORITY_SET.join(' | ')})`);
  }
  if ('department' in fm) {
    const v = stripMatchingQuotes(fm.department.trim());
    if (!DEPARTMENT_SET.includes(v)) fails.push(`department: "${v}" is not in the closed set (${DEPARTMENT_SET.join(' | ')})`);
  }
  // `owner` shares department's set but keeps a genuine free-text tail (14 shared-ownership
  // cards) -- [[Task vocabularies are closed sets 2026-09-19]] is explicit that failing those
  // would force a reclassification the vocabulary decision forbids. Warn only.
  if ('owner' in fm) {
    const v = stripMatchingQuotes(fm.owner.trim());
    if (v && !DEPARTMENT_SET.includes(v)) warns.push(`owner: "${v}" is free text, not in the closed set -- confirm this card is genuinely shared`);
  }

  return { fails, warns };
}

/**
 * Rule 3 — an odd backtick count in the body is the cheapest detector of a card truncated
 * mid-sentence on an unterminated inline code span. Deliberately a raw character count, not a
 * markdown parser: a fenced block's paired ``` delimiters and a paired inline `code` span both
 * contribute an EVEN number of backtick characters, so the total stays even unless something is
 * actually unterminated. Measured clean against the real corpus at this width; do not "improve"
 * it into parsing markdown without re-measuring.
 */
export function bodyBacktickOdd(text) {
  const end = text.indexOf('\n---', 3);
  const body = end === -1 ? '' : text.slice(end + 4);
  const count = (body.match(/`/g) ?? []).length;
  return count % 2 !== 0;
}

/**
 * Lint every `.md` file directly under `<vaultRoot>/Tasks`. Throws if the Tasks folder is missing
 * or holds no `.md` files -- a floor that can pass on zero input is not a floor. Does NOT throw if
 * `vaultRoot` itself is absent; that is a distinct, expected case (this vault is a local machine
 * path with nothing at it in CI) and is the caller's `--vault-missing-is-ok` decision, not this
 * function's.
 */
export function lintVault(vaultRoot) {
  const tasksDir = path.join(vaultRoot, 'Tasks');
  if (!existsSync(tasksDir)) {
    throw new Error(`no Tasks folder at ${tasksDir} -- the lint has nothing to check`);
  }
  const files = readdirSync(tasksDir).filter((f) => f.endsWith('.md') && statSync(path.join(tasksDir, f)).isFile());
  if (files.length === 0) {
    throw new Error(`${tasksDir} holds no .md files -- an empty floor is not a pass`);
  }

  /** @type {{file: string, fails: string[], warns: string[]}[]} */
  const results = [];
  for (const f of files.sort()) {
    const full = path.join(tasksDir, f);
    const text = readFileSync(full, 'utf8');
    const fm = frontmatterLines(text);
    if (!fm) {
      results.push({ file: f, fails: ['no frontmatter block found'], warns: [] });
      continue;
    }
    const { fails, warns } = lintCard(fm);
    if (bodyBacktickOdd(text)) {
      fails.push('body has an odd backtick count -- looks like a card truncated on an unterminated inline code span');
    }
    if (fails.length || warns.length) results.push({ file: f, fails, warns });
  }
  return results;
}
