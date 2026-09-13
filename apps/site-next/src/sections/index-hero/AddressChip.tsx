/**
 * An address chip: a label, the address, and a button that copies it.
 *
 * THE ADDRESS IS SHOWN SHORTENED AND COPIED IN FULL, and the two halves of that
 * sentence are the whole design. A forty-two character hex string set at chip
 * size is unreadable and unverifiable either way, so showing all of it buys
 * nothing; showing the first eight and the last eight is the form a reader
 * actually checks against a block explorer. What goes on the clipboard is the
 * complete address, because a truncated address on a clipboard is a way to lose
 * funds. The full string is also in the button's accessible name, so the two
 * never drift.
 *
 * THE BUTTON REVERTS. `Copied` returns to `Copy` after two seconds, so a reader
 * who copies a second address is not looking at two buttons both claiming
 * success. The timer is cleared on unmount, which matters here only because
 * React's strict mode mounts twice in development and an uncleared timer there
 * is a warning that trains people to ignore warnings.
 *
 * THE CLIPBOARD CALL CAN FAIL AND IS ALLOWED TO. `navigator.clipboard` is absent
 * over plain HTTP and can be refused by permission policy. There is no fallback
 * to the deprecated `execCommand` path and no error toast: the address is
 * rendered as selectable text right there, so a failed copy leaves the reader
 * exactly where a page with no copy button would have left them, which is a
 * working page rather than a broken feature.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { shorten } from '../../live/chain';
import { COPY_DONE, COPY_IDLE } from './copy';
import styles from './AddressChip.module.css';

export function AddressChip({
  label,
  address,
}: {
  label: string;
  address: string;
}): JSX.Element {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const onCopy = () => {
    void navigator.clipboard?.writeText(address).then(
      () => {
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 2000);
      },
      () => {
        // See the header note: the address is selectable text on the page, so a
        // refused clipboard is not a state this component has to represent.
      },
    );
  };

  return (
    <div className={styles.chip}>
      <span className={styles.label}>{label}</span>
      <span className={styles.address}>{shorten(address)}</span>
      <button
        type="button"
        className={styles.button}
        onClick={onCopy}
        aria-label={'Copy the ' + label + ' address, ' + address}
      >
        {done ? COPY_DONE : COPY_IDLE}
      </button>
      {/* The change of label is announced once, politely, rather than being a
          colour change a screen reader never learns about. */}
      <span className="sr-only" role="status">
        {done ? label + ' address copied.' : ''}
      </span>
    </div>
  );
}
