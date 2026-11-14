import { z } from "zod";
import { manifestSchema, operationSchema, type Operation, type Platform, type ScheduleManifest } from "../../contracts/src/index.js";
import { audit, canonical, idempotent, requireHuman, requireScope, sha256Hex, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import { selectOne, type Row } from "./store.js";
import { loadProject, parse } from "./studio.js";

/**
 * Publishing is four separate facts, never collapsed into one status:
 *   proposal (draft times on items) → manifest (exact, hashed) → human approval → publish jobs.
 * A publish job then moves SCHEDULED → PROCESSING → SUBMITTED → VERIFIED_PUBLISHED | FAILED.
 * "Submitted" means a provider accepted the request; only provider evidence makes it "published".
 */
export interface Publisher {
  /** Submit one approved post. Must be idempotent on `attemptKey`. */
  publish(input: { attemptKey: string; credentials: string | null; mediaUrl: string; payload: Row; scheduledAt: string }): Promise<{ providerPostId: string; state: "submitted" | "verified_published"; url: string | null }>;
}
/** No destination has approved API access in this build, so no adapter is registered. See DEMO_READINESS.md. */
export const publishers: Partial<Record<Platform, Publisher>> = {};

export const prepareInputSchema = z.object({ campaignId: z.string().min(1).max(160), expectedRevision: z.number().int().positive(), operationKey: z.uuid() }).strict();
export const manifestInputSchema = z.object({ manifestId: z.string().min(1).max(160), hash: z.string().min(1).max(200), operationKey: z.uuid() }).strict();

function manifestContract(row: Row): ScheduleManifest {
  return parse(manifestSchema, {
    id: row.id,
    campaignId: row.project_id,
    campaignRevision: row.project_revision,
    hash: row.hash,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
    reviewUrl: `/studio/?view=schedule&campaign=${row.project_id}`,
    approval: row.state === "required" ? "required" : row.state === "stale" ? "stale" : "approved",
    entries: row.entries,
    blockers: row.blockers,
  });
}

export async function prepareSchedule(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<ScheduleManifest> {
  requireScope(ctx, "schedule:prepare");
  const input = parse(prepareInputSchema, raw);
  return idempotent(deps, ctx, "prepare_schedule", input.operationKey, input, async () => {
    const project = await loadProject(deps, ctx, input.campaignId);
    if (project.revision !== input.expectedRevision) throw new EngineError("revision_conflict", "The campaign changed. Refresh it before preparing the schedule.");
    const [items, accounts] = await Promise.all([
      deps.store.select("content_items", { org_id: ctx.org.id, project_id: project.id }, { order: ["position", "asc"] }),
      deps.store.select("provider_connections", { org_id: ctx.org.id }),
    ]);
    const assetIds = items.map((item) => item.media_asset_id).filter(Boolean) as string[];
    const assets = assetIds.length ? await deps.store.select("media_assets", { org_id: ctx.org.id, id: { in: assetIds } }) : [];
    const entries: Row[] = [];
    const blockers: Array<{ itemId: string; message: string }> = [];
    const now = deps.now().getTime();
    for (const item of items) {
      const asset = assets.find((entry) => entry.id === item.media_asset_id);
      const rendered = asset && item.render_revision !== null && asset.revision === item.render_revision;
      if (!rendered) blockers.push({ itemId: item.id, message: asset ? "The video is out of date for this script. Render the current version first." : "No finished video yet. Render this item before scheduling it." });
      const targets = item.targets as Row[];
      if (!targets.length) blockers.push({ itemId: item.id, message: "No destination or time has been chosen." });
      for (const target of targets) {
        const platform = target.platform as Platform;
        const variant = (item.variants as Row[]).find((entry) => entry.platform === platform);
        const account = accounts.find((entry) => entry.id === target.accountId && entry.platform === platform);
        if (!publishers[platform]) {
          blockers.push({ itemId: item.id, message: `Publishing to ${platform} is not connected in this build. The schedule can be drafted, but nothing can be posted there yet.` });
          continue;
        }
        if (!account || account.state !== "connected") {
          blockers.push({ itemId: item.id, message: `Connect a ${platform} account before scheduling there.` });
          continue;
        }
        if (!variant) {
          blockers.push({ itemId: item.id, message: `Add ${platform} copy before scheduling there.` });
          continue;
        }
        if (new Date(target.scheduledAt).getTime() <= now + 60_000) {
          blockers.push({ itemId: item.id, message: `The ${platform} time is in the past. Choose a future time.` });
          continue;
        }
        if (!rendered) continue;
        entries.push({
          itemId: item.id,
          revision: item.revision,
          assetId: asset.id,
          assetHash: asset.sha256,
          platform,
          accountId: account.id,
          scheduledAt: new Date(target.scheduledAt).toISOString(),
          timezone: target.timezone,
          caption: variant.caption,
          title: variant.title,
          visibility: variant.visibility,
          aiDisclosure: variant.aiDisclosure,
        });
      }
    }
    const createdAt = deps.now();
    const row = await deps.store.insert("schedule_manifests", {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      project_id: project.id,
      project_revision: project.revision,
      // The hash binds approval to these exact versions, files, accounts, times and copy.
      hash: sha256Hex(canonical({ projectId: project.id, revision: project.revision, entries })),
      entries,
      blockers,
      state: "required",
      approved_by: null,
      approved_at: null,
      expires_at: new Date(createdAt.getTime() + 15 * 60_000).toISOString(),
      created_by: ctx.actorId,
      created_at: createdAt.toISOString(),
    });
    await audit(deps, ctx, { projectId: project.id, action: "Prepared a schedule for review", objectId: row.id, revision: project.revision, outcome: `${entries.length} ready · ${blockers.length} blocker${blockers.length === 1 ? "" : "s"}` });
    return manifestContract(row);
  });
}

async function currentManifest(deps: EngineDeps, ctx: Ctx, input: { manifestId: string; hash: string }) {
  const manifest = await selectOne(deps.store, "schedule_manifests", { id: input.manifestId, org_id: ctx.org.id });
  if (!manifest) throw new EngineError("not_found", "This schedule review was not found in your workspace.");
  if (manifest.hash !== input.hash) throw new EngineError("stale_manifest", "This is not the schedule you reviewed. Prepare and review it again.");
  const project = await loadProject(deps, ctx, manifest.project_id);
  if (manifest.state === "stale" || project.revision !== manifest.project_revision) {
    await deps.store.update("schedule_manifests", { id: manifest.id, org_id: ctx.org.id, state: { in: ["required", "approved"] } }, { state: "stale" });
    throw new EngineError("stale_manifest", "The campaign changed after this schedule was prepared. Review the new version before approving.");
  }
  return { manifest, project };
}

/** Approval is a human act on one exact manifest. An agent, or a forged flag in a request body, cannot perform it. */
export async function approveSchedule(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Operation> {
  const input = parse(manifestInputSchema, raw);
  if (ctx.principal.kind !== "human") {
    const pending = await selectOne(deps.store, "schedule_manifests", { id: input.manifestId, org_id: ctx.org.id });
    throw new EngineError("approval_required", "Publishing needs approval from a signed-in workspace member. Open the review link to approve this exact schedule.", {
      reviewUrl: pending ? `/studio/?view=schedule&campaign=${pending.project_id}` : "/studio/?view=schedule",
    });
  }
  requireHuman(ctx, "Approving a schedule");
  requireScope(ctx, "schedule:approve");
  return idempotent(deps, ctx, "approve_schedule", input.operationKey, input, async () => {
    const { manifest, project } = await currentManifest(deps, ctx, input);
    if (manifest.state === "committed") return parse(operationSchema, { operationId: input.operationKey, state: "completed", jobIds: [], nextPollAfterMs: 60000, reviewUrl: null });
    if (new Date(manifest.expires_at) <= deps.now()) throw new EngineError("stale_manifest", "This review expired. Prepare the schedule again.");
    if ((manifest.blockers as unknown[]).length) throw new EngineError("approval_required", "This schedule still has blockers. Resolve them before approving.");
    if (!(manifest.entries as unknown[]).length) throw new EngineError("validation_error", "There is nothing to approve in this schedule.");
    const now = deps.now().toISOString();
    const approved = await deps.store.update("schedule_manifests", { id: manifest.id, org_id: ctx.org.id, state: { in: ["required", "approved"] } }, { state: "approved", approved_by: (ctx.principal as { userId: string }).userId, approved_at: now });
    if (!approved.length) throw new EngineError("stale_manifest", "This schedule changed while approving. Review it again.");
    for (const entry of manifest.entries as Row[]) await deps.store.update("content_items", { id: entry.itemId, org_id: ctx.org.id, revision: entry.revision }, { approved_revision: entry.revision });
    await audit(deps, ctx, { projectId: project.id, action: "Approved the exact schedule", objectId: manifest.id, revision: project.revision, outcome: `${(manifest.entries as unknown[]).length} destination(s) approved · hash ${String(manifest.hash).slice(0, 12)}` });
    return parse(operationSchema, { operationId: input.operationKey, state: "completed", jobIds: [], nextPollAfterMs: 60000, reviewUrl: null });
  });
}

export async function commitSchedule(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Operation> {
  requireScope(ctx, "schedule:commit");
  const input = parse(manifestInputSchema, raw);
  return idempotent(deps, ctx, "commit_schedule", input.operationKey, input, async () => {
    const { manifest, project } = await currentManifest(deps, ctx, input);
    if (manifest.state === "required") throw new EngineError("approval_required", "Approve this schedule before it can be committed.", { reviewUrl: `/studio/?view=schedule&campaign=${project.id}` });
    const now = deps.now().toISOString();
    const jobIds: string[] = [];
    for (const entry of manifest.entries as Row[]) {
      const identity = { item_id: entry.itemId, revision: entry.revision, platform: entry.platform, account_id: entry.accountId, scheduled_at: entry.scheduledAt };
      try {
        const job = await deps.store.insert("publish_jobs", {
          id: crypto.randomUUID(),
          org_id: ctx.org.id,
          project_id: project.id,
          manifest_id: manifest.id,
          ...identity,
          media_asset_id: entry.assetId,
          timezone: entry.timezone,
          payload: { caption: entry.caption, title: entry.title, visibility: entry.visibility, aiDisclosure: entry.aiDisclosure, assetHash: entry.assetHash },
          state: "scheduled",
          attempt: 0,
          next_attempt_at: null,
          provider_post_id: null,
          published_url: null,
          published_at: null,
          error: null,
          created_at: now,
          updated_at: now,
        });
        jobIds.push(job.id);
      } catch (error) {
        // The same publication intent already exists (retry, or a recreated approval): never post twice.
        if (!(error instanceof StoreConflict)) throw error;
        const existing = await selectOne(deps.store, "publish_jobs", { org_id: ctx.org.id, ...identity });
        if (existing) jobIds.push(existing.id);
      }
    }
    await deps.store.update("schedule_manifests", { id: manifest.id, org_id: ctx.org.id }, { state: "committed" });
    await audit(deps, ctx, { projectId: project.id, action: "Scheduled approved posts", objectId: manifest.id, revision: project.revision, outcome: `${jobIds.length} publish job(s) scheduled` });
    return parse(operationSchema, { operationId: input.operationKey, state: "accepted", jobIds, nextPollAfterMs: 30000, reviewUrl: null });
  });
}

const BACKOFF_MINUTES = [1, 5, 15, 60];

/** Due-job worker, driven by the scheduler tick. Each job is claimed by compare-and-swap, so two ticks cannot double-post. */
export async function processDuePublishJobs(deps: EngineDeps) {
  const nowIso = deps.now().toISOString();
  const due = await deps.store.select("publish_jobs", { state: "scheduled", scheduled_at: { lte: nowIso } }, { order: ["scheduled_at", "asc"], limit: 20 });
  const outcome = { processed: 0, submitted: 0, failed: 0, retried: 0 };
  for (const candidate of due) {
    if (candidate.next_attempt_at && new Date(candidate.next_attempt_at) > deps.now()) continue;
    const claimed = await deps.store.update("publish_jobs", { id: candidate.id, state: "scheduled" }, { state: "processing", attempt: candidate.attempt + 1, updated_at: nowIso });
    if (!claimed.length) continue;
    const job = claimed[0];
    outcome.processed++;
    const finish = async (patch: Row, type: string) => {
      await deps.store.update("publish_jobs", { id: job.id, state: "processing" }, { ...patch, updated_at: deps.now().toISOString() });
      await deps.store.insert("job_events", { id: crypto.randomUUID(), org_id: job.org_id, job_id: job.id, job_kind: "publish", type, detail: { attempt: job.attempt }, at: deps.now().toISOString() });
    };
    const publisher = publishers[job.platform as Platform];
    const [item, asset, account] = await Promise.all([
      selectOne(deps.store, "content_items", { id: job.item_id, org_id: job.org_id }),
      selectOne(deps.store, "media_assets", { id: job.media_asset_id, org_id: job.org_id }),
      selectOne(deps.store, "provider_connections", { id: job.account_id, org_id: job.org_id }),
    ]);
    // Re-validate at send time: only the approved version, with its approved file, on a still-connected account.
    if (!publisher) { await finish({ state: "failed", error: `No publishing adapter is connected for ${job.platform}.` }, "failed"); outcome.failed++; continue; }
    if (!item || item.approved_revision !== job.revision || !asset || asset.sha256 !== job.payload.assetHash) { await finish({ state: "failed", error: "The approved version or its video changed after approval. Review and approve again." }, "failed"); outcome.failed++; continue; }
    if (!account || account.state !== "connected") { await finish({ state: "failed", error: `The ${job.platform} account needs to be reconnected. The approved post was not sent.` }, "failed"); outcome.failed++; continue; }
    try {
      const mediaUrl = (await deps.store.media.signedUrls([asset.storage_path], 900))[asset.storage_path];
      if (!mediaUrl) throw new Error("media unavailable");
      const result = await publisher.publish({ attemptKey: job.id, credentials: account.credentials_ciphertext ?? null, mediaUrl, payload: job.payload, scheduledAt: new Date(job.scheduled_at).toISOString() });
      await finish({ state: result.state, provider_post_id: result.providerPostId, published_url: result.url, published_at: result.state === "verified_published" ? deps.now().toISOString() : null, error: null }, result.state);
      outcome.submitted++;
    } catch (error) {
      const transient = !(error instanceof EngineError) || error.code === "provider_unavailable" || error.code === "quota_exceeded";
      if (transient && job.attempt <= BACKOFF_MINUTES.length) {
        await finish({ state: "scheduled", next_attempt_at: new Date(deps.now().getTime() + BACKOFF_MINUTES[job.attempt - 1] * 60_000).toISOString(), error: "The provider was unavailable; this post will be retried." }, "retry_scheduled");
        outcome.retried++;
      } else {
        await finish({ state: "failed", error: error instanceof EngineError ? error.message : "The provider did not accept this post." }, "failed");
        outcome.failed++;
      }
    }
  }
  return outcome;
}

export const scheduleTargetSchema = z.object({ platform: z.enum(["instagram", "tiktok", "youtube"]), localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }).strict();
