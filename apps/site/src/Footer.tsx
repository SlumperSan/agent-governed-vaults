import { FOOTER } from './copy';

/** One footer, used by every document, so the legal line cannot differ between pages. */
export function Footer() {
  return (
    <footer>
      <div className="inner foot-grid">
        <nav className="foot-links" aria-label="Protocol documents">
          <a href="/disclaimers.html">Disclaimers</a>
          {FOOTER.links.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <p className="foot-legal">{FOOTER.legal}</p>
      </div>
    </footer>
  );
}
