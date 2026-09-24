import { useEffect, useState } from 'react';
import { Page } from './Shell';
import { HERO, SECTIONS, SELF_REFERENCE, TERMS_VERSION, termsTextSha256 } from './terms-copy';

/** Same small helper `Disclaimers.tsx` defines locally, for the same reason: a handful of section
 *  bodies carry `<strong>`/`<ul>` markup (see `packages/terms/src/terms-text.mjs`'s `inlineHtml`),
 *  and rendering that as HTML rather than escaped text is required to carry it unchanged. */
function Html({ value, className }: { value: string; className?: string }) {
  if (className === undefined) {
    return <span dangerouslySetInnerHTML={{ __html: value }} />;
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: value }} />;
}

/**
 * The hash line, embedded in the page as both visible text and a `data-terms-sha256` attribute a
 * test can read directly.
 *
 * COMPUTED CLIENT-SIDE, DELIBERATELY. `termsTextSha256()` uses Web Crypto's async `subtle.digest`,
 * and `renderToString` (this page's SSR pass) runs no effects — the prerendered markup shows
 * "computing…" and hydration fills in the digest, the same loading-then-ready shape
 * `apps/vaults-ui`'s chain reads already use elsewhere in this app. `apps/vaults-ui` imports the
 * exact same `packages/terms` module and calls the exact same function, so the two can never print
 * a different digest for the same `TERMS_TEXT` — there is only one implementation to disagree with.
 */
function TextHash() {
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    termsTextSha256().then((h) => {
      if (!cancelled) setHash(h);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return (
    <p className="dim mono" data-terms-version={TERMS_VERSION} data-terms-sha256={hash ?? ''}>
      {`Version ${TERMS_VERSION} · SHA-256 of the text above: ${hash ?? 'computing…'}`}
    </p>
  );
}

export function Terms() {
  return (
    <Page current="/terms.html">
      <section>
        <div className="inner measure">
          <p className="eyebrow">{HERO.eyebrow}</p>
          <h1>{HERO.title}</h1>
          <p className="lede">{HERO.subtitle}</p>
        </div>
      </section>

      <hr className="rule" />

      <section>
        <div className="inner measure">
          {SECTIONS.map((s) => (
            <article key={s.id} id={s.id} className="mb-64">
              {/* ONE interpolation, not two ({s.number} and {s.heading} side by side): React's SSR
                  inserts a `<!-- -->` hydration marker between adjacent expression children, which
                  would split "1. What this is" across two text nodes in the built HTML — the same
                  contiguity trap disclaimers-copy.ts's header describes for the product phrase. */}
              <h2>{`${s.number}. ${s.heading}`}</h2>
              {s.body.map((block, i) =>
                block.type === 'ul' ? (
                  <ul key={i}>
                    {block.items.map((item, j) => (
                      <li key={j}>
                        <Html value={item} />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p key={i}>
                    <Html value={block.html} />
                  </p>
                ),
              )}
            </article>
          ))}
        </div>
      </section>

      <hr className="rule" />

      <section>
        <div className="inner measure">
          <TextHash />
          <p className="dim mt-8">
            <Html value={SELF_REFERENCE} />
          </p>
        </div>
      </section>
    </Page>
  );
}
