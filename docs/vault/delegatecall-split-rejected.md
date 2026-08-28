# Delegatecall Split — Rejected at Launch

A proposed EIP-170 workaround — splitting `VaultCore` logic across a delegatecall'd library to reclaim bytecode headroom — was taken **off the launch path** once sub-vaults were disabled. **REJECTED-AT-LAUNCH.**

## Why it matters

`VaultCore` runs against the EIP-170 24,576-byte contract-size ceiling: at the end of the remediation session it had only **1,014 B** of margin. That budget governed *which findings could be fixed at all* — H-5, H-6, H-9 and M-15's exit-side remain unfixed precisely because they land in `VaultCore` and there is no room. A delegatecall split was the obvious way to buy headroom for that work.

## The decision and rationale

The split was attractive only while the un-fixed, `VaultCore`-resident findings were **on the launch path**. Two things removed that pressure:

1. **[[root-vaults-only]] disabled sub-vaults**, which made H-5, H-6, H-7, H-9 **DORMANT-AT-LAUNCH** (they all require a funded child, which cannot exist). The most byte-hungry pending work was no longer launch-blocking.
2. The remaining byte spends were absorbed without a split — notably **M-11 returned 336 B** (bounded assembly is smaller than the `abi.decode` path it replaced, and the helpers inline at every call site), which is the only reason M-2's 504-byte escrow routing fit at all.

A delegatecall split is not free: it adds an indirection layer, a new trust boundary, and storage-collision risk to the most delicate contract in the system — exactly where unreviewed complexity is least welcome before an external audit. With the launch-critical `VaultCore` work either done or deferred-with-sub-vaults, the split's cost stopped being worth paying **now**. It is deferred, not deleted: if a future sub-vault release reintroduces the H-5/H-6 pressure, the split (or moving code out of `VaultCore`) returns as a live option.

## Links

- Enabled by: [[root-vaults-only]] · relieved findings: [[highs]] (H-5/H-6/H-9)
- Contracts: [[vaultcore]] · [[execution-adapters]] · [[safetransferlib]]
- Byte-budget context: [[remediation-history]] · [[open-items]] · [[launch-readiness-gates]]
- Related decisions: [[decisions-index]] · [[build-vs-buy]]
