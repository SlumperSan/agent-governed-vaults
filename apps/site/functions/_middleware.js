/**
 * Sanctions geofence + canonical-host redirect for the public site. Two checks, in this order:
 *
 *   1. `blockedResponse(request.cf)` — card 212. Refuses a request from a comprehensively
 *      sanctioned jurisdiction with a plain HTTP 451, before anything else runs.
 *   2. The canonical-host redirect below — unchanged from before this card, kept in the same file
 *      because both exist for the identical reason (see next paragraph).
 *
 * WHY BOTH LIVE HERE, IN ONE FUNCTION, NOT TWO. This file's ENTIRE PREVIOUS HEADER COMMENT said the
 * sanctions geofence "is a WAF custom rule on the `rwally.com` ZONE" and that this redirect exists
 * only to close the gap that leaves for `*.pages.dev` traffic the WAF never sees. THAT SENTENCE IS
 * NO LONGER TRUE, AND THIS COMMIT IS WHAT MAKES IT FALSE: the geofence is now enforced BY THIS
 * FUNCTION, in code, on every hostname Cloudflare Pages serves this site on —
 * `rwally.com`, `www.rwally.com`, `rwally.pages.dev`, every `<hash>.rwally.pages.dev` and
 * `<branch>.rwally.pages.dev` alias — because a Pages Function runs on the request before Pages
 * decides which hostname it arrived on, the same property that made the canonical-host redirect
 * below work regardless of a zone-scoped WAF rule. A zone WAF rule, if one still exists on
 * `rwally.com`, is now redundant with this check rather than load-bearing for it; nothing in this
 * codebase should describe the geofence as "the WAF rule" going forward.
 *
 * WHAT THIS DOES NOT DO. This screens THIS INTERFACE'S OWN FRONT END ONLY. The Protocol's contracts
 * are permissionless and immutable on a public chain — anyone, anywhere, can call them directly
 * through their own RPC, a fork of this open-source front end, or a third-party interface, and
 * nothing here can prevent, detect, or reverse that. See `blockedResponse`'s own HTML for the exact
 * wording shown to a blocked visitor, and Terms of Use draft v0.1 §3 for the same claim in the
 * clickwrap. Never describe this as the Protocol excluding anyone.
 *
 * ─────────────────────────────── the canonical-host redirect, unchanged ───────────────────────────────
 *
 * Cloudflare Pages also serves this exact site on hostnames that are not `rwally.com`:
 *
 *   rwally.pages.dev              the project's production Pages hostname
 *   <hash>.rwally.pages.dev       one per deployment
 *   <branch>.rwally.pages.dev     one per branch alias
 *
 * Note the fix is NOT to hide the pages.dev URLs: `rwally.pages.dev` is the PRODUCTION Pages
 * hostname, and the "public access to preview deployments" setting governs previews only, so it
 * cannot remove it. Redirecting is what actually works for an ordinary visitor who followed a link
 * to one of those hostnames.
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
 * A redirect is not an access control by itself — someone who ignores the 301 can still read the
 * response from a pages.dev hostname directly. That is why the sanctions check above runs BEFORE
 * this redirect, and independently of it, rather than relying on the redirect to funnel every
 * visitor through a single hostname a WAF rule could then cover.
 */

// ─────────────────────────────────── sanctions geofence (card 212) ───────────────────────────────────

/**
 * OFAC comprehensively-sanctioned jurisdictions. Verified directly against OFAC's own live
 * "Sanctions Programs and Country Information" page
 * (https://ofac.treasury.gov/sanctions-programs-and-country-information, read 2026-09-23) —
 * NOT copied from this repo's own older notes (`Business/Legal/Jurisdiction and Geofence
 * Options.md`), which still lists Syria among the comprehensively-sanctioned set.
 *
 * SYRIA IS DELIBERATELY ABSENT. OFAC's current "Active Sanctions Programs" table (read the same
 * day) carries no "Syria Sanctions" program at all. The former country-wide Syrian Sanctions
 * Regulations were wound down after the fall of the Assad government in 2025 and replaced by
 * "Promoting Accountability for Assad and Regional Stabilization Sanctions" (PAARSS) — a
 * targeted, list-based program naming specific persons and entities, not a comprehensive
 * country-wide embargo. A PAARSS-listed person's wallet is still refused — by card 213's SDN
 * address screening in `apps/vaults-ui` — but blocking every visitor whose IP resolves to Syria
 * would no longer be an accurate description of what OFAC's programs currently require.
 *
 * `request.cf.country` returns ISO 3166-1 alpha-2 codes for the remaining three:
 */
const SANCTIONED_COUNTRIES = new Set([
  'CU', // Cuba Sanctions
  'IR', // Iran Sanctions
  'KP', // North Korea Sanctions
]);

/**
 * Crimea, and the so-called "Donetsk People's Republic"/"Luhansk People's Republic" areas of
 * Ukraine, carry their own comprehensive embargoes (EO 13685 for Crimea; EO 14065 for the DNR/LNR
 * areas) under OFAC's "Ukraine-/Russia-related Sanctions" program — distinct from the rest of
 * Ukraine, which is not comprehensively sanctioned as a whole country.
 *
 * `request.cf.country` for all of these is `'UA'` (Ukraine). Cloudflare's own documentation
 * (https://developers.cloudflare.com/workers/runtime-apis/request/, read 2026-09-23) describes
 * `regionCode` only as: "If known, the ISO 3166-2 code for the first-level region associated with
 * the IP address ... for example, 'TX'" — bare, without the country prefix, and explicitly
 * best-effort ("if known"). CLOUDFLARE PUBLISHES NO CONFIRMATION, EITHER WAY, THAT ITS
 * GEOLOCATION DATA DISTINGUISHES CRIMEA/DONETSK/LUHANSK FROM THE REST OF UKRAINE, OR THAT IT DOES
 * NOT INSTEAD ATTRIBUTE SOME OF THOSE IP RANGES TO COUNTRY CODE `'RU'`. Both the bare ISO 3166-2:UA
 * numeric codes and the fully-prefixed form are matched below to hedge that format uncertainty,
 * but THIS IS A DOCUMENTED, ACCEPTED GAP, NOT A VERIFIED GUARANTEE OF COVERAGE: a request
 * Cloudflare attributes to plain `'UA'` with no region code, or with a region code outside this
 * set, is NOT blocked by this check even if it in fact originates from one of these areas.
 * `Business/Legal/Jurisdiction and Geofence Options.md`'s own "what we cannot gate" section already
 * treats this class of residual bypass as accepted, documented risk for the geofence generally —
 * this is one concrete instance of it, named rather than silently assumed away.
 */
const SANCTIONED_UA_REGION_CODES = new Set([
  '43', 'UA-43', // Crimea (Avtonomna Respublika Krym)
  '40', 'UA-40', // Sevastopol (city with Crimea-equivalent status)
  '14', 'UA-14', // Donetsk oblast (so-called "DNR")
  '09', 'UA-09', // Luhansk oblast (so-called "LNR")
]);

/**
 * Whether an edge-populated `cf` object describes a comprehensively sanctioned request.
 *
 * MISSING `cf` FAILS CLOSED (blocked), AND THAT IS A DECISION, NOT AN OVERSIGHT. Cloudflare
 * populates `request.cf` unconditionally for every real request this Function ever sees on the
 * edge — the only way it is absent is local dev tooling that does not emulate it, or a genuine
 * platform anomaly. Given that, the choice is between "block a request this code cannot
 * geo-verify" and "allow one it cannot geo-verify" for a control that exists specifically to keep
 * sanctioned-jurisdiction visitors off this Interface — silently allowing what cannot be verified
 * defeats the purpose of having a sanctions screen at all, so this refuses instead. The residual
 * cost is local-dev friction, not a member-facing one: `wrangler pages dev` without emulated `cf`
 * would need `--local` geolocation stubbing or a fixture to exercise the non-blocked path, which
 * `test/geoblock-middleware.test.mjs` already covers with a fake `cf` object rather than depending
 * on a real edge request.
 */
export function isSanctionedRequest(cf) {
  if (!cf) return true;
  const country = cf.country;
  if (typeof country === 'string' && SANCTIONED_COUNTRIES.has(country)) return true;
  if (country === 'UA' && typeof cf.regionCode === 'string' && SANCTIONED_UA_REGION_CODES.has(cf.regionCode)) return true;
  return false;
}

/**
 * The exact, narrow claim card 212 asks for and nothing else: this screens the Interface, not the
 * chain. No jurisdiction is named in the response body — the block itself is the only fact a
 * visitor needs, and naming the specific list here would be one more place it could drift from the
 * constants above.
 */
const SANCTIONS_BLOCK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Access restricted</title></head>
<body>
<h1>Access restricted</h1>
<p>This website is not available from your location. This restriction applies to this website
only — the Protocol's underlying smart contracts are permissionless and remain reachable directly,
without this Interface.</p>
</body>
</html>`;

function sanctionsBlockedResponse() {
  return new Response(SANCTIONS_BLOCK_HTML, {
    status: 451,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// ─────────────────────────────────── canonical host ───────────────────────────────────

const CANONICAL_HOST = 'rwally.com';

export const onRequest = async (context) => {
  const { request, next } = context;

  if (isSanctionedRequest(request.cf)) return sanctionsBlockedResponse();

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
