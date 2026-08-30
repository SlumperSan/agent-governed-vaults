# docs/site — the documentation site

A static docs site with **no build step, no framework, and no second copy of the prose.** It fetches
the repository's own markdown at runtime and renders it in the browser, so the file a contributor
edits is the file a reader sees.

```powershell
node docs/site/serve.mjs
```

Then open <http://127.0.0.1:8403/docs/site/>. It must be **served**: a browser blocks `fetch()` over
`file://`, so opening `index.html` from disk shows an empty shell (the page says so rather than
failing silently).

## Why render at runtime instead of generating HTML

Because a generated copy drifts. The moment `docs/AGENT-QUICKSTART.md` and its rendered twin can
disagree, one of them is wrong and nobody can tell which — and the reader following the wrong one
burns the hour they were willing to give this project. Rendering at runtime makes that state
unreachable rather than merely discouraged.

The cost is that the site needs a server and JavaScript. That is a cost worth paying for a
developer-facing docs site; it would not be for a marketing page.

## Files

| File | What |
| --- | --- |
| `index.html` | The shell: sidebar, top bar, content pane. No content of its own. |
| `app.mjs` | Router and view. Route = the markdown file's repo-relative path, so `#docs/LIMITS.md` is a URL. |
| `md.mjs` | The markdown renderer. A module, not an inline script — `scripts/test/docs-site.test.mjs` imports the same file under `node --test`, so the renderer the browser runs is the renderer the gate proves. |
| `manifest.mjs` | The nav, and the only definition of the page set. |
| `serve.mjs` | Zero-dependency static server rooted at the repo (the site renders files from all over the tree). Loopback-bound, read-only extension allowlist, refuses path traversal. **A local viewer, not a production server.** |
| `tokens.css` | Design tokens. See below. |
| `site.css` | Layout and prose styling. References tokens only, never a literal colour. |
| `HOME.md` | The landing page — content, like every other page. |

## Design tokens

`tokens.css` is lifted **verbatim** from [`../design/style-tile.html`](../design/style-tile.html),
the rendered artifact of [`../design/VISUAL-DESIGN-SYSTEM.md`](../design/VISUAL-DESIGN-SYSTEM.md).
Nothing in it is invented for this site: a second, divergent palette is precisely what a design
system exists to prevent.

A `design/system-foundation` branch was checked for and **is not present on `origin`**. If one
lands later, swapping `tokens.css` is the whole migration.

Theme handling is the design system's three-state rule — bare `:root` is light, a
`prefers-color-scheme` block guarded with `:root:not([data-theme="light"])` is dark, and an explicit
`:root[data-theme="dark"]` lets the toggle win in both directions. The toggle cycles
System → Light → Dark and persists in `localStorage`, wrapped in `try`/`catch` so blocked storage
degrades to a per-view choice rather than a broken page.

## Adding a page

1. Write the markdown somewhere under `docs/`.
2. Add an entry to `NAV` in `manifest.mjs`.
3. Run `node --test scripts/test/docs-site.test.mjs`.

Step 3 will fail if the file does not exist, if any link in it points at a file or heading that does
not exist, or if it renders to nothing. That is the point.

## What the gate checks

`scripts/test/docs-site.test.mjs` runs inside `npm run gate`. It covers:

- the renderer, including the escaping rule that no document can inject markup into the page;
- every link in every documented page, resolved against the **file** and checked on disk, plus
  every in-page anchor against the headings that actually exist;
- `docs/SDK-REFERENCE.md` against the SDK's **runtime** surface, in both directions — an
  undocumented method fails, and so does a documented method that no longer exists;
- the quickstart's example, **executed** end to end against a real API over the real projections.
