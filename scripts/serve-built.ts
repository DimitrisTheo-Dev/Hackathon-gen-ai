/** Local verification server for built assets and the same public request handler deployed on Vercel. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import proxy from '../proxy';
const root = resolve('dist');
const port = Number(process.env.PORT ?? 4173);
// Opt-in, test-only: the real engine logic on an in-memory store for browser tests. Never set in production.
const engine = process.env.FACEFUL_E2E_ENGINE === 'memory' ? (await import('../tests/browser/support/memory-engine')).createMemoryEngine(`http://127.0.0.1:${port}`) : null;
const types: Record<string,string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8', '.xml':'application/xml' };
createServer(async (req,res) => {
  try {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key,value]) => { if(value) headers.set(key,Array.isArray(value)?value.join(','):value); });
    if(engine && (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/__e2e/') || url.pathname === '/mcp')) {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer);
      const answer = await engine(new Request(url,{method:req.method,headers,body:req.method==='GET'||req.method==='HEAD'?undefined:Buffer.concat(chunks)}),url.pathname);
      if(answer) { res.writeHead(answer.status,Object.fromEntries(answer.headers)); res.end(Buffer.from(await answer.arrayBuffer())); return; }
    }
    const request = new Request(url,{method:req.method,headers});
    const result = proxy(request);
    if(result.headers.get('x-middleware-next') !== '1') { res.writeHead(result.status,Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return; }
    // The same pages vercel.json rewrites to the app shell.
    // Real files under those folders (e.g. /pitch/presenter.vtt) are served as files, as Vercel does before rewrites.
    const privatePage = /^\/(studio|dev|oauth|claude-login-test|pitch)(\/|$)/.test(url.pathname) && !/\/[^/]+\.[a-z0-9]+$/i.test(url.pathname);
    const filename = privatePage ? resolve(root,'studio/index.html') : resolve(root,'.'+decodeURIComponent(url.pathname));
    if(filename !== root && !filename.startsWith(root+sep)) {res.writeHead(404);res.end();return;}
    const file = (await stat(filename)).isDirectory() ? resolve(filename,'index.html') : filename;
    const body = await readFile(file);
    const extra = Object.fromEntries(result.headers);delete extra['x-middleware-next'];
    res.writeHead(200,{'Content-Type':types[extname(file)] ?? 'application/octet-stream',...extra});res.end(req.method==='HEAD'?undefined:body);
  } catch {res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found. See /docs/.');}
}).listen(port,'127.0.0.1',()=>console.log(`Built Faceful verification server: http://127.0.0.1:${port}${engine?' (in-memory engine for tests)':''}`));
