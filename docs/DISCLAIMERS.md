# Disclaimers

**The one place in this repository for legal and risk disclaimers.** The README, `llms.txt` and the
docs link here instead of repeating them. The full text of every risk — what it is, the worst case,
and what is done about it — is the Disclaimers page at
[rwally.com/disclaimers](https://rwally.com/disclaimers). This file quotes that page's standing
paragraphs word for word and indexes its risk register, and
`scripts/test/disclaimers-doc.test.mjs` fails if the two drift apart.

## Not an offer

This holds for this repository exactly as it does for the site, whose words these are:

Nothing on this site is an offer, a solicitation, or financial advice.

## You can lose all of it

Spot crypto assets fall. Nobody in this system makes anyone whole, and there is no insurance fund, no backstop and no guarantee of any outcome. Do not deposit anything you cannot afford to lose entirely.

## Where it may be restricted

Interests in these vaults may be treated as securities or as collective investment scheme interests in some jurisdictions. Access from restricted jurisdictions is intended to be geofenced at the front end; that is a good-faith measure and not a guarantee, because the contracts are permissionless and can be called directly by anyone.

## Licence

The repository is under the MIT licence (`LICENSE`). One licensing question is open: vendored
third-party mathematics carries GPL-2.0-or-later terms alongside MIT ones, so part of the tree may
have to change licence. That is entry 13 below.

## The risk register

Each entry's severity is the site's own label. Read the full entry on
[rwally.com/disclaimers](https://rwally.com/disclaimers) before relying on this list.

1. **Immutability itself** — Structural, no mitigation exists.
2. **An oracle freeze traps every exit** — Accepted by design.
3. **A single price provider, with no fallback** — Partially mitigated.
4. **The settlement token is pinned at $1.00 in the oracle** — Accepted, no mitigation.
5. **Sequencer downtime** — Handled in code, never exercised.
6. **Forward-settled exits are irrevocable** — Accepted by design.
7. **Governance capture and thin electorates** — Partially mitigated.
8. **The rules can freeze permanently** — Accepted by design.
9. **Operator identity cannot be rotated** — Accepted, no recovery path.
10. **Total loss is possible** — Not mitigable.
11. **Securities and collective investment scheme recharacterization** — Open, unresolved.
12. **The reference agent is beta code** — Out of review scope.
13. **An open licensing question** — Open, owner decision.
14. **This is experimental software** — Structural.
15. **There is no oracle rotation path** — Accepted, no recovery path.
