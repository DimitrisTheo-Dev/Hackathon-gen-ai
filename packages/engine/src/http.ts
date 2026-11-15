import { connectionSchema } from "../../contracts/src/index.js";
import { z } from "zod";
import { audit, constantTimeEqual, hashToken, newAgentToken, requireHuman, requireScope, resolveContext, type Ctx, type EngineDeps } from "./access.js";
import { createCheckout, createPortal, getBillingStatus, handleStripeWebhook } from "./billing.js";
import { readBoundedText } from "./body.js";
import { connectChannel, disconnectChannel, getChannelStatus } from "./channels.js";
import { getComposition, saveComposition } from "./composition.js";
import { directorTurn } from "./director.js";
import { archiveFile, completeUpload, listFiles, requestUpload, saveTextFile } from "./files.js";
import { draftScript } from "./script.js";
import { abortTake, completeTake, startTake, takePartUrl } from "./takes.js";
import { authenticateReelWorker, cancelRender, listRenders, queueRender, reelWorker } from "./reel-render.js";
import { EngineError } from "./errors.js";
import { likenessLiveToken, likenessUploadUrl, revokeLikenessConsent, saveLikenessConsent } from "./likeness.js";
import { machinesToken } from "./machines.js";
import { createPersona, createPersonaLook, deletePersona, deletePersonaLook, listPersonas, personaConsentToWithdraw, personaImageUploadUrl, updatePersona, updatePersonaLook } from "./personas.js";
import type { Planner } from "./llm.js";
import { createProduct, deleteProduct, placeProduct, productImageUploadUrl, updateProduct } from "./products.js";
import { authenticateWithLimits, principalSubject, refuseCredential, RequestLimits } from "./ratelimit.js";
import { authenticateWorker, cancelJobs, getRenderStatus, renderContent, sweepRenderJobs, workerClaim, workerComplete, workerFail, workerProgress, workerUploadUrl } from "./render.js";
import { approveReview, getLatestReview, reviewContent } from "./review.js";
import type { ReviewModel } from "./review-model.js";
import { approveSchedule, commitSchedule, prepareSchedule, processDuePublishJobs, verifySubmittedPublishJobs } from "./schedule.js";
import { completeSocialSignIn, connectSocialProvider, disconnectSocialProvider, getSocialPlatform, listSocials, refreshSocialCredentials, removeSocialAccount, socialSignInReturn, syncSocialProvider, usableProviders } from "./socials.js";
import { campaignTestView, createDmCampaign, deleteDmCampaign, listCampaignConversations, listDmCampaigns, prepareCampaignTest, sendDueCampaignMessages, updateDmCampaign } from "./socials-campaigns.js";
import { deliverTestEvents, listSocialEvents, receiveSocialWebhook, renewWebhookSubscriptions, socialWebhookHandshake } from "./socials-events.js";
import { addDraft, addSource, agentScopesFrom, createConnectionInputSchema, getCampaign, getContext, listCampaigns, listVersions, parse, removeSource, restoreVersion, reviseContent, revokeConnectionInputSchema, startCampaign, updateBrand } from "./studio.js";
import { createFromTemplate, createSampleProject, listTemplates } from "./templates.js";
import { listLibraryTemplates } from "./template-library.js";
import { createCloneJob, listCloneJobs, lookupCloneSource } from "./clone.js";
import { draftBrandFromWebsite } from "./brand-draft.js";

export interface HttpDeps extends EngineDeps {
  planner: Planner | null;
  /** The content review's claims model. Omitted: made from `config.llm` when that is set (review.ts). Tests inject one. */
  reviewModel?: ReviewModel | null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", ...headers },
  });
}
async function body(request: Request): Promise<unknown> {
  // Bounded read: refused with 413 past 256 KB, counted in bytes, without buffering an oversized body first.
  const text = await readBoundedText(request);
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

type OperationHandler = (deps: HttpDeps, ctx: Ctx, raw: unknown) => Promise<unknown>;
/**
 * The operation table is a Map, never a plain object indexed by the URL: `operations["constructor"]` on an
 * object literal is `Object`, which would echo the engine's dependencies (config and keys) back to the caller.
 */
const operations = new Map<string, OperationHandler>(Object.entries({
  start_campaign: startCampaign,
  revise_content: (deps, ctx, raw) => reviseContent(deps, ctx, raw),
  restore_version: restoreVersion,
  add_draft: addDraft,
  update_brand: updateBrand,
  // Reads one public https page and proposes brand kit fields (brand-draft.ts). It saves nothing.
  draft_brand_from_website: draftBrandFromWebsite,
  // Brand kit products (products.ts): the same permission as the rest of the brand kit.
  create_product: createProduct,
  update_product: updateProduct,
  delete_product: deleteProduct,
  product_image_upload_url: productImageUploadUrl,
  place_product: placeProduct,
  // Content review (review.ts). Approval is a named human act: owners, admins and reviewers, never agents.
  review_content: reviewContent,
  approve_review: approveReview,
  add_source: addSource,
  remove_source: removeSource,
  render_content: renderContent,
  cancel_jobs: cancelJobs,
  prepare_schedule: prepareSchedule,
  approve_schedule: approveSchedule,
  commit_schedule: commitSchedule,
  create_agent_connection: createConnection,
  revoke_agent_connection: revokeConnection,
  create_from_template: createFromTemplate,
  create_sample_project: createSampleProject,
  create_clone_job: createCloneJob,
  create_checkout: createCheckout,
  create_portal: createPortal,
  // Personas (personas.ts): signed-in members who can edit content; the consent itself is recorded at /face-scan.
  create_persona: createPersona,
  update_persona: updatePersona,
  delete_persona: deletePersona,
  withdraw_persona_consent: async (deps, ctx, raw) => revokeLikenessConsent(deps, ctx, await personaConsentToWithdraw(deps, ctx, raw)),
  persona_image_upload_url: personaImageUploadUrl,
  create_persona_look: createPersonaLook,
  update_persona_look: updatePersonaLook,
  delete_persona_look: deletePersonaLook,
  connect_channel: connectChannel,
  disconnect_channel: disconnectChannel,
  save_composition: saveComposition,
  request_file_upload: requestUpload,
  complete_file_upload: completeUpload,
  save_text_file: saveTextFile,
  archive_file: archiveFile,
  // Recorded takes from the New project flow (takes.ts): streamed to storage in parts while recording.
  start_take_upload: startTake,
  take_part_url: takePartUrl,
  complete_take_upload: completeTake,
  abort_take_upload: abortTake,
  queue_reel_render: queueRender,
  cancel_reel_render: cancelRender,
  create_run_grant: async () => {
    throw new EngineError("unsupported", "Unattended publishing grants are not available in this build. Approve each schedule in the studio.");
  },
} satisfies Record<string, OperationHandler>));
/** Operations that spend money or call an external provider also count against the stricter `costly` bucket. */
export const COSTLY_OPERATIONS: ReadonlySet<string> = new Set(["render_content", "create_checkout", "connect_channel", "create_clone_job", "review_content", "request_file_upload", "start_take_upload", "persona_image_upload_url", "product_image_upload_url", "draft_brand_from_website"]);

async function studio(deps: HttpDeps, request: Request, path: string, correlationId: string, limits: RequestLimits): Promise<Response> {
  const principal = await authenticateWithLimits(deps, limits, request.headers.get("authorization"));
  const subject = principalSubject(principal);
  const policies = deps.config.rateLimit;
  // Counted before any workspace resolution or provisioning, so an over-limit caller costs one database call.
  await limits.enforce(policies.principal, subject);
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
  if (read && (match = path.match(/^\/items\/([^/]+)\/composition$/))) return json(await getComposition(deps, ctx, decodeURIComponent(match[1])));
  if (read && (match = path.match(/^\/items\/([^/]+)\/renders$/))) return json(await listRenders(deps, ctx, decodeURIComponent(match[1])));
  // The latest content review of an item, or null (review.ts).
  if (read && (match = path.match(/^\/items\/([^/]+)\/review$/))) return json(await getLatestReview(deps, ctx, decodeURIComponent(match[1])));
  if (read && (match = path.match(/^\/campaigns\/([^/]+)\/files$/))) return json(await listFiles(deps, ctx, decodeURIComponent(match[1])));
  if (read && (match = path.match(/^\/jobs\/([^/]+)$/))) return json(await getRenderStatus(deps, ctx, decodeURIComponent(match[1])));
  if (read && path === "/templates") return json(listTemplates());
  if (read && path === "/personas") return json(await listPersonas(deps, ctx));
  if (read && path === "/templates/library") return json(await listLibraryTemplates(deps));
  if (read && path === "/billing") return json(await getBillingStatus(deps, ctx));
  if (read && path === "/clone/jobs") return json(await listCloneJobs(deps, ctx));
  if (read && path === "/clone/source") {
    // Asks the platform's oEmbed endpoint (or follows a TikTok short link), so it counts as a costly call.
    await limits.enforce(policies.costly, subject);
    return json(await lookupCloneSource(deps, ctx, new URL(request.url).searchParams.get("url")));
  }
  if (read && path === "/channels") return json(await getChannelStatus(deps, ctx));
  if (post && path === "/workspace/select") {
    // resolveContext has already proven membership of the requested workspace.
    if (principal.kind === "agent" && principal.via === "token") throw new EngineError("forbidden", "A workspace token is bound to one workspace.");
    const row = { user_id: principal.userId, last_org_id: ctx.org.id, updated_at: deps.now().toISOString() };
    if (!(await deps.store.update("user_state", { user_id: principal.userId }, row)).length) await deps.store.insert("user_state", row);
    return json(await getContext(deps, ctx));
  }
  if (post && path === "/director/turn") {
    // A model-backed turn costs money: a stricter burst limit sits in front of the per-workspace daily cap.
    await limits.enforce(policies.director, subject);
    return json(await directorTurn(deps, ctx, await body(request), deps.planner));
  }
  if (post && path === "/script/draft") {
    // The New project flow's script step: a model call like a director turn, under the same limits.
    await limits.enforce(policies.director, subject);
    return json(await draftScript(deps, ctx, await body(request), deps.planner));
  }
  // Likeness capture ("Scan my face"). Signed-in people only; see likeness.ts.
  if (post && path === "/likeness/upload-url") {
    // Each link lets the caller put a file in storage, so it counts against `costly` like the other upload links.
    await limits.enforce(policies.costly, subject);
    return json(await likenessUploadUrl(deps, ctx, await body(request)));
  }
  if (post && path === "/likeness/live-token") return json(await likenessLiveToken(deps, ctx));
  if (post && path === "/likeness/consents") {
    // Where the consent was given from is part of its record. Both values are length-capped, never trusted for access;
    // the forwarded address is kept only behind a proxy that sets it (config.trustProxyHeaders), so a caller cannot choose it.
    const forwarded = deps.config.trustProxyHeaders ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) : null;
    const client = { userAgent: request.headers.get("user-agent")?.trim().slice(0, 500) || null, ipAddress: forwarded || null };
    return json(await saveLikenessConsent(deps, ctx, await body(request), client));
  }
  if (request.method === "DELETE" && (match = path.match(/^\/likeness\/consents\/([^/]+)$/))) return json(await revokeLikenessConsent(deps, ctx, decodeURIComponent(match[1])));
  // A ten-minute token for the Claude Code machines gateway, so the session itself never leaves Faceful (machines.ts).
  if (post && path === "/machines/token") return json(machinesToken(deps, ctx));
  if (post && (match = path.match(/^\/operations\/([a-z_]+)$/))) {
    const name = match[1];
    const operation = operations.get(name);
    if (!operation) throw new EngineError("not_found", "Unknown studio operation.");
    if (COSTLY_OPERATIONS.has(name)) await limits.enforce(policies.costly, subject);
    return json(await operation(deps, ctx, await body(request)));
  }
  throw new EngineError("not_found", "Unknown studio route.");
}

async function worker(deps: HttpDeps, request: Request, path: string, limits: RequestLimits): Promise<Response> {
  // The render worker is a trusted service credential and is not throttled; refused credentials are.
  try {
    authenticateWorker(deps, request.headers.get("authorization"));
  } catch (error) {
    if (error instanceof EngineError) await refuseCredential(limits, deps.config.rateLimit, error);
    throw error;
  }
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

/** Social accounts and their activity: /v1/socials, /v1/socials/:platform, and the per-platform webhook address. */
async function socials(deps: HttpDeps, request: Request, path: string, correlationId: string, limits: RequestLimits): Promise<Response> {
  const { method } = request;
  const query = new URL(request.url).searchParams;
  // Added by the platform rewrite (vercel.json); never part of the caller's query.
  query.delete("__path");
  const policies = deps.config.rateLimit;
  let match: RegExpMatchArray | null;
  // Deliveries are signed by their sender instead of carrying a member session, and need the exact bytes sent.
  if ((match = path.match(/^\/([a-z0-9_]+)\/webhook$/))) {
    if (method === "POST") {
      // Like the Stripe webhook, a genuine delivery is not rate limited: a platform retries what is refused, and a
      // dropped delivery loses activity. A delivery whose signature is refused counts as a failed credential.
      try {
        return json(await receiveSocialWebhook(deps, match[1], request.headers, await readBoundedText(request), query));
      } catch (error) {
        if (error instanceof EngineError && error.code === "unauthenticated") await refuseCredential(limits, policies, error);
        throw error;
      }
    }
    // The check a platform makes when the address is registered carries no credential.
    await limits.enforceNetwork(policies.anonymous);
    const answer = method === "GET" ? await socialWebhookHandshake(deps, match[1], query) : null;
    if (answer === null) throw new EngineError("not_found", "Unknown socials route.");
    return new Response(answer.body, { headers: { "Content-Type": answer.contentType, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  // A platform sending the person's browser back after they signed in there. It carries no member session, so it
  // only passes them on to the studio's connect page, where they complete the connection signed in.
  if (method === "GET" && (match = path.match(/^\/providers\/([a-z0-9_]+)\/callback$/))) {
    await limits.enforceNetwork(policies.anonymous);
    return new Response(null, { status: 302, headers: { Location: socialSignInReturn(deps, match[1], query), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  }
  const principal = await authenticateWithLimits(deps, limits, request.headers.get("authorization"));
  const subject = principalSubject(principal);
  await limits.enforce(policies.principal, subject);
  const ctx = await resolveContext(deps, principal, request.headers.get("x-faceful-workspace"), correlationId);
  if (method === "GET" && (path === "" || path === "/")) return json(await listSocials(deps, ctx));
  if (method === "GET" && path === "/events") return json(await listSocialEvents(deps, ctx, Object.fromEntries(query)));
  // Comment-to-DM campaigns (socials-campaigns.ts). Before `/:platform`, which "campaigns" would otherwise match.
  if (path === "/campaigns") {
    if (method === "GET") return json(await listDmCampaigns(deps, ctx));
    if (method === "POST") return json(await createDmCampaign(deps, ctx, await body(request)), 201);
  }
  if ((match = path.match(/^\/campaigns\/([0-9a-f-]{36})(\/conversations|\/test)?$/))) {
    const [, id, sub] = match;
    if (!sub && method === "PATCH") return json(await updateDmCampaign(deps, ctx, id, await body(request)));
    if (!sub && method === "DELETE") return json(await deleteDmCampaign(deps, ctx, id));
    if (sub === "/conversations" && method === "GET") return json(await listCampaignConversations(deps, ctx, id));
    if (sub === "/test" && method === "GET") return json(await campaignTestView(deps, ctx, id));
    if (sub === "/test" && method === "POST") {
      // A test can ask the AI model for an answer, so it counts against `costly`.
      await limits.enforce(policies.costly, subject);
      const events = await prepareCampaignTest(deps, ctx, id, await body(request));
      const delivered = events ? await deliverTestEvents(deps, "instagram", events) : null;
      return json({ via: delivered?.via ?? null, ...(await campaignTestView(deps, ctx, id)) });
    }
  }
  if (method === "POST" && (match = path.match(/^\/providers\/([a-z0-9_]+)\/complete$/))) {
    // Finishing a sign-in trades its code with the platform, so it counts against `costly` too.
    await limits.enforce(policies.costly, subject);
    return json(await completeSocialSignIn(deps, ctx, match[1], await body(request)));
  }
  if (method === "POST" && (match = path.match(/^\/providers\/([a-z0-9_]+)\/(connect|sync)$/))) {
    // Connecting or syncing calls the provider (or starts a sign-in with it), so it also counts against `costly`.
    await limits.enforce(policies.costly, subject);
    const result = match[2] === "connect" ? await connectSocialProvider(deps, ctx, match[1], await body(request)) : await syncSocialProvider(deps, ctx, match[1]);
    // Where the engine holds a platform's subscription itself (YouTube), new accounts start receiving right away.
    // Best effort: the scheduler tick asks again.
    await renewWebhookSubscriptions(deps, ctx.org.id).catch(() => undefined);
    return json(result);
  }
  if (method === "DELETE" && (match = path.match(/^\/providers\/([a-z0-9_]+)$/))) return json(await disconnectSocialProvider(deps, ctx, match[1]));
  if (method === "DELETE" && (match = path.match(/^\/accounts\/([0-9a-f-]{36})$/))) return json(await removeSocialAccount(deps, ctx, match[1]));
  if (method === "GET" && (match = path.match(/^\/([a-z0-9_]+)$/))) return json(await getSocialPlatform(deps, ctx, match[1]));
  throw new EngineError("not_found", "Unknown socials route.");
}

/** Reel render worker routes: /v1/worker/reel/*. */
async function reelWorkerRoute(deps: HttpDeps, request: Request, path: string, limits: RequestLimits): Promise<Response> {
  // Like the avatar render worker: a trusted service credential that is not throttled; refused credentials are.
  try {
    authenticateReelWorker(deps, request.headers.get("authorization"));
  } catch (error) {
    if (error instanceof EngineError) await refuseCredential(limits, deps.config.rateLimit, error);
    throw error;
  }
  return json(await reelWorker(deps, request, path, () => body(request)));
}

/** Which integrations are configured. Booleans and safe sentences only — never a key, a URL with credentials or an ID. */
export function health(deps: HttpDeps) {
  const { config } = deps;
  return {
    engine: true,
    database: Boolean(config.supabaseUrl),
    director: config.llm ? "ai" : "basic",
    rendering: { connected: Boolean(config.renderWorkerToken), provider: "humanlike", humanlikeKey: Boolean(config.humanlikeApiKey) },
    files: { connected: Boolean(deps.files?.configured) },
    likeness: { liveTranscription: Boolean(config.humanlikeTranscribeKey) },
    reelRendering: { connected: Boolean(config.reelWorkerToken) },
    billing: { mode: config.stripe ? "sandbox" : "not_configured", problem: config.stripeProblem },
    // What can post: YouTube channels connected in the studio, and each social provider a workspace could connect here
    // (SOCIALS_CREDENTIAL_KEY set; for Instagram directly, also this deployment's own Instagram app).
    publishing: { adapters: [...(config.youtube ? ["youtube"] : []), ...usableProviders(deps)], problem: config.youtube ? null : config.youtubeProblem },
    socials: {
      connections: Boolean(config.socials.credentialKey),
      webhooks: Boolean(config.socials.webhookSecret),
      // Platforms whose own webhook format is accepted here.
      nativeWebhooks: Object.entries(config.socials.native).flatMap(([platform, credentials]) => (credentials ? [platform] : [])),
    },
    scheduler: Boolean(config.cronSecret),
  };
}

/** Single entry for every `/v1/*` route. Returns null for paths this engine does not own. */
export async function handleEngineRequest(deps: HttpDeps, request: Request, pathname: string): Promise<Response | null> {
  if (!pathname.startsWith("/v1/")) return null;
  const correlationId = crypto.randomUUID();
  const started = Date.now();
  const limits = new RequestLimits(deps.store, deps.config.rateLimit, request.headers);
  let response: Response;
  try {
    if (pathname === "/v1/health" && request.method === "GET") response = json(health(deps));
    else if (pathname === "/v1/stripe/webhook" && request.method === "POST") {
      // Not rate limited: every delivery is signature-verified, and dropping one would lose a billing event.
      // Signature verification needs the exact bytes Stripe sent, so the body is read as text and never re-serialised.
      // Bounded like every other body (Stripe events are a few KB), so an unsigned flood cannot buffer megabytes first.
      const result = await handleStripeWebhook(deps, await readBoundedText(request, 1024 * 1024), request.headers.get("stripe-signature"));
      response = json(result.body, result.status);
    } else if (pathname === "/v1/cron/tick") {
      // An authorized scheduler is not rate limited; a wrong secret counts as a failed credential.
      const cronSecret = deps.config.cronSecret;
      if (!cronSecret || !constantTimeEqual(request.headers.get("authorization") ?? "", `Bearer ${cronSecret}`)) {
        await refuseCredential(limits, deps.config.rateLimit, new EngineError("unauthenticated", "Scheduler credential required."));
      }
      // Sign-in credentials are refreshed first, so the posts due in this same run go out with ones that still work.
      // Publishing also asks providers about submitted posts (schedule.ts); webhook subscriptions are renewed where the engine holds them.
      const credentials = await refreshSocialCredentials(deps);
      response = json({ swept: await sweepRenderJobs(deps), publishing: await processDuePublishJobs(deps), webhooks: await renewWebhookSubscriptions(deps), credentials, messages: await sendDueCampaignMessages(deps) });
    } else if (pathname.startsWith("/v1/studio/")) response = await studio(deps, request, pathname.slice("/v1/studio".length), correlationId, limits);
    else if (pathname === "/v1/socials" || pathname.startsWith("/v1/socials/")) response = await socials(deps, request, pathname.slice("/v1/socials".length), correlationId, limits);
    else if (pathname.startsWith("/v1/worker/reel/")) response = await reelWorkerRoute(deps, request, pathname.slice("/v1/worker/reel".length), limits);
    else if (pathname.startsWith("/v1/worker/")) response = await worker(deps, request, pathname.slice("/v1/worker".length), limits);
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
  // RateLimit-Policy / RateLimit describe only the limits this request was actually counted against.
  for (const [name, value] of Object.entries(limits.headers())) response.headers.set(name, value);
  response.headers.set("X-Correlation-Id", correlationId);
  // Structured access log: route and outcome only. No bodies, prompts, tokens or query strings.
  console.log(JSON.stringify({ level: "info", event: "request", correlationId, method: request.method, path: pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id"), status: response.status, ms: Date.now() - started }));
  return response;
}
