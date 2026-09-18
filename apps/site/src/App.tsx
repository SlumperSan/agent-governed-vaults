import { AUTHORITY, HERO, HOW, STATUS, WHY } from './copy';
import { Footer } from './Footer';

/**
 * Embers rising behind the hero. Upward motion is the one piece of animation on the page, and it is
 * there because ascension is the idea — not because a static page felt like it needed something.
 *
 * Deterministic positions rather than Math.random(): this page is prerendered, and a random layout
 * produces different markup on the server and the client, which React reports as a hydration
 * mismatch and which makes the built HTML untestable.
 */
function Embers() {
  const n = 18;
  return (
    <div className="ember-field" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => {
        return <span key={i} className="ember" />;
      })}
    </div>
  );
}

function Hero() {
  return (
    <section className="hero">
      <div className="shaft" aria-hidden="true" />
      <Embers />
      <div className="inner">
        <p className="eyebrow">{HERO.eyebrow}</p>
        {/*
          ONE TEXT NODE, DELIBERATELY. The gold in this headline comes from a CSS gradient on the
          element, not from an <em> around a word, because `the AI agent trading index` is a
          protected product phrase that `claims-lede-truth` matches CONTIGUOUSLY. Wrapping any word
          of it in an element splits the phrase in the rendered HTML, the exemption stops matching,
          and the guard reports the page for claiming an AI agent trades — which it does not. This
          cost one red gate to learn; do not reintroduce the markup.
        */}
        <h1>{HERO.headline}</h1>
        <p className="lede">{HERO.lede}</p>
        <p className="status">
          <span className="dot" aria-hidden="true" />
          {HERO.status}
        </p>
      </div>
      <p className="scroll-hint" aria-hidden="true">
        {HERO.scrollHint}
      </p>
    </section>
  );
}

function Why() {
  return (
    <section className="why bright">
      <div className="bloom" aria-hidden="true" />
      <div className="inner">
        <p className="eyebrow">{WHY.eyebrow}</p>
        <h2>{WHY.headline}</h2>
        <div className="body measure">
          {WHY.body.map((p) => (
            <p key={p.slice(0, 24)}>{p}</p>
          ))}
        </div>
        <div className="not-a-claim">
          <p>
            <strong>{WHY.notAClaim}</strong>
          </p>
        </div>
      </div>
    </section>
  );
}

function How() {
  return (
    <section>
      <div className="inner">
        <p className="eyebrow">{HOW.eyebrow}</p>
        <h2 className="measure">{HOW.headline}</h2>
        <div className="steps">
          {HOW.steps.map((s) => (
            <article className="step" key={s.n}>
              <p className="n">{s.n}</p>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Authority() {
  return (
    <section className="authority">
      <div className="inner">
        <p className="eyebrow">{AUTHORITY.eyebrow}</p>
        <h2 className="measure">{AUTHORITY.headline}</h2>
        <p className="lede measure lede-sub">
          {AUTHORITY.lede}
        </p>
        <ul className="invariants">
          {AUTHORITY.invariants.map((i) => (
            <li className="invariant" key={i.k}>
              <span className="k">{i.k}</span>
              <p>{i.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Status() {
  return (
    <section>
      <div className="inner">
        <p className="eyebrow">{STATUS.eyebrow}</p>
        <h2 className="measure">{STATUS.headline}</h2>
        <p className="lede measure lede-sub">
          {STATUS.lede}
        </p>
        <div className="facts">
          {STATUS.facts.map((f) => (
            <div className="fact" key={f.k}>
              <p className="k">{f.k}</p>
              <p className="v">{f.v}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export function App() {
  return (
    <>
      <main>
        <Hero />
        <hr className="rule" />
        <Why />
        <How />
        <hr className="rule" />
        <Authority />
        <How2Spacer />
        <Status />
      </main>
      <Footer />
    </>
  );
}

/** A single hairline between the two dark sections, so they do not run together. */
function How2Spacer() {
  return <hr className="rule" />;
}
