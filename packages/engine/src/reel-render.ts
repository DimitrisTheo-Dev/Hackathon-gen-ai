import { z } from "zod";
import {
  compositionSchema,
  queueRenderInputSchema,
  reelRenderSchema,
  referencedFileIds,
  type ReelRender,
  type ResolvedMedia,
} from "../../contracts/src/index.js";
import { audit, bearerMatches, idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { COMPOSITIONS_TABLE } from "./composition.js";
import { EngineError } from "./errors.js";
import { FILES_TABLE, fileContract, fileKey, filesOf, resolveFiles } from "./files.js";
import { selectOne, type Row } from "./store.js";
import { loadItem, parse } from "./studio.js";

/**
 * Reel renders: a queue of saved timelines that Remotion render workers claim, render to MP4 and
 * upload back as a `render` draft file. Any number of workers (VPS, boxd machines, containers) can
 * poll; a lease makes sure each job is rendered by one worker at a time, and a dead worker's job
 * is picked up again. Workers never see a database credential, only one job and its signed links.
 */
export const RENDERS_TABLE = "reel_renders";
const LEASE_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 3;
const MAX_ACTIVE_PER_ORG = 3;
/** Links handed to a worker must outlive a long render. */
const WORKER_URL_TTL = 3 * 3600;
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const iso = (value: string | Date) => new Date(value).toISOString();

async function renderContract(deps: EngineDeps, row: Row): Promise<ReelRender> {
  const output = row.output_file_id ? await selectOne(deps.store, FILES_TABLE, { id: row.output_file_id, org_id: row.org_id }) : null;
  return parse(reelRenderSchema, {
    id: row.id,
    itemId: row.item_id,
    compositionRevision: row.composition_revision,
    state: row.state,
    progress: Number(row.progress ?? 0),
    workerId: row.worker_id ?? null,
    error: row.error ?? null,
    outputFile: output ? await fileContract(deps, output) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

/** Jobs no worker ever claimed, or whose worker kept dying, end with a reason instead of spinning forever. */
async function sweep(deps: EngineDeps, filter: Row) {
  const now = deps.now();
  const queuedBefore = new Date(now.getTime() - deps.config.renderQueueTimeoutMinutes * 60_000).toISOString();
  await deps.store.update(RENDERS_TABLE, { ...filter, state: "queued", created_at: { lt: queuedBefore } }, {
    state: "failed",
    error: `No render worker picked this up within ${deps.config.renderQueueTimeoutMinutes} minutes. Check that a worker is running, then render again.`,
    updated_at: now.toISOString(),
  });
  await deps.store.update(RENDERS_TABLE, { ...filter, state: "rendering", attempts: { gte: MAX_ATTEMPTS }, lease_expires_at: { lt: now.toISOString() } }, {
    state: "failed",
    error: "The render stopped responding three times. Check the worker logs, then render again.",
    updated_at: now.toISOString(),
  });
}

export async function queueRender(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<ReelRender> {
  requireScope(ctx, "render:write");
  requireScope(ctx, "campaign:read");
  const input = parse(queueRenderInputSchema, raw);
  return idempotent(deps, ctx, "queue_reel_render", input.operationKey, input, async () => {
    const item = await loadItem(deps, ctx, input.contentId);
    const saved = await selectOne(deps.store, COMPOSITIONS_TABLE, { org_id: ctx.org.id, item_id: item.id });
    if (!saved) throw new EngineError("validation_error", "Save the video edit before rendering it.");
    if (saved.revision !== input.expectedRevision)
      throw new EngineError("revision_conflict", "The video edit changed after you opened it. Reload it, check it, then render.");
    const composition = parse(compositionSchema, saved.composition);
    await sweep(deps, { org_id: ctx.org.id });
    const active = await deps.store.select(RENDERS_TABLE, { org_id: ctx.org.id, state: { in: ["queued", "rendering"] } });
    if (active.length >= MAX_ACTIVE_PER_ORG) throw new EngineError("quota_exceeded", `Up to ${MAX_ACTIVE_PER_ORG} renders can wait or run at once in a workspace. Wait for one to finish.`);
    const now = deps.now().toISOString();
    const row = await deps.store.insert(RENDERS_TABLE, {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      project_id: item.project_id,
      item_id: item.id,
      composition_revision: saved.revision,
      // A snapshot: later edits never change what this job renders.
      composition,
      state: "queued",
      progress: 0,
      worker_id: null,
      lease_expires_at: null,
      attempts: 0,
      output_file_id: null,
      error: null,
      created_by: ctx.actorId,
      created_at: now,
      updated_at: now,
    });
    await audit(deps, ctx, { projectId: item.project_id, action: "Queued a video render", objectId: item.id, revision: saved.revision, outcome: deps.config.reelWorkerToken ? "Waiting for a render worker" : "Waiting; no render worker is connected yet" });
    return renderContract(deps, row);
  });
}

export async function listRenders(deps: EngineDeps, ctx: Ctx, itemId: string): Promise<ReelRender[]> {
  requireScope(ctx, "campaign:read");
  const item = await loadItem(deps, ctx, itemId);
  await sweep(deps, { org_id: ctx.org.id, item_id: item.id });
  const rows = await deps.store.select(RENDERS_TABLE, { org_id: ctx.org.id, item_id: item.id }, { order: ["created_at", "desc"], limit: 20 });
  return Promise.all(rows.map((row) => renderContract(deps, row)));
}

export const cancelRenderInputSchema = z.object({ renderId: z.string().min(1).max(160), operationKey: z.uuid() }).strict();
export async function cancelRender(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<ReelRender> {
  requireScope(ctx, "render:write");
  const input = parse(cancelRenderInputSchema, raw);
  return idempotent(deps, ctx, "cancel_reel_render", input.operationKey, input, async () => {
    const row = await selectOne(deps.store, RENDERS_TABLE, { id: input.renderId, org_id: ctx.org.id });
    if (!row) throw new EngineError("not_found", "This render was not found in your workspace.");
    const [updated] = await deps.store.update(RENDERS_TABLE, { id: row.id, org_id: ctx.org.id, state: { in: ["queued", "rendering"] } }, { state: "cancelled", updated_at: deps.now().toISOString() });
    if (updated) await audit(deps, ctx, { projectId: row.project_id, action: "Cancelled a video render", objectId: row.item_id, revision: row.composition_revision, outcome: "Cancelled" });
    return renderContract(deps, updated ?? row);
  });
}

/* ───────────────────────── worker protocol ───────────────────────── */

export function authenticateReelWorker(deps: EngineDeps, authorization: string | null) {
  // Compared as SHA-256 digests (bearerMatches, like the avatar render worker), so the token's length does not leak through timing.
  if (!bearerMatches(authorization, deps.config.reelWorkerToken)) throw new EngineError("unauthenticated", "A reel render worker credential is required.");
}

const workerIdSchema = z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/);
const claimSchema = z.object({ workerId: workerIdSchema }).strict();
const progressSchema = z.object({ workerId: workerIdSchema, progress: z.number().min(0).max(1) }).strict();
const outputSchema = z.object({ workerId: workerIdSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().max(MAX_OUTPUT_BYTES) }).strict();
const completeSchema = outputSchema.extend({ durationSeconds: z.number().positive().max(3600) }).strict();
const failSchema = z.object({ workerId: workerIdSchema, error: z.string().min(1).max(500) }).strict();

async function itemMedia(deps: EngineDeps, orgId: string, itemId: string): Promise<ResolvedMedia | null> {
  const item = await selectOne(deps.store, "content_items", { id: itemId, org_id: orgId });
  if (!item?.media_asset_id) return null;
  const asset = await selectOne(deps.store, "media_assets", { id: item.media_asset_id, org_id: orgId });
  if (!asset) return null;
  const url = (await deps.store.media.signedUrls([asset.storage_path], WORKER_URL_TTL))[asset.storage_path];
  if (!url) return null;
  return { url, mime: asset.mime ?? "video/mp4", expiresAt: new Date(deps.now().getTime() + WORKER_URL_TTL * 1000).toISOString(), durationSeconds: Number(asset.duration_seconds), name: item.title };
}

/** Hands the oldest waiting job (or one whose worker went silent) to this worker, with everything it needs. */
export async function claimReelRender(deps: EngineDeps, raw: unknown) {
  const { workerId } = parse(claimSchema, raw);
  const now = deps.now();
  await sweep(deps, {});
  const candidates = [
    ...(await deps.store.select(RENDERS_TABLE, { state: "queued" }, { order: ["created_at", "asc"], limit: 5 })),
    ...(await deps.store.select(RENDERS_TABLE, { state: "rendering", lease_expires_at: { lt: now.toISOString() }, attempts: { lt: MAX_ATTEMPTS } }, { order: ["created_at", "asc"], limit: 5 })),
  ];
  for (const candidate of candidates) {
    // Compare-and-swap on state, worker and attempts: two workers polling at once never get the same job.
    const [job] = await deps.store.update(
      RENDERS_TABLE,
      { id: candidate.id, state: candidate.state, attempts: candidate.attempts, worker_id: candidate.worker_id ?? null },
      { state: "rendering", worker_id: workerId, attempts: candidate.attempts + 1, progress: 0, lease_expires_at: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(), updated_at: now.toISOString() },
    );
    if (!job) continue;
    const composition = parse(compositionSchema, job.composition);
    return {
      job: {
        id: job.id,
        campaignId: job.project_id,
        itemId: job.item_id,
        compositionRevision: job.composition_revision,
        attempt: job.attempts,
        leaseSeconds: LEASE_SECONDS,
        composition,
        itemMedia: await itemMedia(deps, job.org_id, job.item_id),
        files: await resolveFiles(deps, job.org_id, job.project_id, referencedFileIds(composition), WORKER_URL_TTL),
      },
    };
  }
  return { job: null };
}

async function ownJob(deps: EngineDeps, jobId: string, workerId: string) {
  const job = await selectOne(deps.store, RENDERS_TABLE, { id: jobId });
  if (!job || job.worker_id !== workerId) throw new EngineError("not_found", "This render is not assigned to this worker.");
  if (job.state !== "rendering") throw new EngineError("revision_conflict", job.state === "cancelled" ? "This render was cancelled. Stop working on it." : "This render is no longer running.");
  return job;
}

export async function reelRenderProgress(deps: EngineDeps, jobId: string, raw: unknown) {
  const input = parse(progressSchema, raw);
  const job = await ownJob(deps, jobId, input.workerId);
  const now = deps.now();
  await deps.store.update(RENDERS_TABLE, { id: job.id, worker_id: input.workerId, state: "rendering" }, {
    progress: Math.max(Number(job.progress ?? 0), input.progress),
    lease_expires_at: new Date(now.getTime() + LEASE_SECONDS * 1000).toISOString(),
    updated_at: now.toISOString(),
  });
  return { ok: true as const, leaseSeconds: LEASE_SECONDS };
}

export async function reelRenderUploadUrl(deps: EngineDeps, jobId: string, raw: unknown) {
  const input = parse(outputSchema, raw);
  const job = await ownJob(deps, jobId, input.workerId);
  const key = fileKey(job.org_id, job.project_id, input.sha256, "video/mp4");
  const { url, headers } = await filesOf(deps).uploadUrl(key, { sha256Hex: input.sha256, contentType: "video/mp4", bytes: input.bytes, expiresSeconds: 30 * 60 });
  return { url, method: "PUT" as const, headers };
}

export async function completeReelRender(deps: EngineDeps, jobId: string, raw: unknown) {
  const input = parse(completeSchema, raw);
  const job = await ownJob(deps, jobId, input.workerId);
  const key = fileKey(job.org_id, job.project_id, input.sha256, "video/mp4");
  const stored = await filesOf(deps).head(key);
  if (!stored) throw new EngineError("validation_error", "The rendered file has not arrived. Upload it, then complete the job.");
  if (stored.bytes !== input.bytes) throw new EngineError("validation_error", "The stored render's size does not match. Upload it again.");
  const item = await selectOne(deps.store, "content_items", { id: job.item_id, org_id: job.org_id });
  const name = `${item?.title ?? "Video"} render`;
  const now = deps.now().toISOString();
  const previous = await deps.store.select(FILES_TABLE, { org_id: job.org_id, project_id: job.project_id, item_id: job.item_id, name }, { order: ["version", "desc"], limit: 1 });
  const file = await deps.store.insert(FILES_TABLE, {
    id: crypto.randomUUID(),
    org_id: job.org_id,
    project_id: job.project_id,
    item_id: job.item_id,
    kind: "render",
    name,
    mime: "video/mp4",
    bytes: input.bytes,
    sha256: input.sha256,
    duration_seconds: input.durationSeconds,
    meta: { renderId: job.id, compositionRevision: job.composition_revision, workerId: input.workerId, renderer: "remotion" },
    state: "ready",
    version: (previous[0]?.version ?? 0) + 1,
    storage_key: key,
    created_by: `Render worker ${input.workerId}`,
    actor_id: `worker:${input.workerId}`,
    created_at: now,
    updated_at: now,
  });
  const [done] = await deps.store.update(RENDERS_TABLE, { id: job.id, worker_id: input.workerId, state: "rendering" }, { state: "succeeded", progress: 1, output_file_id: file.id, lease_expires_at: null, updated_at: now });
  if (!done) throw new EngineError("revision_conflict", "This render is no longer running.");
  await deps.store.insert("audit_events", {
    id: crypto.randomUUID(),
    org_id: job.org_id,
    project_id: job.project_id,
    actor: `Render worker ${input.workerId}`,
    actor_kind: "system",
    action: "Rendered the video edit",
    object_id: job.item_id,
    revision: job.composition_revision,
    outcome: `${Math.round(input.durationSeconds * 10) / 10} s MP4 saved as a draft file`,
    correlation_id: null,
    at: now,
  });
  return { ok: true as const, fileId: file.id };
}

export async function failReelRender(deps: EngineDeps, jobId: string, raw: unknown) {
  const input = parse(failSchema, raw);
  const job = await ownJob(deps, jobId, input.workerId);
  await deps.store.update(RENDERS_TABLE, { id: job.id, worker_id: input.workerId, state: "rendering" }, { state: "failed", error: input.error, lease_expires_at: null, updated_at: deps.now().toISOString() });
  return { ok: true as const };
}

export async function reelWorker(deps: EngineDeps, request: Request, path: string, body: () => Promise<unknown>): Promise<unknown> {
  authenticateReelWorker(deps, request.headers.get("authorization"));
  if (request.method !== "POST") throw new EngineError("not_found", "Unknown worker route.");
  if (path === "/claim") return claimReelRender(deps, await body());
  const match = path.match(/^\/([^/]+)\/(progress|upload-url|complete|fail)$/);
  if (!match) throw new EngineError("not_found", "Unknown worker route.");
  const [, jobId, action] = match;
  const payload = await body();
  if (action === "progress") return reelRenderProgress(deps, jobId, payload);
  if (action === "upload-url") return reelRenderUploadUrl(deps, jobId, payload);
  if (action === "complete") return completeReelRender(deps, jobId, payload);
  return failReelRender(deps, jobId, payload);
}
