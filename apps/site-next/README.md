# `apps/site-next` — the public site, rebuilt

Eight pages, built from React to static HTML, serving from one origin with no third party in the
path. It replaces `apps/site` when it is finished; until then `apps/site` is what rwally.com serves
and this directory is not deployed.

Four owner decisions of 2026-09-04 shape everything here: **self-hosted React**, **dark
cinematic**, **no per-claim review markers**, and **the status block is a footer link rather than a
band on every page**. The first keeps "no external request" and drops only "zero JavaScript". The second is
why there is one ground colour and no light palette.

## It is a multi-page build, and it prerenders

There is no router and no client navigation. `vite.config.ts` names eight root-level entry HTMLs, so
`dist/` carries eight flat files with exactly the filenames the current site uses — `dist/risks.html`,
never `dist/risks/index.html`. Internal links keep the `.html` suffix; Cloudflare Pages already 301s
`/risks.html` onto `/risks`.

`npm run build` is four steps in order:

```
tsc -b                  type-check
vite build              the client bundles and the eight HTML files
vite build --ssr        the server bundle, into dist-ssr/ (never deployed)
node scripts/prerender.mjs   render each page and splice the markup into dist/
```

**The prerender is not an optimisation.** Everything that checks this site reads the built HTML as
text: the counted footer sentences, the status band on `status.html`, exactly one `<h1>`,
`<main id="main">`, the position of the skip link, the reference-configuration table rows matched
with no whitespace between the tags, and the fifteen risk article ids. A client-rendered app
ships `<div id="root"></div>` and fails every one of them. So the markup is in the file, and the
browser's job is to hydrate what is already there.

Three rules follow from that, and each fails silently rather than loudly:

1. **No copy is conditionally rendered.** Nothing behind scroll state, an IntersectionObserver, or a
   React-state accordion. Use `<details>`/`<summary>` open in the prerendered markup where a
   disclosure affordance is wanted.
2. **No initial render branches on `matchMedia` or on viewport width.** The server cannot know
   either, React discards the mismatched subtree, and that subtree is the markup the guards read.
   Responsive decisions go in CSS; motion decisions go in an effect.
3. **Eight flat files at the root of `dist/`.**

## Layout, and who owns what

```
index.html … status.html   eight entry HTMLs: head metadata, one #root div, one module script
src/entry-<page>.tsx       eight thin client entries
src/entry-server.tsx       render(pageId) — the interface the prerender calls
src/main.tsx               shared bootstrap; hydrates, imports the three stylesheets
src/tokens.css             the palette, type scale, rhythm and motion curves
src/fonts.css              three hand-written @font-face rules
src/index.css              reset, element defaults, and the shared surfaces
src/shell/                 status band, masthead, footer, skip link, PageShell, PinnedText, pinned.ts
src/motion/                Reveal, LenisProvider, useScrollTimeline, useReducedMotion, easings
src/brand/                 the mark: markPath.ts is the data, Mark.tsx draws it, mark.svg is the artwork
src/assets/                manifest.ts — every picture on the site, declared once — and Backdrop
src/sections/<key>/        one directory per section — see that directory's README
src/pages/*.tsx            eight composition files — see that directory's README
public/                    _headers, _redirects, robots.txt, sitemap.xml, llms.txt, favicons, og card
public/media/              the section backdrops and the one clip, named only by src/assets/manifest.ts
functions/_middleware.js   the canonical-host redirect
scripts/prerender.mjs      the fourth build step
```

A file has exactly one owner. Shell owns everything above `src/sections/` and `src/pages/`; a
section owns its own directory and nothing else; Integrate owns the eight page files and nothing
else. Two agents editing one file is how a pinned sentence drifts.

**Two placement facts, each worth a deploy cycle if got wrong.** `_headers` and `_redirects` live in
`public/`, because Pages reads them from the root of the served directory, which is the build output.
`functions/` lives at the project root, because Pages reads that from the project rather than from
the output. The middleware is not cosmetic: it 301s the `*.rwally.pages.dev` hostnames onto
rwally.com, and the sanctions geofence is a WAF rule on the rwally.com zone that the pages.dev
hostnames are not in. Losing it in the move reopens an unfiltered path to the same content.

## Every request is same-origin

The Content-Security-Policy in `public/_headers` is `default-src 'none'` with exactly two relaxations
against the previous site's: `script-src 'self'` for the built module scripts, and, since 2026-09-05,
`media-src 'self'` for the one background clip. No `unsafe-inline`, no `unsafe-eval`, no `blob:`, no
CDN, no font host, no analytics. Both new directives are `'self'`; nothing in the policy is `*`. Two build settings exist to keep the output inside that envelope, and both
are commented where they are set: `build.modulePreload.polyfill` is false, because Vite's polyfill is
an inline script the browser would refuse; and `build.assetsInlineLimit` is `0`, because `font-src
'self'` does not permit `data:`.

The three type families are bundled from `@fontsource` packages, with the `@font-face` rules written
out by hand against the latin `.woff2` files. Importing a package's own stylesheet pulls five subsets
where this site needs one.

Sign-off is against **served `dist/`**, never the dev server: the policy and the asset paths differ.
The network panel must show zero non-self hosts. One request to a font host is a rejection.

## What is still owed, and by whom

- The sections and the eight page files. Until a page's hero lands it has no `<h1>`, so the
  document-skeleton check cannot pass for it yet. That is expected; it is not something to paper
  over from a page file.
- `faq.html` must carry each of the two standing-fact footer sentences **twice**, and the second
  copy of each lives inside an answer body. The shell renders one of each, so a shell-only
  `faq.html` reads one and one. That second pair is the FAQ section's obligation, not the footer's.
- The middleware test. `functions/_middleware.js` is here and is byte-identical to
  `apps/site/functions/_middleware.js`, but nothing in this directory tests it: `test/` holds
  `site.test.mjs` and nothing else, and `apps/site/test/middleware.test.mjs` still reads the copy
  under `apps/site`. It is owed in the change that stops serving `apps/site` — a middleware left
  behind under test at its old path is a middleware nobody is testing at the path that is served.

## What has landed

- **The scroll-scrub hero is dropped for good, and the hero moves anyway.** Owner decision,
  2026-09-05: keep the strict CSP, put the brand's autoplaying loop behind the headline, and stop
  treating the scroll-scrubbed film as deferred. It is not deferred, it is impossible here — the
  Higgsfield prototype's own audit records that it needs about 21 KB of JavaScript, Blob URLs, video
  decode and `media-src blob:`, and that under `default-src 'none'` it cannot exist. The choice was
  between relaxing the policy this site's main claim about itself rests on and shipping a looping
  clip; the clip won.
- **The WebGL hero field is gone with it.** `hero3d/` is deleted, and `three`, `@react-three/fiber`,
  `@react-three/drei` and `@types/three` are out of `package.json`. The clip is 301,702 B against
  that chunk's 894,420 B, it needs no error boundary because a `<video>` that fails leaves its
  poster on screen, and the contrast floor behind the hero copy is now the one bound stated once in
  `src/assets/backdrop.module.css` rather than four hundred lines of gradient arithmetic that had
  been recomputed three times.
- **The site is called Rwally.** The masthead is the comic horizontal lockup at 48px on desktop and
  the ledger R beside the name in text below 52rem; both are in the markup at every width and CSS
  chooses, because branching the tree on the viewport is the hydration mismatch `App.tsx` forbids.
  Titles end ` — Rwally`. "Agent-Governed Vaults" survives only as the descriptor line, rendered
  once per page in the footer.
- **`risks.html` is now `disclaimers.html`**, in the footer rather than the header nav, which is why
  `NAV` carries seven and `FOOTER_PAGES` carries nine. Nine pages since `vision.html` landed.
- **The brand's secondary hue is in the theme.** `--teal` and `--teal-bright`, adopted from the
  brand token set with both ratios recomputed here (8.30:1 and 12.72:1 on the ground). It has one
  job, which that set states: the second state in a pair. It is not a fourth status colour.
- **The brand line icons are inline SVG**, declared once as path data in `src/brand/icons.ts` so
  one CSS rule colours them through `currentColor`. Six are on the how-it-works lifecycle steps and
  four on the agents entry points; the reveal step takes `--teal`, which is the one job the brand
  token set gives that hue — "the second state in any pair". One lifecycle step, Quorum, is
  deliberately bare: nothing in the set draws a count of stake, and a wrong icon is worse than none.
- **`vision.html` exists as a route with a placeholder body.** The copy deck writes that page; the
  entry, the nav slot, the sitemap entry and the build wiring are in place and guarded so the words
  are the only thing the deck has to add.
- **The masthead has an App slot that renders nothing** until `app.rwally.com` exists. `APP_NAV.href`
  is `null`, and `Masthead` emits no element at all rather than hiding one — a hidden link still
  reaches a screen reader, a crawler and the link guards.

- **The brand mark, at the size the brand says to use it.** Owner rule, 2026-09-05: the illustrated
  comic lockup is the logo everywhere except favicon and small-avatar sizes, where it collapses, and
  there the ledger R is. The masthead is such a size — `.brand-mark` renders about 18 CSS pixels
  tall — so it draws the ledger R beside the site name set as live text in the page's own display
  face. The path is declared once in `src/brand/markPath.ts`, is byte-identical to the one in the
  brand set's own favicon, and is copied into `src/brand/mark.svg` and `public/favicon.svg`, which
  cannot import it; the test named `the brand mark is one path, drawn the same in all three files`
  reds when they disagree. `public/favicon.ico` is rebuilt from that path at 16 and 32 with a
  transparent ground.
- **The accent that failed its floor is gone.** `--accent-dim` was `#6f62d6`, which measures 4.21:1
  on the ground: over the 3:1 non-text floor, under 4.5:1, and fenced off from text by a comment.
  The brand token set of 2026-09-05 retires it from every UI role for that reading and raises the
  same hue to `#8577e4` at 5.51:1. `src/tokens.css` carries the new value with both ratios
  recomputed here rather than copied, and the fence is gone with the reason for it.
- **Every picture is declared in one file.** `src/assets/manifest.ts` names each slot — hero,
  the four section backdrops, the one clip — and `Backdrop`/`MotionBackdrop` are the only things
  that read it. No section names a file, no stylesheet names a file. Replacing the visual set is an
  edit to that manifest and to `public/media/`, and to nothing else. The set now in `public/media/`
  is a placeholder: it carries no lettering, which is checked by eye and recorded in the manifest,
  so it adds no claim to any page it sits behind.
- **status.html is built like the other seven again.** For one day its entry held nothing but
  side-effect CSS imports; rolldown emits no chunk for such an entry, so the page shipped with no
  module script and five of its six stylesheets missing. It is now the same three lines as every
  other entry, and `every class in a built page is defined in a stylesheet that page links` is the
  guard that reds on that whole failure mode rather than on that one file.

- **The per-claim review markers are gone from this directory.** The owner removed them on
  2026-09-04. The two uses and the component that emitted them are deleted, the wrapper rule they
  needed went with them out of `src/index.css`, and `src/sections/risks-review-status/__probe.mjs`
  now asserts the absence of the token rather than one marker's presence. `test/site.test.mjs` reds on
  the token anywhere under `src/`, `test/`, `scripts/` or `dist/`, so the habit cannot come back one
  section at a time.
- **The repository-wide walk covers every prerendered page.**
  `scripts/test/claims-lede-truth.test.mjs` names them and asserts each one is inside the walk;
  `status.html` is on that list. The count lives in that array and nowhere else, deliberately. That
  is a repository-root file rather than one this directory owns.
- **The four replaced assertions.** `test/site.test.mjs` carries all four, each as a named decision
  with its reasoning written into that file's header — items 2 to 5 — rather than as a quiet edit.
  Grep the test names rather than trusting a line number here, because this list goes stale the
  moment that file is edited and a stale line number reads as a fact:
  `exactly one module script per page` replaces the zero-`<script>` rule;
  `src/tokens.css is the only stylesheet permitted a colour literal` repoints the colour-literal
  rule at `src/index.css` and every section's module CSS;
  `every non-generic family named in a token stack has a same-origin @font-face` inverts the
  system-font-stack rule; and `PROSE_FILES` is now `README.md`, `src/tokens.css`, `src/index.css`.
  Weakening a gate to make something pass is on the escalate list in `docs/SWARM.md` §10, so read
  that header before touching any of them. No test count is quoted here: the suite is edited often
  enough that a number in this file is a number that goes stale silently. Run it and read the
  reporter.
- **Gate ordering.** The repository-wide claims guards walk `.md`, `.html`, `.txt` and `.json`, so a
  sentence living only in a `.tsx` component is invisible to them — and so is one in a `dist/` that
  has not been built, because `.gitignore` keeps `dist` out of the repository. Both
  `.github/workflows/ci.yml` and `scripts/gate.mjs` now build this directory **before**
  `npm run test:backend`, and `scripts/test/claims-lede-truth.test.mjs` asserts that the seven
  prerendered pages are inside its walk. Reversing that order now fails a test instead of quietly
  walking nothing. No second source-scanning guard was written.
