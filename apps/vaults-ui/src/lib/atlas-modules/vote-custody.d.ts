/** Types for `apps/web/src/vote-custody.mjs` — see that file for the full design rationale. */
import type { Hex } from 'viem';

export declare const SALT_MESSAGE_PREFIX: string;
export declare const CUSTODY_UNREAD: 'unread';
export declare const CUSTODY_NONE: 'none';
export declare const CUSTODY_REVEALED: 'revealed';
export declare const CUSTODY_READY: 'ready';
export declare const CUSTODY_MISMATCH: 'mismatch';

export declare function saltMessage(p: { chainId: number; vault: string; pid: number | bigint | string }): string;

export declare function deriveSalt(p: {
  signMessage: (a: { message: string }) => Promise<string>;
  chainId: number;
  vault: string;
  pid: number | bigint | string;
  keccak256: (hex: Hex) => Hex | Promise<Hex>;
}): Promise<string>;

export declare function commitmentFor(p: {
  pid: number | bigint | string;
  voter: string;
  support: boolean;
  salt: string;
  keccak256: (hex: Hex) => Hex | Promise<Hex>;
  encodeAbiParameters: (
    types: ReadonlyArray<{ type: string }>,
    values: readonly unknown[],
  ) => Hex | Promise<Hex>;
}): Promise<string>;

export type VoteCustodyState =
  | { status: 'unread'; label: string; detail: string }
  | { status: 'none'; label: string; detail: string }
  | { status: 'revealed'; support: boolean; label: string; detail: string }
  | { status: 'ready'; support: boolean; salt: string; commitment: string; label: string; detail: string }
  | { status: 'mismatch'; onChainCommitment: string; label: string; detail: string };

export declare function reconstructVoteCustody(p: {
  chainId: number;
  vault: string;
  pid: number | bigint | string;
  voter: string;
  onChainCommitment: string | undefined;
  revealed: boolean | undefined;
  revealedSupport: boolean | undefined;
  signMessage: (a: { message: string }) => Promise<string>;
  keccak256: (hex: Hex) => Hex | Promise<Hex>;
  encodeAbiParameters: (
    types: ReadonlyArray<{ type: string }>,
    values: readonly unknown[],
  ) => Hex | Promise<Hex>;
}): Promise<VoteCustodyState>;

export declare function canReveal(state: VoteCustodyState | null | undefined): boolean;
