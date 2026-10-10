/** Types for `apps/web/src/seeded.mjs`, seeded-address awareness (card 210). */
export interface SeededAddressEntry {
  readonly address: string;
  readonly persona: string;
  readonly model: string;
  readonly fundedBy: string;
  readonly addedAt: string;
  readonly note: string;
}
export declare function seededEntryFor(
  address: unknown,
  entries: readonly SeededAddressEntry[] | null | undefined,
): SeededAddressEntry | null;
export declare function isSeeded(
  address: unknown,
  entries: readonly SeededAddressEntry[] | null | undefined,
): boolean;
export declare function organicMemberBound(holderCount: unknown, seededCount: unknown): number | null;
export declare function organicStakeWeightedClaim(holderCount: unknown, seededCount: unknown): boolean | null;
