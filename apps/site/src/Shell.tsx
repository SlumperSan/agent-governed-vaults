import { APP_URL, FOOTER_LEGAL, FOOTER_LINKS, NAV } from './nav';

/**
 * The Threshold mark, inline. Three courses, the middle one open at the centre — the geometry
 * approved by the owner 2026-09-18 (Agent-Governed Vaults/Decisions/the-mark-is-threshold-2026-09-18.md),
 * copied verbatim from Design/brand-threshold/mark.svg. The viewBox is cropped to the mark's own
 * bounding box (the source file's 64x64 canvas leaves margin around it) so it sizes cleanly beside
 * the wordmark; none of the four rects' coordinates changed. Inline rather than an <img src>
 * because both apps' CSP ship `img-src` without `data:`, so a literal SVG element is the only
 * same-origin way to put this beside the name without a network request.
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
 * The header every page carries.
 *
 * THE APP BUTTON IS THE POINT OF THIS COMPONENT. The previous site linked to GitHub and to its own
 * disclaimers and to nothing else — app.rwally.com was live and unreachable from the marketing site,
 * which is the single most expensive kind of missing link: the product exists and no reader can get
 * to it.
 */
export function Header({ current }: { current?: string }) {
  return (
    <header className="nav">
      <div className="nav-inner">
        <a className="brand" href="/" aria-label="RWAlly home">
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

        <a className="btn btn-sm nav-app" href={APP_URL}>
          Open app
          <span aria-hidden="true">→</span>
        </a>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer>
      <div className="inner foot-grid">
        <div>
          <a className="brand" href="/" aria-label="RWAlly home">
            <BrandMark />
            <span className="brand-name">RWAlly</span>
          </a>
          <p className="foot-legal">{FOOTER_LEGAL}</p>
        </div>
        <nav className="foot-links" aria-label="Footer">
          {FOOTER_LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}

/** Every document is Header + content + Footer, so the nav and the legal line cannot differ. */
export function Page({ current, children }: { current?: string; children: React.ReactNode }) {
  return (
    <>
      <Header {...(current ? { current } : {})} />
      <main>{children}</main>
      <Footer />
    </>
  );
}
