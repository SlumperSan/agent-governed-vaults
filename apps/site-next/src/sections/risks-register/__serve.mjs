/**
 * Serves a directory of static files on 127.0.0.1 so the Browser pane can look
 * at the preview __preview.mjs built. A `file://` URL is not openable there,
 * and the dev server is out of bounds for this work, so this is the smallest
 * thing that closes the gap: no framework, no watch, no build step.
 *
 * Run:  node src/sections/risks-register/__serve.mjs <dir> [port]
 * Nothing here ships.
 */
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 5199);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

createServer((req, res) => {
  const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const file = path.join(dir, rel === '/' ? 'preview.html' : rel);
  if (!file.startsWith(dir)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if (!statSync(file).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => {
  console.log(`http://127.0.0.1:${port}/`);
});
