import { z } from "zod";
import { operationSchema, type Operation } from "../../contracts/src/index.js";
import { audit, bearerMatches, idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import { selectOne, type Filter, type Row } from "./store.js";
import { listAvatars, loadItem, loadProject, parse, renderBlocker } from "./studio.js";

/**
 * Render jobs are durable rows. A renderer (the Humanlike recording worker) claims a queued job,
 * uploads the finished file to private storage and reports completion. Nothing in this module can
 * mark a job succeeded without a stored, verified media object.
 *
 *   QUEUED → RUNNING → SUCCEEDED | FAILED          (+ CANCEL_REQUESTED → CANCELLED)
 */
const ACTIVE = ["queued", "running", "cancel_requested"];
const ACCEPTED_MEDIA: Record<string, string> = { "video/mp4": "mp4", "video/webm": "webm" };
const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export const renderInputSchema = z
  .object({ campaignId: z.string().min(1).max(160), itemIds: z.array(z.string().min(1).max(160)).min(1).max(3), expectedRevisions: z.record(z.string(), z.number().int().positive()), operationKey: z.uuid() })
  .strict();
export const cancelInputSchema = z.object({ jobIds: z.array(z.string().min(1).max(160)).min(1).max(100), operationKey: z.uuid() }).strict();

async function event(deps: EngineDeps, orgId: string, jobId: string, type: string, detail: Row = {}) {
  await deps.store.insert("job_events", { id: crypto.randomUUID(), org_id: orgId, job_id: jobId, job_kind: "render", type, detail, at: deps.now().toISOString() });
}
async function releaseCredits(deps: EngineDeps, job: Row) {
  if (!job.credits_reserved) return;
  try {
    await deps.store.insert("credit_ledger", { id: crypto.randomUUID(), org_id: job.org_id, delta: job.credits_reserved, reason: "render_release", ref: `release:${job.id}`, created_at: deps.now().toISOString() });
  } catch (error) {
    // Already released by a concurrent failure path: the unique ref makes the refund exactly-once.
    if (!(error instanceof StoreConflict)) throw error;
  }
}

/** Admission is the single enforcement point for entitlement, budget and concurrency — for the UI and MCP alike. */
export async function renderContent(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Operation> {
  requireScope(ctx, "render:write");
  const input = parse(renderInputSchema, raw);
  return idempotent(deps, ctx, "render_content", input.operationKey, input, async () => {
    const blocker = renderBlocker(deps);
    if (blocker) throw new EngineError("provider_unavailable", blocker);
    const project = await loadProject(deps, ctx, input.campaignId);
    const avatars = await listAvatars(deps);
    const items: Row[] = [];
    for (const id of new Set(input.itemIds)) {
      const item = await loadItem(deps, ctx, id);
      if (item.project_id !== project.id) throw new EngineError("not_found", "This content item is not part of that project.");
      if (item.revision !== input.expectedRevisions[id]) throw new EngineError("revision_conflict", `“${item.title}” changed after you opened it. Reload it before rendering.`);
      if (item.kind !== "avatar_video") throw new EngineError("unsupported", "Only avatar videos can be rendered.");
      if (!item.script.trim()) throw new EngineError("validation_error", `“${item.title}” has no script to render.`);
      const avatar = avatars.find((entry) => entry.id === item.avatar_id && entry.permission === "authorized");
      if (!avatar) throw new EngineError("validation_error", `Choose a presenter for “${item.title}” before rendering.`);
      if (!avatar.languages.includes(item.language)) throw new EngineError("validation_error", `The presenter chosen for “${item.title}” does not support its language.`);
      items.push(item);
    }
    const jobIds: string[] = [];
    let created = 0;
    for (const item of items) {
      const live = (await deps.store.select("render_jobs", { org_id: ctx.org.id, item_id: item.id, revision: item.revision, state: { in: ACTIVE } }, { limit: 1 }))[0];
      if (live) {
        jobIds.push(live.id);
        continue;
      }
      // This exact revision already has a verified video: do not spend another render on it.
      if (item.render_revision === item.revision && item.media_asset_id) continue;
      const running = await deps.store.select("render_jobs", { org_id: ctx.org.id, state: { in: ACTIVE } }, { limit: deps.config.maxActiveRendersPerOrg + 1 });
      if (running.length >= deps.config.maxActiveRendersPerOrg)
        throw new EngineError("quota_exceeded", `This workspace already has ${running.length} renders in progress. Wait for one to finish.`, { retryAfterSeconds: 60 });
      const jobId = crypto.randomUUID();
      const cost = deps.config.renderCreditCost;
      const balance = await deps.store.holdCredits(ctx.org.id, cost, `render:${jobId}`);
      if (balance === null)
        throw new EngineError("quota_exceeded", "This workspace has no render credits left. Upgrade in Billing to keep rendering; your drafts are unchanged.", { reviewUrl: "/studio/?view=billing" });
      const now = deps.now().toISOString();
      const job: Row = {
        id: jobId,
        org_id: ctx.org.id,
        project_id: project.id,
        item_id: item.id,
        revision: item.revision,
        state: "queued",
        stage: "render",
        provider: "humanlike",
        provider_job_id: null,
        provider_status: null,
        avatar_id: item.avatar_id,
        script: item.script,
        language: item.language,
        settings: { style: item.style, aspectRatio: "9:16" },
        attempt: 0,
        credits_reserved: cost,
        credits_settled: false,
        error: null,
        media_asset_id: null,
        claimed_by: null,
        claimed_at: null,
        correlation_id: ctx.correlationId,
        idempotency_key: input.operationKey,
        created_by: ctx.actorId,
        created_at: now,
        updated_at: now,
      };
      try {
        await deps.store.insert("render_jobs", job);
      } catch (error) {
        // Lost a race to another request for the same revision: refund this hold and reuse the winner.
        await releaseCredits(deps, job);
        if (!(error instanceof StoreConflict)) throw error;
        const winner = (await deps.store.select("render_jobs", { org_id: ctx.org.id, item_id: item.id, revision: item.revision, state: { in: ACTIVE } }, { limit: 1 }))[0];
        if (winner) jobIds.push(winner.id);
        continue;
      }
      created++;
      jobIds.push(jobId);
      await deps.store.update("content_items", { id: item.id, org_id: ctx.org.id, revision: item.revision }, { status: "queued" });
      await event(deps, ctx.org.id, jobId, "queued", { credits: cost, balanceAfter: balance });
      await audit(deps, ctx, { projectId: project.id, action: "Requested a video render", objectId: item.id, revision: item.revision, outcome: `Queued · ${cost} credit${cost === 1 ? "" : "s"} held` });
    }
    return parse(operationSchema, { operationId: input.operationKey, state: created || jobIds.length ? "accepted" : "completed", jobIds, nextPollAfterMs: 5000, reviewUrl: null });
  });
}

export async function cancelJobs(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Operation> {
  requireScope(ctx, "render:write");
  const input = parse(cancelInputSchema, raw);
  return idempotent(deps, ctx, "cancel_jobs", input.operationKey, input, async () => {
    const now = deps.now().toISOString();
    const affected: string[] = [];
    for (const id of input.jobIds) {
      const job = await selectOne(deps.store, "render_jobs", { id, org_id: ctx.org.id });
      if (!job) throw new EngineError("not_found", "A job in this request was not found in your workspace.");
      // Queued work has not reached the provider and can be cancelled outright, with its credits returned.
      const cancelled = await deps.store.update("render_jobs", { id, org_id: ctx.org.id, state: "queued" }, { state: "cancelled", updated_at: now });
      if (cancelled.length) {
        await releaseCredits(deps, cancelled[0]);
        await deps.store.update("content_items", { id: job.item_id, org_id: ctx.org.id, status: "queued" }, { status: "draft" });
        await event(deps, ctx.org.id, id, "cancelled", { by: ctx.actorId });
        affected.push(id);
        continue;
      }
      // Running work is only *requested* to stop; the renderer confirms the real outcome.
      const requested = await deps.store.update("render_jobs", { id, org_id: ctx.org.id, state: "running" }, { state: "cancel_requested", updated_at: now });
      if (requested.length) {
        await event(deps, ctx.org.id, id, "cancel_requested", { by: ctx.actorId });
        affected.push(id);
      }
    }
    return parse(operationSchema, { operationId: input.operationKey, state: affected.length ? "accepted" : "completed", jobIds: affected, nextPollAfterMs: 5000, reviewUrl: null });
  });
}

/* ───────────────────────── job read model (UI polling and MCP) ───────────────────────── */

export async function getRenderStatus(deps: EngineDeps, ctx: Ctx, jobId: string) {
  requireScope(ctx, "campaign:read");
  const job = await selectOne(deps.store, "render_jobs", { id: jobId, org_id: ctx.org.id });
  if (!job) throw new EngineError("not_found", "This render job was not found in your workspace.");
  const events = await deps.store.select("job_events", { org_id: ctx.org.id, job_id: jobId }, { order: ["at", "asc"], limit: 50 });
  return {
    renderJobId: job.id,
    itemId: job.item_id,
    projectId: job.project_id,
    revision: job.revision,
    status: job.state as string,
    provider: job.provider as string,
    providerStatus: (job.provider_status ?? null) as string | null,
    providerJobId: (job.provider_job_id ?? null) as string | null,
    mediaAssetId: (job.media_asset_id ?? null) as string | null,
    error: (job.error ?? null) as { code: string; message: string } | null,
    creditsHeld: job.credits_reserved as number,
    createdAt: new Date(job.created_at).toISOString(),
    updatedAt: new Date(job.updated_at).toISOString(),
    events: events.map((entry) => ({ at: new Date(entry.at).toISOString(), type: entry.type as string })),
  };
}

/* ───────────────────────── failure, timeouts ───────────────────────── */

async function fail(deps: EngineDeps, job: Row, from: string[], code: "provider_unavailable" | "validation_error" | "unsupported" | "quota_exceeded", message: string, state: "failed" | "cancelled" = "failed") {
  const now = deps.now().toISOString();
  const updated = await deps.store.update("render_jobs", { id: job.id, state: { in: from } }, { state, error: state === "failed" ? { code, message, retryAfterSeconds: null, reviewUrl: null } : null, updated_at: now });
  if (!updated.length) return false;
  await releaseCredits(deps, updated[0]);
  // Only reset the card if it still shows this job's revision; a newer edit owns the status otherwise.
  await deps.store.update("content_items", { id: job.item_id, org_id: job.org_id, revision: job.revision, status: { in: ["queued", "rendering"] } }, { status: state === "failed" ? "failed" : "draft" });
  await event(deps, job.org_id, job.id, state, { code, message });
  return true;
}

/** No infinite spinners: work nobody claimed, or a renderer that went silent, fails visibly and refunds its hold. */
export async function sweepRenderJobs(deps: EngineDeps, scope: { orgId?: string } = {}) {
  const now = deps.now().getTime();
  const filter: Filter = scope.orgId ? { org_id: scope.orgId } : {};
  const queuedBefore = new Date(now - deps.config.renderQueueTimeoutMinutes * 60_000).toISOString();
  const runningBefore = new Date(now - deps.config.renderRunTimeoutMinutes * 60_000).toISOString();
  let swept = 0;
  for (const job of await deps.store.select("render_jobs", { ...filter, state: "queued", created_at: { lt: queuedBefore } }, { limit: 50 }))
    if (await fail(deps, job, ["queued"], "provider_unavailable", "No renderer picked this job up in time. Your credits were returned; try again when rendering is available.")) swept++;
  for (const job of await deps.store.select("render_jobs", { ...filter, state: { in: ["running", "cancel_requested"] }, updated_at: { lt: runningBefore } }, { limit: 50 }))
    if (await fail(deps, job, ["running", "cancel_requested"], "provider_unavailable", "The renderer stopped reporting progress. Your credits were returned; the job can be requested again.")) swept++;
  return swept;
}

/* ───────────────────────── renderer worker protocol ───────────────────────── */

export function authenticateWorker(deps: EngineDeps, authorization: string | null): string {
  // Digest-then-compare: constant time, and the configured token's length is not observable either.
  if (!bearerMatches(authorization, deps.config.renderWorkerToken)) throw new EngineError("unauthenticated", "A render worker credential is required.");
  return "render-worker";
}

const claimSchema = z.object({ workerId: z.string().min(1).max(80) }).strict();
const progressSchema = z.object({ providerStatus: z.string().min(1).max(120), providerJobId: z.string().min(1).max(200).optional() }).strict();
const completeSchema = z
  .object({ durationSeconds: z.number().positive().max(3600), hasAudio: z.boolean(), width: z.number().int().positive().max(8192).optional(), height: z.number().int().positive().max(8192).optional(), providerJobId: z.string().min(1).max(200).optional() })
  .strict();
const failSchema = z.object({ code: z.enum(["provider_unavailable", "validation_error", "unsupported", "quota_exceeded"]), message: z.string().min(1).max(500) }).strict();

function mediaPath(job: Row, extension: string) {
  return `${job.org_id}/${job.item_id}/r${job.revision}-${job.id}.${extension}`;
}
async function workerJob(deps: EngineDeps, jobId: string): Promise<Row> {
  const job = await selectOne(deps.store, "render_jobs", { id: jobId });
  if (!job) throw new EngineError("not_found", "Unknown render job.");
  return job;
}

export async function workerClaim(deps: EngineDeps, raw: unknown) {
  const input = parse(claimSchema, raw);
  await sweepRenderJobs(deps);
  for (const candidate of await deps.store.select("render_jobs", { state: "queued" }, { order: ["created_at", "asc"], limit: 5 })) {
    const now = deps.now().toISOString();
    const claimed = await deps.store.update("render_jobs", { id: candidate.id, state: "queued" }, { state: "running", claimed_by: input.workerId, claimed_at: now, attempt: candidate.attempt + 1, updated_at: now });
    if (!claimed.length) continue; // another worker won this job
    const job = claimed[0];
    await deps.store.update("content_items", { id: job.item_id, org_id: job.org_id, revision: job.revision, status: "queued" }, { status: "rendering" });
    await event(deps, job.org_id, job.id, "claimed", { workerId: input.workerId, attempt: job.attempt });
    return { job: { id: job.id, itemId: job.item_id, revision: job.revision, avatarId: job.avatar_id, script: job.script, language: job.language, settings: job.settings, attempt: job.attempt, correlationId: job.correlation_id } };
  }
  return { job: null };
}

export async function workerProgress(deps: EngineDeps, jobId: string, raw: unknown) {
  const input = parse(progressSchema, raw);
  const job = await workerJob(deps, jobId);
  const updated = await deps.store.update("render_jobs", { id: job.id, state: { in: ["running", "cancel_requested"] } }, { provider_status: input.providerStatus, provider_job_id: input.providerJobId ?? job.provider_job_id, updated_at: deps.now().toISOString() });
  if (!updated.length) throw new EngineError("revision_conflict", "This job is no longer running.");
  await event(deps, job.org_id, job.id, "progress", { providerStatus: input.providerStatus });
  // The worker learns about a human cancellation on its next heartbeat.
  return { cancelRequested: updated[0].state === "cancel_requested" };
}

export async function workerUploadUrl(deps: EngineDeps, jobId: string, raw: unknown) {
  const { mime } = parse(z.object({ mime: z.enum(["video/mp4", "video/webm"]) }).strict(), raw);
  const job = await workerJob(deps, jobId);
  if (job.state !== "running") throw new EngineError("revision_conflict", "This job is not running.");
  const path = mediaPath(job, ACCEPTED_MEDIA[mime]);
  const { url, token } = await deps.store.media.createUploadUrl(path);
  return { uploadUrl: url, token, path, method: "PUT", headers: { "Content-Type": mime } };
}

export async function workerComplete(deps: EngineDeps, jobId: string, raw: unknown) {
  const input = parse(completeSchema, raw);
  const job = await workerJob(deps, jobId);
  if (job.state === "succeeded") return { state: "succeeded", mediaAssetId: job.media_asset_id }; // replayed completion
  if (job.state !== "running") throw new EngineError("revision_conflict", `This job is ${job.state}; it cannot be completed.`);
  // Success requires a real stored object. The path is derived server-side, never taken from the worker.
  let found: { path: string; mime: string; bytes: number } | null = null;
  for (const [mime, extension] of Object.entries(ACCEPTED_MEDIA)) {
    const path = mediaPath(job, extension);
    const stat = await deps.store.media.stat(path);
    if (stat) found = { path, mime, bytes: stat.bytes };
  }
  if (!found) throw new EngineError("validation_error", "No uploaded media was found for this job. Upload the file before reporting completion.");
  if (found.bytes <= 0 || found.bytes > MAX_MEDIA_BYTES) throw new EngineError("validation_error", "The uploaded media is empty or too large.");
  const sha256 = await deps.store.media.sha256(found.path);
  const now = deps.now().toISOString();
  const assetId = crypto.randomUUID();
  try {
    await deps.store.insert("media_assets", {
      id: assetId,
      org_id: job.org_id,
      item_id: job.item_id,
      revision: job.revision,
      storage_path: found.path,
      mime: found.mime,
      bytes: found.bytes,
      sha256,
      duration_seconds: input.durationSeconds,
      has_audio: input.hasAudio,
      width: input.width ?? null,
      height: input.height ?? null,
      origin: "render",
      provider: job.provider,
      render_job_id: job.id,
      created_at: now,
    });
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
  }
  const asset = (await selectOne(deps.store, "media_assets", { storage_path: found.path }))!;
  const done = await deps.store.update("render_jobs", { id: job.id, state: "running" }, { state: "succeeded", media_asset_id: asset.id, provider_job_id: input.providerJobId ?? job.provider_job_id, provider_status: "completed", credits_settled: true, updated_at: now });
  if (!done.length) throw new EngineError("revision_conflict", "This job changed state while completing.");
  // Attach the file. It only counts as the item's current render if no render-affecting edit happened since.
  const item = await selectOne(deps.store, "content_items", { id: job.item_id, org_id: job.org_id });
  if (item) {
    const later = await deps.store.select("content_versions", { org_id: job.org_id, item_id: item.id, revision: { gte: job.revision + 1 }, affects_render: true }, { limit: 1 });
    const current = later.length === 0;
    await deps.store.update("content_items", { id: item.id, org_id: job.org_id }, current ? { media_asset_id: asset.id, render_revision: job.revision, status: "ready", updated_at: now } : { media_asset_id: item.media_asset_id ?? asset.id });
  }
  await event(deps, job.org_id, job.id, "succeeded", { mediaAssetId: asset.id, bytes: found.bytes, sha256 });
  await deps.store.insert("audit_events", { id: crypto.randomUUID(), org_id: job.org_id, project_id: job.project_id, actor: "Humanlike renderer", actor_kind: "system", action: "Rendered video stored", object_id: job.item_id, revision: job.revision, outcome: `Playable ${found.mime} · ${input.durationSeconds.toFixed(1)}s`, correlation_id: job.correlation_id, at: now });
  return { state: "succeeded", mediaAssetId: asset.id };
}

export async function workerFail(deps: EngineDeps, jobId: string, raw: unknown) {
  const input = parse(failSchema, raw);
  const job = await workerJob(deps, jobId);
  if (job.state === "cancel_requested") {
    await fail(deps, job, ["cancel_requested"], input.code, input.message, "cancelled");
    return { state: "cancelled" };
  }
  if (!(await fail(deps, job, ["running"], input.code, input.message))) throw new EngineError("revision_conflict", `This job is ${job.state}; it cannot be failed.`);
  return { state: "failed" };
}
