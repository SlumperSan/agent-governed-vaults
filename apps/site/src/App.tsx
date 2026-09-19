import { HOME } from './copy';
import { APP_URL } from './nav';
import { Page } from './Shell';

export function App() {
  return (
    <Page>
      <section className="hero">
        <div className="inner">
          <p className="eyebrow">{HOME.hero.eyebrow}</p>
          <h1>{HOME.hero.headline}</h1>
          <p className="lede">{HOME.hero.sub}</p>
          <div className="hero-actions">
            <a className="btn" href={APP_URL}>
              {HOME.hero.primary.label}
              <span aria-hidden="true">→</span>
            </a>
            <a className="btn btn-ghost" href={HOME.hero.secondary.href}>
              {HOME.hero.secondary.label}
            </a>
          </div>

          <div className="proof">
            {HOME.proof.map((p) => (
              <div className="proof-cell" key={p.k}>
                <p className="proof-k">{p.k}</p>
                <p className="proof-v">{p.v}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="inner narrow">
          <p className="eyebrow">{HOME.pitch.eyebrow}</p>
          <h2>{HOME.pitch.headline}</h2>
          <div className="body-copy mt-28">
            {HOME.pitch.body.map((b) => (
              <p key={b.slice(0, 20)}>{b}</p>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="inner">
          <p className="eyebrow">{HOME.steps.eyebrow}</p>
          <h2 className="measure">{HOME.steps.headline}</h2>
          <div className="grid-3">
            {HOME.steps.items.map((s) => (
              <article className="card" key={s.n}>
                <p className="step-n">{s.n}</p>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="inner">
          <p className="eyebrow">{HOME.trust.eyebrow}</p>
          <h2 className="measure">{HOME.trust.headline}</h2>
          <p className="lede measure lede-sub">{HOME.trust.lede}</p>
          <div className="grid-2">
            {HOME.trust.points.map((p) => (
              <article className="card" key={p.t}>
                <h3>{p.t}</h3>
                <p>{p.d}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="inner">
          <div className="cta">
            <h2>{HOME.cta.headline}</h2>
            <p className="lede">{HOME.cta.sub}</p>
            <a className="btn" href={APP_URL}>
              {HOME.cta.label}
              <span aria-hidden="true">→</span>
            </a>
          </div>
        </div>
      </section>
    </Page>
  );
}
