// @ts-check
/**
 * `docs/api/openapi.yaml` writes most short property schemas as YAML FLOW mappings, one per line:
 *
 *     totalShares: { type: string, description: WAD, decimal string }
 *
 * Inside `{ }` an unquoted comma is a SEPARATOR, not text. So that line does not mean what it
 * reads as. It parses to `{type: string, description: WAD, "decimal string": null}` — the
 * description is truncated to its first word, and a junk key with a null value is injected into
 * the schema. Four lines were written that way and every one of them had been read, reviewed and
 * shipped, because the damage is invisible until something actually parses the file: the API
 * server never does, and the sibling `openapi-vaultview.test.mjs` reads it by indentation.
 *
 * This guard closes that. It does not check a list of known-bad lines — it validates the SHAPE, so
 * a flow mapping written tomorrow is covered without anyone remembering this file exists.
 *
 * WHY IT PARSES BY HAND. The repo ships no YAML dependency, and `scripts/gate.mjs` says outright
 * that the gate does not run `npm ci` — "the one case where a green gate can still meet a red CI"
 * is a lockfile change. Adding `js-yaml` to catch a punctuation bug would put this change into
 * exactly that hole. So the scan implements the one piece of YAML that matters here: splitting a
 * flow mapping into entries.
 *
 * WHY IT SELF-TESTS. Once the four lines are fixed, a detector that finds nothing passes forever,
 * including when it has silently stopped matching anything at all. So there is a floor on the
 * number of mappings scanned (85 of them when this was written), an unbalanced brace is a failure
 * rather than a skip, and the three shapes that break naive tokenizers — an apostrophe inside a
 * plain scalar, braces inside a quoted one, and an OpenAPI path template — are asserted CLEAN
 * against inline fixtures.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SPEC = fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url));

/**
 * Is `text[i]` at a position where a NODE may begin?
 *
 * This is the whole subtlety of the format. `'`, `"`, `{` and `[` are indicators only at the start
 * of a node; inside a plain scalar they are ordinary characters. Two shapes in this very file turn
 * on it:
 *
 *   - `description: the vault's USDC token address` — an apostrophe, not a quote. A tokenizer that
 *     flips a flag on every `'` swallows the rest of the line and never finds the closing brace.
 *   - `/vaults/{address}:` — an OpenAPI path template. The `{` is the fourth character of a plain
 *     scalar that started at `/`, so it opens nothing. Treating it as a flow mapping reports a
 *     perfectly good path as malformed.
 *
 * A node begins at the start of a line, or after `{`, `[`, `,`, `:`, or a `-` that is itself a
 * block-sequence dash rather than a hyphen inside a word.
 * @param {string} text
 * @param {number} i
 */
function atNodeStart(text, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = text[j];
    if (c === ' ') continue;
    if (c === '-') return j === 0 || text[j - 1] === ' '; // `- { … }`, not `Mode-{…}`
    return c === '{' || c === '[' || c === ',' || c === ':';
  }
  return true; // nothing but space to the left: the node starts here
}

/**
 * Index of the `}` closing the flow mapping that opens at `open`, or -1 if it does not close in
 * `text`. Quoted scalars are skipped whole, so `pattern: '^0x[0-9a-fA-F]{40}$'` cannot move the
 * depth — that one balances by luck, which is worse than not balancing.
 * @param {string} text
 * @param {number} open  index of the opening `{`
 */
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if ((c === "'" || c === '"') && atNodeStart(text, i)) {
      const end = text.indexOf(c, i + 1);
      if (end === -1) return -1; // unterminated quote: refuse to guess
      i = end;
      continue;
    }
    if ((c === '{' || c === '[') && atNodeStart(text, i)) depth++;
    else if ((c === '}' || c === ']') && depth > 0) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The top-level entries of a flow mapping `{ ... }`, split on the commas that actually separate —
 * not the ones inside a nested collection or a quoted scalar.
 * @param {string} mapping  including the outer braces
 * @returns {string[]}
 */
function splitEntries(mapping) {
  const body = mapping.slice(1, -1);
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if ((c === "'" || c === '"') && atNodeStart(body, i)) {
      const end = body.indexOf(c, i + 1);
      assert.notEqual(end, -1, `unterminated quoted scalar in ${mapping}`);
      i = end;
      continue;
    }
    if ((c === '{' || c === '[') && atNodeStart(body, i)) depth++;
    else if ((c === '}' || c === ']') && depth > 0) depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((e) => e.trim()).filter((e) => e !== '');
}

/**
 * Entries of `mapping` that do not carry one whole scalar — what an unquoted comma or colon inside
 * a flow scalar leaves behind. Recurses into nested flow mappings, so
 * `payment-response: { schema: { type: string } }` is checked all the way down.
 *
 * Two shapes, because the two punctuation marks fail differently:
 *
 *   - A comma SPLITS, leaving a fragment with no value at all (`decimal string`). That is the bug
 *     this file was written for, and it parses silently.
 *   - A colon-space NESTS, so `description: see: this` is a mapping value inside a mapping value.
 *     That is a hard parse error rather than silent truncation, which is why the file had none —
 *     but the check is here so the message can name both, and so a `key: a: b` added tomorrow is
 *     reported by name instead of as a stack trace from whatever tries to load the spec.
 * @param {string} mapping  including the outer braces
 * @returns {string[]}
 */
function malformedEntries(mapping) {
  const bad = [];
  for (const entry of splitEntries(mapping)) {
    // `key: value`. The key may be quoted; the value must be non-empty. An entry with no `:` at all
    // is the truncation artifact, and `key:` with nothing after it is a null value written out.
    const m = /^(?:'[^']*'|"[^"]*"|[^:'"]+?)\s*:\s*(\S.*)$/.exec(entry);
    if (!m) {
      bad.push(entry);
      continue;
    }
    const value = m[1].trim();
    if (value.startsWith('{')) {
      const close = matchBrace(value, 0);
      assert.equal(close, value.length - 1, `nested flow mapping does not close cleanly: ${entry}`);
      bad.push(...malformedEntries(value));
      continue;
    }
    // A second `: ` in a PLAIN value. Quoting it is what makes it text, so a quoted value is fine
    // however many colons it holds.
    const quoted = /^'[^']*'$/.test(value) || /^"[^"]*"$/.test(value);
    if (!quoted && /:\s/.test(value)) bad.push(entry);
  }
  return bad;
}

/**
 * Every flow mapping in `text`, as `{ line, mapping }`. A `{` that does not close on its own line is
 * a hard failure: every flow mapping in this file is single-line, and a multi-line one must not be
 * able to slip past the scan by being unrecognised.
 * @param {string} text
 */
function flowMappings(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  let blockIndent = -1; // inside a `|` / `>` block scalar, where braces are literal text
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === '' || indent > blockIndent) continue;
      blockIndent = -1;
    }
    if (/:\s*[|>][-+]?\d*\s*$/.test(line)) {
      blockIndent = indent;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if ((c === "'" || c === '"') && atNodeStart(line, i)) {
        const end = line.indexOf(c, i + 1);
        if (end === -1) break; // plain scalar with an apostrophe; nothing structural left to find
        i = end;
        continue;
      }
      if (c !== '{' || !atNodeStart(line, i)) continue;
      const close = matchBrace(line, i);
      assert.notEqual(close, -1,
        `docs/api/openapi.yaml:${n + 1} opens a flow mapping that does not close on its line, which this scan cannot check:\n  ${line}`);
      found.push({ line: n + 1, mapping: line.slice(i, close + 1) });
      i = close;
    }
  }
  return found;
}

test('every flow-mapping entry in the OpenAPI spec carries one whole scalar', async () => {
  const mappings = flowMappings(await readFile(SPEC, 'utf8'));

  // A detector that has stopped matching anything reports the same green as a clean file. It does
  // not here: the spec is written almost entirely in flow mappings — 85 of them when this was
  // written — so a collapse of the scan is visible rather than silent.
  assert.ok(mappings.length >= 70,
    `scanned only ${mappings.length} flow mappings in docs/api/openapi.yaml — the scan has gone blind, not the file clean`);

  const offences = [];
  for (const { line, mapping } of mappings) {
    for (const entry of malformedEntries(mapping)) {
      offences.push(`docs/api/openapi.yaml:${line}: "${entry}" is not one whole scalar — an unquoted comma or colon ended the scalar before it early. Quote it.\n    ${mapping}`);
    }
  }
  assert.deepEqual(offences, [], `\n${offences.join('\n')}\n`);
});

test('the flow-mapping scanner survives the shapes that break naive tokenizers', () => {
  // Fixtures, not file lines: these keep meaning something after the file is clean.
  assert.deepEqual(
    malformedEntries('{ type: string, description: WAD, decimal string }'),
    ['decimal string'],
    'an unquoted comma inside a flow scalar must be reported',
  );
  assert.deepEqual(
    malformedEntries('{ type: integer, description: 0 Rebalance, 1 RuleChange, 2 ChildAllocation }'),
    ['1 RuleChange', '2 ChildAllocation'],
    'every fragment after the first comma is a separate junk key',
  );
  assert.deepEqual(
    malformedEntries("{ type: string, description: the vault's USDC token address }"),
    [],
    "an apostrophe inside a plain scalar is not a quote and must not be treated as one",
  );
  assert.deepEqual(
    malformedEntries("{ type: string, pattern: '^0x[0-9a-fA-F]{40}$' }"),
    [],
    'braces inside a quoted scalar are text, not structure',
  );
  assert.deepEqual(
    malformedEntries("{ type: [string, 'null'], description: \"max NAV in USDC base units; 0 = uncapped\" }"),
    [],
    'commas inside a nested sequence, and inside a quoted scalar, do not separate entries',
  );
  assert.deepEqual(
    malformedEntries('{ schema: { type: string, description: WAD, decimal string } }'),
    ['decimal string'],
    'the scan must recurse into nested flow mappings',
  );
  assert.deepEqual(
    malformedEntries('{ type: string, description: see: this }'),
    ['description: see: this'],
    'an unquoted colon-space nests instead of splitting, and is a parse error rather than silent truncation',
  );
  assert.deepEqual(
    malformedEntries('{ type: string, description: "a note: with a colon in it" }'),
    [],
    'a quoted value may hold as many colons as it likes',
  );

  // And the scanner itself: it must find the mappings, skip what only looks like one, and refuse a
  // shape it cannot check.
  assert.equal(flowMappings("a: { b: c }\nd: |\n  { not: yaml, at all }\n").length, 1,
    'a brace inside a block scalar is literal text, not a flow mapping');
  assert.deepEqual(flowMappings('  /vaults/{address}:\n'), [],
    'an OpenAPI path template is a plain scalar — its brace opens no flow mapping');
  assert.equal(flowMappings('  - { name: address, in: path }\n').length, 1,
    'a flow mapping as a block-sequence entry is still scanned');
  assert.throws(() => flowMappings('a: { b: c\n'), /does not close on its line/,
    'a multi-line flow mapping must fail loudly rather than be skipped');
});
