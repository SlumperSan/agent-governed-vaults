# apps/site — public marketing site

Six static HTML pages describing the Agent-Governed Vaults protocol: `index.html`,
`how-it-works.html`, `who-its-for.html`, `operators.html`, `risks.html`, `faq.html`.

No build step. No framework. **Zero JavaScript** — there is not a single `<script>` tag, so "works
with JavaScript disabled" is true by construction rather than by testing. No external requests of
any kind: no webfonts, no CDN, no analytics, no trackers, no remote images. System font stacks only.
The only off-site link anywhere is the project's own GitHub repository.

There is deliberately **no `package.json` in this directory**. `apps/*` is an npm workspace glob and
adding one changes what `npm ci` installs at the root.

## Preview

Any static file server. Do not add a dependency for this.

```
python -m http.server 8000 --directory apps/site
```

Then open `http://localhost:8000/`. Opening the `.html` files directly from disk also works, because
nothing on the page needs an origin.

## Design tokens: the swap contract

`assets/tokens.css` is a placeholder with a contract. `design/system-foundation` does not exist yet;
when a real design system lands, **replace `assets/tokens.css` wholesale** and change nothing else.

- The custom-property **names** are the interface, and they are the same names `apps/web/index.html`
  already uses: `--ground --surface --surface-2 --line --line-soft --ink --muted --faint --accent
  --accent-soft --accent-ink --good --good-soft --warn --warn-soft --crit --crit-soft --shadow-1
  --shadow-2 --display --sans --mono --r-sm --r-md --r-lg --maxw`.
- `assets/site.css` references those names and **contains no raw colour literal**. The claims test
  enforces that, so a token swap re-themes the entire site with no markup churn.
- Three inherited values were overridden here because they fail WCAG 2.2 AA, with the measured
  ratios recorded in comments beside them: light `--faint` (3.03:1 → 4.66:1), dark `--faint`
  (2.96:1 → 4.84:1 worst case) and light `--good` (4.40:1 → 6.16:1); light `--warn` and `--crit`
  were darkened for the same reason. A replacement tokens file inherits that obligation.
- Webfont names are dropped and their existing fallbacks kept. Do not reintroduce an `@import` or a
  font-host `<link>`.
- All three theme states are supported the way `apps/web` does it: bare `:root` for light, a
  `prefers-color-scheme: dark` block guarded with `:root:not([data-theme="light"])`, and an explicit
  `:root[data-theme="dark"]`. The last two are duplicates on purpose — edit both or the forced-dark
  path silently drifts.

## Nothing here goes public before counsel review

The launch constraint on this project is legal, not engineering. Every load-bearing legal or factual
claim on these pages carries an HTML comment on its own line:

```html
<!-- COUNSEL: <one-line description of the claim needing sign-off> -->
```

**Those markers are the review queue.** Grep them to generate the list:

```
grep -rn "COUNSEL:" apps/site/*.html
```

The wording of each marker is self-explanatory out of context, because it is read in a list and not
next to the sentence it describes. If you add a claim about custody, fees, deployment status,
jurisdiction, the security review, the operator's obligations, or what a depositor's position is,
add a marker with it.

## The claims test is what stops a banned claim from shipping

`test/site.test.mjs` runs in `npm run test:backend` and therefore in `npm run gate` and in CI. Prose
has no compiler; that file is the compiler. It asserts, across all six pages:

- **Absence** of banned claim phrases — word-boundary-anchored phrases, never bare words, because a
  test that bans single words gets neutered by its first false positive and then protects nothing.
- **Presence** of the two exact pre-launch banner strings and the two exact footer strings, exactly
  one `<h1>`, `lang="en"`, a skip link to `#main`, `<main id="main">`, a meta description, a title
  ending in ` — Agent-Governed Vaults`, and at least one COUNSEL marker.
- **Zero JavaScript**: no `<script` tag and no inline event-handler attribute.
- **No external host** in any `src`/`href` other than the project's GitHub repository, with explicit
  checks against `fonts.googleapis.com` and `fonts.gstatic.com`.
- No raw hex colour in `site.css`, and the full token set present in `tokens.css`.
- Every internal `.html` link resolves to a file on disk.
- The operator page states `2,500 USDC` and `5%`, names both distinct 5% mechanisms, and never
  claims the operator's capital cost is nil.

One deliberate exception is built into the test: the footer sentence
`Source-available under BUSL-1.1 — not open source.` is the single permitted place the phrase "open
source" appears, because there it is negated. The same applies to the no-token footer sentence. Both
exact sentences are stripped before the absence checks run, and the presence checks run against the
unstripped source. If you change either sentence, change it in the test in the same commit.

Run it alone while editing copy:

```
node --test apps/site/test/site.test.mjs
```
