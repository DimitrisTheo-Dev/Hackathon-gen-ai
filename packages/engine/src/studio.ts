import {
  campaignSchema,
  contentSchema,
  contextSchema,
  reviseInputSchema,
  restoreInputSchema,
  startCampaignInputSchema,
  versionSchema,
  type Campaign,
  type ContentItem,
  type ContentVersion,
  type Platform,
  type StudioContext,
} from "../../contracts/src/index.js";
import { z } from "zod";
import { AGENT_GRANTABLE_SCOPES, audit, canonical, idempotent, listWorkspaces, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import { createHumanlikeClient } from "./providers/humanlike.js";
import { selectOne, type Row } from "./store.js";

export const PLATFORMS: Platform[] = ["instagram", "tiktok", "youtube"];
const iso = (value: string | Date) => new Date(value).toISOString();

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new EngineError("validation_error", `The request does not match the studio contract${issue ? ` (${issue.path.join(".") || "body"}: ${issue.message})` : ""}.`);
  }
  return result.data;
}

/* ───────────────────────── avatars and renderer availability ───────────────────────── */

let humanlikeCache: { at: number; key: string; avatars: Array<{ id: string; name: string }> } | null = null;
export async function listAvatars(deps: EngineDeps): Promise<StudioContext["avatars"]> {
  const { config } = deps;
  // An explicit owner-configured catalog wins: it states exactly what the connected renderer can produce.
  if (config.renderAvatars.length)
    return config.renderAvatars.map((avatar) => ({ id: avatar.id, name: avatar.name, languages: avatar.languages, permission: "authorized" as const, previewUrl: null }));
  if (!config.humanlikeApiKey) return [];
  if (!humanlikeCache || humanlikeCache.key !== config.humanlikeApiKey || deps.now().getTime() - humanlikeCache.at > 300_000) {
    try {
      const { avatars } = await createHumanlikeClient({ apiKey: config.humanlikeApiKey, apiUrl: config.humanlikeApiUrl, fetch: deps.fetch }).listAvatars();
      // Only avatars Humanlike can render to video frames can become a file; browser-only avatars cannot.
      humanlikeCache = { at: deps.now().getTime(), key: config.humanlikeApiKey, avatars: avatars.filter((a) => a.renderModes.includes("video")).map((a) => ({ id: a.id, name: a.title })) };
    } catch {
      return [];
    }
  }
  // Humanlike lip-syncs supplied audio; spoken language comes from the renderer's voice, hence a configured list.
  return humanlikeCache.avatars.map((avatar) => ({ ...avatar, languages: config.avatarLanguages, permission: "authorized" as const, previewUrl: null }));
}

export function renderBlocker(deps: EngineDeps): string | null {
  if (!deps.config.renderWorkerToken)
    return "Video rendering isn’t connected yet. Humanlike provides realtime avatar sessions; the recording worker that turns a session into a video file has not been attached to this workspace.";
  return null;
}

export async function creditBalance(deps: EngineDeps, orgId: string): Promise<number> {
  const rows = await deps.store.select("credit_ledger", { org_id: orgId });
  return rows.reduce((sum, row) => sum + Number(row.delta), 0);
}

/* ───────────────────────── context ───────────────────────── */

export async function getContext(deps: EngineDeps, ctx: Ctx): Promise<StudioContext> {
  requireScope(ctx, "campaign:read");
  const [brand, avatars, connections, providerConnections, balance, workspaces] = await Promise.all([
    selectOne(deps.store, "brand_profiles", { org_id: ctx.org.id }),
    listAvatars(deps),
    ctx.scopes.has("connections:manage") ? deps.store.select("agent_connections", { org_id: ctx.org.id }, { order: ["created_at", "desc"], limit: 50 }) : Promise.resolve([]),
    deps.store.select("provider_connections", { org_id: ctx.org.id }),
    creditBalance(deps, ctx.org.id),
    listWorkspaces(deps, ctx),
  ]);
  const blocker = renderBlocker(deps);
  const canRender = !blocker && ctx.scopes.has("render:write");
  const noRenderReason = blocker ?? (ctx.scopes.has("render:write") ? null : "Your role cannot start renders in this workspace.");
  const connected = new Set(providerConnections.map((row) => row.platform));
  return parse(contextSchema, {
    workspace: { id: ctx.org.id, name: ctx.org.name, timezone: ctx.org.timezone, role: ctx.role, type: ctx.org.type },
    principal: { id: ctx.actorId, kind: ctx.actorKind, scopes: [...ctx.scopes] },
    brand: {
      name: brand?.name || ctx.org.name,
      description: brand?.description ?? "",
      rules: Array.isArray(brand?.rules) ? brand.rules : [],
      color: brand?.color ?? "#5F6C66",
    },
    avatars,
    channels: [
      ...providerConnections.map((row) => ({ id: row.id, platform: row.platform, displayName: row.display_name, state: row.state })),
      ...PLATFORMS.filter((platform) => !connected.has(platform)).map((platform) => ({
        id: `unavailable-${platform}`,
        platform,
        displayName: `${platform[0].toUpperCase()}${platform.slice(1)} account not connected`,
        state: "unavailable" as const,
      })),
    ],
    capabilities: {
      mode: "live",
      canCreateCampaign: ctx.scopes.has("content:edit"),
      canPlanWithDirector: ctx.scopes.has("campaign:read"),
      directorMode: deps.config.llm ? "ai" : "basic",
      renderBlocker: noRenderReason,
      canRender,
      // No publishing provider has approved API access in this build; see DEMO_READINESS.md.
      canConnectChannels: false,
      canRetry: canRender,
      canCancel: ctx.scopes.has("render:write"),
      canCreateAgentToken: ctx.scopes.has("connections:manage"),
      canCreateGrant: false,
      formats: PLATFORMS.flatMap((platform) => [
        { kind: "avatar_video" as const, platform, supported: canRender, reason: noRenderReason },
        { kind: "image" as const, platform, supported: false, reason: "Image generation is not part of this build." },
        { kind: "text" as const, platform, supported: false, reason: "Text-only posts are not part of this build." },
      ]),
      visibility: ["public", "private", "unlisted"],
      renderUnitsRemaining: Math.max(0, Math.floor(balance / deps.config.renderCreditCost)),
      postsRemaining: 0,
      mcpUrl: deps.config.appBaseUrl ? `${deps.config.appBaseUrl}/mcp` : null,
      openapiUrl: deps.config.appBaseUrl ? `${deps.config.appBaseUrl}/openapi.json` : null,
    },
    connections: connections.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      scopes: row.scopes,
      expiresAt: iso(row.expires_at),
      lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null,
      revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
    })),
    workspaces,
  });
}

/* ───────────────────────── read models ───────────────────────── */

const publishToTarget: Record<string, ContentItem["targets"][number]["state"]> = {
  scheduled: "queued",
  processing: "queued",
  submitted: "accepted",
  verified_published: "published",
  failed: "failed",
  cancelled: "cancelled",
};
const publishToJob: Record<string, Campaign["jobs"][number]["state"]> = {
  scheduled: "queued",
  processing: "running",
  submitted: "running",
  verified_published: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
};

export async function loadProject(deps: EngineDeps, ctx: Ctx, id: string): Promise<Row> {
  // The org filter is the tenancy boundary: an ID from another workspace is simply not found.
  const project = await selectOne(deps.store, "projects", { id, org_id: ctx.org.id });
  if (!project) throw new EngineError("not_found", "This project was not found in your workspace.");
  return project;
}
export async function loadItem(deps: EngineDeps, ctx: Ctx, id: string): Promise<Row> {
  const item = await selectOne(deps.store, "content_items", { id, org_id: ctx.org.id });
  if (!item) throw new EngineError("not_found", "This content item was not found in your workspace.");
  return item;
}

async function assemble(deps: EngineDeps, ctx: Ctx, projects: Row[]): Promise<Campaign[]> {
  if (!projects.length) return [];
  const ids = projects.map((project) => project.id);
  const [items, renderJobs, publishJobs, events] = await Promise.all([
    deps.store.select("content_items", { org_id: ctx.org.id, project_id: { in: ids } }, { order: ["position", "asc"] }),
    deps.store.select("render_jobs", { org_id: ctx.org.id, project_id: { in: ids } }, { order: ["created_at", "desc"], limit: 200 }),
    deps.store.select("publish_jobs", { org_id: ctx.org.id, project_id: { in: ids } }, { order: ["created_at", "desc"], limit: 300 }),
    deps.store.select("audit_events", { org_id: ctx.org.id, project_id: { in: ids } }, { order: ["at", "desc"], limit: 300 }),
  ]);
  const assetIds = items.map((item) => item.media_asset_id).filter(Boolean) as string[];
  const assets = assetIds.length ? await deps.store.select("media_assets", { org_id: ctx.org.id, id: { in: assetIds } }) : [];
  const urls = await deps.store.media.signedUrls(assets.map((asset) => asset.storage_path), deps.config.mediaUrlTtlSeconds);
  // A reused signed URL has at least half of its lifetime left, so that is the expiry the client is told.
  const expiresAt = new Date(deps.now().getTime() + (deps.config.mediaUrlTtlSeconds * 1000) / 2).toISOString();
  return projects.map((project) => {
    const projectItems = items.filter((item) => item.project_id === project.id);
    return parse(campaignSchema, {
      id: project.id,
      workspaceId: ctx.org.id,
      title: project.title,
      brief: project.brief,
      companyContext: project.company_context ?? null,
      revision: project.revision,
      createdAt: iso(project.created_at),
      updatedAt: iso(project.updated_at),
      timezone: project.timezone,
      mode: "live",
      origin: project.origin,
      templateId: project.template_id ?? null,
      humanInterventions: project.human_interventions,
      sources: project.sources ?? [],
      items: projectItems.map((item) => {
        const asset = assets.find((entry) => entry.id === item.media_asset_id);
        const url = asset ? urls[asset.storage_path] : null;
        return itemContract(item, ctx.org.id, asset && url ? { asset, url, expiresAt } : null, publishJobs.filter((job) => job.item_id === item.id));
      }),
      jobs: [
        ...renderJobs.filter((job) => job.project_id === project.id).slice(0, 30).map((job) => ({
          id: job.id,
          itemId: job.item_id,
          stage: job.stage,
          state: job.state,
          createdAt: iso(job.created_at),
          updatedAt: iso(job.updated_at),
          providerCorrelationId: job.provider_job_id ?? null,
          error: job.error ?? null,
          nextPollAfterMs: ["queued", "running", "cancel_requested"].includes(job.state) ? 5000 : 60000,
        })),
        ...publishJobs.filter((job) => job.project_id === project.id).slice(0, 30).map((job) => ({
          id: job.id,
          itemId: job.item_id,
          stage: "publish" as const,
          state: publishToJob[job.state] ?? "unknown",
          createdAt: iso(job.created_at),
          updatedAt: iso(job.updated_at),
          providerCorrelationId: job.provider_post_id ?? null,
          error: job.error ? { code: "provider_unavailable" as const, message: String(job.error), retryAfterSeconds: null, reviewUrl: null } : null,
          nextPollAfterMs: 30000,
        })),
      ],
      activity: events.filter((event) => event.project_id === project.id).slice(0, 60).map((event) => ({
        id: event.id,
        actor: event.actor,
        action: event.action,
        objectId: event.object_id,
        revision: event.revision ?? null,
        at: iso(event.at),
        outcome: event.outcome,
      })),
    });
  });
}

export function itemContract(item: Row, orgId: string, media: { asset: Row; url: string; expiresAt: string } | null, publishJobs: Row[]): ContentItem {
  return parse(contentSchema, {
    id: item.id,
    workspaceId: orgId,
    campaignId: item.project_id,
    title: item.title,
    kind: item.kind,
    script: item.script,
    avatarId: item.avatar_id ?? null,
    language: item.language,
    revision: item.revision,
    renderRevision: item.render_revision ?? null,
    status: item.status,
    media: media
      ? {
          id: media.asset.id,
          url: media.url,
          expiresAt: media.expiresAt,
          sha256: media.asset.sha256,
          revision: media.asset.revision,
          durationSeconds: Number(media.asset.duration_seconds),
          hasAudio: media.asset.has_audio,
        }
      : null,
    variants: item.variants,
    targets: (item.targets as Row[]).map((target) => {
      // A destination's state is whatever the publish job for this exact intent says; otherwise it is only a draft time.
      const job = publishJobs.find((candidate) => candidate.platform === target.platform && candidate.account_id === target.accountId && iso(candidate.scheduled_at) === iso(target.scheduledAt));
      return {
        platform: target.platform,
        accountId: target.accountId ?? null,
        scheduledAt: iso(target.scheduledAt),
        timezone: target.timezone,
        state: job ? (publishToTarget[job.state] ?? "unknown") : "draft",
        publishedAt: job?.published_at ? iso(job.published_at) : null,
        providerId: job?.provider_post_id ?? null,
        publishedUrl: job?.published_url ?? null,
        error: job?.error ?? null,
      };
    }),
    style: item.style,
    sourceIds: item.source_ids ?? [],
    updatedAt: iso(item.updated_at),
  });
}

export async function listCampaigns(deps: EngineDeps, ctx: Ctx): Promise<Campaign[]> {
  requireScope(ctx, "campaign:read");
  return assemble(deps, ctx, await deps.store.select("projects", { org_id: ctx.org.id }, { order: ["updated_at", "desc"], limit: 50 }));
}
export async function getCampaign(deps: EngineDeps, ctx: Ctx, id: string): Promise<Campaign> {
  requireScope(ctx, "campaign:read");
  return (await assemble(deps, ctx, [await loadProject(deps, ctx, id)]))[0];
}
export async function getItem(deps: EngineDeps, ctx: Ctx, id: string): Promise<ContentItem> {
  const item = await loadItem(deps, ctx, id);
  const campaign = await getCampaign(deps, ctx, item.project_id);
  return campaign.items.find((entry) => entry.id === id)!;
}

/* ───────────────────────── create ───────────────────────── */

function snapshot(item: Row) {
  return { title: item.title, script: item.script, avatarId: item.avatar_id ?? null, language: item.language, style: item.style, variants: item.variants, targets: item.targets };
}
export interface DraftSeed {
  title: string;
  script: string;
  language?: string;
  avatarId?: string | null;
  captions?: Partial<Record<Platform, string>>;
  targets?: Array<{ platform: Platform; accountId: string | null; scheduledAt: string; timezone: string }>;
}
export interface ProjectSeed {
  title: string;
  brief: string;
  companyContext: Row | null;
  sources?: Row[];
  origin: "user" | "agent" | "sample";
  templateId?: string | null;
  items: DraftSeed[];
  action: string;
}

/** Persists a project and its first drafts. Draft-only: nothing here calls a provider or spends credits. */
export async function createProject(deps: EngineDeps, ctx: Ctx, seed: ProjectSeed): Promise<Campaign> {
  requireScope(ctx, "content:edit");
  const now = deps.now().toISOString();
  const brand = await selectOne(deps.store, "brand_profiles", { org_id: ctx.org.id });
  const avatars = await listAvatars(deps);
  const projectId = crypto.randomUUID();
  await deps.store.insert("projects", {
    id: projectId,
    org_id: ctx.org.id,
    title: seed.title.slice(0, 160),
    brief: seed.brief,
    company_context: seed.companyContext,
    sources: seed.sources ?? [],
    timezone: ctx.org.timezone,
    revision: 1,
    human_interventions: ctx.actorKind === "human" ? 1 : 0,
    origin: seed.origin,
    template_id: seed.templateId ?? null,
    created_by: ctx.principal.kind === "agent" && ctx.principal.via === "token" ? ctx.principal.createdBy : ctx.principal.userId,
    created_at: now,
    updated_at: now,
  });
  for (const [position, draft] of seed.items.entries()) {
    const language = draft.language ?? "en";
    const requested = draft.avatarId ?? brand?.preferred_avatar_id ?? null;
    // Only pre-select a presenter the connected renderer has actually authorized for this language.
    const avatar = avatars.find((entry) => entry.id === requested && entry.languages.includes(language)) ?? null;
    const item = {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      project_id: projectId,
      position,
      kind: "avatar_video",
      title: draft.title.slice(0, 120),
      script: draft.script.slice(0, 5000),
      avatar_id: avatar?.id ?? null,
      language,
      style: { captions: true, brandColor: brand?.color ?? "#5F6C66", captionPosition: "bottom" },
      variants: PLATFORMS.map((platform) => ({ platform, title: platform === "youtube" ? draft.title.slice(0, 150) : "", caption: (draft.captions?.[platform] ?? "").slice(0, 2200), accountId: null, visibility: "public", aiDisclosure: true })),
      targets: draft.targets ?? [],
      source_ids: (seed.sources ?? []).map((source) => source.id),
      revision: 1,
      render_revision: null,
      approved_revision: null,
      status: "draft",
      media_asset_id: null,
      updated_at: now,
    };
    await deps.store.insert("content_items", item);
    await deps.store.insert("content_versions", {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      item_id: item.id,
      revision: 1,
      snapshot: snapshot(item),
      affects_render: true,
      summary: "First draft",
      actor_id: ctx.actorId,
      actor_kind: ctx.actorKind,
      created_at: now,
    });
  }
  // The existing conversation table is fail-closed: the engine, never the browser, grants project chat access.
  const members = await deps.store.select("memberships", { org_id: ctx.org.id });
  for (const member of members) {
    try {
      await deps.store.insert("castroom_director_access", { user_id: member.user_id, workspace_id: ctx.org.id, campaign_id: projectId });
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
    }
  }
  await audit(deps, ctx, { projectId, action: seed.action, objectId: projectId, revision: 1, outcome: `${seed.items.length} draft${seed.items.length === 1 ? "" : "s"} saved` });
  return getCampaign(deps, ctx, projectId);
}

export async function startCampaign(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Campaign> {
  const input = parse(startCampaignInputSchema, raw);
  return idempotent(deps, ctx, "start_campaign", input.operationKey, input, async () => {
    const now = deps.now().toISOString();
    const sourceId = crypto.randomUUID();
    return createProject(deps, ctx, {
      title: input.title,
      brief: input.companyContext.description,
      companyContext: input.companyContext,
      // Supplied text is stored as data. It is never fetched, executed or treated as instructions.
      sources: input.companyContext.sourceText
        ? [{ id: sourceId, title: `${input.companyContext.name} · supplied source`, url: input.companyContext.sourceUrl, excerpt: input.companyContext.sourceText.slice(0, 5000), permittedAssetIds: [], retrievedAt: now }]
        : [],
      origin: ctx.actorKind === "agent" ? "agent" : "user",
      items: input.items.map((item) => ({ title: item.title, script: item.script })),
      action: "Created drafts from a supplied brief",
    });
  });
}

export const addDraftInputSchema = z
  .object({ campaignId: z.string().min(1).max(160), title: z.string().trim().min(1).max(120), script: z.string().trim().min(1).max(5000), language: z.string().min(2).max(12).default("en"), operationKey: z.uuid() })
  .strict();
const MAX_ITEMS_PER_PROJECT = 12;

/** Appends one draft to an existing project. Draft-only, like every create path. */
export async function addDraft(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<ContentItem> {
  requireScope(ctx, "content:edit");
  const input = parse(addDraftInputSchema, raw);
  return idempotent(deps, ctx, "add_draft", input.operationKey, input, async () => {
    const project = await loadProject(deps, ctx, input.campaignId);
    const existing = await deps.store.select("content_items", { org_id: ctx.org.id, project_id: project.id }, { order: ["position", "desc"] });
    if (existing.length >= MAX_ITEMS_PER_PROJECT) throw new EngineError("quota_exceeded", `A project holds up to ${MAX_ITEMS_PER_PROJECT} items. Start a new project for more.`);
    const brand = await selectOne(deps.store, "brand_profiles", { org_id: ctx.org.id });
    const now = deps.now().toISOString();
    const item = {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      project_id: project.id,
      position: (existing[0]?.position ?? -1) + 1,
      kind: "avatar_video",
      title: input.title,
      script: input.script,
      avatar_id: null,
      language: input.language,
      style: { captions: true, brandColor: brand?.color ?? "#5F6C66", captionPosition: "bottom" },
      variants: PLATFORMS.map((platform) => ({ platform, title: platform === "youtube" ? input.title : "", caption: "", accountId: null, visibility: "public", aiDisclosure: true })),
      targets: [],
      source_ids: [],
      revision: 1,
      render_revision: null,
      approved_revision: null,
      status: "draft",
      media_asset_id: null,
      updated_at: now,
    };
    await deps.store.insert("content_items", item);
    await deps.store.insert("content_versions", { id: crypto.randomUUID(), org_id: ctx.org.id, item_id: item.id, revision: 1, snapshot: snapshot(item), affects_render: true, summary: "First draft", actor_id: ctx.actorId, actor_kind: ctx.actorKind, created_at: now });
    await deps.store.update("schedule_manifests", { org_id: ctx.org.id, project_id: project.id, state: { in: ["required", "approved"] } }, { state: "stale" });
    await bumpProject(deps, ctx, project.id, ctx.actorKind === "human");
    await audit(deps, ctx, { projectId: project.id, action: "Added a draft", objectId: item.id, revision: 1, outcome: "Saved" });
    return getItem(deps, ctx, item.id);
  });
}

/* ───────────────────────── revise and versions ───────────────────────── */

const RENDER_FIELDS = ["script", "avatarId", "language", "style"] as const;
const columnFor: Record<string, string> = { title: "title", script: "script", avatarId: "avatar_id", language: "language", style: "style", variants: "variants", targets: "targets" };

export async function bumpProject(deps: EngineDeps, ctx: Ctx, projectId: string, human: boolean) {
  // Optimistic loop: the project revision is a monotonic change counter shared by concurrent item edits.
  for (let attempt = 0; attempt < 5; attempt++) {
    const project = await loadProject(deps, ctx, projectId);
    const updated = await deps.store.update("projects", { id: projectId, org_id: ctx.org.id, revision: project.revision }, {
      revision: project.revision + 1,
      human_interventions: project.human_interventions + (human ? 1 : 0),
      updated_at: deps.now().toISOString(),
    });
    if (updated.length) return updated[0];
  }
  throw new EngineError("revision_conflict", "The project is changing quickly. Refresh and try again.");
}

async function applyRevision(deps: EngineDeps, ctx: Ctx, current: Row, expectedRevision: number, patch: Record<string, unknown>, summary: string): Promise<ContentItem> {
  if (current.revision !== expectedRevision)
    throw new EngineError("revision_conflict", "This item changed after you opened it. Reload its latest version before saving.");
  const submitted = await deps.store.select("publish_jobs", { org_id: ctx.org.id, item_id: current.id, state: { in: ["processing", "submitted"] } }, { limit: 1 });
  if (submitted.length) throw new EngineError("forbidden", "A destination has already been submitted for this item. Wait for its outcome or cancel it before editing.");
  if (patch.avatarId) {
    const language = (patch.language as string | undefined) ?? current.language;
    const avatar = (await listAvatars(deps)).find((entry) => entry.id === patch.avatarId && entry.permission === "authorized");
    if (!avatar) throw new EngineError("forbidden", "Choose a presenter that is authorized for this workspace.");
    if (!avatar.languages.includes(language)) throw new EngineError("validation_error", "This presenter does not support the script language.");
  }
  if (Array.isArray(patch.targets)) {
    const accounts = await deps.store.select("provider_connections", { org_id: ctx.org.id });
    for (const target of patch.targets as Row[])
      if (target.accountId && !accounts.some((account) => account.id === target.accountId && account.platform === target.platform))
        throw new EngineError("validation_error", "A schedule target names an account that is not connected to this workspace.");
  }
  const currentView: Record<string, unknown> = snapshot(current);
  const affectsRender = RENDER_FIELDS.some((field) => field in patch && canonical(patch[field]) !== canonical(currentView[field]));
  const now = deps.now().toISOString();
  const columns: Row = { revision: current.revision + 1, approved_revision: null, updated_at: now };
  for (const [field, value] of Object.entries(patch)) if (value !== undefined) columns[columnFor[field]] = value;
  if (affectsRender) Object.assign(columns, { render_revision: null, status: "draft" });
  // Compare-and-swap on the revision is the commit point: exactly one concurrent editor wins.
  const updated = await deps.store.update("content_items", { id: current.id, org_id: ctx.org.id, revision: expectedRevision }, columns);
  if (!updated.length) throw new EngineError("revision_conflict", "This item changed while saving. Reload its latest version before saving.");
  const item = updated[0];
  await deps.store.insert("content_versions", {
    id: crypto.randomUUID(),
    org_id: ctx.org.id,
    item_id: item.id,
    revision: item.revision,
    snapshot: snapshot(item),
    affects_render: affectsRender,
    summary,
    actor_id: ctx.actorId,
    actor_kind: ctx.actorKind,
    created_at: now,
  });
  // Any edit invalidates approvals that covered the previous content, and unsent publications of it.
  await deps.store.update("schedule_manifests", { org_id: ctx.org.id, project_id: item.project_id, state: { in: ["required", "approved"] } }, { state: "stale" });
  await deps.store.update("publish_jobs", { org_id: ctx.org.id, item_id: item.id, state: "scheduled" }, { state: "cancelled", error: `Superseded by revision ${item.revision}; approve the new version to schedule it.`, updated_at: now });
  await bumpProject(deps, ctx, item.project_id, ctx.actorKind === "human");
  await audit(deps, ctx, {
    projectId: item.project_id,
    action: affectsRender ? `${summary}; video needs regeneration` : `${summary}; schedule needs review`,
    objectId: item.id,
    revision: item.revision,
    outcome: "Saved",
  });
  return getItem(deps, ctx, item.id);
}

export async function reviseContent(deps: EngineDeps, ctx: Ctx, raw: unknown, summary = "Saved content changes"): Promise<ContentItem> {
  requireScope(ctx, "content:edit");
  const input = parse(reviseInputSchema, raw);
  if (!Object.keys(input.patch).length) throw new EngineError("validation_error", "The edit contains no changes.");
  return idempotent(deps, ctx, "revise_content", input.operationKey, input, async () =>
    applyRevision(deps, ctx, await loadItem(deps, ctx, input.contentId), input.expectedRevision, input.patch, summary),
  );
}

export async function listVersions(deps: EngineDeps, ctx: Ctx, itemId: string): Promise<ContentVersion[]> {
  requireScope(ctx, "campaign:read");
  const item = await loadItem(deps, ctx, itemId);
  const [versions, assets] = await Promise.all([
    deps.store.select("content_versions", { org_id: ctx.org.id, item_id: item.id }, { order: ["revision", "desc"], limit: 100 }),
    deps.store.select("media_assets", { org_id: ctx.org.id, item_id: item.id }),
  ]);
  return versions.map((version) =>
    parse(versionSchema, {
      revision: version.revision,
      createdAt: iso(version.created_at),
      actor: version.actor_kind === "agent" ? "Connected agent" : version.actor_kind === "system" ? "Faceful" : "Workspace member",
      actorKind: version.actor_kind,
      summary: version.summary,
      affectsRender: version.affects_render,
      title: version.snapshot.title,
      script: version.snapshot.script,
      avatarId: version.snapshot.avatarId ?? null,
      language: version.snapshot.language,
      hasMedia: assets.some((asset) => asset.revision === version.revision),
    }),
  );
}

/** Restoring never rewrites history: the old content is saved again as a new revision. */
export async function restoreVersion(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<ContentItem> {
  requireScope(ctx, "content:edit");
  const input = parse(restoreInputSchema, raw);
  return idempotent(deps, ctx, "restore_version", input.operationKey, input, async () => {
    const item = await loadItem(deps, ctx, input.contentId);
    const version = await selectOne(deps.store, "content_versions", { org_id: ctx.org.id, item_id: item.id, revision: input.revision });
    if (!version) throw new EngineError("not_found", "That version is not available for this item.");
    const { targets: _targets, ...restorable } = version.snapshot as Record<string, unknown>;
    // Schedule times are not part of a creative restore; they stay as currently requested.
    const restored = await applyRevision(deps, ctx, item, input.expectedRevision, restorable, `Restored version ${input.revision}`);
    // If the restored content was already rendered, reuse that exact file instead of spending a new render.
    const asset = (await deps.store.select("media_assets", { org_id: ctx.org.id, item_id: item.id, revision: input.revision }, { order: ["created_at", "desc"], limit: 1 }))[0];
    if (asset && canonical(RENDER_FIELDS.map((field) => (version.snapshot as Row)[field])) === canonical(RENDER_FIELDS.map((field) => (restored as Row)[field]))) {
      await deps.store.update("content_items", { id: item.id, org_id: ctx.org.id, revision: restored.revision }, { media_asset_id: asset.id, render_revision: asset.revision, status: "ready" });
      return getItem(deps, ctx, item.id);
    }
    return restored;
  });
}

/* ───────────────────────── agent connections (scoped workspace tokens) ───────────────────────── */

export const createConnectionInputSchema = z
  .object({ displayName: z.string().trim().min(1).max(80), scopes: z.array(z.string().min(1).max(80)).min(1).max(20), expiresAt: z.iso.datetime({ offset: true }), operationKey: z.uuid() })
  .strict();
export const revokeConnectionInputSchema = z.object({ connectionId: z.string().min(1).max(160), operationKey: z.uuid() }).strict();

export function agentScopesFrom(requested: string[]) {
  const unknown = requested.filter((scope) => !(AGENT_GRANTABLE_SCOPES as string[]).includes(scope));
  if (unknown.length) throw new EngineError("validation_error", `Agents cannot be granted: ${unknown.join(", ")}. Publication approval, billing management and token administration stay with people.`);
  return [...new Set(requested)];
}
