/**
 * Extract the STATIC TEXT of every string and template literal in a piece of JS/TS source, and
 * nothing else — no comments (line or block), no identifiers, no code. This is the mechanism that
 * lets `claims-web-prose-truth.test.mjs` scan `apps/web/src/*.mjs` for banned claim shapes without
 * reddening on a comment that *describes* a banned shape in order to explain why it is banned.
 * `claims-lede-truth.test.mjs`'s own header (lines 19-21, "sixth instance") is the reason this
 * exists: its docstring quotes the retired universal it bans, and a naive whole-file regex over
 * that file's own text would fail on its own documentation.
 *
 * WHY A HAND-ROLLED TOKENIZER RATHER THAN A DEPENDENCY: `@babel/parser` is present in
 * `node_modules` today, but only as a transitive dependency of something else in the lockfile
 * (grep `package-lock.json` — no `@babel/*` package appears in this repo's own `dependencies`).
 * Reaching for an undeclared transitive package is exactly the kind of silent dependency this
 * repository's own guards exist to refuse: the next `npm install` that drops whatever pulls it in
 * removes this guard's ability to run at all, and it would fail by throwing on import rather than
 * by reporting anything useful. The lexical surface this needs — string/template literals vs.
 * comments vs. everything else — is small and bounded, so a purpose-built scanner is both more
 * auditable and more durable than an incidental dependency on somebody else's transpiler.
 *
 * SCOPE, DELIBERATELY NARROW: this is a LEXER, not a parser. It does not distinguish a regex
 * literal from a division operator — but it does not need to, because it never treats `/` as
 * meaningful on its own; a `/` only starts a comment when immediately followed by another `/` or
 * `*`. A regex literal containing a literal quote character (`/a"b/`) would be mis-tokenized, and
 * there are none in `apps/web/src` today (checked 2026-09-19 — every regex literal there is a
 * character class or escape, never a literal quote). If one is ever added, this function is the
 * place to extend.
 *
 * TEMPLATE LITERALS: only the STATIC segments are collected. A `${expr}` placeholder is skipped
 * over — brace-depth and quote-aware, so a nested object literal or a nested template literal
 * inside the placeholder does not end the skip early — and contributes nothing to the extracted
 * text, since it is not a fixed string a reader ever sees unexamined.
 */

/**
 * Skip a `${ ... }` placeholder starting just after the `${`, respecting nested braces and nested
 * string/template literals so a `}` inside a nested string does not end the placeholder early.
 * Returns the index of the character immediately after the matching top-level `}`.
 * @param {string} src
 * @param {number} start index of the first character after `${`
 * @returns {number}
 */
function skipPlaceholder(src, start) {
  let i = start;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
    } else if (c === "'" || c === '"') {
      i = skipQuotedString(src, i + 1, c) + 1;
    } else if (c === '`') {
      i = skipTemplateLiteral(src, i + 1).end;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

/** Skip a single/double-quoted string body starting just after the opening quote. Returns the
 * index of the closing quote character (not past it). */
function skipQuotedString(src, start, quote) {
  let i = start;
  while (i < src.length) {
    if (src[i] === '\\') i += 2;
    else if (src[i] === quote) return i;
    else i++;
  }
  return i;
}

/**
 * Walk a template literal body starting just after the opening backtick, collecting each static
 * segment. Returns the collected segments and the index just past the closing backtick.
 * @param {string} src
 * @param {number} start
 * @returns {{segments: string[], end: number}}
 */
function skipTemplateLiteral(src, start) {
  const segments = [];
  let i = start;
  let segStart = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
    } else if (c === '`') {
      segments.push(src.slice(segStart, i));
      return { segments, end: i + 1 };
    } else if (c === '$' && src[i + 1] === '{') {
      segments.push(src.slice(segStart, i));
      i = skipPlaceholder(src, i + 2);
      segStart = i;
    } else {
      i++;
    }
  }
  // Unterminated template literal — return what was collected; the caller's zero-strings tripwire
  // catches a file this badly malformed.
  segments.push(src.slice(segStart, i));
  return { segments, end: i };
}

/**
 * Extract the static text of every string and template literal in `src`, in source order,
 * skipping line comments, block comments, and code. Escape sequences are left un-decoded
 * (`\n` stays as the two characters `\` and `n`) — callers match on shape, not on rendered
 * punctuation, and decoding would risk turning `\'` inside a matched phrase into something a
 * regex no longer recognises.
 * @param {string} src
 * @returns {string[]}
 */
export function extractStringLiterals(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'" || c === '"') {
      const close = skipQuotedString(src, i + 1, c);
      out.push(src.slice(i + 1, close));
      i = close + 1;
    } else if (c === '`') {
      const { segments, end } = skipTemplateLiteral(src, i + 1);
      out.push(...segments);
      i = end;
    } else {
      i++;
    }
  }
  return out.filter((s) => s.length > 0);
}
