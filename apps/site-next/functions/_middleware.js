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

  // Rewrite the AUTHORITY of the already-parsed URL. Never re-parse a path as a relative
  // reference against a base — that was an open redirect (CWE-601), shipped and live:
  //
  //   new URL(`${url.pathname}${url.search}`, `https://${CANONICAL_HOST}`)
  //
  // A pathname beginning with `//` is a PROTOCOL-RELATIVE url, so the WHATWG parser keeps the
  // base's scheme and REPLACES its authority. `https://rwally.pages.dev//evil.example/x` then
  // redirected to `https://evil.example/x` — an attacker-controlled destination reached through
  // a link on this project's own domain. A `\` variant worked too; the parser normalises it to
  // `/` before parsing.
  //
  // Zone-level URL normalization does NOT save this: it is a zone feature, and `*.pages.dev` is
  // in no zone — which is this file's own founding premise. The bug was exploitable precisely
  // where the file exists to help.
  //
  // Mutating the parsed URL cannot escape the host: `hostname` is a setter on an already-parsed
  // origin, so `//evil.example/x` stays a PATH.
  const target = new URL(url);
  target.protocol = 'https:';
  target.hostname = CANONICAL_HOST;
  target.port = '';
  return Response.redirect(target.toString(), 301);
};
