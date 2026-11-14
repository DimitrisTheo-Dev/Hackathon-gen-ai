import { test } from "node:test";
import assert from "node:assert/strict";
import proxy from "../proxy";

test("public root negotiates Markdown without affecting HTML or private routes", async () => {
  const md = proxy(
    new Request("https://castroom.test/", {
      headers: { Accept: "text/markdown" },
    }),
  );
  assert.equal(md.status, 200);
  assert.match(md.headers.get("content-type")!, /text\/markdown/);
  assert.equal(md.headers.get("vary"), "Accept");
  assert.match(await md.text(), /not integrated yet/);
  const html = proxy(
    new Request("https://castroom.test/", {
      headers: { Accept: "text/html,text/markdown;q=0.1" },
    }),
  );
  assert.equal(html.headers.get("x-middleware-next"), "1");
  assert.equal(html.headers.get("vary"), "Accept");
  const privateRoute = proxy(
    new Request("https://castroom.test/studio/", {
      headers: { Accept: "text/markdown" },
    }),
  );
  assert.equal(privateRoute.headers.get("x-middleware-next"), "1");
});
test("unknown public paths return actual recoverable 404s in negotiated format", async () => {
  for (const accept of ["text/html", "text/markdown"]) {
    const response = proxy(
      new Request("https://castroom.test/absent", {
        headers: { Accept: accept },
      }),
    );
    assert.equal(response.status, 404);
    assert.match(response.headers.get("content-type")!, new RegExp(accept));
    assert.match(await response.text(), /\/docs\//);
  }
});

test("documentation negotiation, HEAD and invalid Accept qualities stay deterministic", async () => {
  for (const path of ["/docs/", "/docs/api/", "/docs/cli/", "/docs/mcp/", "/docs/setup/", "/docs/security/", "/docs/errors/", "/docs/capabilities/"]) {
    const md=proxy(new Request(`https://castroom.test${path}`,{headers:{Accept:"text/markdown"}}));
    assert.equal(md.status,200);assert.match(md.headers.get('content-type')!,/text\/markdown/);assert.ok((await md.text()).length>500);
    const head=proxy(new Request(`https://castroom.test${path}`,{method:'HEAD',headers:{Accept:'text/markdown'}}));assert.equal(await head.text(),'');assert.equal(head.headers.get('vary'),'Accept');
  }
  for(const accept of ['text/markdown;q=0','text/markdown;q=garbage','text/markdown;q=2','text/markdown;q=.2,text/html;q=1']) assert.equal(proxy(new Request('https://castroom.test/',{headers:{Accept:accept}})).headers.get('x-middleware-next'),'1');
});

test("front-end API and unavailable authentication endpoints return truthful JSON errors",async()=>{
  for(const path of ['/api/missing','/mcp','/.well-known/oauth-authorization-server','/.well-known/oauth-protected-resource']) {
    const response=proxy(new Request(`https://castroom.test${path}`));assert.equal(response.status,404);assert.match(response.headers.get('content-type')!,/application\/problem\+json/);const error=await response.json();assert.equal(error.code,'endpoint_unavailable');assert.match(error.resolution,/\/docs/);
  }
  const response=proxy(new Request('https://castroom.test/',{method:'POST'}));assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'GET, HEAD');
  for(const path of ['/studio/','/dev/studio/','/api/v1/campaigns','/v1/context']) assert.equal(proxy(new Request(`https://castroom.test${path}`)).headers.get('x-middleware-next'),'1');
});
