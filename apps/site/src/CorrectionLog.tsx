import { Page } from './Shell';
import { CORRECTION_ENTRIES, EMPTY_STATE_NOTE, HERO } from './correction-log-copy';

/**
 * correction-log.html — plan item 1.3 (#184). Every sentence lives in ./correction-log-copy.ts;
 * this file only lays it out, reusing the global classes App.tsx already defines in
 * tokens.css/base.css/sections.css (section, .inner, .measure, .eyebrow, .lede, .dim, .facts/.fact,
 * hr.rule), the same set Disclaimers.tsx reuses. No CSS file is edited for this page.
 */
export function CorrectionLog() {
  return (
    <Page current="/correction-log.html">
      <section>
        <div className="inner measure">
          <p className="eyebrow">{HERO.eyebrow}</p>
          <h1>{HERO.title}</h1>
          <p className="lede">{HERO.lede}</p>
        </div>
      </section>

      <hr className="rule" />

      <section>
        <div className="inner">
          {CORRECTION_ENTRIES.length === 0 ? (
            <p className="dim measure">{EMPTY_STATE_NOTE}</p>
          ) : (
            CORRECTION_ENTRIES.map((entry) => (
              <article key={`${entry.date}-${entry.claim.slice(0, 24)}`} className="mb-64">
                <p className="dim mono mt-8 mb-20">{entry.date}</p>
                <div className="facts one-col">
                  <div className="fact">
                    <p className="k">The claim, as stated</p>
                    <p className="v">{entry.claim}</p>
                  </div>
                  <div className="fact">
                    <p className="k">What was wrong, and how it was found</p>
                    <p className="v">{entry.whatWasWrong}</p>
                  </div>
                  <div className="fact">
                    <p className="k">The replacement, and where to verify it</p>
                    <p className="v">{entry.replacement}</p>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </Page>
  );
}
