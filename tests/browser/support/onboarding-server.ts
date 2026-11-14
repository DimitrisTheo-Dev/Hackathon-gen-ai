/**
 * Static server for the onboarding browser specs: serves a build from its own output folder
 * (so it never touches the shared `dist/` other suites serve) and mounts the same opt-in
 * in-memory engine the live suite uses. Test-only; nothing here ships.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { createMemoryEngine } from './memory-engine';

const root = resolve(process.env.ONBOARDING_DIST ?? 'dist');
const port = Number(process.env.PORT ?? 4473);
const engine = createMemoryEngine(`http://127.0.0.1:${port}`);
const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/__e2e/')) {
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const answer = await engine(new Request(url, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks) }), url.pathname);
      if (answer) { res.writeHead(answer.status, Object.fromEntries(answer.headers)); res.end(Buffer.from(await answer.arrayBuffer())); return; }
    }
    // The signed-in shell answers every private route; everything else is a file from the build.
    const shell = /^\/(studio|dev|oauth)(\/|$)/.test(url.pathname) || url.pathname === '/';
    const filename = shell ? resolve(root, 'index.html') : resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (filename !== root && !filename.startsWith(root + sep)) { res.writeHead(404); res.end(); return; }
    const file = (await stat(filename)).isDirectory() ? resolve(filename, 'index.html') : filename;
    res.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Onboarding test server: http://127.0.0.1:${port} (serving ${root})`));
