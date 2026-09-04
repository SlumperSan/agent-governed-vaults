/**
 * Canonical-host redirect for the public site.
 *
 * WHY THIS EXISTS — it closes a hole in the sanctions geofence, not an SEO nicety.
 *
 * The country block is a WAF custom rule on the `rwally.com` ZONE. Cloudflare Pages also serves
 * this exact site on hostnames that are NOT part of that zone:
 *
 *   rwally.pages.dev              the project's production Pages hostname
 *   <hash>.rwally.pages.dev       one per deployment
 *   <branch>.rwally.pages.dev     one per branch alias
 *
 * Zone WAF rules never see those requests, so every one of them was an unfiltered path to the
 * same content — the restriction was one hostname away from being irrelevant. Note the fix is
 * NOT to hide the pages.dev URLs: `rwally.pages.dev` is the PRODUCTION Pages hostname, and the
 * "public access to preview deployments" setting governs previews only, so it cannot remove it.
 * Redirecting is what actually works, because it puts every real visitor back on the zone where
 * the WAF applies.
 *
 * WHY HERE AND NOT `_redirects` — that file explains at length that Pages matches the source
 * column on PATH ONLY, so a hostname rule written there deploys clean and silently does nothing.
 * A Function is the only in-repo mechanism that can read `Host`. It needs no plan upgrade and no
 * Cloudflare Access configuration.
 *
 * CANONICAL HOST is `rwally.com`, matching sitemap.xml, robots.txt's Sitemap line, and every
 * page's og:url. `www.rwally.com` redirects here too, which is the www->apex rule `_redirects`
 * records as impossible to express there.
 *
 * A redirect is not an access control. Someone who ignores the 301 can still read the response
 * from a pages.dev hostname directly. This closes the ordinary-visitor path, and is deliberately
 * the weaker of the two claims — the geofence itself remains the WAF rule on the zone.
 */

const CANONICAL_HOST = 'rwally.com';

export const onRequest = async (context) => {
  const { request, next } = context;
  const url = new URL(request.url);

  if (url.hostname === CANONICAL_HOST) return next();

  // Preserve path and query so a shared deep link survives the hop.
  const target = new URL(`${url.pathname}${url.search}`, `https://${CANONICAL_HOST}`);
  return Response.redirect(target.toString(), 301);
};
