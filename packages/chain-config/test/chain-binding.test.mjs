// @ts-check
/**
 * #204 — a component that resolves an RPC by chain and never asks the RPC which chain it is.
 *
 * Two layers, and the second is the one that matters. The pure decision table is easy to get right
 * and easy to test; what this issue actually costs is the WIRING — whether the refusal reaches the
 * process, or is swallowed by a daemon whose read path is deliberately fault-tolerant.
 *
 * So the runner tests below stand up a real HTTP server answering `eth_chainId` with the WRONG id
 * and drive the real viem client through the real `buildIndexer` / `buildCanary` / `createChainReader`
 * path. No stubbing of the thing under test. A test that asserted "a warning was logged" would pass
 * with the defect present, because the defect IS that a warning is all you get.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chainBindingVerdict, assertChainBinding, ChainBindingError } from '../src/chain-binding.mjs';

// --- #293: every createChainReader caller reaches its binding, decided by a PARSER ---------------
//
// The hand-maintained version said "the three production call sites" in prose and checked one. PR 271
// added a fourth — `scripts/soak/drill5-agent-execute.mjs` built a reader and never bound it — and CI
// stayed green, because nothing walked the filesystem. A human caught it; no guard could.
//
// FOUR ROUNDS OF TEXTUAL SCANNING, AND THIS IS WHY IT IS NOW A PARSER.
//
// r1 asked whether the assertion's text appeared in the file, so `if (false) { … }` passed.
// r2 added brace counting and passed nine mutations.
// r3 inverted the default so anything unprovable became a violation, and closed those nine — then
//    passed seven more (a dotted call was never even enumerated, a nested-arrow helper still read as
//    reachable, a popped brace stack missed `if (x) { return r; }`) AND redded six shapes of
//    idiomatic correct code: module top level, class methods, object methods, wrapped assignments,
//    and any file containing an unrelated `import * as`.
//
// Inverting the default is what produced the second failure direction. **The guard failed both ways
// at once: it passed what it could not parse when dotted, and redded what it could not parse when
// nested.** That is the signature of a method at its limit, not of a bug missed — a textual scan that
// must see through aliases, namespaces, nested arrows, brace stacks and string literals is a parser
// written by accident, one bug at a time.
//
// "Is this assertion reached from this call" is a parser question. `@babel/parser` answers it from the
// AST: scope for the binding, the enclosing function for containment, and the ancestor chain for
// conditionality. Every one of the seven survivors and all six false positives are consequences of
// not having a tree, so they go together rather than one round at a time.
//
// It is a devDependency rather than a transitive accident: it was already in the tree under other
// packages, and a guard resolving a module nothing declares breaks on any lockfile change — silently,
// because a guard that cannot load is a guard that does not run.
import { parse } from '@babel/parser';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The hand-written part, named, because r1 claimed there wasn't one. */
const EXCLUSIONS = Object.freeze({
  dirs: new Set([
    'node_modules', '.git', '.claude', 'out', 'dist', 'dist-ssr', 'cache', 'broadcast',
    'coverage', 'artifacts',
  ]),
  // Vendored forge code, excluded BY PATH. `lib` is deliberately not excluded by NAME: `scripts/lib/`,
  // `apps/vaults-ui/src/lib/` and `contracts/src/lib/` are all real source.
  paths: Object.freeze(['contracts/lib/']),
  exts: Object.freeze(['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts']),
  isTestPath: (rel) => /\.test\.[cm]?[jt]sx?$/.test(rel)
    || rel.split('/').includes('test') || rel.split('/').includes('__tests__'),
});

/**
 * The production callers that MUST be found, as a FLOOR and never a ceiling: extra findings are still
 * checked. It is the only thing that catches an exclusion silently shrinking the corpus, since "every
 * caller found is bound" is trivially true of a smaller set.
 */
const KNOWN_CALLERS = Object.freeze([
  'packages/canary/src/canary-runner.mjs',
  'packages/reference-agent/src/run.mjs',
  'scripts/soak/drill5-agent-execute.mjs',
]);

const relPath = (abs) => path.relative(REPO_ROOT, abs).split(path.sep).join('/');

const PARSE_OPTS = {
  sourceType: 'unambiguous',
  errorRecovery: true,
  plugins: ['topLevelAwait', 'typescript', 'jsx', 'classProperties', 'optionalChaining', 'nullishCoalescingOperator'],
};

/** Walk every node, handing each its ancestor chain (outermost first, excluding itself). */
function walkAst(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
    const v = node[key];
    if (Array.isArray(v)) {
      for (const c of v) if (c && typeof c.type === 'string') walkAst(c, visit, next);
    } else if (v && typeof v.type === 'string') {
      walkAst(v, visit, next);
    }
  }
}

const FUNCTIONS = new Set([
  'FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression',
  'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod',
]);
/** A node whose body may not execute, or may execute more than once. */
const CONDITIONALS = new Set([
  'IfStatement', 'SwitchStatement', 'SwitchCase', 'ConditionalExpression',
  'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement',
  'CatchClause', 'LogicalExpression',
]);

/** The nearest enclosing function, or null at module top level (which always executes). */
const enclosingFunction = (ancestors) => [...ancestors].reverse().find((a) => FUNCTIONS.has(a.type)) ?? null;

/**
 * Every local name `createChainReader` is bound to in this module: a named import, an aliased import,
 * a destructured `await import()`, or a namespace import used as `ns.createChainReader`. r2 searched
 * for the literal text, so an aliased import was an INVISIBLE CALLER rather than a missed binding, and
 * r3's `bare` regex excluded a preceding dot, so a namespaced call could never be enumerated at all.
 */
function readerNames(ast) {
  const direct = new Set();
  const namespaces = new Set();
  walkAst(ast.program, (n) => {
    if (n.type === 'ImportDeclaration') {
      for (const spec of n.specifiers) {
        if (spec.type === 'ImportSpecifier' && (spec.imported?.name ?? spec.imported?.value) === 'createChainReader') {
          direct.add(spec.local.name);
        } else if (spec.type === 'ImportNamespaceSpecifier') {
          namespaces.add(spec.local.name);
        }
      }
      return;
    }
    // `const { createChainReader } = await import(...)` / `= require(...)`
    if (n.type === 'VariableDeclarator' && n.id?.type === 'ObjectPattern') {
      for (const prop of n.id.properties) {
        if (prop.type !== 'ObjectProperty') continue;
        if ((prop.key?.name ?? prop.key?.value) === 'createChainReader' && prop.value?.type === 'Identifier') {
          direct.add(prop.value.name);
        }
      }
    }
  });
  return { direct, namespaces };
}

/** Is this CallExpression a call to createChainReader under any of its local names? */
function isReaderCall(node, names) {
  const c = node.callee;
  if (c?.type === 'Identifier') return names.direct.has(c.name);
  if (c?.type === 'MemberExpression' && !c.computed) {
    const prop = c.property?.name;
    if (prop !== 'createChainReader') return false;
    // `ns.createChainReader(...)` where ns is a namespace import, or any dotted call to that name --
    // enumerated rather than skipped, which is what r3's `[^.\w]` prevented.
    return c.object?.type === 'Identifier' ? names.namespaces.has(c.object.name) || true : true;
  }
  return false;
}

/**
 * Classify one call site: bound | unverifiable | unbound.
 *
 * `unverifiable` is for what the AST genuinely cannot settle — an assertion on a variable that escaped
 * into another function, which needs cross-procedural analysis this does not attempt. It is a
 * VIOLATION, because "I cannot tell" is not "it is fine"; the difference from r3 is that the parser
 * leaves almost nothing in that bucket, so it no longer swallows idiomatic correct code.
 */
function classify(ast, call, ancestors) {
  const decl = ancestors[ancestors.length - 1];
  const varName = decl?.type === 'VariableDeclarator' && decl.id?.type === 'Identifier'
    ? decl.id.name
    : (decl?.type === 'AssignmentExpression' && decl.left?.type === 'Identifier' ? decl.left.name : null);
  if (!varName) {
    return { state: 'unverifiable', why: 'the reader is not assigned to a plain variable, so this check cannot follow it' };
  }

  const fn = enclosingFunction(ancestors);
  const callEnd = call.end;

  // Every `await <varName>.assertBoundToDeclaredChain(...)` in the SAME function body (or at module
  // top level), after the call. AWAITED, specifically: `assertBoundToDeclaredChain` rejects on a
  // mismatch, and a call whose promise nobody awaits proves nothing before the caller moves on —
  // `const bound = r.assertBoundToDeclaredChain();` fires the check but does not block on it, so
  // reads can run first and the rejection surfaces only as an unhandled rejection afterward
  // (Security, PR #321). The FIRST hit-collecting walk below required only that the call MATCH; it
  // did not require the call's own parent to be an AwaitExpression, so this unawaited shape read as
  // fully bound. The `anywhere` fallback just below had the same gap for the same reason.
  const hits = [];
  walkAst(ast.program, (n, anc) => {
    if (n.type !== 'CallExpression') return;
    const c = n.callee;
    if (c?.type !== 'MemberExpression' || c.computed) return;
    if (c.property?.name !== 'assertBoundToDeclaredChain') return;
    if (c.object?.type !== 'Identifier' || c.object.name !== varName) return;
    if (n.start < callEnd) return;
    if (enclosingFunction(anc) !== fn) return; // a nested arrow or helper is a different function
    if (anc[anc.length - 1]?.type !== 'AwaitExpression') return; // un-awaited proves nothing
    hits.push({ node: n, ancestors: anc });
  });

  if (hits.length === 0) {
    // Is it bound ANYWHERE, just not reachably? That distinction is what the operator needs.
    let anywhere = false;
    walkAst(ast.program, (n, anc) => {
      if (n.type !== 'CallExpression') return;
      const c = n.callee;
      if (c?.type === 'MemberExpression' && !c.computed && c.property?.name === 'assertBoundToDeclaredChain'
        && c.object?.type === 'Identifier' && c.object.name === varName
        && anc[anc.length - 1]?.type === 'AwaitExpression') anywhere = true;
    });
    return anywhere
      ? { state: 'unverifiable', why: `"${varName}" is bound only OUTSIDE the function containing the call, so whether that path ever runs is beyond this check` }
      : { state: 'unbound', why: `builds "${varName}" and never awaits ${varName}.assertBoundToDeclaredChain()` };
  }

  // Reached unconditionally? Compare ancestor chains: every conditional the ASSERTION is inside that
  // the CALL is not inside is a path the call can take without reaching it. A `try` block always
  // runs, so TryStatement is deliberately absent from CONDITIONALS -- run.mjs wraps the assertion in
  // one to turn a throw into an exit code, and flagging that would be a false positive on the caller
  // handling the failure most carefully.
  const callGuards = new Set(ancestors.filter((a) => CONDITIONALS.has(a.type)));
  for (const hit of hits) {
    const extra = hit.ancestors.filter((a) => CONDITIONALS.has(a.type) && !callGuards.has(a));
    if (extra.length === 0) {
      // ...and nothing leaves the function between them at a depth the call is not inside.
      let escapes = null;
      walkAst(ast.program, (n, anc) => {
        if (escapes) return;
        if (!['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'].includes(n.type)) return;
        if (n.start < callEnd || n.end > hit.node.start) return;
        if (enclosingFunction(anc) !== fn) return;
        const guarded = anc.some((a) => CONDITIONALS.has(a.type) && !callGuards.has(a));
        if (!guarded) escapes = n.type; // unconditional exit: the assertion is dead code
        else escapes = `conditional ${n.type}`; // a branch that skips the assertion
      });
      if (!escapes) return { state: 'bound', why: '' };
      return { state: 'unverifiable', why: `a ${escapes} between the call and the assertion can skip it` };
    }
  }
  return {
    state: 'unverifiable',
    why: `the assertion sits inside ${hits[0].ancestors.filter((a) => CONDITIONALS.has(a.type) && !callGuards.has(a)).map((a) => a.type).join(', ')} that the call is not inside`,
  };
}

/**
 * Every non-test source file that calls `createChainReader`. Injectable so the WALK itself can be
 * tested against a fixture tree -- r2 pinned the `exts` CONSTANT while the walk could be hardcoded
 * back to `.mjs` with every test green.
 */
export function findChainReaderCallSites(root = REPO_ROOT, exclusions = EXCLUSIONS) {
  const found = [];
  const rel = (abs) => path.relative(root, abs).split(path.sep).join('/');
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const r = rel(full);
      if (entry.isDirectory()) {
        if (exclusions.dirs.has(entry.name)) continue;
        if (exclusions.paths.some((p) => `${r}/`.startsWith(p))) continue;
        walk(full);
        continue;
      }
      if (!exclusions.exts.some((e) => entry.name.endsWith(e))) continue;
      if (exclusions.isTestPath(r)) continue;
      const src = readFileSync(full, 'utf8');
      if (!src.includes('createChainReader')) continue;
      let ast;
      try {
        ast = parse(src, PARSE_OPTS);
      } catch (err) {
        // A file that mentions the symbol and cannot be parsed is a violation, never a skip.
        found.push({ file: r, unparseable: String(err?.message ?? err) });
        continue;
      }
      const names = readerNames(ast);
      if (names.direct.size === 0 && names.namespaces.size === 0) continue; // defines it, or only names it
      walkAst(ast.program, (n, anc) => {
        if (n.type !== 'CallExpression' || !isReaderCall(n, names)) return;
        found.push({ file: r, ast, call: n, ancestors: anc, line: n.loc?.start.line ?? 0 });
      });
    }
  })(root);
  return found;
}

test('#293: every createChainReader call site is BOUND, decided from the AST', () => {
  const callSites = findChainReaderCallSites();
  assert.ok(
    callSites.length > 0,
    'findChainReaderCallSites() found zero call sites -- checked nothing. This is a broken guard, '
      + 'not a passing one: fix the walk before trusting this test again.',
  );

  const files = new Set(callSites.map((c) => c.file));
  const lost = KNOWN_CALLERS.filter((f) => !files.has(f));
  assert.deepEqual(
    lost,
    [],
    `the walk no longer finds these known callers, so every "all bound" result below is over a subset:\n  ${lost.join('\n  ')}`,
  );

  const violations = [];
  for (const site of callSites) {
    if (site.unparseable) {
      violations.push(`${site.file}: mentions createChainReader and could not be parsed -- ${site.unparseable}`);
      continue;
    }
    const { state, why } = classify(site.ast, site.call, site.ancestors);
    if (state !== 'bound') violations.push(`${site.file}:${site.line} [${state}] ${why}`);
  }
  assert.deepEqual(
    violations,
    [],
    `chain binding is not provable at ${violations.length} call site(s):\n${violations.join('\n')}`,
  );
});


/** Classify a source string the way the real check classifies a file. For fixtures. */
function classifySource(src) {
  const ast = parse(src, PARSE_OPTS);
  const names = readerNames(ast);
  const sites = [];
  walkAst(ast.program, (n, anc) => {
    if (n.type === 'CallExpression' && isReaderCall(n, names)) sites.push({ call: n, ancestors: anc });
  });
  if (sites.length === 0) return { state: 'not-enumerated', why: 'the call was never found' };
  return classify(ast, sites[0].call, sites[0].ancestors);
}

const IMPORT = "import { createChainReader } from './x.mjs';\n";
const BIND = 'await r.assertBoundToDeclaredChain();';

test('#293: the classifier passes idiomatic correct code — six shapes round 3 redded', () => {
  // ROUND 3 FAILED IN BOTH DIRECTIONS AT ONCE: it passed what it could not parse when dotted, and
  // redded what it could not parse when nested. Inverting the default to fail closed is what created
  // this second half, and these six are the cost it imposed on correct code. A guard that reds
  // idiomatic code is one nobody keeps, so they are pinned as MUST-PASS.
  const ACCEPTED = {
    'module top level with top-level await': `${IMPORT}const r = createChainReader({});\n${BIND}\n`,
    'class method': `${IMPORT}class A {\n  async build() {\n    const r = createChainReader({});\n    ${BIND}\n  }\n}\n`,
    'object method': `${IMPORT}const o = {\n  async build() {\n    const r = createChainReader({});\n    ${BIND}\n  },\n};\n`,
    'wrapped assignment': `${IMPORT}let r;\nasync function f() {\n  r = createChainReader({});\n  ${BIND}\n}\n`,
    'an unrelated namespace import in the file': `import * as unrelated from 'node:path';\n${IMPORT}async function f() {\n  const r = createChainReader({});\n  ${BIND}\n  unrelated.join('a');\n}\n`,
    'try/catch around the assertion (run.mjs)': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  try {\n    ${BIND}\n  } catch (e) {\n    process.exitCode = 2;\n  }\n}\n`,
    'a conditional the CALL is also inside': `${IMPORT}async function f(rpc) {\n  if (rpc) {\n    const r = createChainReader({});\n    ${BIND}\n  }\n}\n`,
    'a return AFTER the assertion': `${IMPORT}async function f(x) {\n  const r = createChainReader({});\n  ${BIND}\n  if (!x) return;\n}\n`,
    'a brace inside a string': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  log("a } brace");\n  ${BIND}\n}\n`,
    'an arrow function body': `${IMPORT}const f = async () => {\n  const r = createChainReader({});\n  ${BIND}\n};\n`,
  };
  for (const [name, src] of Object.entries(ACCEPTED)) {
    const got = classifySource(src);
    assert.equal(got.state, 'bound', `must be BOUND: ${name} -- got ${got.state}: ${got.why}`);
  }
});

test('#293: the classifier refuses every shape that leaves a reader unbound', () => {
  // NON-VACUITY. Every real caller is `bound`, so the file check would read identically with a
  // classifier that always returned `bound`. Each entry below is a mutation that survived an earlier
  // round -- rounds 1-3 between them passed sixteen of these.
  const REFUSED = {
    'if(false) wrapper': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  if (false) {\n    ${BIND}\n  }\n}\n`,
    'env-gated binding': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  if (process.env.STRICT) {\n    ${BIND}\n  }\n}\n`,
    'loop that may not run': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  for (const x of []) {\n    ${BIND}\n  }\n}\n`,
    'catch-only binding': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  try {\n    g();\n  } catch {\n    ${BIND}\n  }\n}\n`,
    'same-line conditional': `${IMPORT}async function f(x) {\n  const r = createChainReader({});\n  if (x) ${BIND}\n}\n`,
    'short-circuit': `${IMPORT}async function f(x) {\n  const r = createChainReader({});\n  const ok = x && await r.assertBoundToDeclaredChain();\n}\n`,
    'ternary': `${IMPORT}async function f(x) {\n  const r = createChainReader({});\n  const ok = x ? await r.assertBoundToDeclaredChain() : null;\n}\n`,
    'early return between': `${IMPORT}async function f(x) {\n  const r = createChainReader({});\n  if (!x) return;\n  ${BIND}\n}\n`,
    'BRACED early return between': `${IMPORT}async function f(x) {\n  const r = createChainReader({});\n  if (!x) {\n    return r;\n  }\n  ${BIND}\n}\n`,
    'unconditional return before the assertion': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  return r;\n  ${BIND}\n}\n`,
    'sibling helper': `${IMPORT}async function f() {\n  const r = createChainReader({});\n}\nasync function bind(r) {\n  ${BIND}\n}\n`,
    'NESTED ARROW helper': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  const later = async () => {\n    ${BIND}\n  };\n}\n`,
    'binding inside a callback': `${IMPORT}async function f(list) {\n  const r = createChainReader({});\n  list.forEach(async () => {\n    ${BIND}\n  });\n}\n`,
    'no assertion at all': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  use(r);\n}\n`,
    'ALIASED import, unbound': `import { createChainReader as mk } from './x.mjs';\nasync function f() {\n  const r = mk({});\n  use(r);\n}\n`,
    'NAMESPACED call, unbound': `import * as chain from './x.mjs';\nasync function f() {\n  const r = chain.createChainReader({});\n  use(r);\n}\n`,
    'untraceable target': `${IMPORT}async function f() {\n  createChainReader({}).use();\n}\n`,
    // Card 221 / Security's PR #321 gap: `assertBoundToDeclaredChain()` rejects on a mismatch, but
    // nothing without `await` blocks on that rejection -- the check fires and the caller moves on
    // before it can answer, so reads may already run by the time (or instead of) the promise
    // settling. The old classifier matched the call by shape alone and never asked whether its
    // result was awaited.
    'UN-AWAITED assertion, unbound': `${IMPORT}async function f() {\n  const r = createChainReader({});\n  r.assertBoundToDeclaredChain();\n}\n`,
  };
  for (const [name, src] of Object.entries(REFUSED)) {
    const got = classifySource(src);
    assert.notEqual(got.state, 'bound', `must NOT be bound: ${name}`);
    assert.notEqual(got.state, 'not-enumerated', `must at least be ENUMERATED: ${name} -- an invisible caller is the original #293 defect`);
  }

  // The two that r3's docstring promised and did not deliver, asserted by STATE and by MESSAGE.
  for (const name of ['sibling helper', 'NESTED ARROW helper', 'binding inside a callback']) {
    const got = classifySource(REFUSED[name]);
    assert.equal(got.state, 'unverifiable', `${name} must be unverifiable specifically`);
    assert.match(got.why, /OUTSIDE the function/, `${name}: the message must say why`);
  }
  assert.equal(classifySource(REFUSED['no assertion at all']).state, 'unbound');
  // Enumeration is complete even where reachability is not decidable: these were INVISIBLE before.
  assert.equal(classifySource(REFUSED['ALIASED import, unbound']).state, 'unbound');
  assert.equal(classifySource(REFUSED['NAMESPACED call, unbound']).state, 'unbound');
  // The un-awaited binding must read as UNBOUND specifically, not merely "not bound": nothing
  // blocks on the assertion, so reads can run before or instead of it ever settling.
  assert.equal(classifySource(REFUSED['UN-AWAITED assertion, unbound']).state, 'unbound');
});

test('#293: the WALK and the FLOOR cannot be narrowed to nothing', () => {
  // MUTATION 9 REPEATED INSIDE ITS OWN FIX in round 3: the walk fixture pinned 3 of 7 extensions, and
  // KNOWN_CALLERS could be emptied entirely, both green. A floor that can be set to zero is not a floor.
  assert.equal(EXCLUSIONS.exts.length, 7, 'the extension set changed -- pin every one deliberately');
  for (const ext of ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.mts', '.cts']) {
    assert.ok(EXCLUSIONS.exts.includes(ext), `a caller in a ${ext} file would be invisible`);
  }
  assert.ok(KNOWN_CALLERS.length >= 3, 'the known-caller floor must not be emptied -- it is what catches a shrinking corpus');
  assert.ok(!EXCLUSIONS.dirs.has('lib'), '`lib` must not be excluded by name: scripts/lib and src/lib are real source');

  // The walk itself, over a fixture tree. Round 2 pinned the CONSTANT while the walk could be
  // hardcoded back to `.mjs`, which is why this runs the walker rather than reading its inputs.
  const root = mkdtempSync(path.join(os.tmpdir(), 'agv-293-walk-'));
  const write = (rel, body) => {
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  const CALLER = `${IMPORT}async function f() {\n  const r = createChainReader({});\n  ${BIND}\n}\n`;
  for (const ext of EXCLUSIONS.exts) write(`src/a${ext.replace('.', '_')}${ext}`, CALLER);
  write('scripts/lib/d.mjs', CALLER);
  write('apps/ui/src/lib/e.mjs', CALLER);
  write('src/nsp.mjs', `import * as chain from './x.mjs';\nasync function f() {\n  const r = chain.createChainReader({});\n  use(r);\n}\n`);
  write('node_modules/pkg/f.mjs', CALLER);
  write('contracts/lib/forge-std/g.mjs', CALLER);
  write('src/h.test.mjs', CALLER);

  const found = findChainReaderCallSites(root, EXCLUSIONS);
  const files = found.map((f) => f.file).sort();
  assert.equal(files.length, EXCLUSIONS.exts.length + 3, `expected one per extension plus the two lib files and the namespaced one, got ${files.join(', ')}`);
  assert.ok(files.includes('scripts/lib/d.mjs') && files.includes('apps/ui/src/lib/e.mjs'), 'src/lib must be walked');
  assert.ok(files.includes('src/nsp.mjs'), 'a NAMESPACED caller must be enumerated -- round 3 could never see one');
  assert.ok(!files.some((f) => f.startsWith('node_modules/') || f.startsWith('contracts/lib/') || f.endsWith('.test.mjs')), 'excluded paths must stay excluded');

  // And the namespaced one is judged, not merely found.
  const nsp = found.find((f) => f.file === 'src/nsp.mjs');
  assert.equal(classify(nsp.ast, nsp.call, nsp.ancestors).state, 'unbound');

  rmSync(root, { recursive: true, force: true });
});

// --- the pure decision -----------------------------------------------------

test('matching ids bind', () => {
  const r = chainBindingVerdict({ declaredChainId: 8453, rpcChainId: 8453, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, true);
  assert.match(r.message, /is chain 8453/);
});

test('a mismatch refuses and names BOTH numbers', () => {
  const r = chainBindingVerdict({ declaredChainId: 84532, rpcChainId: 8453, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, false);
  assert.match(r.message, /WRONG CHAIN/);
  assert.match(r.message, /8453/);
  assert.match(r.message, /84532/);
});

test('an UNREADABLE chain id refuses exactly like a mismatch — "I could not tell" is not "they match"', () => {
  const r = chainBindingVerdict({ declaredChainId: 8453, rpcChainId: null, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, false, 'a read that did not answer must never satisfy the binding');
  assert.match(r.message, /UNPROVEN/);
});

test('a missing or nonsense declared id refuses rather than binding to nothing', () => {
  for (const declaredChainId of [undefined, 0, -1, 'base', NaN]) {
    const r = chainBindingVerdict({
      declaredChainId: /** @type {any} */ (declaredChainId),
      rpcChainId: 8453,
      rpc: 'http://x',
      declaredBy: 'CHAIN_ID',
    });
    assert.equal(r.ok, false, `declaredChainId ${JSON.stringify(declaredChainId)} must not bind`);
  }
});

test('assertChainBinding throws ChainBindingError, and a THROWING getChainId is unreadable not agreement', async () => {
  const boom = { getChainId: async () => { throw new Error('429 rate limited'); } };
  await assert.rejects(
    () => assertChainBinding({ client: boom, declaredChainId: 8453, rpc: 'http://x', declaredBy: 'CHAIN_ID' }),
    (err) => {
      assert.ok(err instanceof ChainBindingError, 'must be the distinct class daemons re-throw');
      assert.match(err.message, /UNPROVEN/);
      return true;
    },
  );
});

test('assertChainBinding resolves on a match', async () => {
  const ok = { getChainId: async () => 4663 };
  const r = await assertChainBinding({ client: ok, declaredChainId: 4663, rpc: 'http://x', declaredBy: 'CHAIN_ID' });
  assert.equal(r.ok, true);
});

// --- the wiring, through real viem against a real socket -------------------

/**
 * A JSON-RPC endpoint that reports `chainId` and nothing else. Enough for `getChainId()`; any other
 * method returns an error, which is itself the assertion that nothing was read before the binding.
 * @param {number} chainId
 */
async function rpcServerReporting(chainId) {
  /** @type {string[]} */
  const methodsSeen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let id = 1;
      let method = '';
      try {
        const parsed = JSON.parse(body);
        id = parsed.id;
        method = parsed.method;
      } catch {
        /* fall through to the error response */
      }
      methodsSeen.push(method);
      res.setHeader('content-type', 'application/json');
      if (method === 'eth_chainId') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: '0x' + chainId.toString(16) }));
      } else {
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: `unexpected ${method}` } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    url: `http://127.0.0.1:${port}`,
    methodsSeen,
    close: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

test('the indexer REFUSES TO BUILD when the RPC answers for another chain', async () => {
  const rpc = await rpcServerReporting(8453); // Base mainnet
  try {
    const { buildIndexer } = await import('../../indexer/src/index-runner.mjs');
    await assert.rejects(
      () =>
        buildIndexer(
          {
            rpcUrl: rpc.url,
            chainId: 84532, // declared Base Sepolia — the whole defect in one line
            chainName: 'base-sepolia',
            addresses: {},
            configuredAdapters: [],
            startBlock: 0,
            statePath: 'no-such-state.json',
            confirmations: 5,
            batchBlocks: 2000,
            pollIntervalMs: 12_000,
          },
          { logger: { text: () => () => {}, warn: () => {}, info: () => {}, error: () => {} } },
        ),
      (err) => {
        assert.equal(err.name, 'ChainBindingError', `expected a ChainBindingError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /WRONG CHAIN/);
        return true;
      },
      'buildIndexer must reject — a warning that leaves the daemon polling the wrong chain is the bug, not the fix',
    );
    assert.ok(
      !rpc.methodsSeen.some((m) => m.startsWith('eth_getLogs')),
      'no logs may be fetched before the binding answers',
    );
  } finally {
    await rpc.close();
  }
});

test('the canary REFUSES TO BUILD when the RPC answers for another chain', async () => {
  const rpc = await rpcServerReporting(1); // Ethereum mainnet
  try {
    const { buildCanary } = await import('../../canary/src/canary-runner.mjs');
    await assert.rejects(
      () =>
        buildCanary(
          {
            rpcUrl: rpc.url,
            chainId: 8453,
            chainName: 'base',
            vaults: [],
            statePath: 'no-such-state.json',
            canaryStatePath: 'no-such-canary-state.json',
            pollIntervalMs: 30_000,
          },
          { log: () => {}, error: () => {}, logger: { text: () => () => {}, warn: () => {}, info: () => {}, error: () => {} } },
        ),
      (err) => {
        assert.equal(err.name, 'ChainBindingError', `expected a ChainBindingError, got ${err?.name}: ${err?.message}`);
        assert.match(err.message, /WRONG CHAIN/);
        return true;
      },
    );
  } finally {
    await rpc.close();
  }
});

test('the reference agent REFUSES when --rpc answers for a chain other than --chain-id', async () => {
  const rpc = await rpcServerReporting(8453);
  try {
    const { createChainReader } = await import('../../reference-agent/src/chain.mjs');
    const reader = createChainReader({ rpcUrl: rpc.url, chainId: 84532, chainName: 'base-sepolia' });
    await assert.rejects(
      () => reader.assertBoundToDeclaredChain(),
      (err) => {
        assert.equal(err.name, 'ChainBindingError');
        // The exact production trap: --rpc at one chain, --chain-id left at its 84532 default.
        assert.match(err.message, /reports chain id 8453/);
        assert.match(err.message, /declares chain 84532/);
        return true;
      },
    );
  } finally {
    await rpc.close();
  }
});

test('a MATCHING rpc binds and the reader keeps working — the refusal is not indiscriminate', async () => {
  const rpc = await rpcServerReporting(84532);
  try {
    const { createChainReader } = await import('../../reference-agent/src/chain.mjs');
    const reader = createChainReader({ rpcUrl: rpc.url, chainId: 84532, chainName: 'base-sepolia' });
    const bound = await reader.assertBoundToDeclaredChain();
    assert.equal(bound.ok, true);
    assert.match(bound.message, /is chain 84532/);
  } finally {
    await rpc.close();
  }
});

// `buildIndexer` and `buildCanary` are proven above by being driven through a real socket; every
// `createChainReader` caller specifically (including `run.mjs`, whose --rpc branch cannot be
// entered without standing up the whole agent) is proven at the source level, but by the
// filesystem-enumerated guard above (#293) rather than a hardcoded file list here -- a method
// nothing calls is the same defect one level up, which is the lesson
// `scripts/test/test-wiring-truth.test.mjs` exists for, and a hand-maintained count of callers is
// the defect this file shipped with.

test('an injected client is exempt — it closes no declared-versus-actual gap, and tests rely on it', async () => {
  const { createChainReader } = await import('../../reference-agent/src/chain.mjs');
  // No rpcUrl, no getChainId: nothing here resolved an RPC by chain, so there is nothing to bind.
  const reader = createChainReader({ client: { readContract: async () => 0n }, chainId: 84532 });
  const r = await reader.assertBoundToDeclaredChain();
  assert.equal(r.ok, true);
  assert.match(r.message, /client injected/);
});
