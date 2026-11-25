// Seed app. Node built-ins only. Listens on PORT, on 127.0.0.1 only.
// Writes only to DATA_DIR (it does not write at all yet).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const publicDir = path.join(import.meta.dirname, 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{"ok":true}');
  }

  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(publicDir, '.' + rel);
  const inside = file === publicDir || file.startsWith(publicDir + path.sep);
  if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

server.listen(Number(process.env.PORT), '127.0.0.1', () => {
  console.log(`Seed app listening on 127.0.0.1:${process.env.PORT}`);
});
