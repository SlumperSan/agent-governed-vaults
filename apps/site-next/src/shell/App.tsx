/**
 * The root React element, identical on the server and on the client.
 *
 * It is deliberately trivial and deliberately branch-free. The server renders
 * this, the client hydrates this, and nothing in it consults `matchMedia`, the
 * viewport, `window` or the clock — a branch on any of those produces a client
 * tree that differs from the prerendered one, and React 19 responds by
 * discarding the mismatched subtree. That subtree is the markup the claims
 * guards just verified, so a hydration mismatch is a claims failure with a
 * console warning for a symptom.
 *
 * Responsive decisions live in CSS media queries. Motion is added after
 * hydration, in an effect. See src/motion/.
 */
import type { ComponentType, JSX } from 'react';
import { LenisProvider } from '../motion/LenisProvider';
import { PageShell } from './PageShell';
import type { PageId } from './pinned';

export function App({ page, Body }: { page: PageId; Body: ComponentType | null }): JSX.Element {
  return (
    <LenisProvider>
      <PageShell page={page}>{Body ? <Body /> : null}</PageShell>
    </LenisProvider>
  );
}
