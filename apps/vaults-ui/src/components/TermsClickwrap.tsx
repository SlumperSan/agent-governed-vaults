import { TERMS_VERSION } from '@rwally/terms';

const TERMS_URL = 'https://rwally.com/terms';

interface Props {
  readonly checked: boolean;
  /** True while there is nothing to check yet — no wallet connected, or the hash has not resolved.
   *  Never let the box read as checkable against an unresolved hash (see MemberActions.tsx's
   *  `termsHash` state and terms-acceptance.ts's own null-hash rule). */
  readonly disabled: boolean;
  readonly onAccept: () => void;
}

/**
 * The clickwrap gating the FIRST deposit from a given wallet (card #214). Deliberately dumb: it
 * renders one checkbox and one link, and holds no state of its own — `MemberActions.tsx` owns
 * whether this wallet has already accepted (via `hasAcceptedCurrentTerms`) and only mounts this
 * component in the branch where it has not. There is no "uncheck" — accepting is a one-way action
 * recorded in `localStorage`; the box shown here is always the unchecked, un-actioned state.
 *
 * NEVER SHOWN AS ALREADY CHECKED. `checked` is read from props rather than kept as local
 * component state for exactly that reason: a real HTML checkbox can be given `checked` before the
 * click that is supposed to earn it, and a component that owned its own `checked` state would make
 * that an easy mistake to reintroduce later.
 */
export function TermsClickwrap({ checked, disabled, onAccept }: Props) {
  return (
    <p className="note act-row">
      <label>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || checked}
          onChange={(e) => {
            if (e.target.checked) onAccept();
          }}
        />{' '}
        I have read and agree to the{' '}
        <a href={TERMS_URL} target="_blank" rel="noreferrer noopener">
          Terms of Use v{TERMS_VERSION}
        </a>
      </label>
    </p>
  );
}
