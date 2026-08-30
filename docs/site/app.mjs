// @ts-check
/**
 * Docs-site router and view. No framework, no build step, no bundler — the browser loads this
 * module directly and it fetches the repo's own markdown files.
 *
 * Route shape: `#<repo-root-relative path>` — e.g. `#docs/AGENT-QUICKSTART.md`. The path IS the
 * route, so a link between two markdown files needs no mapping table: resolve the relative link,
 * prefix it with `#`, done. Anything that is not markdown (`docs/api/openapi.yaml`,
 * `packages/agent-sdk/src/index.mjs`) is served as a plain file by the static server, which is
 * correct — the site's job is to render the prose, not to reimplement a source browser.
 */

import { renderMarkdown } from './md.mjs';
import { NAV, PAGES, HOME, pageFor } from './manifest.mjs';

/** Repo root relative to this file's URL — the site lives at /docs/site/. */
const ROOT = new URL('../../', import.meta.url);

const el = {
  toc: /** @type {HTMLElement} */ (document.getElementById('toc')),
  content: /** @type {HTMLElement} */ (document.getElementById('content')),
  crumb: /** @type {HTMLElement} */ (document.getElementById('crumb')),
  source: /** @type {HTMLAnchorElement} */ (document.getElementById('source-link')),
  theme: /** @type {HTMLButtonElement} */ (document.getElementById('theme-toggle')),
};

// ── nav ─────────────────────────────────────────────────────────────────────

function buildNav() {
  const frag = document.createDocumentFragment();
  for (const { section, pages } of NAV) {
    const label = document.createElement('div');
    label.className = 'section';
    label.textContent = section;
    frag.append(label);
    for (const page of pages) {
      const a = document.createElement('a');
      a.className = 'nav-item';
      a.href = `#${page.path}`;
      a.textContent = page.title;
      a.dataset.path = page.path;
      frag.append(a);
    }
  }
  el.toc.replaceChildren(frag);
}

function markCurrent(path) {
  for (const a of el.toc.querySelectorAll('a.nav-item')) {
    if (a.getAttribute('data-path') === path) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// ── link rewriting ──────────────────────────────────────────────────────────

/**
 * A markdown link becomes an in-site route when it points at a `.md` file, and a raw file link
 * otherwise. Both are relative to the repo root, which is what the server serves.
 * @param {{href:string, resolved:string|null}} t
 */
function rewriteLink(t) {
  if (t.resolved === null) return t.href; // absolute URL, mailto, or in-page anchor
  const [path, hash] = t.resolved.split('#');
  if (path.endsWith('.md')) return `#${path}${hash ? `#${hash}` : ''}`;
  return new URL(path, ROOT).href + (hash ? `#${hash}` : '');
}

// ── rendering ───────────────────────────────────────────────────────────────

/** @param {string} path */
async function renderPage(path) {
  el.content.innerHTML = '<p class="loading">Loading…</p>';
  let src;
  try {
    const res = await fetch(new URL(path, ROOT), { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    src = await res.text();
  } catch (err) {
    el.content.innerHTML =
      `<p class="error">Could not load <code>${path}</code> — ${String(err && err.message)}.</p>` +
      '<p>The site fetches the markdown at runtime, so it has to be <strong>served over HTTP</strong>; ' +
      'opening <code>index.html</code> from the filesystem will not work. Run ' +
      '<code>node docs/site/serve.mjs</code> from the repo root.</p>';
    return;
  }

  const { html } = renderMarkdown(src, { docPath: path, linkRewrite: rewriteLink });
  el.content.innerHTML = html;
  el.content.scrollIntoView({ block: 'start' });

  const page = pageFor(path);
  el.crumb.textContent = page ? `${sectionOf(path)} / ${page.title}` : path;
  el.source.href = new URL(path, ROOT).href;
  el.source.textContent = path;
  document.title = `${page ? page.title : path} · Agent-Governed Vaults`;
  markCurrent(path);

  // Deep link into a heading: the content only exists now, so honour the hash after render.
  const anchor = location.hash.split('#')[2];
  if (anchor) document.getElementById(anchor)?.scrollIntoView();
  else window.scrollTo({ top: 0 });
}

function sectionOf(path) {
  return NAV.find((s) => s.pages.some((p) => p.path === path))?.section ?? 'Docs';
}

// ── routing ─────────────────────────────────────────────────────────────────

function currentPath() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  const path = raw.split('#')[0];
  if (!path) return HOME;
  // Only render markdown, and only from inside the repo. Refuse anything else rather than
  // fetching an arbitrary path the URL bar asked for.
  if (!path.endsWith('.md') || path.includes('..') || path.startsWith('/')) return HOME;
  return path;
}

function route() {
  renderPage(currentPath());
}

// ── theme ───────────────────────────────────────────────────────────────────

const THEME_KEY = 'x402-docs-theme';

function applyTheme(value) {
  if (value === 'light' || value === 'dark') document.documentElement.setAttribute('data-theme', value);
  else document.documentElement.removeAttribute('data-theme');
  el.theme.textContent = value === 'dark' ? 'Dark' : value === 'light' ? 'Light' : 'System';
  el.theme.setAttribute('aria-label', `Colour theme: ${el.theme.textContent}. Click to change.`);
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem(THEME_KEY); } catch { /* private mode, blocked storage */ }
  applyTheme(stored);
  el.theme.addEventListener('click', () => {
    const order = ['system', 'light', 'dark'];
    const now = document.documentElement.getAttribute('data-theme') ?? 'system';
    const next = order[(order.indexOf(now) + 1) % order.length];
    applyTheme(next === 'system' ? null : next);
    try {
      if (next === 'system') localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch { /* nothing to do; the theme still applies for this page view */ }
  });
}

// ── boot ────────────────────────────────────────────────────────────────────

buildNav();
initTheme();
window.addEventListener('hashchange', route);
route();

export { rewriteLink, currentPath, PAGES };
