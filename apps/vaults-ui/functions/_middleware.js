/**
 * Sanctions geofence for the member surface (`app.rwally.com`) — card 212.
 *
 * WHY A NEW `functions/` DIRECTORY EXISTS HERE, DELIBERATELY, AND NOT CASUALLY. `wrangler.toml`'s
 * own header used to say "no `functions/` directory, and one must not appear casually" — this
 * commit is the deliberate exception that comment warned about, made in the same commit that
 * updates that file's comment to say so. Pages bundles `./functions` RELATIVE TO THE DIRECTORY
 * WRANGLER RUNS IN (`apps/vaults-ui`, matching `apps/site`'s own layout — see that project's
 * `wrangler.toml` for the same rule stated from its side), never from inside the uploaded `dist/`
 * output, so this file has to sit beside `wrangler.toml`, not under `public/` or `dist/`.
 *
 * WHY THIS APP NEEDS ITS OWN COPY OF THE CHECK RATHER THAN IMPORTING `apps/site`'s. The two are
 * separate Cloudflare Pages projects (`rwally` and `rwally-app`), each bundled independently by
 * wrangler from its own project root — a relative import reaching across `apps/site` and
 * `apps/vaults-ui` would make one project's deploy depend on the other project's directory still
 * existing at deploy time, which is a fragile coupling neither project's own docs describe today.
 * `apps/site/functions/_middleware.js` keeps the same "imports nothing" property this file does
 * for the same reason. `scripts/test/sanctioned-jurisdictions-sync.test.mjs` (repo root) is what
 * keeps the two copies of `SANCTIONED_COUNTRIES`/`SANCTIONED_UA_REGION_CODES` from drifting apart —
 * read that file's own header before changing either list.
 *
 * WHAT THIS DOES NOT DO — same claim as `apps/site`'s version. This screens THIS INTERFACE'S OWN
 * FRONT END ONLY. The Protocol's contracts are permissionless and immutable on a public chain —
 * anyone, anywhere, can call them directly through their own RPC, a fork of this open-source front
 * end, or a third-party interface, and nothing here can prevent, detect, or reverse that. See
 * Terms of Use draft v0.1 §3 for the same claim in the clickwrap.
 */

// ─────────────────────────────────── sanctions geofence (card 212) ───────────────────────────────────
//
// KEPT BYTE-IDENTICAL TO `apps/site/functions/_middleware.js`'s copy, and checked by
// `scripts/test/sanctioned-jurisdictions-sync.test.mjs` — see that project's file for the full
// citation trail (OFAC's live program list, Syria's 2025 PAARSS replacement, Cloudflare's own
// `regionCode` documentation) rather than repeating it a third time here.

const SANCTIONED_COUNTRIES = new Set([
  'CU', // Cuba Sanctions
  'IR', // Iran Sanctions
  'KP', // North Korea Sanctions
]);

const SANCTIONED_UA_REGION_CODES = new Set([
  '43', 'UA-43', // Crimea (Avtonomna Respublika Krym)
  '40', 'UA-40', // Sevastopol (city with Crimea-equivalent status)
  '14', 'UA-14', // Donetsk oblast (so-called "DNR")
  '09', 'UA-09', // Luhansk oblast (so-called "LNR")
]);

/**
 * See `apps/site/functions/_middleware.js`'s `isSanctionedRequest` for the full reasoning on
 * missing-`cf` failing closed — identical logic, kept as a second copy for the same
 * separate-Pages-project reason the constants above are duplicated rather than imported.
 */
export function isSanctionedRequest(cf) {
  if (!cf) return true;
  const country = cf.country;
  if (typeof country === 'string' && SANCTIONED_COUNTRIES.has(country)) return true;
  if (country === 'UA' && typeof cf.regionCode === 'string' && SANCTIONED_UA_REGION_CODES.has(cf.regionCode)) return true;
  return false;
}

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

export const onRequest = async (context) => {
  const { request, next } = context;
  if (isSanctionedRequest(request.cf)) return sanctionsBlockedResponse();
  return next();
};
