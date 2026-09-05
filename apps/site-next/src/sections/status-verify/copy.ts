/**
 * status-verify — copy for "Verification" on status.html: how to check every
 * line above.
 *
 * 2026-09-05 CORPUS SYNC. This section used to list six FILE PATHS at
 * `protocol/main` documenting the Base Sepolia deployment and the
 * launch-readiness board. The corpus's "Verification" section instead lists
 * six github.com LINKS into the Robinhood Chain mainnet deployment record and
 * the guard suites that check it — every href below is
 * `https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main/<path>`.
 * That includes the corpus's own reference to
 * `apps/site/test/site.test.mjs` (the OLD static site's guard, not this
 * application's `apps/site-next/test/site.test.mjs`) — carried exactly as the
 * corpus states it, not "corrected" to the new build's own suite.
 *
 * The corpus has no lede paragraph before the list for this section (unlike
 * the old draft, which opened with one), so none is rendered here.
 *
 * `term` now carries a real `<a>` element — the corpus turned these from bare
 * file paths into hyperlinks — so it goes through `<Pinned>` rather than a
 * plain text child. Two of the six entries (the two repository-wide guards)
 * are a single sentence ending at the link itself, with no separate
 * description after a colon the way the other four have; `body` is optional
 * for that reason and is omitted for those two rather than invented.
 */

export const EYEBROW = 'Verification';

export const HEADING = 'How to check every line above.';

const REPO_BLOB = 'https://github.com/SlumperSan/agent-governed-vaults/blob/protocol/main';

export type Reference = {
  readonly key: string;
  /** HTML source bytes: the corpus's own `<a href="…">Label</a>` markup. */
  readonly termHtml: string;
  /** The description after the colon, when the corpus's list item has one. */
  readonly bodyHtml?: string;
};

export const REFERENCES: readonly Reference[] = [
  {
    key: 'deployment-record',
    termHtml: `<a href="${REPO_BLOB}/contracts/config/deployments/robinhood-mainnet.json">The deployment record</a>`,
    bodyHtml: 'every address above, plus the note recording how each was read back on-chain.',
  },
  {
    key: 'chain-config',
    termHtml: `<a href="${REPO_BLOB}/contracts/config/robinhood-mainnet.json">The chain configuration</a>`,
    bodyHtml: 'every parameter this site quotes for chain 4663, each annotated with how it was read.',
  },
  {
    key: 'site-guard',
    termHtml: `<a href="${REPO_BLOB}/apps/site/test/site.test.mjs">The wording guard for this site</a>`,
    bodyHtml:
      'it pins the exact sentences here and reads the contract configuration to catch a page that has gone stale against it.',
  },
  {
    key: 'claims-guard',
    termHtml: `<a href="${REPO_BLOB}/scripts/test/claims-lede-truth.test.mjs">The repository-wide claims guard</a>.`,
  },
  {
    key: 'record-guard',
    termHtml: `<a href="${REPO_BLOB}/scripts/test/claims-robinhood-deployment.test.mjs">The record guard</a>`,
    bodyHtml:
      'it binds every Robinhood Chain claim in this repository to the deployment record, so a claim cannot land before the fact it describes.',
  },
  {
    key: 'config-guard',
    termHtml: `<a href="${REPO_BLOB}/scripts/test/config-doc-truth.test.mjs">The config-versus-docs guard</a>.`,
  },
];

export const CLOSING = 'All of these run in CI on every change. Read the contracts rather than this description of them.';

export const ACTIONS: ReadonlyArray<{ href: string; label: string; primary?: boolean }> = [
  { href: 'disclaimers.html', label: 'Disclaimers', primary: true },
  { href: 'how-it-works.html', label: 'The mechanism' },
  { href: 'https://github.com/SlumperSan/agent-governed-vaults', label: 'Contracts and docs' },
];
