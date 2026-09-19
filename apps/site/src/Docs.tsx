import { DOCS } from './copy';
import { Page } from './Shell';

export function Docs() {
  return (
    <Page current="/docs.html">
      <section className="hero">
        <div className="inner">
          <p className="eyebrow">{DOCS.hero.eyebrow}</p>
          <h1>{DOCS.hero.headline}</h1>
          <p className="lede">{DOCS.hero.sub}</p>
        </div>
      </section>

      <section>
        <div className="inner narrow">
          {DOCS.groups.map((g) => (
            <div className="doc-group" key={g.t}>
              <h3>{g.t}</h3>
              <div className="doc-list">
                {g.items.map((i) => {
                  const external = i.href.startsWith('http');
                  return (
                    <a
                      className="doc-row"
                      href={i.href}
                      key={i.href}
                      {...(external ? { target: '_blank', rel: 'noreferrer noopener' } : {})}
                    >
                      <span className="l">{i.label}</span>
                      <span className="d">{i.d}</span>
                    </a>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>
    </Page>
  );
}
