/** Local verification server for built assets and the same public request handler deployed on Vercel. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import proxy from '../proxy';
const root = resolve('dist');
const types: Record<string,string> = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png', '.webp':'image/webp', '.woff2':'font/woff2', '.txt':'text/plain; charset=utf-8', '.xml':'application/xml' };
createServer(async (req,res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1:4173');
    const headers = new Headers();
    Object.entries(req.headers).forEach(([key,value]) => { if(value) headers.set(key,Array.isArray(value)?value.join(','):value); });
    const request = new Request(url,{method:req.method,headers});
    const result = proxy(request);
    if(result.headers.get('x-middleware-next') !== '1') { res.writeHead(result.status,Object.fromEntries(result.headers)); res.end(Buffer.from(await result.arrayBuffer())); return; }
    const privatePage = /^\/(studio|dev)(\/|$)/.test(url.pathname);
    const filename = privatePage ? resolve(root,'studio/index.html') : resolve(root,'.'+decodeURIComponent(url.pathname));
    if(filename !== root && !filename.startsWith(root+sep)) {res.writeHead(404);res.end();return;}
    const file = (await stat(filename)).isDirectory() ? resolve(filename,'index.html') : filename;
    const body = await readFile(file);
    const extra = Object.fromEntries(result.headers);delete extra['x-middleware-next'];
    res.writeHead(200,{'Content-Type':types[extname(file)] ?? 'application/octet-stream',...extra});res.end(req.method==='HEAD'?undefined:body);
  } catch {res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found. See /docs/.');}
}).listen(4173,'127.0.0.1',()=>console.log('Built Faceful verification server: http://127.0.0.1:4173'));
