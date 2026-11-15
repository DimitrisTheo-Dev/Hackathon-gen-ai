import { CLONE_TRAITS, cloneJobInputSchema, cloneJobSchema, cloneSourceSchema, parseCloneLink, type CloneJob, type CloneLink, type CloneSource } from "../../contracts/src/index.js";
import { audit, idempotent, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import type { Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * Clone a video: a person points at a short video on YouTube, TikTok or Instagram, says what to keep and what
 * to change, and a clone job is queued in `public.clone_jobs` (supabase/migrations/20261115130500_clone_jobs.sql).
 *
 * The engine never downloads or re-hosts the source. It reads the link, follows a TikTok short link to the
 * video it names, and asks the platform's public oEmbed endpoint for the title and author. Creating a job
 * makes nothing: the job waits in `queued` until a worker takes it, and no worker exists in this build.
 */

const LOOKUP_TIMEOUT_MS = 5_000;
const MAX_OEMBED_BYTES = 64 * 1024;
/** Instagram's oEmbed needs a Meta app token this deployment does not have; its embed works without one. */
const OEMBED: Record<CloneLink["platform"], ((url: string) => string) | null> = {
  youtube: (url) => `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`,
  tiktok: (url) => `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
  instagram: null,
};
const PLATFORM_NAMES: Record<CloneLink["platform"], string> = { youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram" };

function readLink(raw: string): CloneLink {
  const result = parseCloneLink(raw);
  if (!result.ok) throw new EngineError("validation_error", result.reason);
  return result.link;
}

/**
 * A short link (vm.tiktok.com/…) names a video only through its redirect. The request goes to a host and path
 * built from the validated code, never to an address the caller typed, and the redirect is read, not followed.
 */
async function followShortLink(deps: EngineDeps, link: CloneLink): Promise<CloneLink> {
  let location: string | null = null;
  try {
    const response = await deps.fetch(link.url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
    location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
    await response.body?.cancel().catch(() => undefined);
  } catch {
    throw new EngineError("provider_unavailable", "TikTok did not answer just now, so this short link could not be opened. Paste the video's full link, or try again.");
  }
  const target = location ? parseCloneLink(new URL(location, link.url).href) : null;
  if (!target?.ok || target.link.platform !== "tiktok" || target.link.kind !== "video")
    throw new EngineError("validation_error", "This TikTok short link does not lead to a video. Open it in TikTok and copy the video's full link.");
  return target.link;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}
function link(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

type Details = Pick<CloneSource, "title" | "author" | "authorUrl" | "thumbnailUrl">;
const NO_DETAILS: Details = { title: null, author: null, authorUrl: null, thumbnailUrl: null };

/**
 * Title, author and thumbnail from the platform's oEmbed. A "not found" answer means the link is wrong or the
 * video is private, and is said so; a slow or broken answer only costs the details, never the preview.
 */
async function oembedDetails(deps: EngineDeps, source: CloneLink): Promise<Details> {
  const endpoint = OEMBED[source.platform];
  if (!endpoint) return NO_DETAILS;
  let response: Response;
  try {
    response = await deps.fetch(endpoint(source.url), { headers: { Accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  } catch {
    return NO_DETAILS;
  }
  const name = PLATFORM_NAMES[source.platform];
  if ([400, 404].includes(response.status))
    throw new EngineError("validation_error", `${name} could not find this video. Check the link; the video may be private or removed.`);
  if ([401, 403].includes(response.status))
    throw new EngineError("validation_error", `The owner of this ${name} video does not allow it to be embedded, so it cannot be previewed or cloned.`);
  if (!response.ok) return NO_DETAILS;
  try {
    const body = await response.text();
    if (body.length > MAX_OEMBED_BYTES) return NO_DETAILS;
    const data = JSON.parse(body) as Record<string, unknown>;
    return { title: text(data.title, 300), author: text(data.author_name, 200), authorUrl: link(data.author_url), thumbnailUrl: link(data.thumbnail_url) };
  } catch {
    return NO_DETAILS;
  }
}

async function resolveSource(deps: EngineDeps, raw: string): Promise<CloneSource> {
  let source = readLink(raw);
  if (source.kind === "short_link") source = await followShortLink(deps, source);
  const details = await oembedDetails(deps, source);
  return parse(cloneSourceSchema, { ...source, ...details });
}

/** `GET /v1/studio/clone/source?url=…`: what the link points to, for the preview. Nothing is stored. */
export async function lookupCloneSource(deps: EngineDeps, ctx: Ctx, url: string | null): Promise<CloneSource> {
  requireScope(ctx, "content:edit");
  if (!url) throw new EngineError("validation_error", "Paste a link to a YouTube, TikTok or Instagram video.");
  return resolveSource(deps, url);
}

const iso = (value: string | Date) => new Date(value).toISOString();
function jobContract(row: Row, resultUrl: string | null): CloneJob {
  return parse(cloneJobSchema, {
    id: row.id,
    source: {
      platform: row.platform,
      kind: row.kind,
      sourceId: row.source_id,
      url: row.source_url,
      embedUrl: row.embed_url,
      orientation: row.orientation,
      title: row.source_title ?? null,
      author: row.source_author ?? null,
      authorUrl: row.source_author_url ?? null,
      thumbnailUrl: row.source_thumbnail_url ?? null,
    },
    brief: row.brief,
    clone: row.clone,
    state: row.state,
    error: typeof row.error?.message === "string" ? row.error.message : null,
    projectId: row.project_id ?? null,
    resultUrl,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

async function withResults(deps: EngineDeps, ctx: Ctx, rows: Row[]): Promise<CloneJob[]> {
  const assetIds = rows.map((row) => row.media_asset_id).filter(Boolean) as string[];
  const assets = assetIds.length ? await deps.store.select("media_assets", { org_id: ctx.org.id, id: { in: assetIds } }) : [];
  const urls = assets.length ? await deps.store.media.signedUrls(assets.map((asset) => asset.storage_path), deps.config.mediaUrlTtlSeconds) : {};
  return rows.map((row) => {
    const asset = assets.find((entry) => entry.id === row.media_asset_id);
    return jobContract(row, asset ? (urls[asset.storage_path] ?? null) : null);
  });
}

/** `GET /v1/studio/clone/jobs`: this workspace's latest clone jobs, newest first. */
export async function listCloneJobs(deps: EngineDeps, ctx: Ctx): Promise<CloneJob[]> {
  requireScope(ctx, "campaign:read");
  const rows = await deps.store.select("clone_jobs", { org_id: ctx.org.id }, { order: ["created_at", "desc"], limit: 30 });
  return withResults(deps, ctx, rows);
}

/** Operation `create_clone_job`. Idempotent on `operationKey`: a retried request returns the same job. */
export async function createCloneJob(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<CloneJob> {
  // Permission first, so a caller who cannot edit never writes an idempotency record.
  requireScope(ctx, "content:edit");
  const input = parse(cloneJobInputSchema, raw);
  // The link is read before the key is recorded: a wrong link is a plain error, never a stored failure.
  readLink(input.url);
  return idempotent(deps, ctx, "create_clone_job", input.operationKey, input, async () => {
    const source = await resolveSource(deps, input.url);
    const now = deps.now().toISOString();
    const row = await deps.store.insert("clone_jobs", {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      platform: source.platform,
      kind: source.kind,
      source_id: source.sourceId,
      source_url: source.url,
      embed_url: source.embedUrl,
      orientation: source.orientation,
      source_title: source.title,
      source_author: source.author,
      source_author_url: source.authorUrl,
      source_thumbnail_url: source.thumbnailUrl,
      brief: input.brief,
      // Stored in the order the studio lists them, whatever order they were sent in.
      clone: CLONE_TRAITS.filter((trait) => input.clone.includes(trait)),
      state: "queued",
      error: null,
      project_id: null,
      media_asset_id: null,
      claimed_by: null,
      claimed_at: null,
      idempotency_key: input.operationKey,
      correlation_id: ctx.correlationId,
      created_by: ctx.actorId,
      created_at: now,
      updated_at: now,
    });
    await audit(deps, ctx, { action: `Queued a clone job for a ${PLATFORM_NAMES[source.platform]} video`, objectId: row.id, outcome: "Queued; nothing is made until a worker takes it" });
    return jobContract(row, null);
  });
}
