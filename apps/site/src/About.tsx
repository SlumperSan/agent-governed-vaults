import { ABOUT } from './copy';
import { Page } from './Shell';

export function About() {
  return (
    <Page current="/about.html">
      <section className="hero">
        <div className="inner">
          <p className="eyebrow">{ABOUT.hero.eyebrow}</p>
          <h1>{ABOUT.hero.headline}</h1>
          <p className="lede">{ABOUT.hero.sub}</p>
        </div>
      </section>

      <section>
        <div className="inner">
          <div className="grid-2">
            {ABOUT.body.map((b) => (
              <article className="card" key={b.t}>
                <h3>{b.t}</h3>
                <p>{b.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="inner narrow">
          <p className="eyebrow">{ABOUT.status.eyebrow}</p>
          <h2>{ABOUT.status.headline}</h2>
          <p className="lede lede-sub">{ABOUT.status.body}</p>
        </div>
      </section>
    </Page>
  );
}
