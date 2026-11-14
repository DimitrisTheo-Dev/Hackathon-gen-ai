import { z } from "zod";
import { publicDocuments, publicOrigin, publicPages } from "./documents.js";
import { publicDiscoveryLinkHeader } from "./discovery.js";
export { publicDocuments, publicOrigin, publicPages, publicDiscoveryLinkHeader };

const absoluteUrl = z.url({ protocol: /^https$/ });
const scopeNames = ["campaign:read", "content:edit", "render:write", "schedule:prepare"] as const;
export const permissionSchema = z.object({
  name: z.enum(scopeNames),
  description: z.string(),
  authority: z.literal("proposed_not_issued"),
}).strict();
export const permissionsSchema = z.object({
  schemaVersion: z.literal("1.0"),
  authenticationStatus: z.literal("awaiting_engine"),
  publicReadsRequireAuthentication: z.literal(false),
  liveGrantAvailable: z.literal(false),
  scopes: z.array(permissionSchema),
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
  engine: z.object({ campaignApi: z.literal(false), agentTokenIssuance: z.literal(false), mcp: z.literal(false), humanlikeRendering: z.literal(false), publishing: z.literal(false) }).strict(),
  blockers: z.array(z.string()),
  links: z.object({ documentation: absoluteUrl, openapi: absoluteUrl, permissions: absoluteUrl, setup: absoluteUrl, cli: absoluteUrl }).strict(),
}).strict();
export const documentMetadataSchema = z.object({ slug: z.string(), title: z.string(), summary: z.string(), url: absoluteUrl }).strict();
export const documentSchema = documentMetadataSchema.extend({ format: z.literal("text/markdown"), content: z.string() }).strict();
export const documentIndexSchema = z.object({ documents: z.array(documentMetadataSchema) }).strict();
export const problemSchema = z.object({
  type: z.literal("about:blank"), title: z.string(), status: z.number().int().min(400).max(599),
  detail: z.string(), instance: z.string(), code: z.string(), resolution: z.string(),
}).strict();

export const publicStatus = statusSchema.parse({
  product: "Faceful", schemaVersion: "1.0", stage: "development",
  publicApi: { available: true, readOnly: true, authenticationRequired: false },
  studio: { available: true, privateDataRequiresAuthentication: true, developmentFixturesAreLiveResults: false },
  engine: { campaignApi: false, agentTokenIssuance: false, mcp: false, humanlikeRendering: false, publishing: false },
  blockers: ["Shared domain API and server-side authorization integration", "Scoped agent credential issuer and authenticated MCP client trials", "Authorized Humanlike media and final composition", "Connected publishing accounts and per-platform receipts"],
  links: { documentation: `${publicOrigin}/docs/`, openapi: `${publicOrigin}/openapi.json`, permissions: `${publicOrigin}/api/public/permissions`, setup: `${publicOrigin}/docs/setup/`, cli: `${publicOrigin}/docs/cli/` },
});
export const publicPermissions = permissionsSchema.parse({
  schemaVersion: "1.0", authenticationStatus: "awaiting_engine", publicReadsRequireAuthentication: false,
  liveGrantAvailable: false, publishingAuthorityIncluded: false,
  scopes: [
    { name: "campaign:read", description: "Proposed: read authorized workspace context, campaign items, versions and jobs.", authority: "proposed_not_issued" },
    { name: "content:edit", description: "Proposed: submit version-checked edits to authorized draft content.", authority: "proposed_not_issued" },
    { name: "render:write", description: "Proposed: request bounded generation for selected current revisions and authorized avatars.", authority: "proposed_not_issued" },
    { name: "schedule:prepare", description: "Proposed: prepare an exact schedule manifest for human review; does not authorize publication.", authority: "proposed_not_issued" },
  ],
  note: "These are the names currently requested by the studio setup. Backend agreement and enforcement are pending. This resource is documentation, not OAuth metadata or a credential grant. A publishing action requires separately verified owner authority.",
  documentationUrl: `${publicOrigin}/docs/security/`,
});
const metadata = (document: (typeof publicDocuments)[number]) => ({ slug: document.slug, title: document.title, summary: document.summary, url: `${publicOrigin}${document.path}` });
export const publicDocumentIndex = documentIndexSchema.parse({ documents: publicDocuments.map(metadata) });

function schema(value: z.ZodType) { return z.toJSONSchema(value, { target: "draft-2020-12" }); }
const versionParameter = { name: "X-API-Version", in: "header", required: false, description: "Pin public API major version 1. Omission defaults to 1; unsupported versions return 400. Breaking changes require a new version.", schema: { type: "string", enum: ["1"], default: "1" } };
const jsonResponse = (name: string, example: unknown) => ({
  description: "Successful public read. No private workspace data or credentials are included.",
  headers: {
    "X-API-Version": { description: "Public API major version served.", schema: { type: "string", const: "1" } },
    Link: { description: "RFC 8631 service description, documentation and integration status; includes the public agent index. Links describe implemented public resources, not live MCP availability.", schema: { type: "string" }, example: publicDiscoveryLinkHeader },
  },
  content: { "application/json": { schema: { $ref: `#/components/schemas/${name}` }, example } },
});
const errorResponse = (description: string) => ({ description, content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } });
const operation = (operationId: string, summary: string, description: string, responseName: string, example: unknown) => ({
  operationId, summary, description, security: [], parameters: [versionParameter], tags: ["Public discovery"],
  responses: {
    "200": jsonResponse(responseName, example),
    "400": errorResponse("Unsupported API version. Retry with X-API-Version: 1."),
    "404": errorResponse("The requested public resource does not exist. Follow resolution to a documented route."),
    "405": { ...errorResponse("The method is unsupported. Use GET or HEAD."), headers: { Allow: { description: "Supported methods.", schema: { type: "string", const: "GET, HEAD" } } } },
  },
});
export const openApiDocument = {
  openapi: "3.1.1", jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
  info: {
    title: "Faceful public discovery API", version: "1.0.0",
    description: "Implemented read-only product status, proposed permission definitions and public documentation. No campaign writes, private data, rendering, token issuance or publishing are exposed by this API. The shared domain engine remains pending integration.",
    contact: { name: "Faceful project maintainer", url: "https://github.com/DimitrisTheo-Dev" },
  },
  servers: [{ url: publicOrigin, description: "Faceful public origin" }], security: [],
  externalDocs: { description: "Faceful API setup, limits and recovery", url: `${publicOrigin}/docs/api/` },
  tags: [{ name: "Public discovery", description: "Credential-free reads containing public information only." }],
  paths: {
    "/api/public/status": { get: operation("getCastroomStatus", "Read current integration status", "Discover which Faceful surfaces are implemented, which engine capabilities remain unavailable and the next documentation link. This does not report private workspace health.", "Status", publicStatus) },
    "/api/public/permissions": { get: operation("getCastroomPermissionDefinitions", "Read proposed scope definitions", "Read the four scope names currently requested by the studio setup. These are proposed definitions, not issued grants or OAuth scopes advertised by a live authorization server.", "Permissions", publicPermissions) },
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
/** Public discovery only; returns null for every private/domain route. */
export function handlePublicRequest(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== "/openapi.json" && path !== "/api/public" && !path.startsWith("/api/public/")) return null;
  let result: unknown;
  if (path === "/openapi.json") result = openApiDocument;
  else if (path === "/api/public/status") result = publicStatus;
  else if (path === "/api/public/permissions") result = publicPermissions;
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
