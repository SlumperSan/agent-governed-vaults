import { Page } from './Shell';
import {
  ACTIONS,
  CONTENTS_ENTRIES,
  CONTENTS_EYEBROW,
  CONTENTS_HEADING,
  GROUPS,
  GROUPS_HEADING,
  HERO,
  REFERENCES,
  REGISTER_ENTRIES,
  REVIEW,
  SCOPE_EYEBROW,
  SCOPE_HEADING,
  SCOPE_LEDE,
  SCOPE_ROWS,
  SELF_REFERENCE,
  UNMITIGATED_NOTE,
  VERIFY_EYEBROW,
  VERIFY_HEADING,
  VERIFY_LEDE,
} from './disclaimers-copy';

/**
 * disclaimers.html — ported from apps/site-next's disclaimers build. Every sentence lives in
 * ./disclaimers-copy.ts; this file only lays it out, reusing the global classes App.tsx already
 * defines in tokens.css/base.css/sections.css (section, .inner, .measure, .eyebrow, .lede, .dim,
 * .mono, .facts/.fact, hr.rule). No CSS file was edited for this page — sections.css is off limits
 * for this port — so every layout need without an existing class equivalent (the jump list, the
 * grid overrides, the action row) is done with an inline style instead of a new global class.
 *
 * Several cells below carry raw HTML (<code>, <strong>, <em>, <a>, and entities like &mdash;)
 * because the source copy does; rendering them as HTML rather than as escaped text is required to
 * carry the content unchanged. Html() is the one place that happens.
 */
function Html({ value, className }: { value: string; className?: string }) {
  if (className === undefined) {
    return <span dangerouslySetInnerHTML={{ __html: value }} />;
  }
  return <span className={className} dangerouslySetInnerHTML={{ __html: value }} />;
}


export function Disclaimers() {
  return (
    <Page current="/disclaimers.html">
        {/* Hero: the standing disclosures. No hero canvas or gradient here on purpose — this page
            is text, not a pitch. */}
        <section>
          <div className="inner measure">
            <p className="eyebrow">{HERO.eyebrow}</p>
            <h1>{HERO.title}</h1>
            <p className="lede">{HERO.lede}</p>
            <p className="dim">{HERO.bannerOffer}</p>
            <p className="dim">
              <Html value={HERO.deploymentParagraph} />
            </p>
            <p className="dim mono">{HERO.licence}</p>
            <p className="dim">{HERO.jurisdictionParagraph}</p>
            <p className="dim">{HERO.totalLossParagraph}</p>
          </div>
        </section>

        <hr className="rule" />

        {/* Contents: the jump list, plus the two sentences derived from REGISTER_ENTRIES. */}
        <section>
          <div className="inner measure">
            <p className="eyebrow">{CONTENTS_EYEBROW}</p>
            <h2>{CONTENTS_HEADING}</h2>
            <ul className="jump">
              {CONTENTS_ENTRIES.map((entry) => (
                <li key={entry.id}>
                  <a className="mono dim" href={`#${entry.id}`}>
                    {entry.text}
                  </a>
                </li>
              ))}
            </ul>
            <p className="dim mt-28">
              {UNMITIGATED_NOTE}
            </p>
          </div>
        </section>

        <hr className="rule" />

        {/* Register: the fifteen entries, each as What it is / Worst case / What is done. */}
        <section>
          <div className="inner">
            {REGISTER_ENTRIES.map((entry) => (
              <article key={entry.id} id={entry.id} className="mb-64">
                <h3>{entry.heading}</h3>
                <p className="dim mono mt-8 mb-20">
                  {entry.severityLabel}
                </p>
                <div className="facts one-col">
                  {entry.rows.map((row) => (
                    <div className="fact" key={row.dt}>
                      <p className="k">{row.dt}</p>
                      <p className="v">
                        <Html value={row.dd} />
                      </p>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>

        <hr className="rule" />

        {/* Review: what the security review covers, and what it does not. */}
        <section>
          <div className="inner measure">
            <p className="eyebrow">{REVIEW.eyebrow}</p>
            <h2>{REVIEW.heading}</h2>
            <p>
              <Html value={REVIEW.attestation} />
            </p>
            <p className="dim">
              <Html value={REVIEW.caveat} />
            </p>
          </div>
        </section>

        <hr className="rule" />

        {/* Scope additions: the twenty-entry caveat list, then the four groups this is wrong for. */}
        <section>
          <div className="inner">
            <p className="eyebrow">{SCOPE_EYEBROW}</p>
            <h2 className="measure">{SCOPE_HEADING}</h2>
            <p className="lede measure lede-sub">
              {SCOPE_LEDE}
            </p>
            <div className="facts facts one-col mt-44">
              {SCOPE_ROWS.map((row) => (
                <div className="fact" key={row.key}>
                  <p className="k">{row.term}</p>
                  <p className="v">
                    <Html value={row.body} />
                  </p>
                </div>
              ))}
            </div>

            <h3 className="mt-64">{GROUPS_HEADING}</h3>
            <div className="facts mt-24">
              {GROUPS.map((group) => (
                <div className="fact" key={group.title}>
                  <p className="k">{group.title}</p>
                  <p className="v">
                    <Html value={group.body} />
                  </p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <hr className="rule" />

        {/* Verify: how to check every claim on this page. */}
        <section>
          <div className="inner measure">
            <p className="eyebrow">{VERIFY_EYEBROW}</p>
            <h2>{VERIFY_HEADING}</h2>
            <p className="dim">{VERIFY_LEDE}</p>

            <div className="facts facts one-col mt-40">
              {REFERENCES.map((ref) => (
                <div className="fact" key={ref.key}>
                  <p className="k mono">
                    <Html value={ref.term} />
                  </p>
                  <p className="v">
                    <Html value={ref.body} />
                  </p>
                </div>
              ))}
            </div>

            <div className="actions">
              {ACTIONS.map((action) => (
                <a key={action.href} href={action.href} className="mono">
                  {action.label}
                </a>
              ))}
            </div>

            <p className="dim mt-40">
              <Html value={SELF_REFERENCE} />
            </p>
          </div>
        </section>
    </Page>
  );
}
