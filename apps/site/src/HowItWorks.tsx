import { HOW } from './copy';
import { APP_URL } from './nav';
import { Page } from './Shell';

export function HowItWorks() {
  return (
    <Page current="/how-it-works.html">
      <section className="hero">
        <div className="inner">
          <p className="eyebrow">{HOW.hero.eyebrow}</p>
          <h1>{HOW.hero.headline}</h1>
          <p className="lede">{HOW.hero.sub}</p>
        </div>
      </section>

      <section>
        <div className="inner narrow">
          <div className="phases">
            {HOW.phases.map((p) => (
              <article className="phase" key={p.n}>
                <h3>{p.title}</h3>
                <p>{p.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="inner">
          <p className="eyebrow">{HOW.fees.eyebrow}</p>
          <h2 className="measure">{HOW.fees.headline}</h2>
          <div className="grid-2">
            {HOW.fees.items.map((f) => (
              <article className="card" key={f.t}>
                <h3>{f.t}</h3>
                <p>{f.d}</p>
              </article>
            ))}
          </div>
          <div className="hero-actions">
            <a className="btn" href={APP_URL}>
              Open the app
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}
