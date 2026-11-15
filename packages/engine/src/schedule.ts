import { z } from "zod";
import { manifestSchema, operationSchema, type Operation, type Platform, type ScheduleManifest } from "../../contracts/src/index.js";
import { audit, canonical, idempotent, requireHuman, requireScope, sha256Hex, type Ctx, type EngineDeps } from "./access.js";
import { NOT_AVAILABLE_YET, youtubePublisher } from "./channels.js";
import { EngineError, StoreConflict } from "./errors.js";
import { ChannelGrantExpired, UnknownPublishOutcome } from "./providers/youtube.js";
import { accountPublisher, connectedThroughProvider, isSocialPlatform, publishingAvailable } from "./socials.js";
import { recordSocialEvents } from "./socials-events.js";
import { selectOne, type Filter, type Row } from "./store.js";
import { loadProject, parse } from "./studio.js";

/**
 * Publishing is four separate facts, never collapsed into one status:
 *   proposal (draft times on items) → manifest (exact, hashed) → human approval → publish jobs.
 * A publish job then moves SCHEDULED → PROCESSING → SUBMITTED → VERIFIED_PUBLISHED | FAILED.
 * "Submitted" means a provider accepted the request; only provider evidence makes it "published".
 * A job whose send has an unknown result stays PROCESSING and is failed by the sweep — never re-sent.
 */
export interface Publisher {
  /** True when the provider itself holds a post until its time, so the post is submitted as soon as the schedule is committed. */
  readonly schedulesNatively: boolean;
  /**
   * Submit one approved post. Throw `EngineError` when nothing was sent, `ChannelGrantExpired` when the
   * account must be reconnected, and `UnknownPublishOutcome` when a send started and its result is not known.
   */
  publish(input: { attemptKey: string; credentials: string | null; mediaUrl: string; mediaMime: string; itemTitle: string; payload: Row; scheduledAt: string }): Promise<{ providerPostId: string; state: "submitted" | "verified_published"; url: string | null }>;
  /**
   * Ask the provider what became of a submitted post. Only provider evidence may return `verified_published`.
   * `url`, when given, is where the post can be seen.
   */
  verify?(input: { credentials: string | null; providerPostId: string; scheduledAt: string; visibility: string }): Promise<{ state: "submitted" | "verified_published" | "failed"; publishedAt: string | null; note: string | null; url?: string | null }>;
}
/**
 * The publisher for one destination. An account connected through a social provider (Buffer, socials.ts) posts
 * through that provider, and only where connecting accounts is switched on. Otherwise the platform decides: the
 * one direct adapter is YouTube, and only when this deployment holds its OAuth client and an encryption key.
 * Instagram and TikTok have no direct adapter: both require platform app review first.
 */
export function publisherFor(deps: EngineDeps, platform: Platform, account?: Row | null): Publisher | null {
  if (connectedThroughProvider(account)) return accountPublisher(deps, account);
  return platform === "youtube" ? youtubePublisher(deps) : null;
}
/** The publisher for a job's own account. */
async function jobPublisher(deps: EngineDeps, job: Row) {
  const account = await selectOne(deps.store, "provider_connections", { id: job.account_id, org_id: job.org_id });
  return publisherFor(deps, job.platform as Platform, account);
}
const PLATFORM_NAME: Record<Platform, string> = { youtube: "YouTube", instagram: "Instagram", tiktok: "TikTok" };

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
        // Without a chosen account, a platform a social provider can reach asks for one instead of being blocked.
        if (!publisherFor(deps, platform, account) && (account || !publishingAvailable(deps, platform))) {
          // Identical wording per cause, so the review groups it once instead of repeating it per item.
          blockers.push({ itemId: item.id, message: platform === "youtube" ? `YouTube publishing is not set up on this deployment yet. The schedule can be drafted, but nothing can be posted there.` : NOT_AVAILABLE_YET });
          continue;
        }
        if (!account) {
          blockers.push({ itemId: item.id, message: `Connect a ${PLATFORM_NAME[platform]} channel and choose it for this item before scheduling there.` });
          continue;
        }
        if (account.state !== "connected") {
          blockers.push({ itemId: item.id, message: `Reconnect ${PLATFORM_NAME[platform]}: “${account.display_name}” no longer has access.` });
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
    // Destinations that hold a post until its time (YouTube `publishAt`) receive it now. Bounded per request;
    // anything left is picked up by the scheduler. Each job is claimed by compare-and-swap, so a repeated
    // commit, a second tab or the scheduler can never send the same post twice.
    let sent = 0;
    for (const id of jobIds) {
      if (sent >= MAX_NATIVE_SUBMISSIONS_PER_COMMIT) break;
      const job = await selectOne(deps.store, "publish_jobs", { id, org_id: ctx.org.id, state: "scheduled" });
      if (!job || !(await jobPublisher(deps, job))?.schedulesNatively) continue;
      if ((await processPublishJob(deps, job)) !== "skipped") sent++;
    }
    return parse(operationSchema, { operationId: input.operationKey, state: "accepted", jobIds, nextPollAfterMs: 30000, reviewUrl: null });
  });
}

const BACKOFF_MINUTES = [1, 5, 15, 60];
const MAX_NATIVE_SUBMISSIONS_PER_COMMIT = 3;
const PROCESSING_TIMEOUT_MINUTES = 15;

async function publishEvent(deps: EngineDeps, job: Row, type: string, detail: Row = {}) {
  await deps.store.insert("job_events", { id: crypto.randomUUID(), org_id: job.org_id, job_id: job.id, job_kind: "publish", type, detail: { attempt: job.attempt, ...detail }, at: deps.now().toISOString() });
}

/**
 * Sends one publish job. The job is claimed by compare-and-swap (scheduled → processing) first, so two
 * callers cannot both send it. Outcomes: submitted | failed | retried | unknown | skipped (not ours to send).
 */
export async function processPublishJob(deps: EngineDeps, candidate: Row): Promise<"submitted" | "failed" | "retried" | "unknown" | "skipped"> {
  if (candidate.next_attempt_at && new Date(candidate.next_attempt_at) > deps.now()) return "skipped";
  const claimed = await deps.store.update("publish_jobs", { id: candidate.id, state: "scheduled" }, { state: "processing", attempt: candidate.attempt + 1, updated_at: deps.now().toISOString() });
  if (!claimed.length) return "skipped";
  const job = claimed[0];
  const finish = async (patch: Row, type: string) => {
    await deps.store.update("publish_jobs", { id: job.id, state: "processing" }, { ...patch, updated_at: deps.now().toISOString() });
    await publishEvent(deps, job, type);
  };
  const platform = job.platform as Platform;
  const [item, asset, account] = await Promise.all([
    selectOne(deps.store, "content_items", { id: job.item_id, org_id: job.org_id }),
    selectOne(deps.store, "media_assets", { id: job.media_asset_id, org_id: job.org_id }),
    selectOne(deps.store, "provider_connections", { id: job.account_id, org_id: job.org_id }),
  ]);
  // The account decides how it is reached (directly, or through the provider it was connected with).
  const publisher = publisherFor(deps, platform, account);
  // Re-validate at send time: only the approved version, with its approved file, on a still-connected account.
  if (!item || item.approved_revision !== job.revision || !asset || asset.sha256 !== job.payload.assetHash) {
    await finish({ state: "failed", error: "The approved version or its video changed after approval. Review and approve again." }, "failed");
    return "failed";
  }
  if (!account || account.state !== "connected") {
    await finish({ state: "failed", error: `Reconnect ${PLATFORM_NAME[platform]}; the approved post was not sent.` }, "failed");
    return "failed";
  }
  if (!publisher) {
    await finish({ state: "failed", error: `No publishing adapter is connected for ${PLATFORM_NAME[platform]}.` }, "failed");
    return "failed";
  }
  try {
    // A provider such as Buffer fetches the file itself after accepting the post, and may take a while to start.
    // Signed for two hours so that at least one is left even when the store hands back a link it signed earlier.
    const mediaUrl = (await deps.store.media.signedUrls([asset.storage_path], 7200))[asset.storage_path];
    if (!mediaUrl) throw new EngineError("provider_unavailable", "The approved video could not be read from storage. Nothing was posted.");
    const result = await publisher.publish({ attemptKey: job.id, credentials: account.credentials_ciphertext ?? null, mediaUrl, mediaMime: asset.mime, itemTitle: item.title, payload: job.payload, scheduledAt: new Date(job.scheduled_at).toISOString() });
    await finish({ state: result.state, provider_post_id: result.providerPostId, published_url: result.url, published_at: result.state === "verified_published" ? deps.now().toISOString() : null, error: null }, result.state);
    await deps.store.insert("audit_events", { id: crypto.randomUUID(), org_id: job.org_id, project_id: job.project_id, actor: PLATFORM_NAME[platform], actor_kind: "system", action: `Approved post uploaded to ${PLATFORM_NAME[platform]}`, object_id: job.item_id, revision: job.revision, outcome: result.state === "verified_published" ? "Published" : `Accepted by ${PLATFORM_NAME[platform]} · not yet confirmed public`, correlation_id: job.id, at: deps.now().toISOString() });
    return "submitted";
  } catch (error) {
    if (error instanceof UnknownPublishOutcome) {
      // A send started and its result is unknown. Stay in "processing": retrying could post a duplicate.
      await publishEvent(deps, job, "unknown_outcome");
      return "unknown";
    }
    if (error instanceof ChannelGrantExpired) {
      await deps.store.update("provider_connections", { id: account.id, org_id: job.org_id }, { state: "expired", updated_at: deps.now().toISOString() });
      await finish({ state: "failed", error: error.message }, "failed");
      return "failed";
    }
    // Everything else thrown by a publisher is a definite "nothing was sent", so a transient failure may be retried.
    const transient = !(error instanceof EngineError) || error.code === "provider_unavailable" || error.code === "quota_exceeded";
    if (transient && job.attempt <= BACKOFF_MINUTES.length) {
      await finish({ state: "scheduled", next_attempt_at: new Date(deps.now().getTime() + BACKOFF_MINUTES[job.attempt - 1] * 60_000).toISOString(), error: "The provider was unavailable; this post will be retried." }, "retry_scheduled");
      return "retried";
    }
    await finish({ state: "failed", error: error instanceof EngineError ? error.message : "The provider did not accept this post." }, "failed");
    return "failed";
  }
}

/**
 * Asks the provider what became of submitted posts. `scope.minIntervalSeconds` throttles how often one job is
 * re-checked (its `updated_at` is the marker), so a studio that polls every few seconds costs one provider call
 * per job per interval at most.
 */
export async function verifySubmittedPublishJobs(deps: EngineDeps, scope: { orgId?: string; projectId?: string; minIntervalSeconds?: number; limit?: number } = {}) {
  const before = new Date(deps.now().getTime() - (scope.minIntervalSeconds ?? 0) * 1000).toISOString();
  const filter: Filter = { state: "submitted", updated_at: { lte: before }, ...(scope.orgId ? { org_id: scope.orgId } : {}), ...(scope.projectId ? { project_id: scope.projectId } : {}) };
  const outcome = { checked: 0, verified: 0, failed: 0 };
  for (const job of await deps.store.select("publish_jobs", filter, { order: ["updated_at", "asc"], limit: scope.limit ?? 20 })) {
    const account = await selectOne(deps.store, "provider_connections", { id: job.account_id, org_id: job.org_id });
    const publisher = publisherFor(deps, job.platform as Platform, account);
    if (!publisher?.verify || !job.provider_post_id) continue;
    const now = deps.now().toISOString();
    if (!account || account.state !== "connected") {
      // Without access we cannot ask. Say so, and leave the last confirmed state alone.
      await deps.store.update("publish_jobs", { id: job.id, state: "submitted" }, { error: `Reconnect ${PLATFORM_NAME[job.platform as Platform]} to confirm whether this post is public.`, updated_at: now });
      continue;
    }
    outcome.checked++;
    try {
      const result = await publisher.verify({ credentials: account.credentials_ciphertext ?? null, providerPostId: job.provider_post_id, scheduledAt: new Date(job.scheduled_at).toISOString(), visibility: String(job.payload?.visibility ?? "private") });
      if (result.state === "verified_published") {
        // The only path to "published": the provider itself reported the post as public.
        const publishedAt = result.publishedAt ?? now;
        if ((await deps.store.update("publish_jobs", { id: job.id, state: "submitted" }, { state: "verified_published", published_at: publishedAt, ...(result.url ? { published_url: result.url } : {}), error: null, updated_at: now })).length) {
          outcome.verified++;
          await publishEvent(deps, job, "verified_published");
          await recordSettledPost(deps, job, account, { published: true, occurredAt: publishedAt, url: result.url ?? null });
        }
      } else if (result.state === "failed") {
        if ((await deps.store.update("publish_jobs", { id: job.id, state: "submitted" }, { state: "failed", error: result.note ?? "The provider reports this post as failed.", updated_at: now })).length) {
          outcome.failed++;
          await publishEvent(deps, job, "failed", { reason: result.note });
          await recordSettledPost(deps, job, account, { published: false, occurredAt: now, url: null });
        }
      } else {
        await deps.store.update("publish_jobs", { id: job.id, state: "submitted" }, { error: result.note, updated_at: now });
      }
    } catch (error) {
      if (error instanceof ChannelGrantExpired) await deps.store.update("provider_connections", { id: account.id, org_id: job.org_id }, { state: "expired", updated_at: now });
      // A failed check changes nothing about the post; touch the marker so it is not retried in a tight loop.
      await deps.store.update("publish_jobs", { id: job.id, state: "submitted" }, { updated_at: now });
    }
  }
  return outcome;
}

/**
 * A provider such as Buffer sends no webhooks, so when it settles a post the outcome joins the account's activity
 * (socials-events.ts) here, next to what arrives by webhook. Direct channels report their own uploads.
 */
async function recordSettledPost(deps: EngineDeps, job: Row, account: Row, outcome: { published: boolean; occurredAt: string; url: string | null }) {
  if (!connectedThroughProvider(account) || !isSocialPlatform(job.platform)) return;
  await recordSocialEvents(deps, job.platform, account.provider, [
    { id: job.provider_post_id, type: outcome.published ? "post.created" : "post.failed", accountId: account.id, occurredAt: outcome.occurredAt, subject: { id: job.provider_post_id, url: outcome.url, parentId: null }, text: job.payload?.caption ?? undefined },
  ]);
}

/** A job stuck in "processing" has an unknown outcome. It fails visibly and is never re-sent automatically. */
export async function sweepPublishJobs(deps: EngineDeps) {
  const before = new Date(deps.now().getTime() - PROCESSING_TIMEOUT_MINUTES * 60_000).toISOString();
  let swept = 0;
  for (const job of await deps.store.select("publish_jobs", { state: "processing", updated_at: { lt: before } }, { limit: 50 })) {
    const failed = await deps.store.update("publish_jobs", { id: job.id, state: "processing" }, { state: "failed", error: "Outcome unknown — check the channel before retrying.", updated_at: deps.now().toISOString() });
    if (failed.length) {
      swept++;
      await publishEvent(deps, job, "failed", { reason: "outcome_unknown" });
    }
  }
  return swept;
}

/** Scheduler tick: send what is due (or can be handed to the provider now), verify what was sent, fail what is stuck. */
export async function processDuePublishJobs(deps: EngineDeps) {
  const nowIso = deps.now().toISOString();
  const outcome = { processed: 0, submitted: 0, failed: 0, retried: 0, unknown: 0, verified: 0, swept: 0 };
  for (const candidate of await deps.store.select("publish_jobs", { state: "scheduled" }, { order: ["scheduled_at", "asc"], limit: 20 })) {
    const due = new Date(candidate.scheduled_at).toISOString() <= nowIso;
    if (!due && !(await jobPublisher(deps, candidate))?.schedulesNatively) continue;
    const result = await processPublishJob(deps, candidate);
    if (result === "skipped") continue;
    outcome.processed++;
    outcome[result]++;
  }
  outcome.verified = (await verifySubmittedPublishJobs(deps)).verified;
  outcome.swept = await sweepPublishJobs(deps);
  return outcome;
}

export const scheduleTargetSchema = z.object({ platform: z.enum(["instagram", "tiktok", "youtube"]), localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }).strict();
