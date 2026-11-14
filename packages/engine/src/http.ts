import { connectionSchema } from "../../contracts/src/index.js";
import { z } from "zod";
import { audit, authenticate, hashToken, newAgentToken, requireHuman, requireScope, resolveContext, type Ctx, type EngineDeps } from "./access.js";
import { createCheckout, createPortal, getBillingStatus, handleStripeWebhook } from "./billing.js";
import { connectChannel, disconnectChannel, getChannelStatus } from "./channels.js";
import { directorTurn } from "./director.js";
import { EngineError } from "./errors.js";
import type { Planner } from "./llm.js";
import { authenticateWorker, cancelJobs, getRenderStatus, renderContent, sweepRenderJobs, workerClaim, workerComplete, workerFail, workerProgress, workerUploadUrl } from "./render.js";
import { approveSchedule, commitSchedule, prepareSchedule, processDuePublishJobs, verifySubmittedPublishJobs } from "./schedule.js";
import { addDraft, agentScopesFrom, createConnectionInputSchema, getCampaign, getContext, listCampaigns, listVersions, parse, restoreVersion, reviseContent, revokeConnectionInputSchema, startCampaign } from "./studio.js";
import { createFromTemplate, createSampleProject, listTemplates } from "./templates.js";

export interface HttpDeps extends EngineDeps {
  planner: Planner | null;
}
const MAX_BODY_BYTES = 256 * 1024;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}
async function body(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new EngineError("validation_error", "The request is too large.");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new EngineError("validation_error", "The request body is not valid JSON.");
  }
}

async function createConnection(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  requireHuman(ctx, "Creating a workspace token");
  requireScope(ctx, "connections:manage");
  const input = parse(createConnectionInputSchema, raw);
  const scopes = agentScopesFrom(input.scopes);
  const expiresAt = new Date(input.expiresAt);
  const maxExpiry = deps.now().getTime() + 90 * 24 * 3600_000;
  if (expiresAt.getTime() <= deps.now().getTime() || expiresAt.getTime() > maxExpiry) throw new EngineError("validation_error", "A workspace token must expire within 90 days.");
  const token = newAgentToken();
  const row = await deps.store.insert("agent_connections", {
    id: crypto.randomUUID(),
    org_id: ctx.org.id,
    display_name: input.displayName,
    token_sha256: hashToken(token),
    scopes,
    expires_at: expiresAt.toISOString(),
    last_seen_at: null,
    revoked_at: null,
    created_by: (ctx.principal as { userId: string }).userId,
    created_at: deps.now().toISOString(),
  });
  await audit(deps, ctx, { action: "Created an agent workspace token", objectId: row.id, outcome: `Scopes: ${scopes.join(", ")}` });
  // The plaintext token exists only in this response. It is never stored or logged, so it cannot be replayed.
  return { connection: parse(connectionSchema, { id: row.id, displayName: row.display_name, scopes, expiresAt: expiresAt.toISOString(), lastSeenAt: null, revokedAt: null }), token };
}
async function revokeConnection(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  requireHuman(ctx, "Revoking a workspace token");
  requireScope(ctx, "connections:manage");
  const input = parse(revokeConnectionInputSchema, raw);
  const revoked = await deps.store.update("agent_connections", { id: input.connectionId, org_id: ctx.org.id }, { revoked_at: deps.now().toISOString() });
  if (!revoked.length) throw new EngineError("not_found", "This connection was not found in your workspace.");
  await audit(deps, ctx, { action: "Revoked an agent workspace token", objectId: input.connectionId, outcome: "New calls with this token are refused" });
  return { revoked: true as const };
}

const operations: Record<string, (deps: HttpDeps, ctx: Ctx, raw: unknown) => Promise<unknown>> = {
  start_campaign: startCampaign,
  revise_content: (deps, ctx, raw) => reviseContent(deps, ctx, raw),
  restore_version: restoreVersion,
  add_draft: addDraft,
  render_content: renderContent,
  cancel_jobs: cancelJobs,
  prepare_schedule: prepareSchedule,
  approve_schedule: approveSchedule,
  commit_schedule: commitSchedule,
  create_agent_connection: createConnection,
  revoke_agent_connection: revokeConnection,
  create_from_template: createFromTemplate,
  create_sample_project: createSampleProject,
  create_checkout: createCheckout,
  create_portal: createPortal,
  connect_channel: connectChannel,
  disconnect_channel: disconnectChannel,
  create_run_grant: async () => {
    throw new EngineError("unsupported", "Unattended publishing grants are not available in this build. Approve each schedule in the studio.");
  },
};

async function studio(deps: HttpDeps, request: Request, path: string, correlationId: string): Promise<Response> {
  const principal = await authenticate(deps, request.headers.get("authorization"));
  const ctx = await resolveContext(deps, principal, request.headers.get("x-faceful-workspace"), correlationId);
  const read = request.method === "GET";
  const post = request.method === "POST";
  let match: RegExpMatchArray | null;
  if (read && path === "/context") return json(await getContext(deps, ctx));
  if (read && path === "/campaigns") return json(await listCampaigns(deps, ctx));
  if (read && (match = path.match(/^\/campaigns\/([^/]+)$/))) {
    // Reads double as the moment stuck work is noticed, so a card can never spin forever.
    await sweepRenderJobs(deps, { orgId: ctx.org.id });
    const campaignId = decodeURIComponent(match[1]);
    // The scheduler runs rarely, so an open project also confirms its own uploaded posts — at most one provider
    // check per post per minute, and never more than three per read. A failed check must not fail the read.
    await verifySubmittedPublishJobs(deps, { orgId: ctx.org.id, projectId: campaignId, minIntervalSeconds: 60, limit: 3 }).catch(() => undefined);
    return json(await getCampaign(deps, ctx, campaignId));
  }
  if (read && (match = path.match(/^\/items\/([^/]+)\/versions$/))) return json(await listVersions(deps, ctx, decodeURIComponent(match[1])));
  if (read && (match = path.match(/^\/jobs\/([^/]+)$/))) return json(await getRenderStatus(deps, ctx, decodeURIComponent(match[1])));
  if (read && path === "/templates") return json(listTemplates());
  if (read && path === "/billing") return json(await getBillingStatus(deps, ctx));
  if (read && path === "/channels") return json(await getChannelStatus(deps, ctx));
  if (post && path === "/workspace/select") {
    // resolveContext has already proven membership of the requested workspace.
    if (principal.kind === "agent" && principal.via === "token") throw new EngineError("forbidden", "A workspace token is bound to one workspace.");
    const row = { user_id: principal.userId, last_org_id: ctx.org.id, updated_at: deps.now().toISOString() };
    if (!(await deps.store.update("user_state", { user_id: principal.userId }, row)).length) await deps.store.insert("user_state", row);
    return json(await getContext(deps, ctx));
  }
  if (post && path === "/director/turn") return json(await directorTurn(deps, ctx, await body(request), deps.planner));
  if (post && (match = path.match(/^\/operations\/([a-z_]+)$/))) {
    const operation = operations[match[1]];
    if (!operation) throw new EngineError("not_found", "Unknown studio operation.");
    return json(await operation(deps, ctx, await body(request)));
  }
  throw new EngineError("not_found", "Unknown studio route.");
}

async function worker(deps: HttpDeps, request: Request, path: string): Promise<Response> {
  authenticateWorker(deps, request.headers.get("authorization"));
  if (request.method !== "POST") throw new EngineError("not_found", "Unknown worker route.");
  let match: RegExpMatchArray | null;
  if (path === "/render/claim") return json(await workerClaim(deps, await body(request)));
  if ((match = path.match(/^\/render\/([^/]+)\/(progress|upload-url|complete|fail)$/))) {
    const [, jobId, action] = match;
    const payload = await body(request);
    if (action === "progress") return json(await workerProgress(deps, jobId, payload));
    if (action === "upload-url") return json(await workerUploadUrl(deps, jobId, payload));
    if (action === "complete") return json(await workerComplete(deps, jobId, payload));
    return json(await workerFail(deps, jobId, payload));
  }
  throw new EngineError("not_found", "Unknown worker route.");
}

/** Which integrations are configured. Booleans and safe sentences only — never a key, a URL with credentials or an ID. */
export function health(deps: HttpDeps) {
  const { config } = deps;
  return {
    engine: true,
    database: Boolean(config.supabaseUrl),
    director: config.llm ? "ai" : "basic",
    rendering: { connected: Boolean(config.renderWorkerToken), provider: "humanlike", humanlikeKey: Boolean(config.humanlikeApiKey) },
    billing: { mode: config.stripe ? "sandbox" : "not_configured", problem: config.stripeProblem },
    publishing: { adapters: config.youtube ? ["youtube"] : ([] as string[]), problem: config.youtube ? null : config.youtubeProblem },
    scheduler: Boolean(config.cronSecret),
  };
}

/** Single entry for every `/v1/*` route. Returns null for paths this engine does not own. */
export async function handleEngineRequest(deps: HttpDeps, request: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/v1/")) return null;
  const correlationId = crypto.randomUUID();
  const started = Date.now();
  let response: Response;
  try {
    if (pathname === "/v1/health" && request.method === "GET") response = json(health(deps));
    else if (pathname === "/v1/stripe/webhook" && request.method === "POST") {
      // Signature verification needs the exact bytes Stripe sent, so the body is read as text and never re-serialised.
      const result = await handleStripeWebhook(deps, await request.text(), request.headers.get("stripe-signature"));
      response = json(result.body, result.status);
    } else if (pathname === "/v1/cron/tick") {
      const supplied = request.headers.get("authorization");
      if (!deps.config.cronSecret || supplied !== `Bearer ${deps.config.cronSecret}`) throw new EngineError("unauthenticated", "Scheduler credential required.");
      response = json({ swept: await sweepRenderJobs(deps), publishing: await processDuePublishJobs(deps) });
    } else if (pathname.startsWith("/v1/studio/")) response = await studio(deps, request, pathname.slice("/v1/studio".length), correlationId);
    else if (pathname.startsWith("/v1/worker/")) response = await worker(deps, request, pathname.slice("/v1/worker".length));
    else throw new EngineError("not_found", "Unknown API route.");
  } catch (error) {
    if (error instanceof EngineError) {
      response = json(error.toBody(), error.status, error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {});
    } else if (error instanceof z.ZodError) {
      response = json(new EngineError("validation_error", "The request does not match the studio contract.").toBody(), 400);
    } else {
      // Unexpected failures are logged with a correlation ID; the caller gets no internals.
      console.error(JSON.stringify({ level: "error", event: "unhandled", correlationId, path: pathname, name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message : null }));
      response = json(new EngineError("unknown_outcome", `Something went wrong on our side. Check the current status before retrying. Reference: ${correlationId}`).toBody(), 500);
    }
  }
  response.headers.set("X-Correlation-Id", correlationId);
  // Structured access log: route and outcome only. No bodies, prompts, tokens or query strings.
  console.log(JSON.stringify({ level: "info", event: "request", correlationId, method: request.method, path: pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id"), status: response.status, ms: Date.now() - started }));
  return response;
}
