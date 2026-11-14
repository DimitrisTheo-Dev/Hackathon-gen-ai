// Execute compiled ESM exactly as a Node server does; tsx hides missing-extension failures.
import assert from 'node:assert/strict';
import proxy from '../.vercel/proxy-check/proxy.js';
for (const path of ['/', '/docs/api/', '/api/public/status', '/openapi.json']) {
  const response = proxy(new Request(`https://castroom.test${path}`,{headers:{Accept:'text/markdown'}}));
  assert.equal(response.status,200,path);
}
assert.equal(proxy(new Request('https://castroom.test/absent')).status,404);
console.log('Compiled Node ESM public-handler smoke checks passed.');
