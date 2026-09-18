import { Footer } from './Footer';

/**
 * 404.html. Served by Cloudflare Pages, with a 404 status, for any path matching no asset.
 *
 * It exists so the host does not soft-404: without a top-level 404.html the Pages asset server
 * falls back to serving index.html with a 200 for every unmatched path, which reads to a crawler —
 * and to a reader — as though the page were real.
 */
export function NotFound() {
  return (
    <>
      <main>
        <section className="hero">
          <div className="shaft" aria-hidden="true" />
          <div className="inner">
            <p className="eyebrow">404</p>
            <h1>Nothing is recorded here.</h1>
            <p className="lede">
              That path does not exist on this site. It has not moved and it is not loading — there
              is simply no document at that address.
            </p>
            <p className="mt-36">
              <a href="/" className="mono">
                Back to the index
              </a>
            </p>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
