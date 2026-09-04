// @ts-check
/**
 * The canonical-host middleware, which is what keeps the sanctions geofence from being one
 * hostname away from irrelevant.
 *
 * The country block is a WAF rule on the `rwally.com` ZONE. Cloudflare Pages serves the same
 * site on `rwally.pages.dev` and on per-deployment and per-branch hostnames, none of which are
 * in that zone, so zone WAF rules never see them. The middleware 301s every non-canonical
 * hostname back to `rwally.com`, which puts real visitors back where the rule applies.
 *
 * These tests exist because that is easy to break by accident — a refactor that returns
 * `next()` unconditionally would still serve every page correctly on every hostname, pass every
 * other test in this suite, and silently re-open the hole. Nothing else would notice.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { onRequest } from '../functions/_middleware.js';

const SERVED = 'served-by-next';
/** @param {string} url */
const ctx = (url) => ({
  request: new Request(url),
  next: async () => new Response(SERVED, { status: 200 }),
});

test('the canonical host is served, not redirected', async () => {
  const res = await onRequest(ctx('https://rwally.com/how-it-works'));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), SERVED);
});

test('every pages.dev hostname is redirected to the zone — the geofence hole', async () => {
  // Production Pages hostname. This one CANNOT be removed by the "public access to preview
  // deployments" setting, because it is not a preview — redirecting is the only in-repo fix.
  for (const host of [
    'rwally.pages.dev',
    'aa060edf.rwally.pages.dev', // a per-deployment hostname
    'protocol-main.rwally.pages.dev', // a per-branch alias
  ]) {
    const res = await onRequest(ctx(`https://${host}/risks`));
    assert.equal(res.status, 301, `${host} was served instead of redirected`);
    assert.equal(
      res.headers.get('location'),
      'https://rwally.com/risks',
      `${host} did not land on the canonical zone`
    );
  }
});

test('www redirects to the apex — the rule _redirects cannot express', async () => {
  const res = await onRequest(ctx('https://www.rwally.com/faq'));
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), 'https://rwally.com/faq');
});

test('path and query survive the hop, so a shared deep link still works', async () => {
  const res = await onRequest(ctx('https://rwally.pages.dev/operators?ref=x&y=1'));
  assert.equal(res.headers.get('location'), 'https://rwally.com/operators?ref=x&y=1');
});

test('the root path redirects without producing a double slash', async () => {
  const res = await onRequest(ctx('https://rwally.pages.dev/'));
  assert.equal(res.headers.get('location'), 'https://rwally.com/');
});

test('an http request on a non-canonical host is upgraded to https', async () => {
  const res = await onRequest(ctx('http://rwally.pages.dev/agents'));
  assert.equal(res.headers.get('location'), 'https://rwally.com/agents');
});

test('a protocol-relative path cannot redirect off the canonical host (CWE-601)', async () => {
  // This shipped and was LIVE: building the target as `new URL(pathname+search, base)` treats a
  // pathname starting with `//` as protocol-relative, so the parser replaces the AUTHORITY and
  // the redirect leaves the site. Verified in production before the fix:
  //   https://rwally.pages.dev//evil.example/x  ->  https://evil.example/x
  for (const path of [
    '//evil.example/x',
    '/\/evil.example/x', // the parser normalises `\` to `/` before parsing
    '//attacker.test/connect-wallet?a=1',
    '///triple.example/x',
  ]) {
    const res = await onRequest(ctx(`https://rwally.pages.dev${path}`));
    const loc = new URL(res.headers.get('location'));
    assert.equal(
      loc.hostname,
      'rwally.com',
      `open redirect: ${path} escaped to ${loc.hostname}`
    );
  }
});
