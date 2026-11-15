import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import { z } from "zod";
import {
  handlePublicRequest, openApiDocument, publicDocuments, publicOrigin,
  statusSchema, permissionsSchema, documentIndexSchema, documentSchema, problemSchema,
  buildPublicStatus, buildPublicPermissions, deploymentFacts, type PublicEnv,
} from "../packages/public-api/src/index";
import { ALL_SCOPES, AGENT_GRANTABLE_SCOPES } from "../packages/engine/src/access";
import { loadConfig } from "../packages/engine/src/config";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";

/** Placeholder configuration. Only presence and format matter; none of these values may ever appear in a response. */
const engineEnv: PublicEnv = { SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "sb_secret_placeholder_value" };
const fullEnv: PublicEnv = { ...engineEnv, RENDER_WORKER_TOKEN: "worker-token-placeholder-0123456789abcdef", ANTHROPIC_API_KEY: "model-key-placeholder", STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_placeholder", STRIPE_PRICE_ID_DEMO: "price_placeholder" };

const request = (path: string, method = "GET") => new Request(`${publicOrigin}${path}`, { method });
const routes = [
  ["/api/public/status", statusSchema], ["/api/public/permissions", permissionsSchema],
  ["/api/public/docs", documentIndexSchema],
  ...publicDocuments.map((document) => [`/api/public/docs/${document.slug}`, documentSchema] as const),
] as const;

test("public discovery routes return valid typed JSON without authentication or private state", async () => {
  for (const [path, schema] of routes) {
    const response = handlePublicRequest(request(path), {});
    assert.ok(response); assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type")!, /^application\/json/);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=60, stale-while-revalidate=300");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.ok(schema.safeParse(await response.json()).success, path);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
  // A deployment without engine credentials: every capability is off, and the reason is stated.
  const body = await handlePublicRequest(request("/api/public/status"), {})!.json();
  const { billing, director, ...flags } = body.engine;
  assert.deepEqual(Object.keys(flags).sort(), ["agentTokenIssuance", "campaignApi", "humanlikeRendering", "mcp", "publishing"]);
  assert.ok(Object.values(flags).every((value) => value === false));
  assert.equal(billing, "not_configured"); assert.equal(director, "basic");
  assert.ok(body.blockers.some((blocker: string) => blocker.startsWith("Domain engine:")));
  assert.ok(body.blockers.some((blocker: string) => blocker.startsWith("Publishing:")));
  assert.equal(body.stage, "development");
  assert.equal(body.publicApi.authenticationRequired, false);
  assert.equal(body.studio.developmentFixturesAreLiveResults, false);
});

test("status describes the deployment it runs on: configured capabilities turn on, publishing never does", async () => {
  // Engine only: the API, workspace tokens and MCP are on; rendering, billing and AI drafting are still off.
  const engineOnly = buildPublicStatus(engineEnv);
  assert.deepEqual(engineOnly.engine, { campaignApi: true, agentTokenIssuance: true, mcp: true, humanlikeRendering: false, publishing: false, billing: "not_configured", director: "basic" });
  assert.ok(!engineOnly.blockers.some((blocker) => blocker.startsWith("Domain engine:")));
  for (const prefix of ["Video rendering:", "Publishing:", "Billing:", "Creative Director:"]) assert.ok(engineOnly.blockers.some((blocker) => blocker.startsWith(prefix)), prefix);
  // Everything configurable is configured: only publishing remains, because no adapter exists.
  const full = buildPublicStatus(fullEnv);
  assert.deepEqual(full.engine, { campaignApi: true, agentTokenIssuance: true, mcp: true, humanlikeRendering: true, publishing: false, billing: "sandbox", director: "ai" });
  assert.equal(full.blockers.length, 1); assert.match(full.blockers[0], /^Publishing: no destination has approved API access/);
  // The HTTP route serves the same per-deployment document, valid against the public schema.
  const served = statusSchema.parse(await handlePublicRequest(request("/api/public/status"), fullEnv)!.json());
  assert.deepEqual(served, full);
  // Presence and format only: no configuration value reaches a public response.
  for (const env of [engineEnv, fullEnv]) {
    const text = JSON.stringify([buildPublicStatus(env), buildPublicPermissions(env)]);
    for (const value of Object.values(env)) assert.ok(!text.includes(value!), "configuration values must never be emitted");
  }
  // Nothing is available without the engine, whatever else is set.
  const { SUPABASE_SECRET_KEY: _secret, ...withoutSecret } = fullEnv;
  assert.deepEqual(buildPublicStatus(withoutSecret).engine, buildPublicStatus({}).engine);
  assert.equal(buildPublicStatus({ VITE_SUPABASE_URL: "https://project.supabase.co", SUPABASE_SECRET_KEY: "x" }).engine.mcp, true);
  // Rejected or incomplete configuration is not reported as available.
  assert.equal(buildPublicStatus({ ...fullEnv, RENDER_WORKER_TOKEN: "x".repeat(31) }).engine.humanlikeRendering, false);
  assert.equal(buildPublicStatus({ ...fullEnv, STRIPE_SECRET_KEY: "sk_live_never" }).engine.billing, "not_configured");
  assert.equal(buildPublicStatus({ ...fullEnv, STRIPE_MODE: "live" }).engine.billing, "not_configured");
  assert.equal(buildPublicStatus({ ...fullEnv, STRIPE_WEBHOOK_SECRET: "" }).engine.billing, "not_configured");
  assert.equal(buildPublicStatus({ ...engineEnv, AI_GATEWAY_API_KEY: "gateway" }).engine.director, "ai");
  assert.equal(buildPublicStatus({ ...engineEnv, GEMINI_API_KEY: "gemini" }).engine.director, "ai");
});

test("public status agrees with what the engine itself accepts as configuration", () => {
  const variants: PublicEnv[] = [
    {}, engineEnv, fullEnv,
    { ...fullEnv, RENDER_WORKER_TOKEN: "too-short" }, { ...fullEnv, RENDER_WORKER_TOKEN: `  ${"y".repeat(32)}  ` },
    { ...fullEnv, STRIPE_SECRET_KEY: "rk_test_restricted" }, { ...fullEnv, STRIPE_SECRET_KEY: "sk_live_x" }, { ...fullEnv, STRIPE_MODE: "production" },
    { ...fullEnv, STRIPE_PRICE_ID_DEMO: "prod_wrong_object" }, { ...fullEnv, STRIPE_WEBHOOK_SECRET: "not-a-signing-secret" },
    { ...fullEnv, ANTHROPIC_API_KEY: "   " }, { ...engineEnv, AI_GATEWAY_API_KEY: "gateway" }, { ...engineEnv, GEMINI_API_KEY: "gemini" },
  ];
  for (const env of variants) {
    const config = loadConfig(env);
    const facts = deploymentFacts(env);
    const label = JSON.stringify(Object.keys(env));
    assert.equal(facts.engine, Boolean(config.supabaseUrl) && Boolean(env.SUPABASE_SECRET_KEY?.trim()), label);
    if (!facts.engine) continue;
    assert.equal(facts.rendering, config.renderWorkerToken !== null, label);
    assert.equal(facts.billing, config.stripe ? "sandbox" : "not_configured", label);
    assert.equal(facts.director, config.llm ? "ai" : "basic", label);
  }
});

test("permission definitions distinguish proposed scopes from a live grant or OAuth metadata", async () => {
  const body = await handlePublicRequest(request("/api/public/permissions"), {})!.json();
  assert.equal(body.authenticationStatus, "awaiting_engine");
  assert.equal(body.liveGrantAvailable, false);
  assert.equal(body.publishingAuthorityIncluded, false);
  assert.deepEqual(body.scopes.map((scope: { name: string }) => scope.name), ["campaign:read", "content:edit", "render:write", "schedule:prepare"]);
  assert.ok(body.scopes.every((scope: { authority: string }) => scope.authority === "proposed_not_issued"));
  assert.ok(!("scopes_supported" in body));
  assert.ok(!("authorization_servers" in body));
});

test("with a configured engine, permissions are the ones it enforces for agents and nothing reserved for people", async () => {
  const body = permissionsSchema.parse(await handlePublicRequest(request("/api/public/permissions"), engineEnv)!.json());
  assert.equal(body.authenticationStatus, "live");
  assert.equal(body.liveGrantAvailable, true);
  assert.equal(body.publishingAuthorityIncluded, false);
  assert.ok(body.scopes.every((scope) => scope.authority === "enforced"));
  // The public list is exactly what the engine will grant an agent, and the remainder stays with people.
  assert.deepEqual(body.scopes.map((scope) => scope.name), AGENT_GRANTABLE_SCOPES);
  assert.deepEqual([...body.humanOnlyPermissions].sort(), ALL_SCOPES.filter((scope) => !AGENT_GRANTABLE_SCOPES.includes(scope)).sort());
  for (const reserved of ["schedule:approve", "schedule:commit", "billing:manage", "connections:manage"]) assert.ok(!body.scopes.some((scope) => scope.name === reserved), reserved);
  assert.deepEqual(buildPublicPermissions({}).humanOnlyPermissions, body.humanOnlyPermissions);
  // Still documentation, never OAuth metadata: that lives on /.well-known/oauth-protected-resource and the issuer.
  assert.ok(!("scopes_supported" in body)); assert.ok(!("authorization_servers" in body));
  assert.match(body.note, /not OAuth scopes/);
});

test("HEAD returns the GET status and headers with an empty body on every public route", async () => {
  for (const path of [...routes.map(([path]) => path), "/openapi.json", "/api/public/missing", "/api/public/docs/missing"]) {
    const get = handlePublicRequest(request(path))!;
    const head = handlePublicRequest(request(path, "HEAD"))!;
    assert.equal(head.status, get.status, path);
    assert.deepEqual([...head.headers], [...get.headers], path);
    assert.equal(await head.text(), "", path);
  }
});

test("unsupported methods are 405 RFC 9457 problems and cannot mutate public resources", async () => {
  for (const path of [...routes.map(([path]) => path), "/openapi.json"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const response = handlePublicRequest(request(path, method))!;
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.equal(response.headers.get("Allow"), "GET, HEAD");
      assert.match(response.headers.get("Content-Type")!, /^application\/problem\+json/);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      const problem = problemSchema.parse(await response.json());
      assert.equal(problem.type, "about:blank"); assert.equal(problem.status, 405);
      assert.equal(problem.code, "method_not_allowed"); assert.ok(problem.resolution.length > 20);
    }
  }
});

test("unknown public routes return actionable 404 problems without query reflection", async () => {
  for (const path of ["/api/public", "/api/public/missing", "/api/public/docs/missing", "/api/public/docs/../../public/missing", "/api/public/docs/setup/extra"]) {
    const response = handlePublicRequest(request(`${path}?token=do-not-reflect`))!;
    assert.equal(response.status, 404);
    assert.match(response.headers.get("Content-Type")!, /^application\/problem\+json/);
    const text = await response.text(); assert.ok(!text.includes("do-not-reflect"));
    const problem = problemSchema.parse(JSON.parse(text));
    assert.equal(problem.status, 404); assert.equal(problem.type, "about:blank");
    assert.ok(problem.resolution.includes("/docs/"));
  }
});

test("public router never handles private domain, authentication or MCP paths", () => {
  for (const path of ["/", "/studio/", "/api/v1/context", "/api/campaigns", "/api/publish", "/mcp", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource", "/api/publicity"]) {
    assert.equal(handlePublicRequest(request(path)), null, path);
  }
});

test("OpenAPI is valid 3.1.1 and its schemas are generated from runtime validators", async () => {
  const spec = JSON.parse(JSON.stringify(openApiDocument));
  await SwaggerParser.validate(structuredClone(spec));
  assert.equal(spec.openapi, "3.1.1"); assert.deepEqual(spec.security, []);
  assert.equal(spec.components.securitySchemes, undefined);
  for (const [name, validator] of Object.entries({ Status: statusSchema, Permissions: permissionsSchema, DocumentIndex: documentIndexSchema, Document: documentSchema, Problem: problemSchema })) {
    assert.deepEqual(spec.components.schemas[name], z.toJSONSchema(validator, { target: "draft-2020-12" }));
  }
  const ids: string[] = [];
  for (const [path, methods] of Object.entries(spec.paths) as [string, Record<string, { operationId: string; description: string; security: []; responses: Record<string, unknown>; parameters?: { in: string; required: boolean; schema: unknown }[] }> ][]) {
    assert.ok(path.startsWith("/api/public/"));
    for (const [method, operation] of Object.entries(methods)) {
      assert.equal(method, "get"); assert.ok(operation.description.length > 40); ids.push(operation.operationId);
      assert.deepEqual(operation.security, []);
      assert.ok(operation.responses["200"]); assert.ok(operation.responses["405"]);
      if (path.includes("{slug}")) assert.ok(operation.parameters?.some((parameter) => parameter.in === "path" && parameter.required && parameter.schema));
    }
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(await handlePublicRequest(request("/openapi.json"))!.json(), spec);
});

test("public docs have raw text, canonical URLs, semantic code and consistent navigation", async () => {
  const paths = [...publicDocuments.map((document) => document.path), "/about/", "/contact/", "/privacy/"];
  for (const path of paths) {
    const html = await readFile(`apps/web/public${path}index.html`, "utf8");
    assert.match(html, /<html lang="en">/); assert.equal((html.match(/<h1(?:\s|>)/g) ?? []).length, 1);
    assert.ok(html.includes(`<link rel="canonical" href="${publicOrigin}${path}">`), path);
    assert.ok(html.indexOf('/design.css') < html.indexOf('/docs/docs.css'));
    const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/)?.[1] ?? "";
    assert.ok(main.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").length > 500, path);
    assert.ok(!/<h[4-6][ >]/.test(main));
    for (const link of ["/docs/api/", "/docs/mcp/", "/docs/cli/"]) assert.ok(html.includes(`href="${link}"`));
    for (const block of html.matchAll(/<pre[^>]*><code([^>]*)>/g)) assert.match(block[1], /class="language-/);
    assert.equal((html.match(/<pre/g) ?? []).length, (html.match(/<pre tabindex="0"><code class="language-/g) ?? []).length, `${path} code blocks are labelled and keyboard-scrollable`);
  }
});

test("docs pages share one accessible, script-optional chrome", async () => {
  const docs = publicDocuments.map((document) => document.path);
  for (const path of [...docs, "/about/", "/contact/", "/privacy/"]) {
    const html = await readFile(`apps/web/public${path}index.html`, "utf8");
    // Landmarks and the route to the content.
    assert.ok(html.includes('<a class="skip" href="#content">Skip to content</a>'), path);
    assert.equal((html.match(/<main id="content">/g) ?? []).length, 1, path);
    assert.ok(html.includes('<nav class="sidebar" aria-label="Documentation">') && html.includes('<details class="menu">'), path);
    assert.ok(html.includes('<nav aria-label="Breadcrumb">'), path);
    // The current page is marked in both the sidebar and the phone menu, and nowhere on project pages.
    assert.equal((html.match(new RegExp(`<a href="${path}" aria-current="page">`, "g")) ?? []).length, docs.includes(path) ? 2 : 0, path);
    // Exactly one "Privacy" link, in the footer, so the label stays unambiguous.
    assert.equal((html.match(/>Privacy<\/a>/g) ?? []).length, 1, path);
    // Under the site's CSP only same-origin script files run: one deferred enhancement, JSON-LD data, no handlers or inline styles.
    const scripts = [...html.matchAll(/<script\b([^>]*)>/g)].map((match) => match[1].trim());
    assert.deepEqual(scripts.sort(), ['src="/docs/docs.js" defer', 'type="application/ld+json"'], path);
    assert.ok(!/\son[a-z]+="/.test(html) && !/\sstyle="/.test(html), `${path} has no inline handlers or styles`);
    assert.ok(html.includes('<link rel="preload" href="/fonts/InterVariable.woff2" as="font" type="font/woff2" crossorigin>'), path);
    // Status is always a written word next to its marker, never colour alone.
    for (const chip of html.matchAll(/<span class="chip chip-(live|sandbox|coming|note)"><i aria-hidden="true"><\/i><strong>([^<]+)<\/strong>/g)) {
      assert.ok(chip[2].trim().length > 2, path);
      if (chip[1] !== "note") assert.equal(chip[2], { live: "Live", sandbox: "Sandbox", coming: "Coming" }[chip[1]], path);
    }
    // Previous/next links follow the sidebar order on documentation pages.
    assert.equal(html.includes('<nav class="pager"'), docs.includes(path), path);
  }
  const { default: proxy } = await import("../proxy");
  for (const asset of ["/docs/docs.css", "/docs/docs.js"]) assert.equal(proxy(new Request(`${publicOrigin}${asset}`)).headers.get("x-middleware-next"), "1", asset);
  const script = await readFile("apps/web/public/docs/docs.js", "utf8");
  assert.ok(!/innerHTML|eval\(|document\.write/.test(script), "the enhancement script builds DOM nodes, never markup strings");
});

test("agent index and sitemap discover public actions without exposing private paths", async () => {
  const llms = await readFile("apps/web/public/llms.txt", "utf8");
  assert.ok(llms.startsWith("# Faceful\n\n>"));
  for (const section of ["## When to use", "## When not to use", "## First calls", "## Current limitations"]) assert.ok(llms.includes(section));
  for (const path of ["/openapi.json", "/docs/api/", "/docs/mcp/", "/docs/cli/"]) assert.ok(llms.includes(path));
  const sitemap = await readFile("apps/web/public/sitemap.xml", "utf8");
  for (const path of [...publicDocuments.map((document) => document.path), "/about/", "/contact/", "/privacy/"]) assert.ok(sitemap.includes(`<loc>${publicOrigin}${path}</loc>`));
  assert.ok(!sitemap.includes("/studio/")); assert.ok(!sitemap.includes("/dev/"));
  const robots = await readFile("apps/web/public/robots.txt", "utf8");
  assert.match(robots, /Allow: \/\n/); assert.match(robots, /Disallow: \/studio\//); assert.match(robots, /Disallow: \/dev\//);
  assert.ok(robots.includes(`${publicOrigin}/sitemap.xml`));
});

test('public API version pinning is enforced with explicit cache variation and recoverable errors',async()=>{
  for(const version of [null,'1','2','unknown']) {
    const headers:Record<string,string>={};if(version!==null)headers['X-API-Version']=version;
    const response=handlePublicRequest(new Request('https://castroom.test/api/public/status',{headers}))!;
    assert.equal(response.headers.get('x-api-version'),'1');assert.equal(response.headers.get('vary'),'X-API-Version');
    assert.equal(response.status,version===null||version==='1'?200:400);
    if(response.status===400){const problem=await response.json();assert.equal(problem.code,'unsupported_api_version');assert.equal(response.headers.get('cache-control'),'no-store');assert.match(problem.resolution,/X-API-Version: 1/);}
  }
  for(const path of Object.values(openApiDocument.paths)) assert.ok(path.get.parameters.some(parameter=>parameter.in==='header'&&parameter.name==='X-API-Version'));
});

test("RFC 8631 discovery links advertise canonical implemented resources on public API responses", async () => {
  const { publicDiscoveryLinkHeader } = await import("../packages/public-api/src/discovery");
  const links = [...publicDiscoveryLinkHeader.matchAll(/<([^>]+)>; rel="([^"]+)"; type="([^"]+)"; title="([^"]+)"/g)];
  assert.equal(links.length, 6);
  assert.ok(links.some(([, url, relation]) => url === `${publicOrigin}/openapi.json` && relation.split(" ").includes("service-desc")));
  for (const path of ["/docs/api/", "/docs/mcp/", "/docs/cli/"]) {
    assert.ok(links.some(([, url, relation]) => url === `${publicOrigin}${path}` && relation === "service-doc"));
  }
  assert.ok(links.some(([, url, relation]) => url === `${publicOrigin}/api/public/status` && relation === "status"));
  assert.ok(links.some(([, url, relation]) => url === `${publicOrigin}/llms.txt` && relation === "index"));
  assert.ok(!links.some(([, url]) => new URL(url).pathname === "/mcp"));
  for (const path of [...routes.map(([path]) => path), "/openapi.json", "/api/public/missing"]) {
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = handlePublicRequest(new Request(`https://untrusted-host.example${path}`, { method }))!;
      assert.equal(response.headers.get("Link"), publicDiscoveryLinkHeader);
      assert.ok(!response.headers.get("Link")!.includes("untrusted-host.example"));
    }
  }
  for (const path of Object.values(openApiDocument.paths)) {
    assert.equal(path.get.responses["200"].headers.Link.example, publicDiscoveryLinkHeader);
  }
});

test("public presentation links discovery for HTML, Markdown and missing pages without altering private routing", async () => {
  const { default: proxy } = await import("../proxy");
  const { publicDiscoveryLinkHeader } = await import("../packages/public-api/src/discovery");
  for (const path of ["/", "/index.html", ...publicDocuments.map((document) => document.path), "/about/", "/contact/", "/privacy/", "/readiness-missing-page"]) {
    for (const accept of ["text/html", "text/markdown"]) {
      const response = proxy(new Request(`${publicOrigin}${path}`, { headers: { Accept: accept } }));
      assert.equal(response.headers.get("Link"), publicDiscoveryLinkHeader, `${accept} ${path}`);
      assert.equal(response.status, path === "/readiness-missing-page" ? 404 : 200);
    }
  }
  // The studio, the domain API, the MCP endpoint, the OAuth consent page and the protected-resource
  // metadata belong to the engine functions: the public proxy passes them through untouched.
  for (const path of ["/studio/", "/dev/studio/", "/v1/campaigns", "/v1/stripe/webhook", "/api/v1/context", "/mcp", "/oauth/consent", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    for (const method of ["GET", "POST"]) {
      const response = proxy(new Request(`${publicOrigin}${path}`, { method }));
      assert.equal(response.headers.get("Link"), null, path);
      assert.equal(response.headers.get("x-middleware-next"), "1", `${method} ${path}`);
    }
  }
  // Authorization-server metadata is published by the Supabase issuer, not by this origin.
  for (const path of ["/api/missing", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    const response = proxy(new Request(`${publicOrigin}${path}`));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("Location"), null);
    const problem = problemSchema.parse(await response.json());
    assert.equal(problem.code, "endpoint_unavailable");
    assert.match(problem.detail, /\/\.well-known\/oauth-protected-resource\/mcp/);
    assert.ok(!/pending/i.test(problem.detail));
  }
});

test("public discovery does not fabricate quota counters, throttling or a live MCP transport", async () => {
  for (const path of ["/api/public/status", "/openapi.json", "/api/public/missing"]) {
    const response = handlePublicRequest(request(path), fullEnv)!;
    for (const name of ["RateLimit", "RateLimit-Policy", "X-RateLimit-Limit", "X-RateLimit-Remaining", "X-RateLimit-Reset", "Retry-After"]) {
      assert.equal(response.headers.get(name), null, `${path} ${name}`);
    }
  }
  // MCP is reported only where this deployment can serve it, and the static discovery links never name the transport.
  assert.equal((await handlePublicRequest(request("/api/public/status"), {})!.json()).engine.mcp, false);
  const configured = handlePublicRequest(request("/api/public/status"), fullEnv)!;
  assert.equal((await configured.json()).engine.mcp, true);
  assert.ok(!configured.headers.get("Link")!.includes(`${publicOrigin}/mcp>`));
  assert.equal(JSON.stringify(openApiDocument.paths).includes("/mcp\""), false);
  const apiGuide = publicDocuments.find((document) => document.slug === "api")!;
  assert.match(apiGuide.markdown, /No application request quota or remaining-count telemetry is configured/);
  assert.match(apiGuide.markdown, /RateLimit and RateLimit-Policy are therefore not emitted/);
  const cliGuide = publicDocuments.find((document) => document.slug === "cli")!;
  assert.match(cliGuide.markdown, /not published on npm/);
});

test("the agent guide documents exactly the MCP tools, protocol and SDK the engine ships", async () => {
  const source = await readFile("packages/engine/src/mcp.ts", "utf8");
  const registered = [...source.matchAll(/server\.registerTool\(\s*"([a-z_]+)"/g)].map((match) => match[1]);
  assert.equal(registered.length, 21);
  const guide = publicDocuments.find((document) => document.slug === "mcp")!;
  const html = await readFile("apps/web/public/docs/mcp/index.html", "utf8");
  const documented = [...guide.markdown.matchAll(/^- ([a-z_]+): /gm)].map((match) => match[1]).filter((name) => name.includes("_"));
  assert.deepEqual(documented, registered, "tool list and order in the Markdown guide");
  assert.deepEqual([...html.matchAll(/<tr><th scope="row"><code>([a-z_]+)<\/code><\/th>/g)].map((match) => match[1]), registered, "tool table in the HTML guide");
  // Every tool row says whether a person is needed, and only approval and checkout answer yes.
  const needsPerson = [...html.matchAll(/<tr><th scope="row"><code>([a-z_]+)<\/code><\/th><td>[\s\S]*?<\/td><td data-label="Needs a person">(<strong>Yes\.<\/strong>|No)/g)];
  assert.equal(needsPerson.length, registered.length);
  assert.deepEqual(needsPerson.filter((match) => match[2] !== "No").map((match) => match[1]), ["approve_schedule", "create_checkout_link"]);
  const sdk = JSON.parse(await readFile("node_modules/@modelcontextprotocol/sdk/package.json", "utf8")).version;
  for (const text of [guide.markdown, html]) {
    assert.ok(text.includes(LATEST_PROTOCOL_VERSION), "negotiated protocol revision");
    assert.ok(text.includes(sdk), "installed SDK version");
    assert.match(text, /2026-07-28 revision is not implemented/);
    assert.match(text, /FACEFUL_TOKEN/); assert.match(text, /bearer-token-env-var FACEFUL_TOKEN/);
    assert.match(text, /engine\.mcp/);
    // Evidence is stated at the level it exists: token auth with real clients; OAuth with a scripted client only.
    assert.match(text, /Claude Code 2\.1\.325 and Codex CLI 0\.169\.0/);
    assert.match(text, /local engine server/);
    assert.match(text, /OAuth has not yet been tried through a host['’]s own sign-in screen/);
    assert.match(text, /Cursor, Gemini CLI and other hosts are untested/);
    // Rate limiting is live (15 Nov 2026); the guide states the per-connection limits and how to back off.
    assert.match(text, /rate limited per connection/);
    assert.match(text, /retryAfterSeconds/);
    assert.doesNotMatch(text, /no application rate limiting/);
  }
  assert.equal(guide.title, "Use Faceful with your AI agent");
});

test("no public page still describes the engine as pending or uses retired names", async () => {
  const pages = await Promise.all([...publicDocuments.map((document) => `apps/web/public${document.path}index.html`), "apps/web/public/llms.txt"].map((path) => readFile(path, "utf8")));
  const { default: proxy } = await import("../proxy");
  const home = await proxy(new Request(`${publicOrigin}/`, { headers: { Accept: "text/markdown" } })).text();
  for (const text of [...publicDocuments.map((document) => document.markdown), ...pages, home, JSON.stringify(openApiDocument.info)]) {
    for (const stale of [/CASTROOM_(?:MCP_URL|TOKEN)/, /studio_get_context/, /MCP endpoint is not available yet/, /pending engine integration/, /engine (?:remains|remain) pending/, /No live OAuth issuer/, /token issuer (?:is|are) pending/]) {
      assert.ok(!stale.test(text), `${stale} still present`);
    }
  }
  // Availability is always tied to the status endpoint rather than asserted for every deployment.
  for (const slug of ["overview", "mcp", "setup", "api", "capabilities"]) assert.match(publicDocuments.find((document) => document.slug === slug)!.markdown, /\/api\/public\/status/, slug);
  for (const text of [home, publicDocuments.find((document) => document.slug === "overview")!.markdown]) {
    assert.match(text, /no destination has approved API access/);
    assert.match(text, /refused[^.]{0,40}simulated/);
  }
});
