import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('Supabase OTP email uses one real token, no magic link, external assets or invented expiry',async()=>{
 const html=await readFile('supabase/templates/email-otp.html','utf8');
 assert.equal((html.match(/{{\s*\.Token\s*}}/g)??[]).length,1);
 assert.ok(!html.includes('.ConfirmationURL'));assert.ok(!/<(script|iframe|img|form)\b/i.test(html));assert.match(html,/six digits/);assert.match(html,/used once/);assert.match(html,/Didn’t request/);
 assert.ok(!html.includes('123456'));assert.match(html,/<html lang="en">/);assert.match(html,/role="presentation"/);assert.ok(!/expires in \d/i.test(html));
 for(const url of [...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1]))assert.equal(new URL(url).origin,'https://faceful.dtheo.dev');
});
