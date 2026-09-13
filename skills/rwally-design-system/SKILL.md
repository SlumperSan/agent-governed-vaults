---
name: rwally-design-system
description: The visual and motion system for the rwally.com redesign — dark cinematic, self-hosted React. Load before designing or building any component, page, animation, or shader for apps/site-next. Encodes the owner's two decisions (self-hosted React; dark cinematic), the security envelope the build must stay inside, the token system, the motion grammar, and the performance and accessibility budgets.
---

# rwally design system: dark cinematic, self-hosted

## The two decisions (owner, 2026-09-04)

1. **Self-hosted React.** rwally.com becomes a Vite + React site built to static output. It keeps
   "no external requests" and drops only "zero JavaScript".
2. **Dark cinematic.** Near-black ground, luminous data, one hero moment that makes a first-time
   visitor say *wow*, scroll-driven reveals, restraint everywhere else.

## The security envelope: non-negotiable, enforced by `_headers`

The current CSP is `default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'`. The new one makes five relaxations and no others: it
adds `script-src 'self'`, `font-src 'self'`, `connect-src 'self'` and `worker-src 'self'` (each
previously `'none'` by inheritance from `default-src`) and widens `img-src` with `data:`. Nothing
else moves:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

### CSP traps in this exact stack (checked against the installed packages)

- `@react-three/drei` ships hardcoded CDN defaults: `Gltf` (draco decoders from
  `www.gstatic.com`), `Ktx2` and `MatcapTexture` (`cdn.jsdelivr.net`), `Cloud` and `NormalTexture`
  (`rawcdn.githack.com`), `FaceLandmarker` (`storage.googleapis.com`) and `<Environment preset>`
  (HDRIs from `githack.com`). Under this CSP each fails loudly at runtime. Use drei helpers that
  take a local path, or pass a same-origin path prop; the hero field needs none of these.
- `motion` core (`animate`, `motion.*`) sets styles through the CSSOM and is fine. Its View
  Transitions helper injects a `<style>` element and is blocked by `style-src 'self'`; do not use
  it. `gsap` has the same problem only in `GSDevTools`, a dev-only plugin.
- `@fontsource-variable/newsreader` and `@fontsource-variable/ibm-plex-sans` expose only axis
  entries (`index.css`, `wght.css`, `opsz.css` or `wdth.css`, `standard.css`, and their italics) and
  no per-subset entry; each ships every script subset (18 and 36 files in `files/`, measured). To
  ship Latin only, write the `@font-face` yourself against `files/<family>-latin-wght-normal.woff2`
  (and the italic file). `@fontsource/ibm-plex-mono` is a static face, not a variable one, and does
  have `latin-400.css` and `latin-500.css`.

Consequences a component author must design around:

- **No CDN, no Google Fonts, no analytics, no remote images, no `unsafe-inline`.** Fonts are
  `@fontsource` packages bundled into `dist/`. Every asset ships from this origin.
- **No inline `style=` attributes and no inline `<script>`**: CSP refuses them. Motion libraries
  that set `style` via JS are fine (that is CSSOM, not the attribute in HTML). Vite's default
  injected module script is fine (`'self'`). Anything needing `'unsafe-inline'` or `'unsafe-eval'`
  is out; if a library demands it, pick another library.
- **WebGL is allowed** (`worker-src 'self'`, no eval). Three.js / R3F ship as bundled modules.
- **Still zero third parties.** No `preconnect`, no `<link rel=stylesheet href=https://…>`.
- The guards do NOT test the build output today: `site.test.mjs` reads a hardcoded list of seven
  prose `.html` files and `claims-lede-truth` walks source by extension, and a client-rendered
  `dist/index.html` has no prose to test. Until a prerender step exists, the rendered-DOM check in
  `visual-verify-loop` step 4 is the substitute. One forward collision to plan for: `site.test.mjs`
  asserts that `tokens.css` uses system font stacks only, and this skill prescribes Newsreader and
  IBM Plex; re-pointing that test means rewriting that assertion, not deleting it.

## Tokens

Start from Vault Atlas (`apps/web/index.html`, the `:root` block) so the app and site share a
family, then commit to dark:

| token | value | note |
|---|---|---|
| `--ground` | `#07070b` | near-black, not pure black: pure `#000` banding on OLED gradients |
| `--surface` | `#0e0e16` | cards, nav |
| `--surface-2` | `#16161f` | raised |
| `--line` | `rgba(255,255,255,.08)` | hairlines only |
| `--ink` | `#eaeaf3` | body |
| `--muted` | `#a8a8bd` | secondary |
| `--accent` | `#a094ff` | the Atlas violet, dark-mode value: ONE accent, used for data and focus |
| `--good` / `--warn` / `--crit` | `#5fd89a` / `#f2c14e` / `#ff8b83` | status only, never decoration |
| `--display` | `'Newsreader Variable', Georgia, serif` | bundled via `@fontsource-variable/newsreader` |
| `--sans` | `'IBM Plex Sans Variable', system-ui, sans-serif` | `@fontsource-variable/ibm-plex-sans` |
| `--mono` | `'IBM Plex Mono', ui-monospace, monospace` | numbers, addresses, code |

Contrast: every ink-on-surface pair ≥ 4.5:1. The Atlas block already satisfies this in dark.

Type scale: display at 64/72/96 with tight tracking (`-0.02em`) and serif; body 16–18 sans at
1.6; numbers ALWAYS mono with `font-variant-numeric: tabular-nums` so animated counters do not
jitter.

## The hero: where the wow lives

One idea, executed precisely, beats five effects. The thesis is *the first agent-aggregated index*
(owner decision `product-thesis-agent-aggregated-index`). The hero should make that visible:

- A WebGL field of constituents (R3F): points/instances whose position and luminance are driven
  by weight and conviction, drifting under a slow orbital camera. Not a generic particle cloud: the
  data must be legible as *an index being formed*.
- One headline in serif, one line, centered, that a member could quote. Copy goes through the
  claims contract before it renders.
- A single restrained CTA. Ondo's structure: nav · headline · CTA · "scroll to explore" · logo strip.
  We have no partner logos and must not fake any. The strip is replaced by three verifiable facts
  (contracts immutable, member-governed, source-available) each linking to the evidence.
- Reduced motion: the field renders **static**, the counters render final values, the camera does
  not move. `prefers-reduced-motion` is a first-class state, not a fallback.

## Motion grammar

- **Motion (framer)** for component and layout animation, `AnimatePresence` for every conditional
  render.
- **GSAP + ScrollTrigger** for scroll sequences and pinned sections only.
- **Lenis** for scroll feel. Sync GSAP's ticker to it; never run two scroll loops.
- **R3F** for the hero and nothing else. One canvas. Suspend and lazy-load it; the page must be
  readable before the shader compiles.
- Easing: `[0.16, 1, 0.3, 1]` for enters, `[0.7, 0, 0.84, 0]` for exits. Durations 0.4–0.8s for
  UI, 1.2–2s for hero reveals. Nothing bounces.
- Every animated number is `tabular-nums` and animates value, never layout.
- Hover states change luminance, not size. Focus rings use `--accent` at 2px offset and are never
  removed.

## Budgets

- LCP < 2.0s on a mid-range phone, INP < 200ms, CLS 0. The hero canvas must not block LCP: render
  the headline first, mount the canvas after `requestIdleCallback`.
- Initial JS ≤ 180 KB gzip excluding the lazily-loaded hero chunk; hero chunk ≤ 350 KB gzip.
- Fonts: two variable faces, subset to Latin, `font-display: swap`.
- 60fps on the scroll path. Profile with the Chrome DevTools MCP before calling a section done.

## What "custom" means here

No shadcn, no template hero, no stock gradient blob, no "trusted by" logos we do not have, no
number we cannot cite. The distinctiveness comes from the serif-on-black typography, the
data-driven hero, and copy that is true.
