import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { publicDocuments } from '../packages/public-api/src/index';
const origin = process.argv[2] ?? 'http://127.0.0.1:4173';
const output = process.argv[3];
const results: unknown[]=[];
async function check(path:string, status:number, type:string, options:RequestInit={}, inspect?:(body:string, response:Response)=>void) {
  const response=await fetch(new URL(path,origin),{...options,signal:AbortSignal.timeout(20_000)});const body=await response.text();
  assert.equal(response.status,status,`${path} status`);assert.ok(response.headers.get('content-type')?.includes(type),`${path} content-type`);inspect?.(body,response);
  results.push({path,method:options.method??'GET',accept:new Headers(options.headers).get('accept'),status:response.status,contentType:response.headers.get('content-type'),vary:response.headers.get('vary'),bytes:Buffer.byteLength(body),finalUrl:response.url});
}
const content=(body:string)=>body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim();
await check('/',200,'text/html',{headers:{Accept:'text/html'}},body=>{assert.ok(content(body).length>500);assert.equal((body.match(/<h1\b/g)??[]).length,1);assert.ok(body.includes('application/ld+json'));assert.ok(body.includes('rel="canonical"'));assert.ok(body.includes('og:image'));});
await check('/',200,'text/markdown',{headers:{Accept:'text/markdown'}},(body,response)=>{assert.ok(body.length>500);assert.ok(response.headers.get('vary')?.toLowerCase().split(',').map(x=>x.trim()).includes('accept'));});
for(const path of [...publicDocuments.map(d=>d.path),'/about/','/contact/','/privacy/']) await check(path,200,'text/html',{},body=>assert.ok(content(body).length>500,path+' useful initial HTML'));
for(const doc of publicDocuments) await check(doc.path,200,'text/markdown',{headers:{Accept:'text/markdown'}},body=>assert.ok(body.startsWith('# ')));
for(const path of ['/api/public/status','/api/public/permissions','/api/public/docs',...publicDocuments.map(d=>'/api/public/docs/'+d.slug),'/openapi.json']) {
  await check(path,200,'application/json',{},(body,response)=>{JSON.parse(body);assert.equal(response.headers.get('x-api-version'),'1');});await check(path,200,'application/json',{method:'HEAD'},body=>assert.equal(body,''));
}
for(const path of ['/api/public/absent','/api/public/docs/nope','/api/missing','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource','/mcp']) await check(path,404,'application/problem+json',{},body=>{const problem=JSON.parse(body);assert.equal(problem.status,404);assert.ok(problem.resolution.length>20);});
await check('/api/public/status',405,'application/problem+json',{method:'POST'},(body,res)=>{assert.equal(JSON.parse(body).status,405);assert.equal(res.headers.get('allow'),'GET, HEAD');});
await check('/not-a-castroom-page',404,'text/markdown',{headers:{Accept:'text/markdown'}},body=>{assert.ok(body.length>20);assert.ok(body.includes('/docs/'));});
await check('/not-a-castroom-page',404,'text/html');
await check('/api/public/status',200,'application/json',{headers:{'X-API-Version':'1'}},(_,res)=>assert.equal(res.headers.get('vary'),'X-API-Version'));
await check('/api/public/status',400,'application/problem+json',{headers:{'X-API-Version':'2'}},body=>assert.equal(JSON.parse(body).code,'unsupported_api_version'));
for(const [path,type] of [['/llms.txt','text/plain'],['/robots.txt','text/plain'],['/sitemap.xml','xml'],['/design.css','text/css'],['/docs/docs.css','text/css'],['/favicon.svg','image/svg+xml'],['/og.png','image/png'],['/fonts/InterVariable.woff2','font/woff2'],['/fonts/LICENSE.txt','text/plain']]) await check(path,200,type);
const evidence={origin,verifiedAt:new Date().toISOString(),checks:results.length,results};if(output)await writeFile(output,JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify({origin,checks:results.length,result:'passed'}));
