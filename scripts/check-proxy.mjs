// Execute compiled ESM exactly as a Node server does; tsx hides missing-extension failures.
import assert from 'node:assert/strict';
import proxy from '../.vercel/proxy-check/proxy.js';
for (const path of ['/', '/docs/api/', '/api/public/status', '/openapi.json']) {
  const response = proxy(new Request(`https://castroom.test${path}`,{headers:{Accept:'text/markdown'}}));
  assert.equal(response.status,200,path);
}
assert.equal(proxy(new Request('https://castroom.test/absent')).status,404);
// The 404 is a real page: escaped path, a suggestion for near-misses, and agent entry points in HTML and Markdown.
const lost = await proxy(new Request('https://castroom.test/doc/mcp%3Cscript%3E')).text();
assert.ok(lost.includes('For agents') && lost.includes('/llms.txt') && !lost.includes('<script>'), 'html 404');
assert.ok((await proxy(new Request('https://castroom.test/doc/mcp')).text()).includes('Did you mean <a href="/docs/mcp/">'), 'suggestion');
const lostMd = proxy(new Request('https://castroom.test/nowhere',{headers:{Accept:'text/markdown'}}));
assert.equal(lostMd.status,404);
assert.ok((await lostMd.text()).includes('[Agent instructions](/llms.txt)'), 'markdown 404');
console.log('Compiled Node ESM public-handler smoke checks passed.');
