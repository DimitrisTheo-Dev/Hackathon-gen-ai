import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import { z } from "zod";
import {
  handlePublicRequest, openApiDocument, publicDocuments, publicOrigin,
  statusSchema, permissionsSchema, documentIndexSchema, documentSchema, problemSchema,
} from "../packages/public-api/src/index";

const request = (path: string, method = "GET") => new Request(`${publicOrigin}${path}`, { method });
const routes = [
  ["/api/public/status", statusSchema], ["/api/public/permissions", permissionsSchema],
  ["/api/public/docs", documentIndexSchema],
  ...publicDocuments.map((document) => [`/api/public/docs/${document.slug}`, documentSchema] as const),
] as const;

test("public discovery routes return valid typed JSON without authentication or private state", async () => {
  for (const [path, schema] of routes) {
    const response = handlePublicRequest(request(path));
    assert.ok(response); assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type")!, /^application\/json/);
    assert.equal(response.headers.get("Cache-Control"), "public, max-age=60, stale-while-revalidate=300");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.ok(schema.safeParse(await response.json()).success, path);
    assert.equal(response.headers.get("Set-Cookie"), null);
  }
  const body = await handlePublicRequest(request("/api/public/status"))!.json();
  assert.ok(Object.values(body.engine).every((value) => value === false));
  assert.equal(body.publicApi.authenticationRequired, false);
  assert.equal(body.studio.developmentFixturesAreLiveResults, false);
});

test("permission definitions distinguish proposed scopes from a live grant or OAuth metadata", async () => {
  const body = await handlePublicRequest(request("/api/public/permissions"))!.json();
  assert.equal(body.authenticationStatus, "awaiting_engine");
  assert.equal(body.liveGrantAvailable, false);
  assert.equal(body.publishingAuthorityIncluded, false);
  assert.deepEqual(body.scopes.map((scope: { name: string }) => scope.name), ["campaign:read", "content:edit", "render:write", "schedule:prepare"]);
  assert.ok(body.scopes.every((scope: { authority: string }) => scope.authority === "proposed_not_issued"));
  assert.ok(!("scopes_supported" in body));
  assert.ok(!("authorization_servers" in body));
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
    for (const block of html.matchAll(/<pre><code([^>]*)>/g)) assert.match(block[1], /class="language-/);
  }
});

test("agent index and sitemap discover public actions without exposing private paths", async () => {
  const llms = await readFile("apps/web/public/llms.txt", "utf8");
  assert.ok(llms.startsWith("# Castroom\n\n>"));
  for (const section of ["## When to use", "## When not to use", "## First calls", "## Current limitations"]) assert.ok(llms.includes(section));
  for (const path of ["/openapi.json", "/docs/api/", "/docs/mcp/", "/docs/cli/"]) assert.ok(llms.includes(path));
  const sitemap = await readFile("apps/web/public/sitemap.xml", "utf8");
  for (const path of [...publicDocuments.map((document) => document.path), "/about/", "/contact/", "/privacy/"]) assert.ok(sitemap.includes(`<loc>${publicOrigin}${path}</loc>`));
  assert.ok(!sitemap.includes("/studio/")); assert.ok(!sitemap.includes("/dev/"));
  const robots = await readFile("apps/web/public/robots.txt", "utf8");
  assert.match(robots, /Allow: \/\n/); assert.match(robots, /Disallow: \/studio\//); assert.match(robots, /Disallow: \/dev\//);
  assert.ok(robots.includes(`${publicOrigin}/sitemap.xml`));
});
