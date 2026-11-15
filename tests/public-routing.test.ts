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
  const home = await md.text();
  // The home page ties availability to this deployment's status and states what no deployment can do yet.
  assert.match(home, /\[integration status\]\(\/api\/public\/status\)/);
  assert.match(home, /Publishing is not available on any deployment/);
  assert.match(home, /refused, not simulated/);
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

test("paths this origin does not serve return truthful JSON errors, and engine routes pass through",async()=>{
  // Authorization-server metadata lives on the Supabase issuer; unknown /api routes do not exist here.
  for(const path of ['/api/missing','/api/engine-not-a-route','/.well-known/oauth-authorization-server','/.well-known/security.txt']) {
    const response=proxy(new Request(`https://castroom.test${path}`));assert.equal(response.status,404);assert.match(response.headers.get('content-type')!,/application\/problem\+json/);const error=await response.json();assert.equal(error.code,'endpoint_unavailable');assert.match(error.resolution,/\/docs/);assert.match(error.resolution,/\/api\/public\/status/);
  }
  // The MCP endpoint, its OAuth protected-resource metadata, the consent page and the domain API are the engine's.
  for(const path of ['/mcp','/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/oauth/consent','/v1/studio/context','/v1/health','/api/engine','/api/mcp']) assert.equal(proxy(new Request(`https://castroom.test${path}`,{method:path==='/mcp'?'POST':'GET'})).headers.get('x-middleware-next'),'1',path);
  const response=proxy(new Request('https://castroom.test/',{method:'POST'}));assert.equal(response.status,405);assert.equal(response.headers.get('allow'),'GET, HEAD');
  for(const path of ['/studio/','/dev/studio/','/claude-login-test/','/face-scan','/face-scan/','/api/v1/campaigns','/v1/context']) assert.equal(proxy(new Request(`https://castroom.test${path}`)).headers.get('x-middleware-next'),'1');
});

test("only the licensed local art and attribution pass through the public file allowlist",()=>{
  for(const path of ['/art/grainient-sunlit.webp','/art/ATTRIBUTION.txt']) assert.equal(proxy(new Request(`https://castroom.test${path}`)).headers.get('x-middleware-next'),'1');
  assert.equal(proxy(new Request('https://castroom.test/art/missing.webp')).status,404);
});

test("the MCP server card is public, versioned with the server, and served only where the engine runs", async () => {
  const { handlePublicRequest, MCP_SERVER_CARD_PATH, MCP_PROTOCOL_VERSION, MCP_SERVER_VERSION } = await import("../packages/public-api/src/index");
  const { LATEST_PROTOCOL_VERSION } = await import("@modelcontextprotocol/sdk/types.js");
  const { readFile } = await import("node:fs/promises");
  assert.equal(MCP_PROTOCOL_VERSION, LATEST_PROTOCOL_VERSION, "card advertises the protocol the SDK negotiates");
  assert.match(await readFile("packages/engine/src/mcp.ts", "utf8"), new RegExp(`SERVER_VERSION = "${MCP_SERVER_VERSION.replace(/\./g, "\\.")}"`));

  const configured = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "configured" };
  const response = handlePublicRequest(new Request(`https://faceful.vercel.app${MCP_SERVER_CARD_PATH}`), configured)!;
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/json/);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  const card = await response.json();
  assert.equal(card.remotes[0].type, "streamable-http");
  assert.match(card.remotes[0].url, /\/mcp$/);
  assert.equal(card.transport.url, card.remotes[0].url);
  assert.deepEqual(card.supportedProtocolVersions, [LATEST_PROTOCOL_VERSION]);
  assert.match(card.authentication.resourceMetadata, /\/\.well-known\/oauth-protected-resource\/mcp$/);
  assert.equal(card.tools, undefined, "tools are discovered with tools/list, not listed in the card");
  assert.doesNotMatch(JSON.stringify(card), /configured|supabase\.co|sk_|whsec_/, "no configuration values leak into the card");

  const unconfigured = handlePublicRequest(new Request(`https://faceful.vercel.app${MCP_SERVER_CARD_PATH}`), {})!;
  assert.equal(unconfigured.status, 404);
  const post = handlePublicRequest(new Request(`https://faceful.vercel.app${MCP_SERVER_CARD_PATH}`, { method: "POST" }), configured)!;
  assert.equal(post.status, 405);
});
