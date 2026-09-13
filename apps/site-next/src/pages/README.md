# `src/pages/` — composition only, owned by Integrate

Eight files, one per page, and nothing else lives here:

| file | page | client entry that loads it |
| --- | --- | --- |
| `IndexPage.tsx` | `index.html` | `src/entry-index.tsx` |
| `HowItWorksPage.tsx` | `how-it-works.html` | `src/entry-how-it-works.tsx` |
| `AgentsPage.tsx` | `agents.html` | `src/entry-agents.tsx` |
| `WhoItsForPage.tsx` | `who-its-for.html` | `src/entry-who-its-for.tsx` |
| `OperatorsPage.tsx` | `operators.html` | `src/entry-operators.tsx` |
| `RisksPage.tsx` | `risks.html` | `src/entry-risks.tsx` |
| `FaqPage.tsx` | `faq.html` | `src/entry-faq.tsx` |
| `StatusPage.tsx` | `status.html` | `src/entry-status.tsx` |

The filenames are not free: `src/shell/pageBody.ts` maps each page id to exactly one of them, and
the entries glob for that name. A file called anything else is a page that never renders and never
errors.

## The contract

Each file default-exports a component that takes no props and returns the sections for that page, in
document order:

```tsx
export default function RisksPage() {
  return (
    <>
      <RisksHero />
      <RisksContents />
      <RisksRegister />
      <RisksReviewStatus />
      <RisksVerify />
    </>
  );
}
```

The banner, the masthead, `<main id="main">` and the footer are **not** here. `PageShell` renders
them around this component, from one source, which is what stops the pinned sentences drifting
between pages. A page that renders its own footer has two footers and fails the counted-sentence
check on the second one.

## What Integrate owns, and what it does not

Integrate owns these eight files. Not a section, not a shell file, not an entry, not a stylesheet.
If a page needs something that is not a section and not in `PageShell`, that is a shell request.

## The one obligation an empty page has

Every page must carry **exactly one `<h1>`**, and it comes from that page's hero section. Until a
page's hero lands, the built file has none and the document-skeleton check cannot pass. That is
expected while the sections are being written; it is not a thing to work around by adding an `<h1>`
here.
