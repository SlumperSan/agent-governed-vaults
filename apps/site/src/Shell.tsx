import { APP_URL, FOOTER_LEGAL, FOOTER_LINKS, NAV } from './nav';

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
          <span className="brand-mark" aria-hidden="true" />
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
            <span className="brand-mark" aria-hidden="true" />
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
