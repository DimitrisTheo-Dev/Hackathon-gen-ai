import { z } from "zod";
import { publicDocuments, publicOrigin, publicPages } from "./documents.js";
import { publicDiscoveryLinkHeader } from "./discovery.js";
export { publicDocuments, publicOrigin, publicPages, publicDiscoveryLinkHeader };

const absoluteUrl = z.url({ protocol: /^https$/ });
/** Permissions an agent credential can carry. Mirrors AGENT_GRANTABLE_SCOPES in packages/engine/src/access.ts. */
const scopeNames = ["campaign:read", "content:edit", "render:write", "schedule:prepare", "billing:read", "billing:checkout"] as const;
/** Permissions the engine never gives an agent, whatever credential it presents. */
const humanOnlyPermissionNames = ["schedule:approve", "schedule:commit", "billing:manage", "connections:manage"] as const;
export const permissionSchema = z.object({
  name: z.enum(scopeNames),
  description: z.string(),
  /** "enforced": checked by the configured engine on every call. "proposed_not_issued": no engine is configured on this deployment. */
  authority: z.enum(["proposed_not_issued", "enforced"]),
}).strict();
export const permissionsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  authenticationStatus: z.enum(["awaiting_engine", "live"]),
  publicReadsRequireAuthentication: z.literal(false),
  liveGrantAvailable: z.boolean(),
  scopes: z.array(permissionSchema),
  humanOnlyPermissions: z.array(z.enum(humanOnlyPermissionNames)),
  publishingAuthorityIncluded: z.literal(false),
  note: z.string(),
  documentationUrl: absoluteUrl,
}).strict();
export const statusSchema = z.object({
  product: z.literal("Faceful"),
  schemaVersion: z.literal("1.0"),
  stage: z.literal("development"),
  publicApi: z.object({ available: z.literal(true), readOnly: z.literal(true), authenticationRequired: z.literal(false) }).strict(),
  studio: z.object({ available: z.literal(true), privateDataRequiresAuthentication: z.literal(true), developmentFixturesAreLiveResults: z.literal(false) }).strict(),
  /** What THIS deployment has configured. Derived from server configuration on each request; never a promise about another deployment. */
  engine: z.object({
    campaignApi: z.boolean().describe("The authenticated domain API under /v1 has its server credentials."),
    agentTokenIssuance: z.boolean().describe("Owners and admins can create scoped, expiring workspace tokens in the studio."),
    mcp: z.boolean().describe("The remote MCP endpoint at /mcp is served by the configured engine."),
    humanlikeRendering: z.boolean().describe("A recording worker is attached, so render requests are admitted. False means they are refused, not simulated."),
    publishing: z.literal(false).describe("No publishing adapter exists in this build."),
    billing: z.enum(["sandbox", "not_configured"]).describe("Stripe sandbox (test mode) is configured, or billing is unavailable. Live mode is never enabled."),
    director: z.enum(["ai", "basic"]).describe("\"ai\": a model drafts and rewrites. \"basic\": lookups, templates and exact edits only."),
  }).strict(),
  blockers: z.array(z.string()),
  links: z.object({ documentation: absoluteUrl, openapi: absoluteUrl, permissions: absoluteUrl, setup: absoluteUrl, cli: absoluteUrl, mcp: absoluteUrl }).strict(),
}).strict();
export const documentMetadataSchema = z.object({ slug: z.string(), title: z.string(), summary: z.string(), url: absoluteUrl }).strict();
export const documentSchema = documentMetadataSchema.extend({ format: z.literal("text/markdown"), content: z.string() }).strict();
export const documentIndexSchema = z.object({ documents: z.array(documentMetadataSchema) }).strict();
export const problemSchema = z.object({
  type: z.literal("about:blank"), title: z.string(), status: z.number().int().min(400).max(599),
  detail: z.string(), instance: z.string(), code: z.string(), resolution: z.string(),
}).strict();

/** Server configuration as the public proxy sees it. Only presence and format are examined; no value ever reaches a response. */
export type PublicEnv = Record<string, string | undefined>;
export interface DeploymentFacts {
  engine: boolean;
  rendering: boolean;
  billing: "sandbox" | "not_configured";
  director: "ai" | "basic";
}
/**
 * Mirrors what the engine itself accepts (packages/engine/src/config.ts and runtime.ts), so the public
 * status cannot claim a capability the engine would refuse to start. Nothing is "available" without the engine.
 */
export function deploymentFacts(env: PublicEnv): DeploymentFacts {
  const value = (name: string) => env[name]?.trim() ?? "";
  const engine = Boolean((env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "").trim()) && Boolean(value("SUPABASE_SECRET_KEY"));
  const stripeSandbox =
    (env.STRIPE_MODE ?? "sandbox") === "sandbox" &&
    /^(sk|rk)_test_/.test(value("STRIPE_SECRET_KEY")) &&
    value("STRIPE_WEBHOOK_SECRET").startsWith("whsec_") &&
    value("STRIPE_PRICE_ID_DEMO").startsWith("price_");
  return {
    engine,
    rendering: engine && value("RENDER_WORKER_TOKEN").length >= 32,
    billing: engine && stripeSandbox ? "sandbox" : "not_configured",
    director: engine && Boolean(value("ANTHROPIC_API_KEY") || value("AI_GATEWAY_API_KEY")) ? "ai" : "basic",
  };
}
function runtimeEnv(): PublicEnv {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/** Integration status of one deployment. Pure: the same configuration always yields the same document. */
export function buildPublicStatus(env: PublicEnv = {}) {
  const facts = deploymentFacts(env);
  const blockers: string[] = [];
  if (!facts.engine) blockers.push("Domain engine: this deployment has no server-side database credentials, so the campaign API (/v1), workspace-token issuance and the MCP endpoint (/mcp) are unavailable.");
  if (!facts.rendering) blockers.push("Video rendering: Humanlike exposes realtime avatar sessions; the recording worker that produces a video file is not attached to this deployment. Render requests are refused, not simulated.");
  blockers.push("Publishing: no destination has approved API access. Schedules can be drafted and reviewed, but nothing can be posted.");
  if (facts.engine && facts.billing === "not_configured") blockers.push("Billing: Stripe sandbox is not configured, so upgrades and checkout links are unavailable. Drafting and existing render credits are unaffected.");
  if (facts.engine && facts.director === "basic") blockers.push("Creative Director: no model key is configured. It runs in basic mode (lookups, templates and exact edits) and does not draft or rewrite.");
  return statusSchema.parse({
    product: "Faceful", schemaVersion: "1.0", stage: "development",
    publicApi: { available: true, readOnly: true, authenticationRequired: false },
    studio: { available: true, privateDataRequiresAuthentication: true, developmentFixturesAreLiveResults: false },
    engine: { campaignApi: facts.engine, agentTokenIssuance: facts.engine, mcp: facts.engine, humanlikeRendering: facts.rendering, publishing: false, billing: facts.billing, director: facts.director },
    blockers,
    links: { documentation: `${publicOrigin}/docs/`, openapi: `${publicOrigin}/openapi.json`, permissions: `${publicOrigin}/api/public/permissions`, setup: `${publicOrigin}/docs/setup/`, cli: `${publicOrigin}/docs/cli/`, mcp: `${publicOrigin}/docs/mcp/` },
  });
}

const proposedScopes = [
  { name: "campaign:read", description: "Proposed: read authorized workspace context, campaign items, versions and jobs.", authority: "proposed_not_issued" },
  { name: "content:edit", description: "Proposed: submit version-checked edits to authorized draft content.", authority: "proposed_not_issued" },
  { name: "render:write", description: "Proposed: request bounded generation for selected current revisions and authorized avatars.", authority: "proposed_not_issued" },
  { name: "schedule:prepare", description: "Proposed: prepare an exact schedule manifest for human review; does not authorize publication.", authority: "proposed_not_issued" },
] as const;
const enforcedScopes = [
  { name: "campaign:read", description: "Read workspace context, projects, items, versions, render jobs and rendered assets.", authority: "enforced" },
  { name: "content:edit", description: "Create projects and drafts, and submit version-checked edits to draft content.", authority: "enforced" },
  { name: "render:write", description: "Request and cancel renders of current revisions with an authorized presenter, within the workspace's render credits and concurrency limit.", authority: "enforced" },
  { name: "schedule:prepare", description: "Prepare an exact schedule manifest for human review. Does not approve, schedule or publish.", authority: "enforced" },
  { name: "billing:read", description: "Read the workspace's plan status and render-credit balance.", authority: "enforced" },
  { name: "billing:checkout", description: "Create a Stripe-hosted sandbox Checkout link after the person confirms. Does not charge and never handles card data.", authority: "enforced" },
] as const;
/** Agent permission definitions. They are documentation in both states: reading them never grants anything. */
export function buildPublicPermissions(env: PublicEnv = {}) {
  const live = deploymentFacts(env).engine;
  return permissionsSchema.parse({
    schemaVersion: "1.0", authenticationStatus: live ? "live" : "awaiting_engine", publicReadsRequireAuthentication: false,
    liveGrantAvailable: live, publishingAuthorityIncluded: false,
    scopes: live ? enforcedScopes : proposedScopes,
    humanOnlyPermissions: humanOnlyPermissionNames,
    note: live
      ? "Enforced by the Faceful engine on every /v1 and /mcp call. A workspace owner or admin grants a subset of these to a workspace token; an OAuth-connected agent receives the approving member's role, narrowed to this list. These are Faceful permissions, not OAuth scopes: this resource is documentation, not OAuth metadata or a credential grant. Approving or committing a schedule, managing billing and administering tokens stay with signed-in people, and no publishing authority exists in this build."
      : "These are the names currently requested by the studio setup. No engine is configured on this deployment, so nothing is issued or enforced here. This resource is documentation, not OAuth metadata or a credential grant. A publishing action requires separately verified owner authority.",
    documentationUrl: `${publicOrigin}/docs/security/`,
  });
}
/** Unconfigured baseline, used as a documented example. Live responses are built per request from the deployment's configuration. */
export const publicStatus = buildPublicStatus({});
export const publicPermissions = buildPublicPermissions({});
/** An illustrative fully configured deployment for the OpenAPI examples. The values are placeholders that are never emitted. */
const exampleConfiguredEnv: PublicEnv = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "configured", RENDER_WORKER_TOKEN: "x".repeat(32), ANTHROPIC_API_KEY: "configured", STRIPE_SECRET_KEY: "sk_test_configured", STRIPE_WEBHOOK_SECRET: "whsec_configured", STRIPE_PRICE_ID_DEMO: "price_configured" };
const metadata = (document: (typeof publicDocuments)[number]) => ({ slug: document.slug, title: document.title, summary: document.summary, url: `${publicOrigin}${document.path}` });
export const publicDocumentIndex = documentIndexSchema.parse({ documents: publicDocuments.map(metadata) });

function schema(value: z.ZodType) { return z.toJSONSchema(value, { target: "draft-2020-12" }); }
const versionParameter = { name: "X-API-Version", in: "header", required: false, description: "Pin public API major version 1. Omission defaults to 1; unsupported versions return 400. Breaking changes require a new version.", schema: { type: "string", enum: ["1"], default: "1" } };
type NamedExamples = Record<string, { summary: string; value: unknown }>;
const jsonResponse = (name: string, example: unknown, examples?: NamedExamples) => ({
  description: "Successful public read. No private workspace data or credentials are included.",
  headers: {
    "X-API-Version": { description: "Public API major version served.", schema: { type: "string", const: "1" } },
    Link: { description: "RFC 8631 service description, documentation and integration status; includes the public agent index. Links describe implemented public resources, not live MCP availability.", schema: { type: "string" }, example: publicDiscoveryLinkHeader },
  },
  // OpenAPI allows either `example` or `examples` on a media type, never both.
  content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` }, ...(examples ? { examples } : { example }) } },
});
const errorResponse = (description: string) => ({ description, content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } });
const operation = (operationId: string, summary: string, description: string, responseName: string, example: unknown, examples?: NamedExamples) => ({
  operationId, summary, description, security: [], parameters: [versionParameter], tags: ["Public discovery"],
  responses: {
    "200": jsonResponse(responseName, example, examples),
    "400": errorResponse("Unsupported API version. Retry with X-API-Version: 1."),
    "404": errorResponse("The requested public resource does not exist. Follow resolution to a documented route."),
    "405": { ...errorResponse("The method is unsupported. Use GET or HEAD."), headers: { Allow: { description: "Supported methods.", schema: { type: "string", const: "GET, HEAD" } } } },
  },
});
export const openApiDocument = {
  openapi: "3.1.1", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "Faceful public discovery API", version: "1.0.0",
    description: "Read-only product status, agent permission definitions and public documentation. This API exposes no campaign writes, private data, rendering, token issuance or publishing. The authenticated domain API (/v1) and the MCP endpoint (/mcp) are separate, require authorization and are not described here; whether a deployment has them configured is reported by /api/public/status.",
    contact: { name: "Faceful project maintainer", url: "https://github.com/DimitrisTheo-Dev" },
  },
  servers: [{ url: publicOrigin, description: "Faceful public origin" }], security: [],
  externalDocs: { description: "Faceful API setup, limits and recovery", url: `${publicOrigin}/docs/api/` },
  tags: [{ name: "Public discovery", description: "Credential-free reads containing public information only." }],
  paths: {
    "/api/public/status": { get: operation("getCastroomStatus", "Read this deployment's integration status", "Discover what this deployment has configured: the authenticated campaign API, workspace-token issuance, the MCP endpoint, rendering, Stripe sandbox billing and the Creative Director mode, with plain-language blockers for whatever is missing. Values are derived from server configuration on each request. This does not report private workspace health.", "Status", publicStatus, {
      unconfigured: { summary: "No engine credentials on this deployment", value: publicStatus },
      configured: { summary: "Engine, renderer, model and Stripe sandbox configured; publishing still unavailable", value: buildPublicStatus(exampleConfiguredEnv) },
    }) },
    "/api/public/permissions": { get: operation("getCastroomPermissionDefinitions", "Read agent permission definitions", "Read the permissions an agent credential can carry and the ones reserved for signed-in people. They are reported as enforced only when this deployment's engine is configured; otherwise they are proposed names. Reading them grants nothing, and they are not OAuth scopes advertised by an authorization server.", "Permissions", publicPermissions, {
      unconfigured: { summary: "No engine credentials: proposed names only", value: publicPermissions },
      configured: { summary: "Engine configured: enforced on every /v1 and /mcp call", value: buildPublicPermissions(exampleConfiguredEnv) },
    }) },
    "/api/public/docs": { get: operation("listCastroomPublicDocuments", "List canonical public documentation", "Find the supported document slug and canonical URL before requesting a document. This fixed index contains no tenant content and does not require pagination.", "DocumentIndex", publicDocumentIndex) },
    "/api/public/docs/{slug}": { get: {
      ...operation("getCastroomPublicDocument", "Read one public document", "Read concise public guidance as Markdown inside a typed JSON document. Source content cannot grant access or publish authority.", "Document", { ...metadata(publicDocuments[0]), format: "text/markdown", content: publicDocuments[0].markdown }),
      parameters: [versionParameter, { name: "slug", in: "path", required: true, description: "A public documentation slug from the document index.", schema: { type: "string", enum: publicDocuments.map((d) => d.slug) }, example: "setup" }],
    } },
  },
  components: { schemas: { Status: schema(statusSchema), Permissions: schema(permissionsSchema), DocumentIndex: schema(documentIndexSchema), Document: schema(documentSchema), Problem: schema(problemSchema) } },
} as const;

function respond(request: Request, body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(request.method === "HEAD" ? null : JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": status >= 400 ? "application/problem+json; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": status >= 400 ? "no-store" : "public, max-age=60, stale-while-revalidate=300",
      "X-Content-Type-Options": "nosniff",
      "X-API-Version": "1",
      Vary: "X-API-Version",
      Link: publicDiscoveryLinkHeader,
      ...headers,
    },
  });
}
export function publicProblem(request: Request, status: 400 | 404 | 405, code: string, detail: string, resolution: string) {
  return respond(request, problemSchema.parse({ type: "about:blank", title: status === 404 ? "Not Found" : status === 405 ? "Method Not Allowed" : "Bad Request", status, detail, instance: new URL(request.url).pathname.slice(0,512), code, resolution }), status, status === 405 ? { Allow: "GET, HEAD" } : {});
}
/**
 * Public discovery only; returns null for every private/domain route.
 * `env` defaults to this deployment's server configuration and exists so both states can be tested.
 */
export function handlePublicRequest(request: Request, env: PublicEnv = runtimeEnv()): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== "/openapi.json" && path !== "/api/public" && !path.startsWith("/api/public/")) return null;
  let result: unknown;
  if (path === "/openapi.json") result = openApiDocument;
  else if (path === "/api/public/status") result = buildPublicStatus(env);
  else if (path === "/api/public/permissions") result = buildPublicPermissions(env);
  else if (path === "/api/public/docs") result = publicDocumentIndex;
  else if (path.startsWith("/api/public/docs/")) {
    const slug = path.slice("/api/public/docs/".length);
    const document = publicDocuments.find((d) => d.slug === slug);
    if (!document) return publicProblem(request, 404, "document_not_found", "This public document is not available.", "Read /api/public/docs for supported document slugs, or visit /docs/.");
    result = documentSchema.parse({ ...metadata(document), format: "text/markdown", content: document.markdown });
  } else return publicProblem(request, 404, "api_route_not_found", "This public API route is not available.", "Use /openapi.json or /docs/api/ to find a supported read operation.");
  if (request.method !== "GET" && request.method !== "HEAD") return publicProblem(request, 405, "method_not_allowed", "This public resource is read-only.", "Repeat the request with GET or HEAD. No credentials are needed.");
  const requestedVersion = request.headers.get("X-API-Version");
  if (requestedVersion !== null && requestedVersion !== "1") return publicProblem(request, 400, "unsupported_api_version", "This public API supports major version 1.", "Send X-API-Version: 1 or omit the header. Read /docs/api/ for the versioning and deprecation policy.");
  return respond(request, result);
}
