#!/usr/bin/env node
// @ts-check
/**
 * Static file server for the docs site. Zero dependencies, Node built-ins only.
 *
 * It exists because the site fetches the repo's markdown at runtime, and a browser refuses
 * `fetch()` over `file://` — so opening `index.html` from disk shows an empty shell. Rather than
 * leave that as a footgun in the quickstart, the server ships with the site.
 *
 * Run from the repo root:
 *   node docs/site/serve.mjs            → http://127.0.0.1:8403/docs/site/
 *   node docs/site/serve.mjs --port=9000
 *
 * The document root is the REPO root, not `docs/site/`, because the site's whole point is to render
 * files that live elsewhere in the tree (`docs/*.md`, `llms.txt`, `docs/api/openapi.yaml`). Reads
 * are confined to that root and to a read-only allowlist of extensions; it binds loopback by
 * default. This is a local docs viewer, not a production web server — do not expose it.
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, normalize, sep, extname, resolve } from 'node:path';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Extensions the viewer will serve. Anything else 404s — including `.env`, keys, and binaries. */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.sol': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Map a request URL to a path inside the repo root, or null to refuse.
 * Normalisation happens BEFORE the prefix check, so `/../../etc/passwd` and its encoded forms
 * cannot walk out of the root.
 * @param {string} url
 * @returns {string|null}
 */
export function resolveRequestPath(url) {
  let decoded;
  try {
    decoded = decodeURIComponent(url.split('?')[0].split('#')[0]);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  if (decoded === '/' || decoded === '') decoded = '/docs/site/index.html';
  if (decoded.endsWith('/')) decoded += 'index.html';

  const abs = normalize(join(REPO_ROOT, decoded));
  if (abs !== REPO_ROOT && !abs.startsWith(REPO_ROOT + sep)) return null;
  if (!(extname(abs).toLowerCase() in TYPES)) return null;
  return abs;
}

export function createDocsServer() {
  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain' });
      res.end('method not allowed');
      return;
    }
    const abs = resolveRequestPath(req.url ?? '/');
    if (!abs) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    try {
      const st = await stat(abs);
      if (!st.isFile()) throw new Error('not a file');
      res.writeHead(200, {
        'content-type': TYPES[extname(abs).toLowerCase()],
        'content-length': st.size,
        'cache-control': 'no-cache',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(abs).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const portArg = process.argv.find((a) => a.startsWith('--port='));
  const port = portArg ? Number(portArg.slice('--port='.length)) : 8403;
  const host = process.argv.includes('--any-host') ? '0.0.0.0' : '127.0.0.1';
  createDocsServer().listen(port, host, () => {
    console.log(`docs site  →  http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/docs/site/`);
    console.log(`serving    →  ${REPO_ROOT}`);
    console.log('Ctrl+C to stop.');
  });
}
