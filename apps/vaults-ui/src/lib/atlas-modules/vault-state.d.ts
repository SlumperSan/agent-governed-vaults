/** Types for `apps/web/src/vault-state.mjs` — see that file for the full design rationale (the
 *  two deliberate traps `actions()` refuses beyond what the contract itself forbids, and why
 *  `frozen: boolean | null` is tri-state rather than a plain boolean). */

export interface VaultFacts {
  readonly frozen: boolean | null;
  readonly attested: boolean;
  readonly exitMode: 'I' | 'F' | 'unknown';
  readonly isMember: boolean;
  readonly hasPendingDeposit: boolean;
  readonly pendingMatured: boolean;
  readonly hasQueuedExit: boolean;
  readonly capacityFull: boolean;
  readonly capacityKnown?: boolean;
  readonly isCreatorBelowGate?: boolean;
  readonly walletConnected?: boolean;
}

export interface Verdict {
  readonly available: boolean;
  readonly reason: string;
  readonly severity: 'ok' | 'info' | 'warn' | 'blocked';
}

export interface VaultNotice {
  readonly id: string;
  readonly tone: string;
  readonly title: string;
  readonly body: string;
}

export interface VaultActions {
  readonly deposit: Verdict;
  readonly activate: Verdict;
  readonly cancelPending: Verdict;
  readonly exit: Verdict;
  readonly skipWindow: Verdict;
  readonly settleQueuedExit: Verdict;
  readonly notices: readonly VaultNotice[];
}

export declare function actions(f: VaultFacts): VaultActions;

export interface VaultStatusBadge {
  readonly key: string;
  readonly label: string;
  readonly tone: string;
  readonly glyph: string;
}

export declare function vaultStatus(f: VaultFacts): VaultStatusBadge;
