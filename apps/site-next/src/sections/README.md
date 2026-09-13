# `src/sections/` — one directory per section, one owner per directory

A section builder owns `src/sections/<key>/` and **nothing outside it**. The `<key>` is the one
named in that section's entry in the build brief — `index-hero`, `risks-register`, `hiw-exit`, and
so on.

## What a section may do

- Import from `src/shell/pinned.ts` for any sentence that is pinned or that travels between pages.
- Import `src/shell/PinnedText.tsx` to render a pinned sentence.
- Import `src/shell/PreLaunchBanner.tsx` — but only `status-hero` does, and only because the owner
  moved the status band off the top of every page on 2026-09-04. `PageShell` no longer renders it,
  so exactly one section owes it. No other section may render it: `site.test.mjs` asserts that
  `status.html` is the only page carrying the band.
- Import from `src/motion/` — `Reveal`, `useScrollTimeline`, `useReducedMotion`, `easings`.
- Read the custom properties defined in `src/tokens.css`.
- Carry its own `<key>.module.css` inside its own directory.

## What a section may not do

- Import another section. If two sections need the same thing, it is a shell primitive; ask.
- Add a dependency, edit `vite.config.ts`, or touch an entry HTML.
- Edit `src/tokens.css` or `src/index.css`. A token that is missing gets asked for, not added
  locally, because a local copy is a value nobody re-measures for contrast.
- Retype a pinned sentence. Import it. A retyped sentence is a sentence that diverges on the next
  edit, and the failure lands on a different page from the change that caused it.
- Write a new sentence. Copy is adapted from `apps/site/*.html`, which carries every claim. A
  section builder who finds themselves composing prose has made a mistake: go back and find the
  sentence that already exists.

## Three rules that fail silently if broken

1. **Nothing a guard reads may be conditionally rendered.** No copy behind scroll state, behind an
   IntersectionObserver, or inside a React-state accordion. The build prerenders, and the guards
   read the prerendered file; text that only appears after an interaction is not in that file. Where
   a disclosure affordance is wanted, use native `<details>`/`<summary>` with the content open in the
   prerendered markup.
2. **Never branch the initial render tree on `matchMedia` or on viewport width.** Both differ
   between the server and the client, React discards the mismatched subtree, and the discarded
   subtree is the markup the guards just verified. Responsive decisions belong in CSS media queries;
   motion decisions belong in an effect. `useReducedMotion` is built for exactly this and returns
   the resting answer until after hydration.
3. **Render the resting state, animate from it.** The prerendered page is the finished page. A
   reader with motion reduced sees it as it is; everyone else gets the same thing with an enter
   animation added afterwards.

## The banned vocabulary reaches into code, not only into copy

The claims suite scans stylesheets as prose, so a class name, a custom property, a shader uniform or
a file name is as exposed as a paragraph is. The list is in
`.claude/skills/rwally-claims-contract/SKILL.md` and in the `BANNED` array at the top of
`apps/site/test/site.test.mjs`; read one of them before naming anything, because two of the entries
are ordinary CSS that nobody thinks of as prose:

- the environment variable for a device's inset area, and the overflow keyword of the same name that
  can follow `justify-content` — both match a banned word on its boundaries;
- the Greek letter commonly used for an opacity channel. Write `opacity`, or name the channel.

The same applies to outcome vocabulary, funnel vocabulary and discretionary-manager vocabulary in a
comment. A stylesheet comment reds the gate exactly as a paragraph does.

## Notice from the orchestrator — 2026-09-04 20:5x UTC — Reveal.tsx type error FIXED (Shell-owned file)

A section builder reported, and I reproduced, that `src/motion/Reveal.tsx:165` failed `npx tsc -b --force` for every caller (TS2745 / TS2322: the `ElementType` union made the JSX site's props resolve to `never`; a stale buildinfo had hidden it). Fixed in place: `as` is now an exported `RevealTag` union — div, section, article, aside, p, ul, ol, dl, li, figure, header, footer — and the JSX site uses one concrete intrinsic type; the runtime element is unchanged. `npx tsc -b --force` in `apps/site-next` exits 0 project-wide as of this notice. If your section needs a tag outside that union, add the literal to `RevealTag`; do not reopen `ElementType`. index-hero: the dependency your `hero3d/fiber.ts` comment names (Reveal's `ElementType`) is gone, so the plain `import { Canvas, useFrame, useThree } from '@react-three/fiber'` should now be viable — I have NOT run it; verify with `npx tsc -b --force` before dropping the deep import.
