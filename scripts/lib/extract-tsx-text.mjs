/**
 * Extract the STATIC TEXT of every string literal, template-literal segment, AND JSX text child
 * from a `.ts`/`.tsx` source file — the mechanism `claims-vaults-ui-prose-truth.test.mjs` (card
 * P-O13/P-O21) needs to scan `apps/vaults-ui/src/{components,lib}` for banned claim shapes.
 *
 * ## Why this is a SEPARATE extractor from `extract-string-literals.mjs`, not an extension of it
 *
 * `extract-string-literals.mjs` was built for `apps/web/src/*.mjs` (card #68) — plain JS with no
 * JSX. Its hand-rolled lexer only needs to distinguish string/template literals from comments,
 * which is a small, bounded lexical surface (that file's own header says so explicitly). TSX is
 * not that surface: nested tags, self-closing elements, `{...}` expression containers holding
 * arbitrary nested expressions (which can themselves contain strings, template literals, or more
 * JSX), and `{/* ... *\/}` JSX comments are a grammar, not a lexeme set. Hand-rolling a
 * brace/quote/tag-depth tracker for that is exactly the kind of bounded-lexical-surface argument
 * `extract-string-literals.mjs`'s own header makes FOR a hand-rolled tokenizer and AGAINST one
 * here — the surface here is unbounded. So this file uses the `typescript` package's own parser
 * (`ts.createSourceFile`) to build a real AST and walks it, rather than adding JSX-awareness to
 * the JS-only lexer and turning #322's guard into something it was never scoped to parse.
 *
 * `typescript` is not an incidental dependency the way `@babel/parser` would have been for #322
 * (present only as an undeclared transitive of something else — see that file's header for why
 * that mattered enough to refuse it). It is a DECLARED, DIRECT `devDependency` of
 * `apps/vaults-ui/package.json` (`~5.9.0`) — `apps/vaults-ui`'s own `tsc -b` build depends on it
 * being present and correct. It is ALSO added to the repo ROOT's `devDependencies` at the same
 * range, because this guard runs under `npm run test:backend` from the repo root, not from inside
 * `apps/vaults-ui`'s workspace — without that root declaration, this guard would resolve
 * `typescript` only by accident of npm workspace hoisting, which is the same "silent dependency on
 * someone else's tree" failure mode `extract-string-literals.mjs` was written to avoid.
 *
 * ## Comments are excluded for free, not by a special case
 *
 * The TypeScript parser does not include comments as AST nodes at all — they are trivia, attached
 * to the source text by position, never visited by `ts.forEachChild`. Walking the AST therefore
 * never sees a `//` line comment, a `/* *\/` block comment, or a `{/* *\/}` JSX comment: none of
 * the three exist as nodes to visit. This is the same guarantee `extract-string-literals.mjs`
 * gives by explicit design (skip `//`, skip `/* *\/`) — here it is a property of using a real
 * parser rather than something that has to be separately implemented and separately tested.
 *
 * ## What counts as extracted text
 *
 * - `StringLiteral`, `NoSubstitutionTemplateLiteral`, and each static `TemplateHead` /
 *   `TemplateMiddle` / `TemplateTail` segment of a template literal — a `${expr}` placeholder
 *   contributes nothing (it is not fixed text a reader sees unexamined), but the AST already knows
 *   exactly where the placeholder starts and ends, so there is no brace-depth tracking to get
 *   wrong the way a hand-rolled version would need.
 * - `JsxText` — the text a member actually reads between tags, e.g. `<p>Real rendered text</p>`.
 *   This is the extraction `extract-string-literals.mjs` cannot do at all (it was never asked to),
 *   and it is where the highest-risk prose in this app's components actually lives: `Holdings.tsx`
 *   ("a leg whose price could not be read shows "—" rather than a fabricated $0") and
 *   `MemberActions.tsx` (the exit-queue warning, the deposit-escrow explanation) are JSX text
 *   children, not string literals. A guard that only extracted string/template literals would miss
 *   the majority of this app's member-facing prose.
 * - Nodes matched above are leaves for this walk (their own children are not separately visited —
 *   a string literal has no sub-nodes with independent text, and a JSX text node's raw content is
 *   already the whole of what it has to say). Every other node is walked via `ts.forEachChild` so
 *   nested expressions (inside `${...}`, inside `{...}` JSX expression containers, inside function
 *   bodies) are still reached.
 *
 * ## Script kind matters — `.ts` is parsed as TS, `.tsx` as TSX
 *
 * `apps/vaults-ui/src/lib/atlas.ts`, `chain-actions.ts`, `chains.ts`, and `live-vaults.ts` are
 * plain `.ts`, where `<Type>expr` is a legal angle-bracket type assertion. Parsing those under
 * `ScriptKind.TSX` would misparse that assertion as a JSX element and either throw or silently
 * mis-tokenize. `extractTsxText` below picks `ScriptKind.TSX` only for a `.tsx` filename and
 * `ScriptKind.TS` otherwise — verified against a `<string>someValue` fixture (see this guard's
 * probe tests) so this is checked behavior, not an assumption.
 *
 * Escape sequences ARE decoded here (`node.text` on a TS literal node is the parsed, decoded
 * value), unlike `extract-string-literals.mjs`'s deliberately-undecoded output — callers still
 * match on shape/wording, and a parser-decoded string is if anything more faithful to what a
 * member actually reads than the raw source bytes would be.
 */
import ts from 'typescript';

const TEXT_LITERAL_KINDS = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/**
 * Extract the static text of every string/template literal and every JSX text child in `src`, in
 * source order, skipping all comment forms (`//`, `/* *\/`, `{/* *\/}`) and code.
 * @param {string} src
 * @param {string} fileName used only to pick `.ts` vs `.tsx` parsing and to label parse errors —
 *   never read from disk here.
 * @returns {{strings: string[], jsxText: string[]}} the two extraction categories kept separate so
 *   a caller can apply the JSX-specific coverage tripwire (see the guard's header) without
 *   re-parsing.
 */
export function extractTsxText(src, fileName) {
  const isTsx = fileName.endsWith('.tsx');
  const sourceFile = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const strings = [];
  const jsxText = [];

  const visit = (node) => {
    if (TEXT_LITERAL_KINDS.has(node.kind)) {
      if (node.text) strings.push(node.text);
      return; // leaf: no independently-textful children
    }
    if (node.kind === ts.SyntaxKind.JsxText) {
      const text = node.text;
      if (text && text.trim()) jsxText.push(text);
      return; // leaf
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return {
    strings: strings.filter((s) => s.length > 0),
    jsxText: jsxText.filter((s) => s.length > 0),
  };
}
