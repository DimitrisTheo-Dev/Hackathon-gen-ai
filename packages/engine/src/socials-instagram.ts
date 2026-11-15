import { z } from "zod";
import type { EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import type { PostStatus, ProviderAccount, SocialProvider } from "./socials.js";
import type { Row } from "./store.js";

/**
 * Instagram, connected directly: the person allows this deployment's own Meta app, and posts and messages go out
 * through Instagram's API with no service in between. A Meta app offers one of two setups, and this provider speaks
 * both (config.ts, `instagramLogin.mode`):
 *
 *   instagram  "Instagram API with Instagram Login". The person signs in at instagram.com; an Instagram user token
 *              (60 days, refreshable) calls graph.instagram.com, where `/me` names the account.
 *   unified    "Instagram API with Unified Login", the only one Meta offers apps created since late 2026. The person
 *              signs in with Instagram or Facebook through a Facebook Login for Business configuration; the token is
 *              a system user's, owned by the client's business portfolio, and calls graph.facebook.com with the
 *              account's ID spelled out.
 *
 * Written from Meta's documentation, read 15 November 2026 (developers.facebook.com/documentation/instagram-platform):
 *   sign-in     /instagram-api-with-instagram-login/business-login    code → 1-hour token → 60-day token, refreshable
 *               /instagram-api-with-unified-login/get-started, /authentication
 *                                                                     dialog/oauth?config_id → code → system-user token;
 *                                                                     /me/assigned_instagram_accounts names the accounts
 *   posting     /content-publishing                                   container → wait until FINISHED → media_publish
 *   messaging   /private-replies, /instagram-api-with-instagram-login/messaging-api
 *                                                                     <ig-id>/messages, to a comment or to a person
 *   activity    /webhooks/setup                                       <ig-id>/subscribed_apps for the account
 *
 * Only professional (business or creator) accounts can be connected, and only public posts can be made.
 */
const AUTHORIZE = "https://www.instagram.com/oauth/authorize";
const TOKEN = "https://api.instagram.com/oauth/access_token";
const INSTAGRAM_GRAPH = "https://graph.instagram.com";
const FACEBOOK_DIALOG = "https://www.facebook.com/dialog/oauth";
const FACEBOOK_GRAPH = "https://graph.facebook.com";
const VERSION = "v27.0";
/** The activity this studio understands (socials-webhooks.ts). Mentions arrive inside `comments` for this kind of app. */
const WEBHOOK_FIELDS = "comments,live_comments,messages,message_reactions,messaging_seen";
/** Refreshed once less than this is left of the 60 days. A token must also be a day old before it can be refreshed. */
const REFRESH_WHEN_LEFT_MS = 30 * 24 * 3600_000;
/** How long `publish` waits for Instagram to process the video before leaving the rest to the scheduler. */
export const instagramTiming = { pollMs: 5000, polls: 12 };

const token = z.string().min(10).max(2000);
const instant = z.iso.datetime({ offset: true });
const credentialsSchema = z.union([
  // Instagram Login: an Instagram user token, which also names the account (`/me`).
  z.object({ accessToken: token, expiresAt: instant }).strict(),
  // Unified Login: a system user's token for the client's business, used with the account's own ID.
  z.object({ api: z.literal("facebook"), accessToken: token, igUserId: z.string().regex(/^\d{1,32}$/), businessId: z.string().max(64).nullable(), expiresAt: instant.nullable() }).strict(),
]);
type Credentials = z.infer<typeof credentialsSchema>;
const unified = (credentials: Credentials): credentials is Extract<Credentials, { api: "facebook" }> => "api" in credentials;
/** The account in request paths: its ID with Unified login, `/me` with Instagram's own token. */
const owner = (credentials: Credentials) => (unified(credentials) ? credentials.igUserId : "me");

function app(deps: EngineDeps) {
  const config = deps.config.socials.instagramLogin;
  if (!config) throw new EngineError("provider_unavailable", "Connecting Instagram directly is not switched on for this deployment yet.");
  return config;
}
const reconnect = () => new EngineError("forbidden", "Instagram no longer accepts this connection. Connect the account again in the studio.");

/**
 * One call to Instagram. `unclear` is what a missing or unreadable answer means for the caller: a read can simply be
 * tried again, while a publish or a message that may have gone through must not be.
 */
async function call<T>(deps: EngineDeps, url: string, init: RequestInit, unclear: "provider_unavailable" | "unknown_outcome" = "provider_unavailable"): Promise<T> {
  const noAnswer = () => new EngineError(unclear, unclear === "unknown_outcome" ? "Instagram did not confirm whether this went through." : "Instagram could not be reached. Try again in a moment.");
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
  // 2534022: a message outside the window in which Instagram lets a business write to someone.
  if (error.error_subcode === 2534022) throw new EngineError("unsupported", "Instagram only lets an account message someone within 24 hours of their last message.");
  const detail = String(error.error_user_msg ?? error.message ?? "").slice(0, 300);
  throw new EngineError("validation_error", `Instagram did not accept this${detail ? `: ${detail}` : "."}`);
}
const notYet = (error: unknown) => error instanceof EngineError && (error.code === "provider_unavailable" || error.code === "quota_exceeded");
/** A Graph API call with the account's token, on the host its kind of token belongs to. */
function graph<T>(deps: EngineDeps, credentials: Credentials | { accessToken: string; api?: "facebook" }, method: "GET" | "POST", path: string, body?: Record<string, unknown>, unclear?: "provider_unavailable" | "unknown_outcome") {
  const host = "api" in credentials && credentials.api === "facebook" ? FACEBOOK_GRAPH : INSTAGRAM_GRAPH;
  return call<T>(deps, `${host}/${VERSION}${path}`, { method, headers: { Authorization: `Bearer ${credentials.accessToken}`, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined }, unclear);
}
/** When a token runs out. Instagram says how many seconds are left; 60 days is assumed if it does not. */
const expiry = (deps: EngineDeps, seconds: unknown) => new Date(deps.now().getTime() + (Number(seconds) > 0 ? Number(seconds) : 60 * 24 * 3600) * 1000).toISOString();

/* ───────────────────────── signing in ───────────────────────── */

function authorizeUrl(deps: EngineDeps, input: { redirectUri: string; state: string }) {
  const config = deps.config.socials.instagramLogin;
  if (!config) return null;
  if (config.mode === "unified")
    // What to ask for (accounts and permissions) lives in the configuration, not in the address.
    return `${FACEBOOK_DIALOG}?${new URLSearchParams({ client_id: config.appId, config_id: config.configId, redirect_uri: input.redirectUri, response_type: "code", override_default_response_type: "true", state: input.state })}`;
  return `${AUTHORIZE}?${new URLSearchParams({ client_id: config.appId, redirect_uri: input.redirectUri, response_type: "code", scope: config.scopes.join(","), state: input.state })}`;
}

async function complete(deps: EngineDeps, input: { code: string; redirectUri: string }): Promise<{ credentials: Credentials; account: ProviderAccount; subscribed: boolean }> {
  const config = app(deps);
  // The code is good once. Instagram appends "#_" to the address it returns to, Facebook "#_=_"; neither is part of it.
  const code = input.code.replace(/#_(=_)?$/, "");
  if (config.mode === "unified") return completeUnified(deps, config, code, input.redirectUri);
  const granted = await call<any>(deps, TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, grant_type: "authorization_code", redirect_uri: input.redirectUri, code }).toString(),
  });
  const short = (granted.data?.[0] ?? granted).access_token;
  if (typeof short !== "string" || !short) throw new EngineError("provider_unavailable", "Instagram did not return access for this sign-in. Start again.");
  // The 1-hour token is traded for the 60-day one straight away; only that one is kept.
  const long = await call<{ access_token: string; expires_in: number }>(deps, `${INSTAGRAM_GRAPH}/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.appSecret, access_token: short })}`, { method: "GET" });
  const answer = await graph<any>(deps, { accessToken: long.access_token }, "GET", "/me?fields=user_id,username,name,account_type");
  const profile = answer.data?.[0] ?? answer;
  // `user_id` is the professional account's ID, the one webhook deliveries name. (`id` is a different, app-scoped ID.)
  if (!profile?.user_id || !profile.username) throw new EngineError("validation_error", "Instagram did not describe this account. Only professional (business or creator) accounts can be connected.");
  const credentials = { accessToken: long.access_token, expiresAt: expiry(deps, long.expires_in) };
  // Ask for the account's comments and messages to be sent to this deployment. Best effort: posting works without it,
  // and the scheduler asks again until it takes (socials.ts, subscribeProviderAccounts).
  const subscribed = await subscribe(deps, credentials);
  return { credentials, account: accountFrom(String(profile.user_id), profile.username), subscribed };
}

const accountFrom = (id: string, username: string): ProviderAccount => ({ platform: "instagram", externalAccountId: id, providerAccountId: id, displayName: `@${username}`, profileUrl: `https://www.instagram.com/${encodeURIComponent(username)}/`, state: "connected" });

/**
 * Unified Login. The code is traded with the Meta app's own ID and secret for a system user's token; the token names
 * the Instagram accounts the person shared, and the first one is connected. (Signing in again and sharing a different
 * one connects that one too.)
 */
async function completeUnified(deps: EngineDeps, config: { appId: string; appSecret: string }, code: string, redirectUri: string) {
  const granted = await call<{ access_token?: string; expires_in?: number }>(deps, `${FACEBOOK_GRAPH}/${VERSION}/oauth/access_token?${new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, redirect_uri: redirectUri, code })}`, { method: "GET" });
  const accessToken = granted.access_token;
  if (typeof accessToken !== "string" || !accessToken) throw new EngineError("provider_unavailable", "Instagram did not return access for this sign-in. Start again.");
  const session = { api: "facebook" as const, accessToken };
  const assigned = await graph<{ data?: Array<{ id?: string; username?: string }> }>(deps, session, "GET", "/me/assigned_instagram_accounts?fields=id,username");
  const first = (assigned.data ?? []).find((entry) => typeof entry.id === "string" && /^\d{1,32}$/.test(entry.id) && typeof entry.username === "string" && entry.username);
  if (!first) throw new EngineError("validation_error", "No Instagram account was shared in this sign-in. Start again and choose the Instagram professional account to connect.");
  // The client's business portfolio owns the token; it is kept with it, as Meta asks, for managing the token later.
  const business = await graph<{ client_business_id?: string }>(deps, session, "GET", "/me?fields=client_business_id").catch(() => ({ client_business_id: undefined }));
  const credentials: Credentials = {
    api: "facebook",
    accessToken,
    igUserId: first.id!,
    businessId: typeof business.client_business_id === "string" ? business.client_business_id.slice(0, 64) : null,
    // The configuration decides how long it lasts; "never" is answered without `expires_in`.
    expiresAt: Number(granted.expires_in) > 0 ? expiry(deps, granted.expires_in) : null,
  };
  const subscribed = await subscribe(deps, credentials);
  return { credentials, account: accountFrom(first.id!, first.username!), subscribed };
}

/** Asks Instagram to send the account's activity here (socials-webhooks.ts reads it). True once Instagram says it will. */
async function subscribe(deps: EngineDeps, credentials: Credentials): Promise<boolean> {
  return graph<{ success?: boolean }>(deps, credentials, "POST", `/${owner(credentials)}/subscribed_apps?subscribed_fields=${WEBHOOK_FIELDS}`)
    .then((result) => result.success === true)
    .catch(() => false);
}

async function refresh(deps: EngineDeps, credentials: Credentials): Promise<Credentials | null> {
  // A system user's token is managed by its business, not refreshed here.
  if (unified(credentials) || new Date(credentials.expiresAt).getTime() - deps.now().getTime() > REFRESH_WHEN_LEFT_MS) return null;
  const renewed = await call<{ access_token: string; expires_in: number }>(deps, `${INSTAGRAM_GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: credentials.accessToken })}`, { method: "GET" });
  return { accessToken: renewed.access_token, expiresAt: expiry(deps, renewed.expires_in) };
}

/* ───────────────────────── posting ───────────────────────── */

const CONTAINER = "container:";
const containerStatus = (deps: EngineDeps, credentials: Credentials, container: string) => graph<{ status_code?: string; status?: string }>(deps, credentials, "GET", `/${encodeURIComponent(container)}?fields=status_code,status`);
const refused = (status: { status_code?: string; status?: string }) =>
  status.status_code === "EXPIRED" ? "Instagram stopped waiting for this video before it was published. Schedule it again." : `Instagram could not process this video${status.status ? ` (${String(status.status).slice(0, 200)})` : ""}.`;

/**
 * Publishes a container that finished processing. Null: Instagram says it is not ready yet. An answer that never
 * arrives is `unknown_outcome`; the container's own status then says whether the post went out.
 */
async function publishContainer(deps: EngineDeps, credentials: Credentials, container: string): Promise<{ mediaId: string; url: string | null } | null> {
  let published: { id?: string };
  try {
    published = await graph<{ id?: string }>(deps, credentials, "POST", `/${owner(credentials)}/media_publish`, { creation_id: container }, "unknown_outcome");
  } catch (error) {
    // Instagram said "not now": nothing was published, and the container can be published later.
    if (notYet(error)) return null;
    throw error;
  }
  if (!published.id) throw new EngineError("unknown_outcome", "Instagram did not confirm whether it published this post.");
  const media = await graph<{ permalink?: string }>(deps, credentials, "GET", `/${encodeURIComponent(published.id)}?fields=permalink`).catch(() => null);
  return { mediaId: published.id, url: typeof media?.permalink === "string" && media.permalink.startsWith("https://") ? media.permalink : null };
}

async function publish(deps: EngineDeps, input: Parameters<SocialProvider<Credentials>["publish"]>[1]) {
  const { payload, credentials } = input;
  // Instagram has no private posts. Posting publicly what was approved as private would break the approval.
  if (payload.visibility !== "public") throw new EngineError("unsupported", "Instagram can only post publicly. Set this post to public and approve the schedule again.");
  // Step one makes nothing public: Instagram fetches the video from the link and prepares it. A failure here is safe to retry.
  const { id: container } = await graph<{ id: string }>(deps, credentials, "POST", `/${owner(credentials)}/media`, { media_type: "REELS", video_url: input.mediaUrl, caption: payload.caption ?? "", share_to_feed: true, is_ai_generated: Boolean(payload.aiDisclosure) });
  if (!container) throw new EngineError("provider_unavailable", "Instagram did not accept the video. Try again in a moment.");
  const waiting = { providerPostId: `${CONTAINER}${container}`, state: "submitted" as const, url: null };
  for (let attempt = 0; attempt < instagramTiming.polls; attempt++) {
    const status = await containerStatus(deps, credentials, container).catch((error): { status_code?: string; status?: string } => {
      if (notYet(error)) return { status_code: "IN_PROGRESS" };
      throw error;
    });
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") throw new EngineError("validation_error", refused(status));
    if (status.status_code === "FINISHED") {
      try {
        const published = await publishContainer(deps, credentials, container);
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
  const status = await containerStatus(deps, input.credentials, container);
  if (status.status_code === "PUBLISHED") return done(null);
  if (status.status_code === "ERROR" || status.status_code === "EXPIRED") return { state: "failed", url: null, publishedAt: null, error: refused(status) };
  if (status.status_code !== "FINISHED") return { state: "pending", url: null, publishedAt: null, error: null };
  const published = await publishContainer(deps, input.credentials, container);
  return published ? done(published.url, published.mediaId) : { state: "pending", url: null, publishedAt: null, error: null };
}

/* ───────────────────────── messaging ───────────────────────── */

/**
 * Instagram's rules for a business writing to people, which socials-campaigns.ts plans around:
 *   - A comment can be answered with one private message, within 7 days of the comment.
 *   - Anything more waits until the person writes back, and then has to be sent within 24 hours of their message.
 * An answer that never arrives is `unknown_outcome`, so a message is never sent twice by retrying blindly.
 */
type MessagingInput = { credentials: Credentials; account: Row; text: string };
const MESSAGE_LIMIT = 1000;
const messageText = (text: string) => ({ text: text.slice(0, MESSAGE_LIMIT) });

async function privateReply(deps: EngineDeps, input: MessagingInput & { commentId: string }) {
  const sent = await graph<{ recipient_id?: string; message_id?: string }>(deps, input.credentials, "POST", `/${owner(input.credentials)}/messages`, { recipient: { comment_id: input.commentId }, message: messageText(input.text) }, "unknown_outcome");
  // The person's ID for messages (IGSID): their reply to this message arrives from it.
  return { recipientId: typeof sent.recipient_id === "string" ? sent.recipient_id : null, messageId: typeof sent.message_id === "string" ? sent.message_id : null };
}

async function sendMessage(deps: EngineDeps, input: MessagingInput & { recipientId: string }) {
  const sent = await graph<{ message_id?: string }>(deps, input.credentials, "POST", `/${owner(input.credentials)}/messages`, { recipient: { id: input.recipientId }, message: messageText(input.text) }, "unknown_outcome");
  return { messageId: typeof sent.message_id === "string" ? sent.message_id : null };
}

async function replyToComment(deps: EngineDeps, input: MessagingInput & { commentId: string }) {
  const sent = await graph<{ id?: string }>(deps, input.credentials, "POST", `/${encodeURIComponent(input.commentId)}/replies`, { message: input.text.slice(0, 2200) }, "unknown_outcome");
  return { commentId: typeof sent.id === "string" ? sent.id : null };
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
  messaging: { privateReply, send: sendMessage, replyToComment },
};
