import { DISCLAIMERS_URL, FOOTER_LINKS, NAV, SITE_URL } from './nav';

/**
 * The Threshold mark, inline, ported from `apps/site/src/Shell.tsx`'s own `BrandMark` — same
 * geometry, same reasoning: three courses, the middle one open at the centre, copied verbatim from
 * Design/brand-threshold/mark.svg (owner-approved 2026-09-18,
 * Agent-Governed Vaults/Decisions/the-mark-is-threshold-2026-09-18.md), viewBox cropped to the
 * mark's own bounding box rather than the source file's padded 64x64 canvas. Inline rather than an
 * `<img src>` because this app's CSP ships `img-src 'self'` with no `data:`.
 */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="5 12.5 54 39" aria-hidden="true" focusable="false">
      <g fill="#2f6bff">
        <rect x="5" y="12.5" width="54" height="11" rx="3" />
        <rect x="5" y="26.5" width="16" height="11" rx="3" />
        <rect x="43" y="26.5" width="16" height="11" rx="3" />
        <rect x="5" y="40.5" width="54" height="11" rx="3" />
      </g>
    </svg>
  );
}

/**
 * The masthead, ported from `apps/site/src/Shell.tsx`.
 *
 * SAME CLASS NAMES, SAME MARKUP SHAPE, SAME TOKENS — deliberately, so the two surfaces are one
 * product rather than two that resemble each other. The class names are the contract: `chrome.css`
 * here and `sections.css` there style `.nav`, `.nav-inner`, `.brand`, `.brand-mark`, `.brand-name`,
 * `.nav-links` and `.btn` from the same custom properties, which `src/styles.css` imports from
 * `apps/site/src/tokens.css` rather than copying.
 *
 * WHAT IS NOT PORTED, AND WHY. The site's `base.css` carries marketing typography — a 72px `h1`, a
 * fixed radial glow behind the fold, 120px section padding — and an application shell that
 * inherited them would be a landing page with a table in it. Only the chrome came across.
 */
export function Header({ current }: { current?: string }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="brand" href={SITE_URL} aria-label="RWAlly home">
          <BrandMark />
          <span className="brand-name">RWAlly</span>
        </a>

        <nav className="nav-links" aria-label="Main">
          {NAV.map((n) => (
            <a
              key={n.href}
              href={n.href}
              aria-current={current === n.href ? 'page' : undefined}
              {...(n.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
            >
              {n.label}
            </a>
          ))}
        </nav>

        <a className="nav-site" href={DISCLAIMERS_URL} target="_blank" rel="noreferrer noopener">
          Disclaimers
          <span aria-hidden="true">↗</span>
        </a>
      </div>
    </header>
  );
}

/**
 * THE DISCLAIMERS LINK IS IN BOTH BARS ON PURPOSE. This surface renders NAV, a share price and a
 * member's own position; the page that says none of it is advice, a forecast or a promise is one
 * click away from the top of the screen rather than only from the bottom of it.
 */
export function Footer() {
  return (
    <footer>
      <div className="foot-grid">
        <a className="brand" href={SITE_URL} aria-label="RWAlly home">
          <BrandMark />
          <span className="brand-name">RWAlly</span>
        </a>
        <nav className="foot-links" aria-label="Footer">
          {FOOTER_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              {...(l.external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}

/** Every view is Header + content + Footer, so the chrome cannot differ between them. */
export function Page({ current, children }: { current?: string; children: React.ReactNode }) {
  return (
    <>
      <Header {...(current ? { current } : {})} />
      <main className="shell">{children}</main>
      <Footer />
    </>
  );
}
