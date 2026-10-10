/**
 * Terms of Use acceptance (card #214), recorded client-side only. Contracts stay permissionless —
 * this never becomes an on-chain gate — so the record this file keeps is exactly what the card
 * asks for and no more: {termsVersion, sha256 of the shipped text, acceptedAt, address}, one entry
 * per wallet, in `localStorage`.
 *
 * WHY LOCALSTORAGE ALONE, AND ITS LIMIT STATED HERE RATHER THAN LEFT IMPLICIT (card's "choices
 * left to the CTO" note). An EIP-191 signed acceptance message or a small logging endpoint would
 * both survive a cleared browser and be producible as evidence to a third party; `localStorage`
 * does not; and a wallet address plus a version hash is a CIVIL record, not a security control —
 * nothing this app or the contracts do differs based on whether a member accepted. Given that, and
 * that this card's own copy rule (main task prompt) says contracts stay permissionless and a
 * backend needs its own sign-off before being added, `localStorage` is the cheapest thing that
 * actually gates the UI today and is genuinely producible as "what this browser last recorded" if
 * ever asked. What it does NOT give: proof to a third party (a clevered wallet or a fresh profile
 * has no record and simply re-prompts — the safe failure direction, not a security hole), survival
 * across browsers/devices for the same member, or an operator-side audit trail. If a produced
 * record is ever required as EVIDENCE (a dispute, a regulator ask), that is the trigger to come
 * back to this card and add the signed-message or server-logged form — not something to build now
 * on spec.
 *
 * PER THE REPO'S STORAGE RULE: every `localStorage` read and write is wrapped in try/catch.
 * Storage can throw (private browsing, a full quota, a disabled setting) or simply be absent
 * (`window` unset during the SSR smoke render — see ssr-smoke.tsx's own note that MemberActions
 * never mounts there, but this module is safe to import regardless). A throw here must never
 * crash the deposit flow: the safe fallback in every case is "treat as not yet accepted", which
 * re-prompts rather than silently unblocking a deposit no one actually agreed to.
 */

export interface TermsAcceptance {
  readonly termsVersion: string;
  readonly termsTextSha256: string;
  readonly acceptedAt: number;
  readonly address: string;
}

const STORAGE_KEY = 'rwally.termsAcceptance.v1';

function isTermsAcceptance(value: unknown): value is TermsAcceptance {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.termsVersion === 'string' &&
    typeof v.termsTextSha256 === 'string' &&
    typeof v.acceptedAt === 'number' &&
    typeof v.address === 'string'
  );
}

/** Every stored acceptance, keyed by lowercased address. Never throws — a corrupt or inaccessible
 *  store reads as "nobody has accepted anything", the same safe direction as every other failed
 *  read in this app (see MemberActions.tsx: a failed read is not a clean state). */
function readAll(): Record<string, TermsAcceptance> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, TermsAcceptance> = {};
    for (const [address, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (isTermsAcceptance(entry)) out[address] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, TermsAcceptance>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // Storage refused the write (quota, private mode, disabled). The acceptance simply is not
    // remembered for next time — the clickwrap re-prompts, which is the safe failure direction,
    // never a deposit that silently proceeds as though it had been recorded.
  }
}

/** Records that `address` accepted `termsVersion`, whose text hashes to `hash`. */
export function recordTermsAcceptance(address: string, termsVersion: string, hash: string): void {
  const all = readAll();
  const key = address.toLowerCase();
  all[key] = { termsVersion, termsTextSha256: hash, acceptedAt: Math.floor(Date.now() / 1000), address };
  writeAll(all);
}

/**
 * Has `address` already accepted EXACTLY this version and EXACTLY this hash?
 *
 * BOTH MUST MATCH, not just the version string. `termsVersion` is the human label ("0.1"); `hash`
 * is what actually shipped. A version bump that forgets to change the '0.1' string would still be
 * caught because the hash moves with the text (see packages/terms/src/terms-text.mjs) — checking
 * the hash is what makes "a changed text re-prompts" true regardless of whether anyone remembered
 * to also bump the label.
 *
 * `hash === null` (not yet computed) and `address === null` (no wallet connected) both read as
 * "not accepted" — never default an unresolved state to "accepted", the same rule every other
 * gate in MemberActions.tsx already follows for a chain read that has not come back yet.
 */
export function hasAcceptedCurrentTerms(address: string | null, termsVersion: string, hash: string | null): boolean {
  if (address === null || hash === null) return false;
  const rec = readAll()[address.toLowerCase()];
  return rec !== undefined && rec.termsVersion === termsVersion && rec.termsTextSha256 === hash;
}
