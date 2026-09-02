/**
 * Every `file:line` citation in the Slither triage documents must resolve to the code it names.
 *
 * The triage documents are a mapping from `file:line` to a disposition. That mapping is the whole
 * product: an auditor reads "row 9 is BENIGN, and here is why", follows the pointer, and checks
 * the code. When `protocol/main` moves a line, the document keeps asserting the disposition —
 * about different code. It does not degrade into uselessness, it degrades into confident
 * wrongness, and it is invisible in a diff because the citation text never changed.
 *
 * This happened. `main` moved `VaultCore.sol` by +55 lines; PR #110 merged `main` into itself and
 * 12 of its 16 citations came to point at unrelated lines with nothing turning red. Row 9, the
 * ERC-4626 inflation site, landed on `require(p.amountUsdc > 0, NoPending())`. Every one of them
 * was correct at the commit before the merge.
 *
 * Same shape as `scripts/test/config-doc-truth.test.mjs`, which pins the `Deploy.s.sol:N`
 * citations in `docs/`; a 16-row triage table needs it more than one doc line does. The
 * difference is that no expectation is written here — each is read out of the citation itself, so
 * this file cannot go stale as rows are added, reworded or re-dispositioned.
 *
 * TWO PINNABLE CITATION FORMS, and nothing else is allowed:
 *
 *   1. A triage table row: | N | `File.sol:LINE` `fn` | `condition` | ...
 *      Asserted: LINE is inside a function named `fn`, AND `condition` appears on LINE.
 *      Both halves matter — the function alone would still pass on some other line inside it
 *      that has nothing to do with the row.
 *
 *   2. A symbolic citation anywhere: `Contract.member:LINE` or `Contract.member:LINE-LINE`.
 *      Asserted: every cited line is inside a function-like member named `member`.
 *      This form survives a merge in the half that matters — if `main` moves the code, the name
 *      still names it, and this test tells you the new number.
 *
 * A bare `File.sol:LINE` outside a table row is REJECTED as unpinned: there is nothing beside it
 * to check it against, which is exactly how the twelve drifted unnoticed. Rewrite it as
 * `Contract.member:LINE`.
 *
 * RELATION TO PR #124 (`scripts/lib/doc-claims.mjs`), which is the general, repo-wide version of
 * this and uses the same citation convention deliberately, not by coincidence. Where both run,
 * #124 subsumes the symbol, unpinned-citation, PR-state and file-existence assertions here, and
 * those four should be deleted from this file once it lands — flagged to Ops4 rather than left
 * as a hope. What #124 structurally cannot do, and this file exists for:
 *
 *   - **The condition column.** #124 asserts the enclosing SYMBOL only, on purpose: a substring
 *     check fires on `forge fmt` and a guard with false positives gets deleted. But `_settleExit`
 *     is 166 lines long, so symbol-only passes on any of them. Six of the thirteen rows here
 *     disposition an expression inside `_settleExit`, and moving row 9's citation three lines —
 *     from `ts == 0` to `if (sharesOf[member] == 0) {`, still inside `_mintShares` — is a wrong
 *     disposition that a symbol check cannot see. Here the expectation is the row's own condition
 *     cell, so it is a quote of the source rather than open-ended similarity.
 *   - **The measured gas figure**, which is a citation in exactly the way a line number is.
 *
 * SCOPE, stated because the cheap half is not the check: this pins Solidity citations only. The
 * `.mjs`, `.toml` and `.md` citations in these documents are NOT covered and can still drift, and
 * ~34 bare `:N` shorthands were DELETED rather than pinned — dropping a line number asserts
 * nothing and cannot be wrong, whereas re-pointing 34 by hand is 34 chances to ship a new wrong
 * pointer that this test would then certify green.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const TRIAGE_DOCS = ['docs/reviews/SLITHER-TRIAGE.md', 'docs/vault/slither-triage.md'];

// Where our Solidity lives. `contracts/lib` is the forge-std submodule and is not ours to cite.
const SOL_ROOTS = ['contracts/src', 'contracts/script', 'contracts/test'];

function solFiles() {
  const out = [];
  for (const root of SOL_ROOTS) {
    const abs = path.join(REPO, root);
    if (!existsSync(abs)) continue;
    (function walk(dir) {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.sol')) out.push(path.relative(REPO, full).split(path.sep).join('/'));
      }
    })(abs);
  }
  return out;
}
const SOL_FILES = solFiles();

/**
 * Resolve a cited path suffix (`VaultCore.sol`, `lib/Checkpoints.sol`, `src/Governance.sol`) to
 * exactly one file. `contracts/src` wins over `contracts/test`, so a retired copy of a contract
 * kept under `test/` cannot shadow the live one.
 */
function resolveSol(suffix) {
  const want = suffix.replace(/^\.?\//, '');
  const hits = SOL_FILES.filter((f) => f === want || f.endsWith('/' + want));
  if (hits.length === 0) return null;
  const src = hits.filter((f) => f.startsWith('contracts/src/'));
  const pool = src.length ? src : hits;
  return pool.length === 1 ? pool[0] : { ambiguous: pool };
}

/**
 * Blank out comments and string literals so brace counting cannot be fooled by a `{` in prose.
 * Length and newlines are preserved, so offsets stay usable for line numbers.
 */
function blankNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
    } else if (c === '/' && d === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      j = Math.min(n, j + 2);
      blank(i, j);
      i = j;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      j = Math.min(n, j + 1);
      blank(i, j);
      i = j;
    } else {
      i++;
    }
  }
  return out.join('');
}

const solCache = new Map();

/**
 * Every function-like member with a body, as {name, startLine, endLine} — 1-based, from the
 * declaration line through the closing brace. Bodyless interface declarations are skipped: they
 * end in `;` and there is nothing inside them to cite.
 */
function parseSol(relPath) {
  if (solCache.has(relPath)) return solCache.get(relPath);
  const raw = readFileSync(path.join(REPO, relPath), 'utf8');
  const code = blankNonCode(raw);
  const lineStarts = [0];
  for (let k = 0; k < code.length; k++) if (code[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (idx) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const found = [];
  const decl = /\b(?:function\s+([A-Za-z0-9_$]+)|(constructor)|modifier\s+([A-Za-z0-9_$]+)|(receive|fallback))\s*\(/g;
  let m;
  while ((m = decl.exec(code)) !== null) {
    const name = m[1] || m[2] || m[3] || m[4];
    // Walk forward to the first `{` or `;` outside the parameter and `returns` parentheses.
    let depth = 0;
    let bodyStart = -1;
    for (let j = m.index + m[0].length - 1; j < code.length; j++) {
      const ch = code[j];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0 && ch === '{') {
        bodyStart = j;
        break;
      } else if (depth === 0 && ch === ';') break;
    }
    if (bodyStart < 0) continue; // bodyless: an interface or abstract declaration
    let braces = 0;
    let end = bodyStart;
    for (let k = bodyStart; k < code.length; k++) {
      if (code[k] === '{') braces++;
      else if (code[k] === '}') {
        braces--;
        if (braces === 0) {
          end = k;
          break;
        }
      }
    }
    found.push({ name, startLine: lineOf(m.index), endLine: lineOf(end) });
  }
  const value = { members: found, lines: raw.split(/\r?\n/) };
  solCache.set(relPath, value);
  return value;
}

/** The innermost function-like member containing `line`, or null. */
function enclosing(relPath, line) {
  const hits = parseSol(relPath).members.filter((f) => line >= f.startLine && line <= f.endLine);
  if (!hits.length) return null;
  return hits.reduce((a, b) => (b.endLine - b.startLine < a.endLine - a.startLine ? b : a));
}

const srcLine = (relPath, line) => parseSol(relPath).lines[line - 1] ?? '';
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const unescapeCell = (s) => s.replace(/\\\|/g, '|'); // markdown escapes a literal pipe in a cell

// A condition cell quotes source, so compare it whitespace-insensitively: `h.arr[len-1]` and
// `h.arr[len - 1]` are the same expression. Everything else must match character for character —
// an abbreviated condition (`s == Defeated` for `s == Status.Defeated`) is not a pin.
const tighten = (s) => s.replace(/\s+/g, '');

// ---------------------------------------------------------------------------------------------

const DOCS = TRIAGE_DOCS.map((doc) => [doc, readFileSync(path.join(REPO, doc), 'utf8').split(/\r?\n/)]);

/** A triage table row: | N | `File.sol:LINE` `fn` | `condition` | ... */
const TABLE_ROW = /^\|\s*\d+\s*\|\s*`([\w./-]+\.sol):(\d+)`\s+`([A-Za-z0-9_$]+)`\s*\|\s*`(.+?)`\s*\|/;

/** A symbolic citation: `Contract.member:LINE` or `Contract.member:LINE-LINE`. */
const SYMBOLIC = /\b([A-Z][A-Za-z0-9_$]*)\.([A-Za-z0-9_$]+):(\d+)(?:-(\d+))?\b/g;

/** Any Solidity file:line, pinned or not. */
const ANY_SOL_CITE = /\b([\w./-]+\.sol):(\d+)(?:-(\d+))?\b/g;

test('every triage table row cites a line inside the function it names, holding the condition it names', () => {
  let rows = 0;
  const failures = [];
  for (const [doc, lines] of DOCS) {
    lines.forEach((text, i) => {
      const m = TABLE_ROW.exec(text);
      if (!m) return;
      rows += 1;
      const [, file, lineStr, fn, condRaw] = m;
      const where = `${doc}:${i + 1}`;
      const rel = resolveSol(file);
      if (!rel) return void failures.push(`${where}: cites ${file}, which is not a file in this repo`);
      if (rel.ambiguous) return void failures.push(`${where}: ${file} matches ${rel.ambiguous.join(', ')}`);
      const n = Number(lineStr);
      const encl = enclosing(rel, n);
      const actual = squash(srcLine(rel, n));
      if (!encl || encl.name !== fn) {
        failures.push(
          `${where}: cites ${file}:${n} as \`${fn}\`, but that line is inside ` +
            `${encl ? '`' + encl.name + '`' : 'no function'} and reads ${JSON.stringify(actual)}`,
        );
        return;
      }
      const cond = squash(unescapeCell(condRaw));
      if (!tighten(actual).includes(tighten(cond))) {
        failures.push(`${where}: cites ${file}:${n} for \`${cond}\`, but that line reads ${JSON.stringify(actual)}`);
      }
    });
  }
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
  assert.ok(rows >= 13, `only ${rows} rows matched the pinnable triage-row shape; the table format changed`);
});

test('every `Contract.member:LINE` citation names the member that line is actually inside', () => {
  let cites = 0;
  const failures = [];
  for (const [doc, lines] of DOCS) {
    lines.forEach((text, i) => {
      for (const m of text.matchAll(SYMBOLIC)) {
        const [, contract, member, aStr, bStr] = m;
        // `VaultCore.sol:342` also matches this shape with member === 'sol'. That is the bare
        // file form, checked by the table test above or rejected by the unpinned test below.
        if (member === 'sol') continue;
        const rel = resolveSol(`${contract}.sol`);
        // Not a Solidity citation (`chain.mjs:46-48`, `foundry.toml:7`, a version string).
        if (!rel || rel.ambiguous) continue;
        cites += 1;
        const where = `${doc}:${i + 1}`;
        for (const n of bStr ? [Number(aStr), Number(bStr)] : [Number(aStr)]) {
          const encl = enclosing(rel, n);
          if (!encl || encl.name !== member) {
            failures.push(
              `${where}: cites \`${contract}.${member}:${aStr}${bStr ? '-' + bStr : ''}\`, but ${rel}:${n} is inside ` +
                `${encl ? '`' + encl.name + '`' : 'no function'} and reads ${JSON.stringify(squash(srcLine(rel, n)))}`,
            );
          }
        }
      }
    });
  }
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
  assert.ok(cites > 0, 'no symbolic Solidity citation left in the triage docs; drop this test or re-point it');
});

test('every `File.sol:LINE` citation names, in backticks beside it, the symbol it is about', () => {
  // PR #124's convention, adopted deliberately rather than a competing one: a citation must carry
  // a backticked identifier next to it, and that identifier must be a declaration enclosing the
  // cited line or an identifier used on it. A bare `File.sol:LINE` has nothing beside it to check
  // it against, which is exactly how the twelve drifted unnoticed.
  const failures = [];
  for (const [doc, lines] of DOCS) {
    lines.forEach((text, i) => {
      // A pinned triage row's own citation is checked in full by the first test.
      const row = TABLE_ROW.exec(text);
      const rest = row ? text.slice(row[0].length) : text;
      const offset = row ? row[0].length : 0;
      for (const m of rest.matchAll(ANY_SOL_CITE)) {
        const where = `${doc}:${i + 1} col ${offset + m.index + 1}`;
        const rel = resolveSol(m[1]);
        if (!rel || rel.ambiguous) continue; // reported by the file-existence test below
        // Identifiers in backticks immediately before or after the citation, allowing the
        // punctuation that separates them in prose: `latestPrice` (`Uniswap…sol:282-292`).
        const before = rest.slice(Math.max(0, m.index - 60), m.index);
        const after = rest.slice(m.index + m[0].length, m.index + m[0].length + 60);
        const anchors = [
          ...[...before.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]*)`[\s(`,—-]*$/g)].map((a) => a[1]),
          ...[...after.matchAll(/^[\s)`,—-]*`([A-Za-z_$][A-Za-z0-9_$]*)`/g)].map((a) => a[1]),
        ];
        if (!anchors.length) {
          failures.push(
            `${where}: \`${m[0]}\` is an unpinned line citation — no backticked symbol beside it. ` +
              `Name the symbol it is about (\`someFunction\` (\`${m[0]}\`)), or write it as ` +
              `\`Contract.member:${m[2]}${m[3] ? '-' + m[3] : ''}\`, so a merge that moves the line ` +
              `turns this test red instead of silently re-pointing the disposition.`,
          );
          continue;
        }
        const a = Number(m[2]);
        const b = m[3] ? Number(m[3]) : a;
        const seen = new Set();
        for (let n = a; n <= b; n++) {
          const encl = enclosing(rel, n);
          if (encl) seen.add(encl.name);
          for (const w of srcLine(rel, n).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) seen.add(w);
        }
        if (!anchors.some((x) => seen.has(x))) {
          failures.push(
            `${where}: \`${m[0]}\` names {${anchors.join(', ')}}, but ${rel}:${m[2]}${m[3] ? '-' + m[3] : ''} ` +
              `is inside {${[...seen].slice(0, 6).join(', ') || 'nothing'}} and mentions none of them`,
          );
        }
      }
    });
  }
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
});

test('every claim about a pull request being open carries a date', () => {
  // The same defect as a drifted line number, one level up. A citation goes stale because a line
  // moved; "#98 is an OPEN PR — H-9 is UNFIXED here" goes stale because a PR merged, and it is
  // worse, because a wrong line number is at least visibly wrong to anyone who follows it while a
  // wrong branch-state claim reads perfectly. #98 merged at 2026-09-01T22:30:54Z and three
  // documents went on asserting it was open.
  //
  // Whether a given PR is open cannot be checked offline, so this does not check the fact — it
  // enforces the form. An undated present-tense claim has no expiry on its face and reads as
  // current forever; a dated one tells the reader exactly how much to trust it. The durable
  // shape is "as of <date>" or a merge SHA, and a claim later found stale is corrected in place
  // with a dated note rather than deleted, so the reasoning built on it stays legible.
  const CLAIM = /#\d+\s+(?:IS\s+|is\s+)(?:still\s+)?(?:an?\s+)?(?:OPEN|open)\b|is\s+(?:still\s+)?an?\s+open\s+PR|#\d+\s+is\s+not\s+yet\s+merged/g;
  const DATE = /\b20\d\d-\d\d-\d\d\b/;
  const failures = [];
  for (const doc of TRIAGE_DOCS) {
    const text = readFileSync(path.join(REPO, doc), 'utf8');
    // Paragraphs, so a dated correction appended to the same block covers the claim in it.
    let offset = 0;
    for (const para of text.split(/\n\s*\n/)) {
      const start = text.indexOf(para, offset);
      offset = start + para.length;
      for (const m of para.matchAll(CLAIM)) {
        if (DATE.test(para)) continue;
        const line = text.slice(0, start + m.index).split('\n').length;
        failures.push(
          `${doc}:${line}: "${m[0]}" is an undated claim about branch state. Write it as ` +
            `"as of <YYYY-MM-DD>", cite the merge SHA, or append a dated correction in the same ` +
            `paragraph — an undated one reads as current forever and cannot be checked offline.`,
        );
      }
    }
  }
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
});

test('the navWad measurement the triage doc prints is the one the gas test asserts', () => {
  // A measured number in prose is a citation too, and it drifts the same way a line number does.
  // `navWad()` at the structural maximum is M-5's whole substance — how large the number is *is*
  // the finding — and the first recorded figure went stale within a day of being written, because
  // the only assertion on it was `assertLt(used, NAV_GAS_CEILING)` and the ceiling has 7.7% of
  // slack. AuditCallsLoopMaxBound now asserts the printed gas against NAV_GAS_MEASURED to within
  // 1%; this pins the prose to that same constant, so the two cannot part company again.
  const solPath = 'contracts/test/audit/AuditCallsLoopMaxBound.t.sol';
  const sol = readFileSync(path.join(REPO, solPath), 'utf8');

  const measured = /uint256 constant NAV_GAS_MEASURED = ([\d_]+);/.exec(sol);
  assert.ok(measured, `${solPath} no longer declares NAV_GAS_MEASURED`);
  assert.match(sol, /assertApproxEqRel\(\s*used,\s*NAV_GAS_MEASURED,/, `${solPath} no longer asserts the measurement`);

  const ceiling = /uint256 constant NAV_GAS_CEILING = ([\d_]+);/.exec(sol);
  assert.ok(ceiling, `${solPath} no longer declares NAV_GAS_CEILING`);

  const commas = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const gas = Number(measured[1].replace(/_/g, ''));
  const cap = Number(ceiling[1].replace(/_/g, ''));
  const doc = readFileSync(path.join(REPO, 'docs/reviews/SLITHER-TRIAGE.md'), 'utf8');

  assert.ok(
    doc.includes(`\`navWad()\` costs ${commas(gas)} gas`),
    `docs/reviews/SLITHER-TRIAGE.md does not state "\`navWad()\` costs ${commas(gas)} gas"; ` +
      `${solPath} measures ${commas(gas)}. Re-read the number the test logs and update both.`,
  );
  assert.ok(
    doc.includes(`\`NAV_GAS_CEILING\` of ${commas(cap)}`),
    `docs/reviews/SLITHER-TRIAGE.md does not state the ceiling ${commas(cap)} that ${solPath} declares`,
  );
  // The ceiling is a coarse fence. The document must not describe it as anything tighter.
  const slack = ((cap - gas) / gas) * 100;
  assert.ok(slack > 0, `NAV_GAS_CEILING ${cap} is below the measured ${gas}`);
  assert.ok(
    doc.includes(`sitting ${slack.toFixed(1)}% above the measurement`),
    `docs/reviews/SLITHER-TRIAGE.md must state the ceiling's real slack (${slack.toFixed(1)}%) rather ` +
      `than a remembered one; the PR body once called ${commas(cap)} "a tight named constant, not a round number".`,
  );
});

test('every Solidity file the triage docs cite exists and is unambiguous', () => {
  const failures = [];
  for (const [doc, lines] of DOCS) {
    lines.forEach((text, i) => {
      for (const m of text.matchAll(ANY_SOL_CITE)) {
        const rel = resolveSol(m[1]);
        if (!rel) failures.push(`${doc}:${i + 1}: cites ${m[1]}, which is not a file in this repo`);
        else if (rel.ambiguous) failures.push(`${doc}:${i + 1}: ${m[1]} matches ${rel.ambiguous.join(', ')}`);
      }
    });
  }
  assert.equal(failures.length, 0, `\n  ${failures.join('\n  ')}\n`);
});
