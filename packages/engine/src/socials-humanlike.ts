import { createHash } from "node:crypto";
import { z } from "zod";
import type { EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import type { PostStatus, ProviderAccount, PublishInput, SocialPlatform, SocialProvider } from "./socials.js";

/**
 * Humanlike (api.humanlike.co) as a partner. Faceful is one of Humanlike's partner apps, as kanesite.gr and dikio.gr
 * are: Humanlike holds the social accounts and their tokens, under its own reviewed platform apps (TikTok's Content
 * Posting API, Instagram), in a Humanlike workspace (a "partner tenant") that belongs to one Faceful workspace.
 * Faceful never sees a platform token. It sends the workspace key (`x-humanlike-key`), and Humanlike pins every call
 * to that workspace, replacing any company or user id in the body.
 *
 *   POST /partners/tenants                 partner login (x-partner-client + Bearer secret): the workspace, a fresh key
 *   POST /integrations/content/accounts    the workspace's accounts per platform (Humanlike connection ids)
 *   POST /integrations/content/upload      a presigned upload into the workspace (TikTok takes only the workspace's files)
 *   POST /integrations/tiktok/creator-info what the TikTok account allows: privacy levels, the longest video
 *   POST /integrations/content/save        the post, due now; Humanlike's 30-second publisher sends it
 *   POST /integrations/content/list        the workspace's posts, with what each platform did
 *
 * Connected one of two ways. A pasted workspace key (`{ apiKey: "hlpk_…" }`) for a Humanlike workspace made by hand.
 * Or, where this deployment holds a Humanlike partner login (HUMANLIKE_PARTNER_CLIENT_ID / _SECRET), an empty body:
 * the engine makes or finds this Faceful workspace's own Humanlike workspace and takes a fresh key for it.
 *
 * The accounts themselves are connected on Humanlike's side. Humanlike has no partner sign-in for social platforms
 * yet (its POST /partners/connect covers Google Business Profile only), so until it does, an account reaches the
 * Humanlike workspace through a Humanlike member connecting it there (INTEGRATION_CONTRACTS.md §4).
 *
 * Each publish job is saved under one Humanlike post id derived from it. Saving again updates that same post, and
 * Humanlike refuses (409) a post it is already sending or has sent, so a retry after an unclear answer never posts twice.
 */
const credentialsSchema = z.object({
  apiKey: z.string().trim().regex(/^hlpk_[A-Za-z0-9_-]{43}$/, "a Humanlike workspace key starts with hlpk_"),
}).strict();
type Credentials = z.infer<typeof credentialsSchema>;

/**
 * Where Faceful posts video through Humanlike. YouTube stays with the studio's own adapter: Humanlike keeps YouTube
 * data away from partner apps (a commitment of its YouTube API audit). LinkedIn pages take only text posts there.
 */
const PLATFORMS: SocialPlatform[] = ["tiktok", "instagram"];
const LABEL: Record<string, string> = { tiktok: "TikTok", instagram: "Instagram" };

/** TikTok's privacy levels for the studio's visibility. TikTok has nothing like "unlisted". */
const TIKTOK_PRIVACY: Record<string, string> = { public: "PUBLIC_TO_EVERYONE", private: "SELF_ONLY" };
/** Videos Humanlike stores (its content storage), with their upload limit. */
const VIDEO_TYPES: Record<string, string> = { "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm" };
const MAX_UPLOAD_BYTES = 250 * 1024 * 1024;

type Auth = { key: string } | { client: { id: string; secret: string } };
interface Answer {
  status: number;
  data: Record<string, any>;
  retryAfter: number | null;
}

async function send(deps: EngineDeps, path: string, body: Record<string, unknown>, auth: Auth, timeoutMs = 30_000): Promise<Answer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if ("key" in auth) headers["x-humanlike-key"] = auth.key;
  else Object.assign(headers, { "x-partner-client": auth.client.id, Authorization: `Bearer ${auth.client.secret}` });
  let response: Response;
  try {
    response = await deps.fetch(`${deps.config.humanlikeApiUrl}${path}`, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new EngineError("provider_unavailable", "Humanlike could not be reached. Try again in a moment.");
  }
  const data: unknown = await response.json().catch(() => null);
  return { status: response.status, data: data && typeof data === "object" ? (data as Record<string, any>) : {}, retryAfter: Number(response.headers.get("retry-after")) || null };
}

/** A refusal, in Humanlike's own words where it gave some. */
function refusal(answer: Answer, auth: Auth): EngineError {
  const words = typeof answer.data.error === "string" ? answer.data.error.trim().slice(0, 300) : "";
  const { status } = answer;
  if (status === 429) return new EngineError("quota_exceeded", "Humanlike's request limit for this workspace has been reached. Try again later.", { retryAfterSeconds: answer.retryAfter });
  if (status === 401)
    return "key" in auth
      ? new EngineError("forbidden", "Humanlike did not accept this workspace key. Connect Humanlike again.")
      : new EngineError("provider_unavailable", "Humanlike did not accept this deployment's partner login. Connecting Humanlike is not available until it is fixed.");
  if (status === 403) return new EngineError("forbidden", words ? `Humanlike refused: ${words}` : "Humanlike refused this for the workspace key.");
  if (status === 404) return new EngineError("not_found", words ? `Humanlike: ${words}` : "Humanlike could not find that.");
  if (status >= 400 && status < 500) return new EngineError("validation_error", words ? `Humanlike did not accept this: ${words}` : "Humanlike did not accept this request.");
  return new EngineError("provider_unavailable", "Humanlike could not be reached. Try again in a moment.");
}

/** One call; anything but a success is thrown as an EngineError. */
async function call<T = Record<string, any>>(deps: EngineDeps, path: string, body: Record<string, unknown>, auth: Auth, timeoutMs?: number): Promise<T> {
  const answer = await send(deps, path, body, auth, timeoutMs);
  if (answer.status < 200 || answer.status >= 300 || answer.data.success === false) throw refusal(answer, auth);
  return answer.data as T;
}

/** The address a Faceful workspace's Humanlike workspace is known by: one per Faceful workspace, nobody's own mail. Pure. */
const humanlikeTenantEmail = (workspaceId: string, domain: string) => `faceful-${workspaceId.toLowerCase()}@${domain}`;

/**
 * This Faceful workspace's own Humanlike workspace, made on first use, with a fresh key: earlier keys stop working,
 * and every account row of the provider is sealed again with the new one (socials.ts).
 */
async function provisionWorkspace(deps: EngineDeps, workspace: { id: string; name: string }): Promise<Credentials> {
  const partner = deps.config.socials.humanlikePartner;
  if (!partner) throw new EngineError("provider_unavailable", "This deployment has no Humanlike partner login. Paste a Humanlike workspace key instead.");
  const name = workspace.name.trim().replace(/\s+/g, " ").slice(0, 120);
  const made = await call<{ api_key?: unknown }>(
    deps,
    "/partners/tenants",
    { email: humanlikeTenantEmail(workspace.id, partner.tenantEmailDomain), ...(name.length >= 2 ? { name } : {}), rotate: true },
    { client: { id: partner.clientId, secret: partner.clientSecret } },
  );
  const parsed = credentialsSchema.safeParse({ apiKey: made.api_key });
  if (!parsed.success) throw new EngineError("provider_unavailable", "Humanlike made the workspace but sent no key for it. Try again.");
  return parsed.data;
}

async function listAccounts(deps: EngineDeps, credentials: Credentials): Promise<ProviderAccount[]> {
  const { accounts } = await call<{ accounts?: Record<string, unknown> }>(deps, "/integrations/content/accounts", {}, { key: credentials.apiKey });
  const found: ProviderAccount[] = [];
  for (const platform of PLATFORMS) {
    const listed = accounts?.[platform];
    for (const account of Array.isArray(listed) ? listed : []) {
      if (typeof account?.id !== "string" || !account.id) continue;
      found.push({
        platform,
        // Humanlike names an account by its connection, not by the platform's own ID.
        externalAccountId: `humanlike:${account.id}`,
        providerAccountId: account.id,
        displayName: String(account.name || `${LABEL[platform]} account`).slice(0, 200),
        profileUrl: null,
        state: "connected",
      });
    }
  }
  return found;
}

/** The Humanlike post id for one publish job: a UUID made from it, so Faceful's own ids never reach Humanlike. Pure. */
export function humanlikePostId(attemptKey: string) {
  const hex = createHash("sha256").update(`faceful-publish:${attemptKey}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The checked TikTok choices Humanlike requires (its tiktokPostOptions): an available privacy level, a duration within
 * the account's limit, interactions and commercial disclosure stated, and a fingerprint over exactly what was reviewed.
 * The person reviewed them by approving the schedule; interactions stay off and nothing is declared commercial. Pure.
 */
function tiktokOptions(input: { tokenId: string; caption: string; media: { id: string; name: string }; privacy: string; durationSeconds: number }) {
  const choices = { privacy: input.privacy, allowComment: false, allowDuet: false, allowStitch: false, commercial: false, ownBrand: false, brandedContent: false };
  const consentFingerprint = JSON.stringify([
    input.tokenId,
    input.caption,
    [[input.media.id, input.media.name]],
    choices.privacy,
    choices.allowComment,
    choices.allowDuet,
    choices.allowStitch,
    choices.commercial,
    choices.ownBrand,
    choices.brandedContent,
  ]);
  return { ...choices, durationSeconds: input.durationSeconds, consentFingerprint };
}

/** Copies the approved video into the Humanlike workspace (TikTok posts only the workspace's own files). */
async function uploadVideo(deps: EngineDeps, auth: Auth, input: PublishInput) {
  const mime = (input.mediaMime ?? "video/mp4").toLowerCase();
  const extension = VIDEO_TYPES[mime];
  if (!extension) throw new EngineError("unsupported", "Humanlike takes MP4, MOV or WebM videos. Render this video as MP4 and approve the schedule again.");
  let bytes: ArrayBuffer;
  try {
    const source = await deps.fetch(input.mediaUrl, { signal: AbortSignal.timeout(120_000) });
    if (!source.ok) throw new Error(String(source.status));
    bytes = await source.arrayBuffer();
  } catch {
    throw new EngineError("provider_unavailable", "The approved video could not be read from storage. Nothing was posted.");
  }
  if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) throw new EngineError("unsupported", "Humanlike takes videos of up to 250 MB. Nothing was posted.");
  const slot = await call<{ key?: unknown; uploadUrl?: unknown }>(deps, "/integrations/content/upload", { type: mime, size: bytes.byteLength, folder: "faceful" }, auth);
  if (typeof slot.key !== "string" || typeof slot.uploadUrl !== "string" || !slot.uploadUrl.startsWith("https://"))
    throw new EngineError("provider_unavailable", "Humanlike did not hand over a place to upload the video. Try again in a moment.");
  let stored: Response;
  try {
    stored = await deps.fetch(slot.uploadUrl, { method: "PUT", headers: { "Content-Type": mime }, body: bytes, signal: AbortSignal.timeout(300_000) });
  } catch {
    throw new EngineError("provider_unavailable", "The video could not be uploaded to Humanlike. Try again in a moment.");
  }
  if (!stored.ok) throw new EngineError("provider_unavailable", "The video could not be uploaded to Humanlike. Try again in a moment.");
  return { id: "faceful-video", kind: "video" as const, name: `faceful.${extension}`, key: slot.key };
}

async function publish(deps: EngineDeps, input: PublishInput & { credentials: Credentials }) {
  const { account, payload } = input;
  const platform = account.platform as string;
  if (!PLATFORMS.includes(platform as SocialPlatform)) throw new EngineError("unsupported", "Humanlike does not post to this platform for Faceful.");
  const auth: Auth = { key: input.credentials.apiKey };
  const tokenId = String(account.provider_account_id ?? "");
  const caption = String(payload.caption ?? "");
  const id = humanlikePostId(input.attemptKey);

  let media: Record<string, unknown>;
  let options: Record<string, unknown>;
  if (platform === "instagram") {
    if (payload.visibility !== "public") throw new EngineError("unsupported", "Instagram can only post publicly. Set this post to public and approve the schedule again.");
    // Instagram fetches the video from this link while Humanlike prepares the Reel, within its first minute.
    media = { id: "faceful-video", kind: "video", name: "faceful.mp4", url: input.mediaUrl };
    options = { instagramOptions: { is_ai_generated: Boolean(payload.aiDisclosure) } };
  } else {
    const privacy = TIKTOK_PRIVACY[String(payload.visibility)];
    if (!privacy) throw new EngineError("unsupported", "TikTok has no unlisted posts. Set this post to public or private and approve the schedule again.");
    // TikTok asks for an AI-generated label on such videos, and Humanlike's TikTok path cannot set it yet.
    if (payload.aiDisclosure) throw new EngineError("unsupported", "Humanlike cannot mark a TikTok video as AI-generated yet, and this post is approved with an AI disclosure. Nothing was sent.");
    const durationSeconds = Number(input.mediaDurationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new EngineError("validation_error", "The video's length is not known, and TikTok needs it checked against the account's limit. Nothing was sent.");
    const info = await call<{ data?: Record<string, any> }>(deps, "/integrations/tiktok/creator-info", { token_id: tokenId }, auth, 60_000);
    const creator = info.data ?? {};
    if (!Array.isArray(creator.privacy_level_options) || !creator.privacy_level_options.includes(privacy))
      throw new EngineError("unsupported", `This TikTok account cannot post ${payload.visibility === "public" ? "publicly" : "privately"} right now. Choose the other visibility and approve the schedule again.`);
    const longest = Number(creator.max_video_post_duration_sec);
    if (Number.isFinite(longest) && durationSeconds > longest) throw new EngineError("unsupported", `This TikTok account takes videos of up to ${longest} seconds. Nothing was sent.`);
    const uploaded = await uploadVideo(deps, auth, input);
    media = uploaded;
    options = { tiktokOptions: tiktokOptions({ tokenId, caption, media: uploaded, privacy, durationSeconds }) };
  }

  const answer = await send(
    deps,
    "/integrations/content/save",
    {
      post: {
        id,
        type: "video",
        // Due now: the scheduler holds a post until its approved time and checks it again then.
        status: "scheduled",
        scheduledFor: deps.now().toISOString(),
        timezone: "UTC",
        platforms: [platform],
        title: String(payload.title ?? "").slice(0, 1000),
        body: caption,
        media: [media],
        accounts: { [platform]: tokenId },
        ...options,
      },
    },
    auth,
  );
  // 409: an earlier attempt of this same job already reached Humanlike, which is sending or has sent it.
  if (answer.status !== 409 && (answer.status < 200 || answer.status >= 300 || answer.data.success === false)) throw refusal(answer, auth);
  return { providerPostId: id, state: "submitted" as const, url: null };
}

const settled = (state: "published" | "failed", fields: Partial<PostStatus> = {}): PostStatus => ({ state, url: null, publishedAt: null, error: null, ...fields });

async function postStatus(deps: EngineDeps, input: { credentials: Credentials; account: Record<string, any>; providerPostId: string }): Promise<PostStatus> {
  const { posts } = await call<{ posts?: unknown }>(deps, "/integrations/content/list", {}, { key: input.credentials.apiKey }, 60_000);
  const post = (Array.isArray(posts) ? posts : []).find((entry: any) => entry?.id === input.providerPostId);
  const platform = String(input.account.platform);
  const name = LABEL[platform] ?? platform;
  if (!post) return settled("failed", { error: `Humanlike no longer has this post. Check ${name} before sending it again.` });
  const result = post.results?.[platform];
  if (result?.state === "published") {
    if (result.remote === "draft") return settled("failed", { error: `${name} put the video in the account's inbox instead of posting it. Open ${name} to finish posting.` });
    const url = typeof result.link === "string" && result.link.startsWith("https://") ? result.link : null;
    return settled("published", { url, publishedAt: typeof result.at === "string" ? result.at : null });
  }
  if (result?.state === "failed") return settled("failed", { error: result.error ? `${name} refused this post through Humanlike: ${String(result.error).slice(0, 300)}` : `${name} refused this post through Humanlike.` });
  if (result?.state === "skipped") return settled("failed", { error: `Humanlike cannot post this to ${name} automatically.` });
  if (post.status === "failed") return settled("failed", { error: `Humanlike could not post this to ${name}.` });
  return { state: "pending", url: null, publishedAt: null, error: null };
}

export const humanlikeProvider: SocialProvider<Credentials> = {
  id: "humanlike",
  label: "Humanlike",
  platforms: PLATFORMS,
  credentialsSchema,
  provision: { available: (deps) => Boolean(deps.config.socials.humanlikePartner), make: provisionWorkspace },
  listAccounts,
  publish,
  postStatus,
};
