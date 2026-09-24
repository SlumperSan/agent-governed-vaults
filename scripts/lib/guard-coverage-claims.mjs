/**
 * A CLAIM ABOUT A GUARD is a different thing from the guard itself, and nothing checked the claim.
 *
 * Five vault notes said `claims-lede-truth.test.mjs enforces the vote/trade claims`. It never has —
 * `scripts/test/claims-lede-truth.test.mjs` covers who-does-what, weighting, stake-blindness, the
 * deposit gate and RWLY attribution; none of its eleven tests mention a vote or a trade shape. The
 * false belief survived because it read fine on its own and nobody re-derived it from the suite's
 * source before repeating it (see `Rules/fix-the-source-not-only-the-consumer.md`).
 *
 * Card 45, scoped by Security on 2026-09-23. Deliberately narrow, so it cannot cry wolf on the
 * paraphrases that actually shipped the defect ("enforces the vote/trade claims" with no quoted
 * token, "covers none of the three", "covers who-does-what, weighting, the ..."). Widening this to
 * match those shapes is `claims-lede-truth.test.mjs`'s own job (matching SHAPE, not phrasing) — this
 * file exists to check a NARROWER, MECHANICAL claim: a sentence that names a suite, a coverage verb
 * and a specific quoted token, resolved against that suite's actual source.
 *
 * PARSED FORM, EXACTLY: `<file>.test.mjs (enforces|covers|pins|guards) <quoted token>`, where the
 * token is immediately after the verb (only whitespace between them) and is wrapped in backticks or
 * double quotes. `<file>.test.mjs` may itself be backtick-wrapped. Anything looser — a verb followed
 * by prose instead of a token, a token separated from the verb by other words, a bare mention of a
 * suite with no coverage verb — is not this claim shape and is not parsed. A run of tokens joined by
 * `/`, `,` or `and` right after the verb ("pins `MIN_HEARTBEAT`/`MAX_HEARTBEAT`") is one claim with
 * several tokens, each checked independently.
 *
 * RED WHEN: the named suite does not exist in this repository, or the quoted token does not appear
 * anywhere in that suite's source text. A bare basename that matches more than one suite on disk is
 * also red — an ambiguous citation cannot be verified, and reporting nothing would be exactly the
 * silent-pass failure this file exists to close.
 *
 * The parsing and the checking are pure functions (`parseClaims`, `evaluateClaims`), independent of
 * the filesystem, so the mutation bar can run entirely in memory: a synthetic suite index proves the
 * guard catches an absent token and a nonexistent suite, and stops catching once the token is added —
 * without touching a real suite file to do it. The test file wires these to the real repo and vault.
 */

/** A repo-relative, slash-separated path. */
export const toSlash = (p) => p.split('\\').join('/');

/**
 * One quoted-token group immediately after a coverage verb: a run of backtick- or double-quoted
 * spans joined by `/`, `,` or `and`, with no other separator allowed — a looser join is not this
 * claim shape.
 */
const TOKEN_GROUP = '(?:`[^`\\n]{1,160}`|"[^"\\n]{1,160}")(?:\\s*(?:/|,|and)\\s*(?:`[^`\\n]{1,160}`|"[^"\\n]{1,160}"))*';

/**
 * `<file>.test.mjs (enforces|covers|pins|guards) <quoted token>[/<quoted token>...]`, with the
 * suite name optionally backtick-wrapped and exactly one run of whitespace between each part. This
 * is deliberately the ONLY shape parsed — see the file header for why looser forms are excluded on
 * purpose rather than by oversight.
 */
const CLAIM_RE = new RegExp(
  '`?([A-Za-z0-9_][\\w./-]*\\.test\\.mjs)`?\\s+(enforces|covers|pins|guards)\\s+(' + TOKEN_GROUP + ')',
  'g',
);

const TOKEN_RE = /`([^`\n]{1,160})`|"([^"\n]{1,160})"/g;

/** 1-indexed line number of a character offset in `text`. */
function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * Every claim of the parsed shape in `text`.
 * @param {string} text
 * @returns {{file: string, verb: string, tokens: string[], line: number, raw: string}[]}
 */
export function parseClaims(text) {
  const out = [];
  for (const m of text.matchAll(CLAIM_RE)) {
    const tokens = [];
    for (const t of m[3].matchAll(TOKEN_RE)) tokens.push(t[1] ?? t[2]);
    if (!tokens.length) continue; // the token group matched but somehow yielded nothing — not a claim
    out.push({
      file: m[1],
      verb: m[2],
      tokens,
      line: lineAt(text, m.index ?? 0),
      raw: m[0],
    });
  }
  return out;
}

/**
 * Resolve one claim's suite name against an index of known test files.
 * @param {string} file the `<file>.test.mjs` the claim named
 * @param {Map<string, Set<string>>} bySuffix every repo-relative test file path, indexed by itself
 *   AND by every path suffix — same shape as `doc-claims.mjs`'s `indexSources`, so `X.test.mjs` and
 *   `scripts/test/X.test.mjs` both resolve, and an ambiguous basename is reported as ambiguous
 *   rather than guessed at.
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function resolveSuite(file, bySuffix) {
  const key = toSlash(file);
  const candidates = bySuffix.get(key);
  if (!candidates || candidates.size === 0) {
    return { ok: false, reason: `no test file named ${file} exists in this repository` };
  }
  if (candidates.size > 1) {
    return {
      ok: false,
      reason: `${file} matches more than one suite (${[...candidates].join(', ')}) — cite a path, not a basename`,
    };
  }
  return { ok: true, path: [...candidates][0] };
}

/**
 * Check every parsed claim against a suite index.
 * @param {{file: string, verb: string, tokens: string[], line: number, raw: string}[]} claims
 * @param {Map<string, Set<string>>} bySuffix as in `resolveSuite`
 * @param {(path: string) => string} readSuite reads a resolved suite's source, given its repo-relative path
 * @returns {{claim: object, token: string | null, kind: 'missing-suite' | 'missing-token', detail: string}[]}
 */
export function evaluateClaims(claims, bySuffix, readSuite) {
  const problems = [];
  const sourceCache = new Map();
  for (const claim of claims) {
    const resolved = resolveSuite(claim.file, bySuffix);
    if (!resolved.ok) {
      problems.push({ claim, token: null, kind: 'missing-suite', detail: resolved.reason });
      continue;
    }
    if (!sourceCache.has(resolved.path)) sourceCache.set(resolved.path, readSuite(resolved.path));
    const source = sourceCache.get(resolved.path);
    for (const token of claim.tokens) {
      if (!source.includes(token)) {
        problems.push({
          claim,
          token,
          kind: 'missing-token',
          detail: `${resolved.path} exists but does not contain ${JSON.stringify(token)} anywhere in its source`,
        });
      }
    }
  }
  return problems;
}

/** Build the suffix index `resolveSuite`/`evaluateClaims` need, from a flat list of repo-relative test file paths. */
export function indexTestFiles(paths) {
  const bySuffix = new Map();
  for (const p of paths) {
    const parts = toSlash(p).split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      const key = parts.slice(i).join('/');
      if (!bySuffix.has(key)) bySuffix.set(key, new Set());
      bySuffix.get(key).add(toSlash(p));
    }
  }
  return bySuffix;
}
