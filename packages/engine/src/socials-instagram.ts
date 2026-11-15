import { z } from "zod";
import type { EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import type { PostStatus, ProviderAccount, SocialProvider } from "./socials.js";

/**
 * Instagram, connected directly: the person signs in to Instagram and allows this deployment's own app
 * ("Instagram API with Instagram Login"), and posts go out through Instagram's API with no service in between.
 *
 * Written from Meta's documentation, read 15 November 2026 (developers.facebook.com/documentation/instagram-platform):
 *   sign-in     /instagram-api-with-instagram-login/business-login   code → 1-hour token → 60-day token, refreshable
 *   account     /instagram-api-with-instagram-login/get-started      /me: `user_id` is the ID webhooks name
 *   posting     /content-publishing, /reference ig-user/media        container → wait until FINISHED → media_publish
 *   activity    /webhooks/setup, /webhooks/fields                    /subscribed_apps for the account
 *
 * Only professional (business or creator) accounts can be connected, and only public posts can be made.
 */
const AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const TOKEN = "https://api.instagram.com/oauth/access_token";
const GRAPH = "https://graph.instagram.com";
const VERSION = "v27.0";
/** The activity this studio understands (socials-webhooks.ts). Mentions arrive inside `comments` for this kind of app. */
const WEBHOOK_FIELDS = "comments,live_comments,messages,message_reactions,messaging_seen";
/** Refreshed once less than this is left of the 60 days. A token must also be a day old before it can be refreshed. */
const REFRESH_WHEN_LEFT_MS = 30 * 24 * 3600_000;
/** How long `publish` waits for Instagram to process the video before leaving the rest to the scheduler. */
export const instagramTiming = { pollMs: 5000, polls: 12 };

const credentialsSchema = z.object({ accessToken: z.string().min(10).max(2000), expiresAt: z.iso.datetime({ offset: true }) }).strict();
type Credentials = z.infer<typeof credentialsSchema>;

function app(deps: EngineDeps) {
  const config = deps.config.socials.instagramLogin;
  if (!config) throw new EngineError("provider_unavailable", "Connecting Instagram directly is not switched on for this deployment yet.");
  return config;
}
const reconnect = () => new EngineError("forbidden", "Instagram no longer accepts this connection. Connect the account again in the studio.");

/**
 * One call to Instagram. `unclear` is what a missing or unreadable answer means for the caller: a read can simply be
 * tried again, while a publish that may have gone through must not be.
 */
async function call<T>(deps: EngineDeps, url: string, init: RequestInit, unclear: "provider_unavailable" | "unknown_outcome" = "provider_unavailable"): Promise<T> {
  const noAnswer = () => new EngineError(unclear, unclear === "unknown_outcome" ? "Instagram did not confirm whether it published this post." : "Instagram could not be reached. Try again in a moment.");
  let response: Response;
  try {
    response = await deps.fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw noAnswer();
  }
  const body: any = await response.json().catch(() => null);
  // Graph errors are `{ error: { message, code, error_subcode, is_transient, error_user_msg } }`; the sign-in endpoint uses `{ error_type, code, error_message }`.
  const error = body?.error ?? (body?.error_type ? { message: body.error_message, code: body.code } : null);
  if (response.ok && body && !error) return body as T;
  if (!error) throw noAnswer();
  // An explicit refusal: whatever was asked did not happen.
  if (error.code === 190) throw reconnect();
  // 4, 17, 32 and 613 are request limits; 2207042 is the account's daily limit of posts made through the API.
  if (response.status === 429 || [4, 17, 32, 613].includes(error.code) || error.error_subcode === 2207042)
    throw new EngineError("quota_exceeded", error.error_subcode === 2207042 ? "This Instagram account reached its daily limit of posts made through an app. It can post again tomorrow." : "Instagram's request limit has been reached. Try again later.");
  // 2207027: the video is still being prepared. The others are Instagram's own "try again" errors.
  if (error.is_transient || error.error_subcode === 2207027 || [-2, -1, 1, 2].includes(error.code)) throw new EngineError("provider_unavailable", "Instagram is not ready yet. Try again in a moment.");
  const detail = String(error.error_user_msg ?? error.message ?? "").slice(0, 300);
  throw new EngineError("validation_error", `Instagram did not accept this${detail ? `: ${detail}` : "."}`);
}
const notYet = (error: unknown) => error instanceof EngineError && (error.code === "provider_unavailable" || error.code === "quota_exceeded");
const graph = <T>(deps: EngineDeps, token: string, method: "GET" | "POST", path: string, body?: Record<string, unknown>, unclear?: "provider_unavailable" | "unknown_outcome") =>
  call<T>(deps, `${GRAPH}/${VERSION}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }, unclear);
/** When a 60-day token runs out. Instagram says how many seconds are left; 60 days is assumed if it does not. */
const expiry = (deps: EngineDeps, seconds: unknown) => new Date(deps.now().getTime() + (Number(seconds) > 0 ? Number(seconds) : 60 * 24 * 3600) * 1000).toISOString();

/* ───────────────────────── signing in ───────────────────────── */

function authorizeUrl(deps: EngineDeps, input: { redirectUri: string; state: string }) {
  const config = deps.config.socials.instagramLogin;
  if (!config) return null;
  return `${AUTHORIZE}?${new URLSearchParams({ client_id: config.appId, redirect_uri: input.redirectUri, response_type: "code", scope: config.scopes.join(","), state: input.state })}`;
}

async function complete(deps: EngineDeps, input: { code: string; redirectUri: string }): Promise<{ credentials: Credentials; account: ProviderAccount; subscribed: boolean }> {
  const config = app(deps);
  // The code is good once, for an hour. Instagram appends "#_" to the address it returns to; that is not part of it.
  const code = input.code.replace(/#_$/, "");
  const granted = await call<any>(deps, TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, grant_type: "authorization_code", redirect_uri: input.redirectUri, code }).toString(),
  });
  const short = (granted.data?.[0] ?? granted).access_token;
  if (typeof short !== "string" || !short) throw new EngineError("provider_unavailable", "Instagram did not return access for this sign-in. Start again.");
  // The 1-hour token is traded for the 60-day one straight away; only that one is kept.
  const long = await call<{ access_token: string; expires_in: number }>(deps, `${GRAPH}/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.appSecret, access_token: short })}`, { method: "GET" });
  const answer = await graph<any>(deps, long.access_token, "GET", "/me?fields=user_id,username,name,account_type");
  const profile = answer.data?.[0] ?? answer;
  // `user_id` is the professional account's ID, the one webhook deliveries name. (`id` is a different, app-scoped ID.)
  if (!profile?.user_id || !profile.username) throw new EngineError("validation_error", "Instagram did not describe this account. Only professional (business or creator) accounts can be connected.");
  const credentials = { accessToken: long.access_token, expiresAt: expiry(deps, long.expires_in) };
  // Ask for the account's comments and messages to be sent to this deployment. Best effort: posting works without it,
  // and the scheduler asks again until it takes (socials.ts, subscribeProviderAccounts).
  const subscribed = await subscribe(deps, credentials);
  return {
    credentials,
    account: { platform: "instagram", externalAccountId: String(profile.user_id), providerAccountId: String(profile.user_id), displayName: `@${profile.username}`, profileUrl: `https://www.instagram.com/${encodeURIComponent(profile.username)}/`, state: "connected" },
    subscribed,
  };
}

/** Asks Instagram to send the account's activity here (socials-webhooks.ts reads it). True once Instagram says it will. */
async function subscribe(deps: EngineDeps, credentials: Credentials): Promise<boolean> {
  return graph<{ success?: boolean }>(deps, credentials.accessToken, "POST", `/me/subscribed_apps?subscribed_fields=${WEBHOOK_FIELDS}`)
    .then((result) => result.success === true)
    .catch(() => false);
}

async function refresh(deps: EngineDeps, credentials: Credentials): Promise<Credentials | null> {
  if (new Date(credentials.expiresAt).getTime() - deps.now().getTime() > REFRESH_WHEN_LEFT_MS) return null;
  const renewed = await call<{ access_token: string; expires_in: number }>(deps, `${GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: credentials.accessToken })}`, { method: "GET" });
  return { accessToken: renewed.access_token, expiresAt: expiry(deps, renewed.expires_in) };
}

/* ───────────────────────── posting ───────────────────────── */

const CONTAINER = "container:";
const containerStatus = (deps: EngineDeps, token: string, container: string) => graph<{ status_code?: string; status?: string }>(deps, token, "GET", `/${encodeURIComponent(container)}?fields=status_code,status`);
const refused = (status: { status_code?: string; status?: string }) =>
  status.status_code === "EXPIRED" ? "Instagram stopped waiting for this video before it was published. Schedule it again." : `Instagram could not process this video${status.status ? ` (${String(status.status).slice(0, 200)})` : ""}.`;

/**
 * Publishes a container that finished processing. Null: Instagram says it is not ready yet. An answer that never
 * arrives is `unknown_outcome`; the container's own status then says whether the post went out.
 */
async function publishContainer(deps: EngineDeps, token: string, container: string): Promise<{ mediaId: string; url: string | null } | null> {
  let published: { id?: string };
  try {
    published = await graph<{ id?: string }>(deps, token, "POST", "/me/media_publish", { creation_id: container }, "unknown_outcome");
  } catch (error) {
    // Instagram said "not now": nothing was published, and the container can be published later.
    if (notYet(error)) return null;
    throw error;
  }
  if (!published.id) throw new EngineError("unknown_outcome", "Instagram did not confirm whether it published this post.");
  const media = await graph<{ permalink?: string }>(deps, token, "GET", `/${encodeURIComponent(published.id)}?fields=permalink`).catch(() => null);
  return { mediaId: published.id, url: typeof media?.permalink === "string" && media.permalink.startsWith("https://") ? media.permalink : null };
}

async function publish(deps: EngineDeps, input: Parameters<SocialProvider<Credentials>["publish"]>[1]) {
  const { payload } = input;
  const token = input.credentials.accessToken;
  // Instagram has no private posts. Posting publicly what was approved as private would break the approval.
  if (payload.visibility !== "public") throw new EngineError("unsupported", "Instagram can only post publicly. Set this post to public and approve the schedule again.");
  // Step one makes nothing public: Instagram fetches the video from the link and prepares it. A failure here is safe to retry.
  const { id: container } = await graph<{ id: string }>(deps, token, "POST", "/me/media", { media_type: "REELS", video_url: input.mediaUrl, caption: payload.caption ?? "", share_to_feed: true, is_ai_generated: Boolean(payload.aiDisclosure) });
  if (!container) throw new EngineError("provider_unavailable", "Instagram did not accept the video. Try again in a moment.");
  const waiting = { providerPostId: `${CONTAINER}${container}`, state: "submitted" as const, url: null };
  for (let attempt = 0; attempt < instagramTiming.polls; attempt++) {
    const status = await containerStatus(deps, token, container).catch((error): { status_code?: string; status?: string } => {
      if (notYet(error)) return { status_code: "IN_PROGRESS" };
      throw error;
    });
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw new EngineError("validation_error", refused(status));
    if (status.status_code === "FINISHED") {
      try {
        const published = await publishContainer(deps, token, container);
        if (published) return { providerPostId: published.mediaId, state: "verified_published" as const, url: published.url };
      } catch (error) {
        // Unclear whether it went out. The scheduler asks the container on its next run: PUBLISHED means it did.
        if (error instanceof EngineError && error.code === "unknown_outcome") return waiting;
        throw error;
      }
    }
    if (instagramTiming.pollMs) await new Promise((resolve) => setTimeout(resolve, instagramTiming.pollMs));
  }
  // Still processing. The scheduler finishes it (`postStatus`) on a later run, within the day Instagram keeps a container.
  return waiting;
}

async function postStatus(deps: EngineDeps, input: { credentials: Credentials; providerPostId: string }): Promise<PostStatus> {
  const done = (url: string | null, providerPostId?: string): PostStatus => ({ state: "published", url, publishedAt: deps.now().toISOString(), error: null, providerPostId });
  if (!input.providerPostId.startsWith(CONTAINER)) return done(null);
  const container = input.providerPostId.slice(CONTAINER.length);
  const token = input.credentials.accessToken;
  const status = await containerStatus(deps, token, container);
  if (status.status_code === "PUBLISHED") return done(null);
  if (status.status_code === "ERROR" || status.status_code === "EXPIRED") return { state: "failed", url: null, publishedAt: null, error: refused(status) };
  if (status.status_code !== "FINISHED") return { state: "pending", url: null, publishedAt: null, error: null };
  const published = await publishContainer(deps, token, container);
  return published ? done(published.url, published.mediaId) : { state: "pending", url: null, publishedAt: null, error: null };
}

export const instagramProvider: SocialProvider<Credentials> = {
  id: "instagram",
  label: "Instagram",
  platforms: ["instagram"],
  credentialsSchema,
  signIn: { authorizeUrl, complete },
  subscribe,
  refresh,
  publish,
  postStatus,
};
