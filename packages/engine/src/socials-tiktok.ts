import { z } from "zod";
import type { EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import { ChannelGrantExpired } from "./providers/youtube.js";
import type { PostStatus, ProviderAccount, PublishInput, SocialProvider } from "./socials.js";

/**
 * TikTok, connected directly: the person signs in to TikTok and allows this deployment's own TikTok app (Login Kit),
 * and videos go out through TikTok's Content Posting API with no service in between.
 *
 * Written from TikTok's documentation (developers.tiktok.com/doc):
 *   sign-in   /login-kit-web, /oauth-user-access-token-management   code → 24-hour token + 365-day refresh token
 *   account   /tiktok-api-v2-get-user-info                          `open_id` is the ID TikTok's webhooks name
 *   posting   /content-posting-api-reference-query-creator-info     what the account allows, asked before every post
 *             /content-posting-api-reference-direct-post            init → upload the file in chunks → TikTok publishes
 *             /content-posting-api-reference-get-video-status       where a post stands
 *
 * The video is uploaded from this server (FILE_UPLOAD), so no domain has to be verified with TikTok. Until TikTok
 * audits the app, it may only post privately (SELF_ONLY), to accounts that are themselves set to private; TikTok's
 * refusal says so and is shown as it is. Interactions (comments, duets, stitches) are off and nothing is declared
 * commercial: the studio does not ask for those choices, and TikTok wants them left off unless the person turns them on.
 */
const AUTHORIZE = "https://www.tiktok.com/v2/auth/authorize/";
const API = "https://open.tiktokapis.com/v2";
/** Renewed once less than this is left of the 24-hour access token. Sends renew it too, since the tick is daily. */
const REFRESH_WHEN_LEFT_MS = 60 * 60_000;
/** Videos are buffered so their size is known before TikTok is asked for an upload address. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
/** TikTok's chunk rules: one chunk below 5 MB or up to 64 MB; otherwise chunks of 5–64 MB, the last one taking the rest. */
const CHUNK_BYTES = 10 * 1024 * 1024;
const SINGLE_CHUNK_MAX = 64 * 1024 * 1024;
/** How long `publish` waits for TikTok to finish before leaving the rest to the scheduler. */
export const tiktokTiming = { pollMs: 5000, polls: 6 };
/** TikTok's privacy levels for the studio's visibility. TikTok has nothing like "unlisted". */
const PRIVACY: Record<string, string> = { public: "PUBLIC_TO_EVERYONE", private: "SELF_ONLY" };

const credentialsSchema = z.object({
  accessToken: z.string().min(10).max(2000),
  accessExpiresAt: z.iso.datetime({ offset: true }),
  refreshToken: z.string().min(10).max(2000),
  refreshExpiresAt: z.iso.datetime({ offset: true }),
  openId: z.string().min(1).max(200),
  scopes: z.array(z.string().max(80)).max(40),
}).strict();
type Credentials = z.infer<typeof credentialsSchema>;

class TikTokGrantExpired extends ChannelGrantExpired {
  constructor() {
    super();
    this.message = "TikTok no longer accepts this connection. Connect the TikTok account again in the studio; the approved post was not sent.";
  }
}

function app(deps: EngineDeps) {
  const config = deps.config.socials.tiktokLogin;
  if (!config) throw new EngineError("provider_unavailable", "Connecting TikTok directly is not switched on for this deployment yet.");
  return config;
}

/** TikTok's refusals that a person can act on, in plain words. */
const REFUSALS: Record<string, [EngineError["code"], string]> = {
  unaudited_client_can_only_post_to_private_accounts: ["unsupported", "Until TikTok reviews this app, it can only post privately, to a TikTok account that is set to private. Make the account private, set the post to private, and approve the schedule again."],
  privacy_level_option_mismatch: ["unsupported", "This TikTok account cannot post at the chosen visibility. Choose another one and approve the schedule again."],
  spam_risk_too_many_posts: ["quota_exceeded", "This TikTok account reached its daily limit of posts made through apps. It can post again tomorrow."],
  spam_risk_too_many_pending_share: ["quota_exceeded", "This TikTok account has too many posts still being processed. Try again later."],
  spam_risk_user_banned_from_posting: ["unsupported", "TikTok does not let this account post right now."],
  reached_active_user_cap: ["quota_exceeded", "TikTok's daily limit of accounts posting through this app has been reached. Try again tomorrow."],
  scope_not_authorized: ["forbidden", "TikTok was not allowed to post for this account. Connect it again and allow posting."],
  file_format_check_failed: ["unsupported", "TikTok did not accept this video file. Render it as an MP4 (H.264) and approve the schedule again."],
  duration_check_failed: ["unsupported", "This video is longer than the TikTok account allows."],
  frame_rate_check_failed: ["unsupported", "TikTok did not accept this video's frame rate."],
  picture_size_check_failed: ["unsupported", "TikTok did not accept this video's size."],
};

/**
 * TikTok sends post IDs as 64-bit JSON numbers, which lose their last digits as JavaScript numbers, so they are read
 * as text. Null: not JSON. Pure.
 */
export function parseAnswer(text: string): any {
  try {
    return JSON.parse(text.replace(/("publicaly_available_post_id"\s*:\s*\[)([^\]]*)\]/g, (_, head: string, list: string) => `${head}${list.replace(/-?\d+/g, (id) => `"${id}"`)}]`));
  } catch {
    return null;
  }
}

/**
 * One call to TikTok's API. Answers are `{ data, error: { code: "ok" | …, message, log_id } }`. A missing or unreadable
 * answer can be tried again: nothing becomes public until the whole file has been uploaded.
 */
async function api<T = Record<string, any>>(deps: EngineDeps, token: string, path: string, body?: Record<string, unknown>, method: "GET" | "POST" = "POST"): Promise<T> {
  let response: Response;
  try {
    response = await deps.fetch(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json; charset=UTF-8" } : {}) },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new EngineError("provider_unavailable", "TikTok could not be reached. Try again in a moment.");
  }
  const answer: any = parseAnswer(await response.text().catch(() => ""));
  const code = String(answer?.error?.code ?? "");
  if (response.ok && code === "ok") return (answer.data ?? {}) as T;
  if (code === "access_token_invalid" || response.status === 401) throw new TikTokGrantExpired();
  if (response.status === 429 || code === "rate_limit_exceeded") throw new EngineError("quota_exceeded", "TikTok's request limit has been reached. Try again later.");
  const known = REFUSALS[code];
  if (known) throw new EngineError(known[0], known[1]);
  if (!answer || response.status >= 500 || code === "internal_error") throw new EngineError("provider_unavailable", "TikTok could not be reached. Try again in a moment.");
  const detail = String(answer?.error?.message ?? code).slice(0, 300);
  throw new EngineError("validation_error", `TikTok did not accept this${detail ? `: ${detail}` : "."}`);
}

/** The token endpoint: a form in, `{ access_token, … }` or `{ error, error_description }` out. */
async function token(deps: EngineDeps, form: Record<string, string>, refusal: () => EngineError) {
  let response: Response;
  try {
    response = await deps.fetch(`${API}/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new EngineError("provider_unavailable", "TikTok could not be reached. Try again in a moment.");
  }
  const answer: any = await response.json().catch(() => null);
  if (response.ok && typeof answer?.access_token === "string" && typeof answer.refresh_token === "string" && typeof answer.open_id === "string") return answer;
  if (!answer || response.status >= 500) throw new EngineError("provider_unavailable", "TikTok could not be reached. Try again in a moment.");
  throw refusal();
}

const after = (deps: EngineDeps, seconds: unknown, fallback: number) => new Date(deps.now().getTime() + (Number(seconds) > 0 ? Number(seconds) : fallback) * 1000).toISOString();
function credentialsFrom(deps: EngineDeps, answer: any, previous?: Credentials): Credentials {
  return {
    accessToken: answer.access_token,
    accessExpiresAt: after(deps, answer.expires_in, 24 * 3600),
    refreshToken: answer.refresh_token,
    refreshExpiresAt: after(deps, answer.refresh_expires_in, 365 * 24 * 3600),
    openId: answer.open_id,
    scopes: typeof answer.scope === "string" ? answer.scope.split(",").map((scope: string) => scope.trim()).filter(Boolean) : (previous?.scopes ?? []),
  };
}

/* ───────────────────────── signing in ───────────────────────── */

function authorizeUrl(deps: EngineDeps, input: { redirectUri: string; state: string }) {
  const config = deps.config.socials.tiktokLogin;
  if (!config) return null;
  return `${AUTHORIZE}?${new URLSearchParams({ client_key: config.clientKey, response_type: "code", scope: config.scopes.join(","), redirect_uri: input.redirectUri, state: input.state })}`;
}

async function complete(deps: EngineDeps, input: { code: string; redirectUri: string }): Promise<{ credentials: Credentials; account: ProviderAccount; subscribed: boolean }> {
  const config = app(deps);
  const granted = await token(
    deps,
    { client_key: config.clientKey, client_secret: config.clientSecret, code: input.code, grant_type: "authorization_code", redirect_uri: input.redirectUri },
    () => new EngineError("validation_error", "TikTok did not accept this sign-in. It may have expired; start again."),
  );
  const credentials = credentialsFrom(deps, granted);
  if (!credentials.scopes.includes("video.publish")) throw new EngineError("forbidden", "TikTok was not allowed to post for this account. Connect it again and allow posting.");
  const profile = credentials.scopes.includes("user.info.profile");
  const { user } = await api<{ user?: Record<string, any> }>(deps, credentials.accessToken, `/user/info/?fields=${["open_id", "display_name", "avatar_url", ...(profile ? ["username"] : [])].join(",")}`, undefined, "GET");
  const username = typeof user?.username === "string" && /^[A-Za-z0-9._]{1,64}$/.test(user.username) ? user.username : null;
  return {
    credentials,
    account: {
      platform: "tiktok",
      // `open_id` is this app's ID for the account, and what TikTok's webhooks name (`user_openid`).
      externalAccountId: credentials.openId,
      providerAccountId: credentials.openId,
      displayName: username ? `@${username}` : String(user?.display_name || "TikTok account").slice(0, 200),
      profileUrl: username ? `https://www.tiktok.com/@${username}` : null,
      state: "connected",
    },
    // TikTok's webhooks are registered once for the whole app; every account that allowed it is covered.
    subscribed: Boolean(deps.config.socials.native.tiktok),
  };
}

async function refresh(deps: EngineDeps, credentials: Credentials): Promise<Credentials | null> {
  if (new Date(credentials.accessExpiresAt).getTime() - deps.now().getTime() > REFRESH_WHEN_LEFT_MS) return null;
  const config = app(deps);
  // A refresh token TikTok no longer takes (revoked, or a year old) means the person has to sign in again.
  const renewed = await token(deps, { client_key: config.clientKey, client_secret: config.clientSecret, grant_type: "refresh_token", refresh_token: credentials.refreshToken }, () => new TikTokGrantExpired());
  return credentialsFrom(deps, renewed, credentials);
}

/* ───────────────────────── posting ───────────────────────── */

async function readVideo(deps: EngineDeps, url: string) {
  let bytes: Uint8Array;
  try {
    const response = await deps.fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(String(response.status));
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw new EngineError("provider_unavailable", "The approved video could not be read from storage. Nothing was posted.");
  }
  if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) throw new EngineError("unsupported", "TikTok posts from here take videos of up to 512 MB. Nothing was posted.");
  return bytes;
}

/** How TikTok wants a file of `size` bytes cut. Pure. */
export function tiktokChunks(size: number) {
  if (size <= SINGLE_CHUNK_MAX) return { chunkSize: size, count: 1 };
  return { chunkSize: CHUNK_BYTES, count: Math.floor(size / CHUNK_BYTES) };
}

/**
 * Sends the file to TikTok's upload address. Returns false when the last piece went out but its answer did not come
 * back: TikTok may then publish it, so only its status can say what happened.
 */
async function upload(deps: EngineDeps, address: string, bytes: Uint8Array, mime: string): Promise<boolean> {
  const { chunkSize, count } = tiktokChunks(bytes.byteLength);
  for (let index = 0; index < count; index++) {
    const start = index * chunkSize;
    const end = index === count - 1 ? bytes.byteLength : start + chunkSize;
    const last = index === count - 1;
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2 && !response?.ok; attempt++) {
      try {
        response = await deps.fetch(address, {
          method: "PUT",
          headers: { "Content-Type": mime, "Content-Length": String(end - start), "Content-Range": `bytes ${start}-${end - 1}/${bytes.byteLength}` },
          body: bytes.slice(start, end),
          signal: AbortSignal.timeout(300_000),
        });
        if (response.status >= 400 && response.status < 500) throw new EngineError("unsupported", "TikTok did not accept this video file. Nothing was posted.");
      } catch (error) {
        if (error instanceof EngineError) throw error;
        response = null;
      }
    }
    if (!response?.ok) {
      // Before the last piece nothing can be published, so the whole post can simply be tried again.
      if (!last) throw new EngineError("provider_unavailable", "The video could not be uploaded to TikTok. Try again in a moment.");
      return false;
    }
  }
  return true;
}

async function status(deps: EngineDeps, accessToken: string, publishId: string) {
  return api<{ status?: string; fail_reason?: string; publicaly_available_post_id?: unknown[] }>(deps, accessToken, "/post/publish/status/fetch/", { publish_id: publishId });
}

/** What a status means for the studio. Null: still being processed. */
function settled(deps: EngineDeps, account: Record<string, any>, answer: Awaited<ReturnType<typeof status>>): PostStatus | null {
  if (answer.status === "PUBLISH_COMPLETE") {
    // Only a public post has an ID anyone can open; the address needs the account's @name.
    const id = Array.isArray(answer.publicaly_available_post_id) ? String(answer.publicaly_available_post_id[0] ?? "") : "";
    const handle = /^https:\/\/www\.tiktok\.com\/@([A-Za-z0-9._]{1,64})$/.exec(String(account.profile_url ?? ""))?.[1];
    return { state: "published", url: id && handle ? `https://www.tiktok.com/@${handle}/video/${id}` : null, publishedAt: deps.now().toISOString(), error: null, ...(id ? { providerPostId: id } : {}) };
  }
  if (answer.status === "FAILED") {
    const reason = String(answer.fail_reason ?? "");
    return { state: "failed", url: null, publishedAt: null, error: REFUSALS[reason]?.[1] ?? `TikTok could not publish this video${reason ? ` (${reason.slice(0, 120)})` : ""}.` };
  }
  if (answer.status === "SEND_TO_USER_INBOX") return { state: "failed", url: null, publishedAt: null, error: "TikTok put the video in the account's inbox instead of posting it. Open TikTok to finish posting." };
  return null;
}

async function publish(deps: EngineDeps, input: PublishInput & { credentials: Credentials }) {
  const { payload, account } = input;
  const accessToken = input.credentials.accessToken;
  const privacy = PRIVACY[String(payload.visibility)];
  if (!privacy) throw new EngineError("unsupported", "TikTok has no unlisted posts. Set this post to public or private and approve the schedule again.");
  // TikTok asks before every post what this account allows right now.
  const creator = await api<Record<string, any>>(deps, accessToken, "/post/publish/creator_info/query/");
  if (Array.isArray(creator.privacy_level_options) && !creator.privacy_level_options.includes(privacy))
    throw new EngineError("unsupported", `This TikTok account cannot post ${privacy === "SELF_ONLY" ? "privately" : "publicly"} right now. Choose the other visibility and approve the schedule again.`);
  const longest = Number(creator.max_video_post_duration_sec);
  if (Number.isFinite(longest) && longest > 0 && Number(input.mediaDurationSeconds) > longest) throw new EngineError("unsupported", `This TikTok account takes videos of up to ${longest} seconds. Nothing was sent.`);

  const bytes = await readVideo(deps, input.mediaUrl);
  const { chunkSize, count } = tiktokChunks(bytes.byteLength);
  // Starting a post makes nothing public: TikTok waits for the whole file. A failure here is safe to retry.
  const started = await api<{ publish_id?: string; upload_url?: string }>(deps, accessToken, "/post/publish/video/init/", {
    post_info: {
      title: String(payload.caption ?? ""),
      privacy_level: privacy,
      disable_comment: true,
      disable_duet: true,
      disable_stitch: true,
      brand_content_toggle: false,
      brand_organic_toggle: false,
      is_aigc: Boolean(payload.aiDisclosure),
    },
    source_info: { source: "FILE_UPLOAD", video_size: bytes.byteLength, chunk_size: chunkSize, total_chunk_count: count },
  });
  if (!started.publish_id || typeof started.upload_url !== "string" || !started.upload_url.startsWith("https://"))
    throw new EngineError("provider_unavailable", "TikTok did not hand over a place to upload the video. Try again in a moment.");
  const waiting = { providerPostId: started.publish_id, state: "submitted" as const, url: null };
  if (!(await upload(deps, started.upload_url, bytes, (input.mediaMime ?? "video/mp4").toLowerCase()))) return waiting;

  for (let attempt = 0; attempt < tiktokTiming.polls; attempt++) {
    if (tiktokTiming.pollMs) await new Promise((resolve) => setTimeout(resolve, tiktokTiming.pollMs));
    const answer = await status(deps, accessToken, started.publish_id).catch(() => null);
    const outcome = answer && settled(deps, account, answer);
    if (outcome?.state === "published") return { providerPostId: outcome.providerPostId ?? started.publish_id, state: "verified_published" as const, url: outcome.url };
    if (outcome?.state === "failed") throw new EngineError("validation_error", outcome.error ?? "TikTok could not publish this video.");
  }
  // Still processing: the scheduler asks again on a later run (`postStatus`).
  return waiting;
}

async function postStatus(deps: EngineDeps, input: { credentials: Credentials; account: Record<string, any>; providerPostId: string }): Promise<PostStatus> {
  return settled(deps, input.account, await status(deps, input.credentials.accessToken, input.providerPostId)) ?? { state: "pending", url: null, publishedAt: null, error: null };
}

export const tiktokProvider: SocialProvider<Credentials> = {
  id: "tiktok",
  label: "TikTok",
  platforms: ["tiktok"],
  credentialsSchema,
  signIn: { authorizeUrl, complete },
  refresh,
  publish,
  postStatus,
};
