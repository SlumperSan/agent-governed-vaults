/**
 * api.html — the page for a program reading this protocol over HTTP, rather
 * than a person reading a screen. One section carries the whole body; see
 * `src/sections/api-docs/ApiDocs.tsx` for what it says and why.
 */
import ApiDocs from '../sections/api-docs/ApiDocs';

export default function ApiPage() {
  return <ApiDocs />;
}
