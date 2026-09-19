/**
 * Every control on this site, measured against the palette it is drawn from.
 *
 * WHY THIS EXISTS. On 2026-09-19 all three of this site's button rules were measured and all three
 * failed WCAG 2.2 — the filled label at 4.4988:1, its hover at 3.1626:1, and the ghost variant's
 * identifying border at 1.3321:1. None of that was new code. Two of the three had been in the tree
 * since the blue/white rebuild, and the first was *recorded in tokens.css as passing*, because
 * 4.4988 had been written down once as "4.50:1, passing by 0.00" and never recomputed.
 *
 * SO THE FIGURE IS NOT WRITTEN DOWN ANY MORE; IT IS COMPUTED. This file parses tokens.css and
 * base.css, resolves each rule's foreground and background to the values that actually ship, and
 * asserts the ratio. A comment cannot go stale against the file it describes when the assertion
 * reads the file.
 *
 * IT READS THE CSS RATHER THAN dist/. The built stylesheet is the same declarations with the same
 * values; parsing the source is what lets a failure name the rule that broke rather than a byte
 * offset. `test/site.test.mjs` next door reads `dist/` for the opposite reason: it is checking that
 * content REACHED the page, which is a question about the build. This is a question about values.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TOKENS = readFileSync(path.join(APP, 'src', 'tokens.css'), 'utf8');
const BASE = readFileSync(path.join(APP, 'src', 'base.css'), 'utf8');
const SECTIONS = readFileSync(path.join(APP, 'src', 'sections.css'), 'utf8');

function tokenMap(css) {
  const t = new Map();
  for (const m of css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gim)) t.set(m[1], m[2].trim());
  assert.ok(t.size > 10, 'tokens.css parsed to almost nothing — its format changed');
  return t;
}
const T = tokenMap(TOKENS);

const hex = (h) => {
  const s = h.replace('#', '');
  const f = s.length === 3 ? [...s].map((c) => c + c).join('') : s;
  assert.match(f, /^[0-9a-f]{6}$/i, `not a hex colour: ${h}`);
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
};

/** A token name, a #hex, or `white`. Refuses anything it cannot resolve rather than guessing. */
function colour(v) {
  if (v === 'white' || v === '#fff' || v === '#ffffff') return [255, 255, 255];
  if (v.startsWith('--')) {
    assert.ok(T.has(v), `${v} is not declared in tokens.css`);
    return colour(T.get(v));
  }
  assert.ok(v.startsWith('#'), `not an opaque colour: ${v}`);
  return hex(v);
}

const lin = (c) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * Pull one declaration out of one rule, so the test breaks when the RULE changes rather than only
 * when a token does. `.btn:hover { background: var(--blue-bright) }` was the whole of the worst of
 * the three failures, and no token was wrong.
 */
function declaration(selector, prop) {
  const rule = new RegExp(
    `(?:^|\\})\\s*${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\{([^}]*)\\}`,
    'm',
  ).exec(BASE);
  assert.ok(rule, `no rule for ${selector} in base.css — it was renamed or removed`);
  const decl = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`, 'm').exec(rule[1]);
  assert.ok(decl, `${selector} declares no ${prop}`);
  const value = decl[1].trim();
  const v = /var\(\s*(--[a-z0-9-]+)\s*\)/.exec(value);
  return v ? v[1] : value;
}

/**
 * THE GROUNDS ARE ENUMERATED FROM THE STYLESHEETS, NOT TYPED HERE.
 *
 * A list of three surface names in a test file is a list that stops being true the day somebody
 * adds a fourth, and the failure is silent: the new ground is simply never measured. So this reads
 * every `background` declaration in base.css and sections.css, keeps the ones that resolve to an
 * opaque token, and returns that set. A surface a button can land on is, by definition, one the
 * stylesheet paints.
 *
 * THIS IS THE LESSON FROM THE VALUE THAT DID NOT SHIP. `#2559d6` was chosen against `--bg` alone:
 * white at 6.04, edge at 3.25, both fine. Against `--surface-2` its edge is 2.85 and the control
 * disappears. A band measured against one ground is true and useless.
 */
function paintedGrounds() {
  const grounds = new Set();
  for (const css of [BASE, SECTIONS]) {
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const selector = m[1].trim();
      // A CONTROL'S OWN FILL IS NOT A GROUND. `.btn` paints --blue-control, which would otherwise
      // come back as a surface and be measured against itself. The discriminator is the SELECTOR
      // rather than a list of token names, so a new control variant is excluded automatically and
      // a new page surface is included automatically.
      if (selector.includes('.btn')) continue;
      // A PSEUDO-ELEMENT IS A DRAWING, NOT A CONTAINER. `.phase::before` paints --blue as a
      // timeline dot; nothing is ever laid out inside it, so it is not a ground a control can
      // land on. Same test as above and for the same reason: it reads the selector, so a new
      // decoration is excluded on the commit that adds it.
      if (selector.includes('::')) continue;
      for (const d of m[2].matchAll(/background(?:-color)?:\s*var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
        const name = d[1];
        const raw = T.get(name);
        // A LINE TOKEN PAINTED AS A BACKGROUND IS STILL A LINE. This palette draws 1px rules and
        // grid hairlines by giving a container `background: var(--line)` and its children
        // `var(--surface)`, so --line shows up as a "painted background" on six containers and is
        // nowhere a control can sit — it is 1px wide. Excluding it by its name in the palette's
        // own vocabulary is the honest discriminator; excluding it by listing the six selectors
        // would go stale on the seventh.
        if (name.includes('line')) continue;
        // Gradients, `transparent` and rgba() washes are not grounds a solid edge is judged
        // against; a translucent layer is measured through its own composite where it matters.
        if (raw && raw.startsWith('#')) grounds.add(name);
      }
    }
  }
  // The page's own ground is painted on `body`, which the loop above catches, but assert it rather
  // than assume that selector never changes.
  // NON-VACUITY, THREE WAYS, because a scan that quietly returns fewer grounds than there are is
  // indistinguishable from a passing test. The page's own ground and the whole surface ramp must
  // come back, and the ramp is enumerated from tokens.css rather than named here.
  assert.ok(grounds.has('--bg'), '--bg is not painted as a background anywhere — the scan is broken, not clean');
  for (const name of T.keys()) {
    if (!name.startsWith('--surface')) continue;
    assert.ok(grounds.has(name), `${name} is declared in the palette but the ground scan never found it painted`);
  }
  assert.ok(grounds.size >= 3, `only ${grounds.size} painted ground(s) found; these stylesheets paint more than that`);
  return [...grounds];
}


test('a filled control carries its label at AA, at rest and on hover', () => {
  // 15px semibold is below the 18.66px large-text allowance, so the bar is 4.5:1 in both states.
  for (const [what, sel] of [
    ['.btn', '.btn'],
    ['.btn:hover', '.btn:hover'],
  ]) {
    const fill = colour(declaration(sel, 'background'));
    const label = colour(sel === '.btn' ? declaration('.btn', 'color') : '#fff');
    const r = contrast(label, fill);
    assert.ok(r >= 4.5, `${what}: label is ${r.toFixed(4)}:1 on its fill, needs 4.5:1`);
  }
});

test("a filled control's own edge is visible against every ground it sits on", () => {
  const grounds = paintedGrounds();
  for (const sel of ['.btn', '.btn:hover']) {
    const fill = colour(declaration(sel, 'background'));
    for (const ground of grounds) {
      const r = contrast(fill, colour(ground));
      assert.ok(r >= 3, `${sel} on ${ground}: ${r.toFixed(4)}:1, needs 3:1 — the button is invisible`);
    }
  }
});

test('a ghost control is identified by its border, so the border clears 3:1', () => {
  // .btn-ghost has no fill. Its border is the entire affordance, which is exactly the "visual
  // information required to identify a user interface component" SC 1.4.11 covers.
  const rest = colour(declaration('.btn-ghost', 'border-color'));
  for (const ground of paintedGrounds()) {
    const r = contrast(rest, colour(ground));
    assert.ok(r >= 3, `.btn-ghost border on ${ground}: ${r.toFixed(4)}:1, needs 3:1`);
  }
  // Its hover ground is --surface-2, declared by the same rule.
  const hover = colour(declaration('.btn-ghost:hover', 'border-color'));
  const hoverBg = colour(declaration('.btn-ghost:hover', 'background'));
  assert.ok(
    contrast(hover, hoverBg) >= 3,
    `.btn-ghost:hover border is ${contrast(hover, hoverBg).toFixed(4)}:1 on its own hover fill`,
  );
  assert.ok(
    contrast(colour(declaration('.btn-ghost', 'color')), hoverBg) >= 4.5,
    '.btn-ghost label fails AA on its hover fill',
  );
});

test('the focus ring is visible on every surface it can land on', () => {
  const ring = /a:focus-visible[^{]*\{[^}]*outline:\s*\d+px\s+solid\s+var\(\s*(--[a-z0-9-]+)\s*\)/m.exec(BASE);
  assert.ok(ring, 'no :focus-visible outline in base.css');
  // `outline-offset: 3px` puts the ring OUTSIDE the element, so it is judged against the ground the
  // element sits on rather than against the element's own fill. That offset is load-bearing: at 0
  // the ring on a primary button would be --blue-bright over --blue-control, 1.70:1, effectively
  // invisible on the one control it matters most on.
  assert.match(BASE, /focus-visible[^{]*\{[^}]*outline-offset:\s*[1-9]/m, 'the focus ring lost its offset');
  for (const ground of paintedGrounds()) {
    const r = contrast(colour(ring[1]), colour(ground));
    assert.ok(r >= 3, `focus ring on ${ground}: ${r.toFixed(4)}:1, needs 3:1`);
  }
});

test('mutation: each assertion fails against the values that were there before the fix', () => {
  // The three rules as they shipped until 2026-09-19. If any of these now reads as passing, the
  // corresponding check above is measuring something other than what it claims to.
  const W = [255, 255, 255];
  assert.ok(contrast(W, colour('--blue')) < 4.5, '#fff on --blue should still be below AA');
  assert.ok(contrast(W, colour('--blue-bright')) < 4.5, '#fff on --blue-bright should still be below AA');
  assert.ok(contrast(colour('--line'), colour('--bg')) < 3, '--line should still be below the non-text floor');
  // And the new values must not merely be different — they must clear it.
  assert.ok(contrast(W, colour('--blue-control')) >= 4.5);
  assert.ok(contrast(W, colour('--blue-control-hover')) >= 4.5);
  assert.ok(contrast(colour('--line-control'), colour('--bg')) >= 3);
});

test('--blue is still the brand accent and is still used only where nothing reads on it', () => {
  // The fix deliberately did NOT move --blue: it is the mark's gradient and the base of
  // --blue-soft and --blue-line, none of which carries a label. This asserts the split holds —
  // if --blue comes back as a control fill, the first test would catch the label and this
  // catches the intent.
  assert.equal(T.get('--blue'), '#2f6bff', '--blue moved; if that was deliberate, re-measure everything that reads it');
  assert.notEqual(declaration('.btn', 'background'), '--blue', '.btn went back to the brand accent as a fill');
});
