// @ts-check
/**
 * The Terms of Use, ONE SOURCE, shared by `apps/site` (the published page) and `apps/vaults-ui`
 * (the clickwrap), so the two cannot ship different words or disagree about the version hash.
 *
 * `TERMS_TEXT` IS VERBATIM. It is the part of
 * "Obsidian Vault/Agent-Governed Vaults/Business/Legal/Terms of Use draft v0.1 2026-09-23.md"
 * under its own "## Terms of Use" heading, through the end of "### 13. Whole agreement" —
 * card #214's own instruction: publish that part, not "## Held for counsel" above or below it.
 * Do not paraphrase or "clean up" this string. The owner-approved draft is the legal text; editing
 * it here would ship words counsel never saw. If the source `.md` changes, copy the new text in
 * here character for character — `terms-text.test.mjs` in this package's test/ (via
 * apps/site/test and apps/vaults-ui/test, which both import this module) checks the hash moves
 * when the text does, not that the text matches some other copy of itself.
 *
 * WHY A NEW PACKAGE RATHER THAN APPS/WEB. `apps/web/src` is the allocator front end's own
 * zero-dependency module set (`@atlas/*`), already aliased into `apps/vaults-ui`; the Terms text
 * has nothing to do with vault mechanics and putting it there would make an unrelated import
 * necessary just to reach a legal string. `packages/terms` has no `package.json` — nothing
 * declares it as an npm dependency, the same way `apps/vaults-ui` never lists `packages/chain-config`
 * in its own `package.json` (see that app's `vite.config.ts`): both apps reach this file by a
 * direct path (a relative import from `apps/site`, a `@rwally/terms` vite alias from
 * `apps/vaults-ui`), not by npm resolution.
 *
 * THE HASH IS A PURE FUNCTION OF `TERMS_TEXT`, computed with the Web Crypto `subtle.digest` that
 * is a global in both a browser and Node 19+ (this repo runs Node 24) — no `node:crypto` (browser
 * side would need a bundler polyfill) and no hand-rolled SHA-256 (a vendored crypto primitive is
 * exactly the kind of "build it" this repo's CLAUDE.md asks to avoid when nothing free is missing).
 * Memoized after the first call so every caller in one page load shares one digest.
 */

export const TERMS_VERSION = '0.1';

/** The line under the "## Terms of Use" heading in the source draft, kept separate from
 *  `TERMS_TEXT`'s sections so a renderer can style it as a subtitle rather than a numbered clause. */
export const TERMS_SUBTITLE = 'Version 0.1. By checking the box and continuing, you agree to these Terms.';

export const TERMS_TEXT = `## Terms of Use

*Version 0.1. By checking the box and continuing, you agree to these Terms.*

### 1. What this is

rwally.com and app.rwally.com (the **Interface**) are websites that help you read and interact
with smart contracts deployed on the Arc blockchain (the **Protocol**). The Interface is one way
to reach the Protocol, not the only one. The Protocol's contracts run on the blockchain by
themselves. Once a vault is set up, its rules change only through the member vote the contracts
require, and no one, us included, can pause the contracts or reverse a confirmed transaction.

**We never hold your funds.** You connect your own wallet, you sign every transaction yourself, and
your assets move only through the Protocol's contracts. We can't access your wallet, recover lost
keys, or undo a confirmed transaction.

### 2. Who may use the Interface

You may use the Interface only if all of these are true:

- you are at least 18 and legally able to agree to these Terms;
- you are not located in, organised in, or ordinarily resident in a country or region subject to
  comprehensive U.S. sanctions;
- you are not on, owned by, or acting for anyone on, a U.S. sanctions list, including OFAC's
  Specially Designated Nationals list;
- your use is lawful where you are.

### 3. Sanctions screening covers this Interface only

We block access to the Interface from comprehensively sanctioned jurisdictions, and we check a
connecting wallet address against OFAC's published sanctioned addresses. **This screening applies
to our front end only.** The Protocol's contracts are permissionless: anyone can call them directly
without this Interface, and we don't control who does. Passing our screening isn't a statement
that you are allowed to transact where you are. Checking that is your responsibility.

### 4. No advice, no fiduciary duty

Nothing in the Interface is investment, financial, legal or tax advice, or a recommendation to
buy, hold or sell anything. Nobody owes you a fiduciary duty. AI agents may propose actions for a
vault and members vote on them. A proposal, a vote result or a displayed figure is not advice or a
promise of any outcome. Make your own decisions, and get your own advice.

### 5. The risks are yours

Using the Protocol can lose you **all** of the money you put in. The Disclaimers page
(rwally.com/disclaimers) describes the specific risks, and you should read it before depositing.
They include, among others:

- **Bugs.** The contracts can't be patched in place. A defect may be permanent.
- **Price feeds.** If a price feed goes stale, everything that reads the vault's value reverts,
  including your exit, and stays that way while the feed is stale.
- **Assets and issuers.** The vault's assets and USDC are issued by third parties who can pause,
  upgrade or blacklist them. We don't control those powers.
- **Liquidity and price impact.** Exits trade through on-chain liquidity. Large exits can move the
  price against you.
- **Governance.** Vault decisions pass by member vote. You can be outvoted, and a vote can be
  captured.
- **Blockchain.** Networks can halt, congest, or change. Transactions are final.

Figures shown in the Interface come from chain reads that can fail or go stale. Where a figure
couldn't be read, the Interface tries to say so, but it can be wrong.

### 6. Fees

Fees are set in the Protocol's contracts and shown in the Interface before you sign. We charge
nothing for using the Interface itself. You pay the network's transaction costs.

### 7. Things you must not do

Don't use the Interface to break the law, to evade sanctions, to launder money or finance terrorism,
to manipulate markets or votes, to attack or disrupt the Interface or the Protocol, or to get round
the screening in section 3.

### 8. Third parties

The Protocol and Interface rely on services we don't control, including the Arc network, Circle
(USDC and cirBTC), Chainlink price feeds, Uniswap liquidity pools, your wallet provider and your
RPC provider. Their terms govern your use of them, and we aren't responsible for them.

### 9. No warranties

The Interface and the Protocol are provided **"as is" and "as available"**, without warranties of
any kind, express or implied, including merchantability, fitness for a particular purpose,
accuracy, availability or non-infringement.

### 10. Limitation of liability

To the fullest extent the law allows, the people who build and run the Interface aren't liable
for any indirect, incidental, special, consequential or punitive damages, or for any loss of
funds, profits, data or opportunity, arising from your use of the Interface or the Protocol.
That applies even if we were told such loss was possible.

### 11. Indemnity

You agree to cover the people who build and run the Interface against claims, losses and costs
that come from your breach of these Terms or your misuse of the Interface.

### 12. Access and changes

We can change, restrict or stop the Interface at any time, for anyone, including where the law
requires it. We can update these Terms, and each version has its own hash. When the Terms change,
the Interface asks you to accept the new version before you deposit again. Stopping the Interface
doesn't stop the Protocol: its contracts stay reachable on-chain.

### 13. Whole agreement

These Terms and the Disclaimers page are the whole agreement between you and us about the
Interface. If part of these Terms can't be enforced, the rest still applies.`;

/** `**bold**` to `<strong>`, the same light hand-authored transform `apps/site/src/disclaimers-copy.ts`
 *  applies to its own ported sentences. Only wraps the words already in `TERMS_TEXT` — it inserts no
 *  new words, so this is markup, not an edit to the legal text. */
function inlineHtml(text) {
  return text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/** A "- " list block, where a continuation line (indented, no leading "- ") joins the item above it
 *  — exactly how sections 2 and 5 wrap their bullet text across lines in the source draft. */
function parseListItems(paraLines) {
  const items = [];
  for (const line of paraLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      items.push(trimmed.slice(2));
    } else if (items.length > 0) {
      items[items.length - 1] += ` ${trimmed}`;
    }
  }
  return items;
}

/** One section's body, as blank-line-delimited blocks: a "- " block becomes `{type:'ul'}`, anything
 *  else becomes `{type:'p'}` with its wrapped lines joined back into one sentence-flow string. */
function parseBody(raw) {
  return raw
    .trim()
    .split(/\n\s*\n/)
    .filter((para) => para.trim().length > 0)
    .map((para) => {
      const lines = para.split('\n');
      const firstLine = lines[0];
      if (firstLine !== undefined && firstLine.trim().startsWith('- ')) {
        return { type: 'ul', items: parseListItems(lines).map(inlineHtml) };
      }
      return { type: 'p', html: inlineHtml(lines.map((l) => l.trim()).join(' ')) };
    });
}

/**
 * `TERMS_TEXT`, split into its thirteen numbered sections — DERIVED, not a second hand-typed copy,
 * for the same reason `apps/site/src/disclaimers-copy.ts`'s `CONTENTS_HEADING` is computed from
 * `REGISTER_ENTRIES` rather than duplicated: two representations of the same words drift, and the
 * one nobody re-reads is the one that goes stale.
 *
 * THROWS RATHER THAN RETURNING FEWER THAN 13 — a parse that silently produced 11 sections would
 * ship a Terms page missing two clauses and nothing would report it. See CLAUDE.md's "a guard that
 * can skip is a guard that will".
 */
export function parseTermsSections(text) {
  const headingRe = /^### (\d+)\. (.+)$/gm;
  const matches = [...text.matchAll(headingRe)];
  if (matches.length !== 13) {
    throw new Error(
      `parseTermsSections: found ${matches.length} "### N. Title" headings, expected 13. TERMS_TEXT ` +
        'moved or the heading shape changed — fix the parser or the text before shipping either.',
    );
  }
  return matches.map((m, i) => {
    const heading = m[2];
    const numberStr = m[1];
    if (heading === undefined || numberStr === undefined) {
      throw new Error('parseTermsSections: a heading match is missing its captured groups');
    }
    const start = (m.index ?? 0) + m[0].length;
    const nextMatch = matches[i + 1];
    const end = nextMatch !== undefined ? (nextMatch.index ?? text.length) : text.length;
    return {
      id: `s${numberStr}`,
      number: Number(numberStr),
      heading,
      body: parseBody(text.slice(start, end)),
    };
  });
}

/** Memoized: every caller in one page load / test run shares one digest of the same input string. */
let hashPromise = null;

/** SHA-256 hex digest of `TERMS_TEXT`, via Web Crypto — see this file's header for why. */
export function termsTextSha256() {
  if (hashPromise === null) {
    hashPromise = (async () => {
      const bytes = new TextEncoder().encode(TERMS_TEXT);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    })();
  }
  return hashPromise;
}
