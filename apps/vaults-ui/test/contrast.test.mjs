/**
 * WCAG 2.2 AA over every colour pair the workspace actually renders.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. The ratios were computed once when the
 * masthead was ported and would have been true only on that day: every one is a
 * function of apps/site/src/tokens.css, which is shared with the marketing site
 * and edited by whoever is working on either surface. A recorded figure goes
 * stale silently; this one goes red.
 *
 * EVERY CASE RESOLVES THROUGH THE RULE, NOT THE TOKEN, AND THAT IS THE WHOLE
 * POINT OF THE SHAPE. The first version of this file asserted token values
 * directly while labelling each case with a selector:
 *
 *     ['.vault-row.is-selected border', solid('--line-focus'), SURFACE]
 *
 * which measures --line-focus and claims to measure a border. Changing
 * styles.css to `border-color: var(--line)` drops that boundary from 6.21:1 to
 * 1.33:1 and every assertion in the file stayed green, because none of them
 * read styles.css at all. Engineering found it by measuring rather than by
 * reading. Every one of the 29 cases had the same shape, so this is a fix to
 * the shape and not to the four entries that were named.
 *
 * SO A CASE NAMES A SELECTOR AND A PROPERTY, and the colour is whatever the
 * shipped stylesheet declares for it. A rule that moves to a different token
 * reds. A rule that is renamed or deleted reds by name. A token that is renamed
 * reds by name. None of those were catchable before.
 *
 * INHERITANCE IS DECLARED, NOT GUESSED. Several surfaces set no colour of their
 * own and take `body`'s. Those cases carry `inherit: true`, which still requires
 * the rule to EXIST — so a renamed class is caught — and then resolves body's
 * colour. A case without `inherit` that declares nothing is an error rather than
 * a silent fallback, because "no declaration found" and "deliberately inherits"
 * are different facts and only one of them is safe.
 *
 * HOW TO RUN IT. `npm run test:backend` from the repo root, which the gate's
 * `backend` step calls, or `node --test apps/vaults-ui/test/*.test.mjs` on its
 * own. THERE IS DELIBERATELY NO `npm test` SCRIPT IN THIS WORKSPACE:
 * scripts/test/wired-scripts.test.mjs requires every package script that runs
 * tests to be invoked by BOTH scripts/gate.mjs and .github/workflows/ci.yml, and
 * a second invocation path to the same file would have to be wired into both to
 * earn its existence. One path is enough.
 *
 * THE FAILING DIRECTIONS ARE TESTED. Two mutations at the bottom: the known-bad
 * --ink-faint value must red the text suite, and moving the selected-row border
 * to --line must red the non-text suite. The second is the regression that
 * motivated this rewrite, so it is asserted rather than described.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const TOKENS = fileURLToPath(new URL('../../site/src/tokens.css', import.meta.url));
const STYLES = fileURLToPath(new URL('../src/styles.css', import.meta.url));
const CHROME = fileURLToPath(new URL('../src/chrome.css', import.meta.url));

/** @returns {Record<string,string>} every custom property declared in tokens.css */
function readTokens(css) {
  const t = {};
  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) t[m[1]] = m[2].trim();
  assert.ok(Object.keys(t).length > 10, 'tokens.css parsed to almost nothing — the format changed');
  return t;
}

const hex = (h) => {
  const s = h.replace('#', '');
  const f = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  assert.match(f, /^[0-9a-f]{6}$/i, `not a hex colour: ${h}`);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};

const rgba = (v) => {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)/.exec(v);
  return m ? { rgb: [+m[1], +m[2], +m[3]], a: m[4] === undefined ? 1 : +m[4] } : null;
};

const parse = (v) => {
  const p = v === '#fff' || v === '#ffffff' || v === 'white'
    ? { rgb: [255, 255, 255], a: 1 }
    : v.startsWith('#') ? { rgb: hex(v), a: 1 } : rgba(v);
  assert.ok(p, `not a colour this test can read: ${v}`);
  return p;
};

/** Composite a translucent colour over an opaque one. Straight sRGB, 0-255. */
const over = (src, dst) => src.rgb.map((c, i) => c * src.a + dst[i] * (1 - src.a));

const lin = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** WCAG 2.x relative-luminance contrast. Order-independent. */
export function contrast(a, b) {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** 24px, or 18.66px bold, is "large text" and drops the requirement to 3:1. */
const required = (px, bold) => (px >= 24 || (bold && px >= 18.66) ? 3 : 4.5);

/**
 * Flatten both stylesheets into ordered {selector, body} pairs. Concatenated in
 * the order main.tsx imports them — styles.css then chrome.css — so "last
 * declaration wins" below matches the cascade for the equal-specificity
 * selectors this file names.
 */
function readRules(styles, chrome) {
  const rules = [];
  for (const raw of [styles, chrome]) {
    // COMMENTS FIRST, AND THIS IS NOT COSMETIC. Both files carry long block
    // comments immediately above the rules they explain, and the selector
    // capture below is "everything since the last brace" — so without this a
    // rule's selector reads as `/* … */\n.nav` and matches nothing by name.
    // The first run of this rewrite failed exactly there.
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const sel of m[1].split(',')) {
        const selector = sel.trim();
        // An @media prelude is not a selector; its inner rules are matched on
        // their own by the same scan.
        if (selector === '' || selector.startsWith('@')) continue;
        rules.push({ selector, body: m[2] });
      }
    }
  }
  assert.ok(rules.length > 20, 'the stylesheets parsed to almost nothing — the format changed');
  return rules;
}

function build(tokensCss, stylesCss, chromeCss) {
  const T = readTokens(tokensCss);
  const RULES = readRules(stylesCss, chromeCss);

  const tok = (n) => {
    assert.ok(n in T, `token ${n} is not declared in tokens.css`);
    return parse(T[n]);
  };

  /** The raw declared value of `prop` on `selector`, last one wins, or null. */
  function declared(selector, prop) {
    let found = null;
    for (const r of RULES) {
      if (r.selector !== selector) continue;
      const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`).exec(r.body);
      if (m) found = m[1].trim();
    }
    return found;
  }

  const ruleExists = (selector) => RULES.some((r) => r.selector === selector);

  /** Resolve a declared value — `var(--x)`, a hex, or an rgba() — to a colour. */
  function resolve(value) {
    const v = /var\(\s*(--[a-z0-9-]+)\s*\)/.exec(value);
    return v ? tok(v[1]) : parse(value);
  }

  /**
   * The colour a rule paints, read from the stylesheet. This is the function
   * that makes the whole file measure the tree rather than a transcription of
   * it — see the header.
   */
  function ruleColour({ sel, prop, inherit = false }) {
    const d = declared(sel, prop);
    if (d !== null) return resolve(d);
    assert.ok(
      ruleExists(sel),
      `no rule for \`${sel}\` in styles.css or chrome.css — it was renamed or deleted, and this ` +
        'case has been measuring nothing since. Re-point it; do not delete it.',
    );
    assert.ok(
      inherit,
      `\`${sel}\` declares no ${prop}. If that is deliberate, mark the case \`inherit: true\`; a ` +
        'silent fallback would make a missing declaration indistinguishable from an inherited one.',
    );
    const body = declared('body', 'color');
    assert.ok(body, 'body declares no color, so nothing can inherit one');
    return resolve(body);
  }

  const rgbOf = (spec) => {
    const c = ruleColour(spec);
    assert.equal(c.a, 1, `${spec.sel} ${spec.prop} is translucent and needs a backdrop`);
    return c.rgb;
  };

  const solid = (n) => {
    const p = tok(n);
    assert.equal(p.a, 1, `${n} is translucent and needs a backdrop`);
    return p.rgb;
  };

  const BG = solid('--bg');
  const SURFACE = solid('--surface');
  const SURFACE2 = solid('--surface-2');

  // The masthead is --bg's own channels at 0.78, so what shows through is
  // whatever scrolls beneath it. Both extremes are asserted.
  const BAR = parse(declared('.nav', 'background') ?? '');
  const NAV_BG = over(BAR, BG);
  const NAV_PANEL = over(BAR, SURFACE2);

  // The selected row's ground is a translucent wash the RULE picks, so it is
  // read from the rule too — a selected row that changes its fill changes what
  // its text has to clear.
  const SELECTED = over(ruleColour({ sel: '.vault-row.is-selected', prop: 'background' }), BG);

  /** @type {Array<[string, object, number[], number, boolean]>} */
  const text = [
    ['.brand-name over the page', { sel: '.brand', prop: 'color' }, NAV_BG, 16, true],
    ['.brand-name over a scrolled panel', { sel: '.brand', prop: 'color' }, NAV_PANEL, 16, true],
    ['.nav-links a at rest', { sel: '.nav-links a', prop: 'color' }, NAV_BG, 14.5, false],
    ['.nav-links a over a scrolled panel', { sel: '.nav-links a', prop: 'color' }, NAV_PANEL, 14.5, false],
    ['.nav-links a on hover', { sel: '.nav-links a:hover', prop: 'color' }, NAV_BG, 14.5, false],
    ['.nav-links a current', { sel: '.nav-links a[aria-current="page"]', prop: 'color' }, NAV_BG, 14.5, false],
    ['.nav-site over the page', { sel: '.nav-site', prop: 'color' }, NAV_BG, 14, true],
    ['.nav-site over a scrolled panel', { sel: '.nav-site', prop: 'color' }, NAV_PANEL, 14, true],
    ['.foot-links a at rest', { sel: '.foot-links a', prop: 'color' }, BG, 13.5, false],
    ['.foot-links a on hover', { sel: '.foot-links a:hover', prop: 'color' }, BG, 13.5, false],
    ['body text', { sel: 'body', prop: 'color' }, BG, 15, false],
    ['.masthead h1', { sel: '.masthead h1', prop: 'color', inherit: true }, BG, 28, true],
    ['.note', { sel: '.note', prop: 'color' }, BG, 13, false],
    ['.note.faint', { sel: '.faint', prop: 'color' }, BG, 13, false],
    ['.panel h2', { sel: '.panel h2', prop: 'color', inherit: true }, SURFACE, 16, true],
    ['.panel h3', { sel: '.panel h3', prop: 'color' }, SURFACE, 14, false],
    ['.kv dt', { sel: '.kv dt', prop: 'color' }, SURFACE, 13, false],
    ['.kv dd', { sel: '.kv dd', prop: 'color', inherit: true }, SURFACE, 15, false],
    ['.grid thead th', { sel: '.grid thead th', prop: 'color' }, SURFACE, 12.5, false],
    ['.mono', { sel: '.mono', prop: 'color', inherit: true }, SURFACE, 12.5, false],
    ['.vault-row-name at rest', { sel: '.vault-row-name', prop: 'color', inherit: true }, SURFACE, 15, true],
    ['.vault-row-meta at rest', { sel: '.vault-row-meta', prop: 'color' }, SURFACE, 12.5, false],
    ['.vault-row-name selected', { sel: '.vault-row-name', prop: 'color', inherit: true }, SELECTED, 15, true],
    ['.vault-row-meta selected', { sel: '.vault-row-meta', prop: 'color' }, SELECTED, 12.5, false],
    ['.tag label', { sel: '.tag', prop: 'color' }, SURFACE2, 12, false],
    ['.tag-warn label', { sel: '.tag-warn', prop: 'color' }, SURFACE2, 12, false],
    // THE SIGNING SURFACE — MemberActions, ProposalPanel, WalletConnect, Holdings. Added
    // 2026-09-23: until then the guard covered the ported chrome and none of the controls a
    // member signs from. Both grounds a button's label sits on are read from the rule.
    ['.btn label on its own fill', { sel: '.btn', prop: 'color' }, rgbOf({ sel: '.btn', prop: 'background' }), 14, true],
    ['.btn-ghost label on a panel', { sel: '.btn-ghost', prop: 'color' }, SURFACE, 14, true],
    ['.dim on a panel', { sel: '.dim', prop: 'color' }, SURFACE, 13, false],
    ['.proposal-title on a panel', { sel: '.proposal-title', prop: 'color', inherit: true }, SURFACE, 15, false],
    ['.act-row label on a panel', { sel: '.act-row label', prop: 'color', inherit: true }, SURFACE, 13, false],
    [
      '.act-row input text on its own fill',
      { sel: ".act-row input[type='text']", prop: 'color' },
      rgbOf({ sel: ".act-row input[type='text']", prop: 'background' }),
      14,
      false,
    ],
  ];

  /** Visual information REQUIRED to identify a component or its state: 3:1. */
  const nonText = [
    ['.vault-row.is-selected border', { sel: '.vault-row.is-selected', prop: 'border-color' }, SURFACE],
    [':focus-visible ring on the page', { sel: 'a:focus-visible', prop: 'outline' }, BG],
    [':focus-visible ring on a panel', { sel: 'a:focus-visible', prop: 'outline' }, SURFACE],
    ['.bar-for fill against its track', { sel: '.bar-for', prop: 'background' }, SURFACE2],
    // A text input's edge is what identifies it as a field at all (WCAG 2.2 1.4.11); its fill
    // is --surface-2 on a --surface panel, a step no reader can see.
    ['.act-row input boundary on a panel', { sel: ".act-row input[type='text']", prop: 'border' }, SURFACE],
    ['.btn boundary on a panel', { sel: '.btn', prop: 'border' }, SURFACE],
  ];

  return { text, nonText, rgbOf, solid, declared };
}

const CSS = readFileSync(TOKENS, 'utf8');
const STYLES_CSS = readFileSync(STYLES, 'utf8');
const CHROME_CSS = readFileSync(CHROME, 'utf8');

test('every text pair the workspace renders clears WCAG 2.2 AA', () => {
  const { text, rgbOf } = build(CSS, STYLES_CSS, CHROME_CSS);
  assert.ok(text.length >= 25, 'the case list shrank — a surface stopped being covered');
  for (const [what, spec, bg, px, bold] of text) {
    const r = contrast(rgbOf(spec), bg);
    const need = required(px, bold);
    assert.ok(r >= need, `${what}: ${r.toFixed(4)}:1 at ${px}px${bold ? ' bold' : ''}, needs ${need}:1`);
  }
});

test('every meaningful non-text boundary clears 3:1', () => {
  const { nonText, rgbOf } = build(CSS, STYLES_CSS, CHROME_CSS);
  for (const [what, spec, bg] of nonText) {
    const r = contrast(rgbOf(spec), bg);
    assert.ok(r >= 3, `${what}: ${r.toFixed(4)}:1, needs 3:1`);
  }
});

test('mutation: a token regression reds the text suite', () => {
  // --ink-faint was #5d6c8c and was a live AA failure on the marketing site at
  // the sizes it is used at. Put it back and this suite must go red.
  const broken = CSS.replace(/--ink-faint:\s*#[0-9a-f]{6};/i, '--ink-faint: #5d6c8c;');
  assert.notEqual(broken, CSS, 'the mutation changed nothing — --ink-faint was not found');

  const { text, rgbOf } = build(broken, STYLES_CSS, CHROME_CSS);
  const failures = text.filter(([, spec, bg, px, bold]) => contrast(rgbOf(spec), bg) < required(px, bold));
  assert.ok(failures.length > 0, 'a known-bad palette passed — this suite asserts nothing');
});

test('mutation: a RULE regression reds the non-text suite, which it did not before', () => {
  // THE REGRESSION THIS FILE WAS REWRITTEN FOR. The selected row's border is
  // the state indicator; moving it from --line-focus (5.89:1 on --surface) to
  // --line (1.26:1) is a real accessibility defect and the previous version of
  // this suite stayed green through it, because it read the token and never the
  // rule.
  const broken = STYLES_CSS.replace(
    /(\.vault-row\.is-selected\s*\{[^}]*?border-color:\s*)var\(--line-focus\)/,
    '$1var(--line)',
  );
  assert.notEqual(broken, STYLES_CSS, 'the mutation changed nothing — the rule was not found');

  const { nonText, rgbOf } = build(CSS, broken, CHROME_CSS);
  const failures = nonText.filter(([, spec, bg]) => contrast(rgbOf(spec), bg) < 3);
  assert.ok(failures.length > 0, 'the selected-row border dropped to 1.26:1 and this suite passed');
});

test('mutation: a renamed rule reds rather than silently inheriting', () => {
  // A case whose selector disappears must name itself, not fall back to body's
  // colour and keep passing. This is the skip-shaped failure one level up.
  const broken = STYLES_CSS.replace('.vault-row-meta {', '.vault-row-subtitle {');
  assert.notEqual(broken, STYLES_CSS, 'the mutation changed nothing — .vault-row-meta was not found');

  const { text, rgbOf } = build(CSS, broken, CHROME_CSS);
  assert.throws(
    () => text.forEach(([, spec]) => rgbOf(spec)),
    /no rule for `\.vault-row-meta`/,
    'a deleted rule did not red',
  );
});

test('the tokens file is the shared one, not a copy inside this app', () => {
  assert.match(TOKENS.replace(/\\/g, '/'), /apps\/site\/src\/tokens\.css$/);
  const local = new URL('../src/tokens.css', import.meta.url);
  assert.throws(() => readFileSync(local), /ENOENT/, 'a second palette appeared inside apps/vaults-ui');
});
