/**
 * WCAG 2.2 AA over every colour pair the workspace chrome actually renders.
 *
 * WHY THIS IS A TEST AND NOT A NOTE. The ratios were computed once when the
 * masthead was ported and would have been true only on that day: every one of
 * them is a function of apps/site/src/tokens.css, which is shared with the
 * marketing site and is edited by whoever is working on either surface. A
 * recorded figure goes stale silently; this one goes red.
 *
 * IT PARSES THE SHIPPED TOKENS FILE. No hex value below is retyped from the
 * palette, so the test measures the tree rather than a transcription of it, and
 * a token that is renamed or deleted throws by name instead of quietly reading
 * as black.
 *
 * HOW TO RUN IT. `npm run test:backend` from the repo root, which the gate's
 * `backend` step calls, or `node --test apps/vaults-ui/test/*.test.mjs` on its
 * own. THERE IS DELIBERATELY NO `npm test` SCRIPT IN THIS WORKSPACE:
 * scripts/test/wired-scripts.test.mjs requires every package script that runs
 * tests to be invoked by BOTH scripts/gate.mjs and .github/workflows/ci.yml, and
 * a second invocation path to the same file would have to be wired into both to
 * earn its existence. One path is enough.
 *
 * THE FAILING DIRECTION IS TESTED TOO. `mutation` at the bottom re-runs the same
 * assertion against a deliberately broken value and requires it to fail. A
 * contrast check that passes whatever the palette says is decoration.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';

const TOKENS = fileURLToPath(new URL('../../site/src/tokens.css', import.meta.url));

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
  const p = v.startsWith('#') ? { rgb: hex(v), a: 1 } : rgba(v);
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

function build(css) {
  const T = readTokens(css);
  const tok = (n) => {
    assert.ok(n in T, `token ${n} is not declared in tokens.css`);
    return parse(T[n]);
  };
  const solid = (n) => {
    const p = tok(n);
    assert.equal(p.a, 1, `${n} is translucent and needs a backdrop`);
    return p.rgb;
  };

  const BG = solid('--bg');
  const SURFACE = solid('--surface');
  const SURFACE2 = solid('--surface-2');
  const INK = solid('--ink');
  const DIM = solid('--ink-dim');

  // The masthead is --bg's own channels at 0.78, so what shows through is
  // whatever scrolls beneath it. Both extremes are asserted.
  const BAR = parse('rgba(7, 11, 24, 0.78)');
  const NAV_BG = over(BAR, BG);
  const NAV_PANEL = over(BAR, SURFACE2);
  const SELECTED = over(tok('--blue-soft'), BG);

  /** @type {Array<[string, number[], number[], number, boolean]>} */
  const text = [
    ['.brand-name over the page', INK, NAV_BG, 16, true],
    ['.brand-name over a scrolled panel', INK, NAV_PANEL, 16, true],
    ['.nav-links a at rest', DIM, NAV_BG, 14.5, false],
    ['.nav-links a over a scrolled panel', DIM, NAV_PANEL, 14.5, false],
    ['.nav-links a current/hover', INK, NAV_BG, 14.5, false],
    ['.nav-site over the page', INK, NAV_BG, 14, true],
    ['.nav-site over a scrolled panel', INK, NAV_PANEL, 14, true],
    ['.foot-links a at rest', DIM, BG, 13.5, false],
    ['.foot-links a on hover', INK, BG, 13.5, false],
    ['body text', INK, BG, 15, false],
    ['.masthead h1', INK, BG, 28, true],
    ['.note', DIM, BG, 13, false],
    ['.note.faint', solid('--ink-faint'), BG, 13, false],
    ['.panel h2', INK, SURFACE, 16, true],
    ['.panel h3', DIM, SURFACE, 14, false],
    ['.kv dt', DIM, SURFACE, 13, false],
    ['.kv dd', INK, SURFACE, 15, false],
    ['.grid thead th', DIM, SURFACE, 12.5, false],
    ['.mono', INK, SURFACE, 12.5, false],
    ['.vault-row-name at rest', INK, SURFACE, 15, true],
    ['.vault-row-meta at rest', DIM, SURFACE, 12.5, false],
    ['.vault-row-name selected', INK, SELECTED, 15, true],
    ['.vault-row-meta selected', DIM, SELECTED, 12.5, false],
    ['.tag label', solid('--blue-bright'), SURFACE2, 12, false],
    ['.tag-warn label', solid('--warn'), SURFACE2, 12, false],
  ];

  /** Visual information REQUIRED to identify a component or its state: 3:1. */
  const nonText = [
    ['.vault-row.is-selected border', solid('--line-focus'), SURFACE],
    [':focus-visible ring on the page', solid('--blue-bright'), BG],
    [':focus-visible ring on a panel', solid('--blue-bright'), SURFACE],
    ['.bar-for fill against its track', solid('--blue'), SURFACE2],
  ];

  return { text, nonText };
}

const CSS = readFileSync(TOKENS, 'utf8');

test('every text pair the workspace renders clears WCAG 2.2 AA', () => {
  const { text } = build(CSS);
  assert.ok(text.length >= 25, 'the case list shrank — a surface stopped being covered');
  for (const [what, fg, bg, px, bold] of text) {
    const r = contrast(fg, bg);
    const need = required(px, bold);
    assert.ok(r >= need, `${what}: ${r.toFixed(4)}:1 at ${px}px${bold ? ' bold' : ''}, needs ${need}:1`);
  }
});

test('every meaningful non-text boundary clears 3:1', () => {
  const { nonText } = build(CSS);
  for (const [what, fg, bg] of nonText) {
    const r = contrast(fg, bg);
    assert.ok(r >= 3, `${what}: ${r.toFixed(4)}:1, needs 3:1`);
  }
});

test('mutation: the same assertion fails when a token is broken', () => {
  // --ink-faint was #5d6c8c and was a live AA failure on the marketing site at
  // the sizes it is used at. Put it back and this suite must go red; if it does
  // not, the check above is not reading the file it claims to read.
  const broken = CSS.replace(/--ink-faint:\s*#[0-9a-f]{6};/i, '--ink-faint: #5d6c8c;');
  assert.notEqual(broken, CSS, 'the mutation changed nothing — --ink-faint was not found');

  const { text } = build(broken);
  const failures = text.filter(([, fg, bg, px, bold]) => contrast(fg, bg) < required(px, bold));
  assert.ok(failures.length > 0, 'a known-bad palette passed — this suite asserts nothing');
});

test('the tokens file is the shared one, not a copy inside this app', () => {
  assert.match(TOKENS.replace(/\\/g, '/'), /apps\/site\/src\/tokens\.css$/);
  const local = new URL('../src/tokens.css', import.meta.url);
  assert.throws(() => readFileSync(local), /ENOENT/, 'a second palette appeared inside apps/vaults-ui');
});
