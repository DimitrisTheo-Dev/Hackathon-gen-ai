import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { audit, requireHuman, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import type { Publisher } from "./schedule.js";
import { bufferProvider } from "./socials-buffer.js";
import { instagramProvider } from "./socials-instagram.js";
import type { Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * Social accounts, served under /v1/socials. Three lists drive everything here, and each grows by one entry:
 *
 *   SOCIAL_PLATFORMS   where content and conversations happen (TikTok, Instagram, ...)
 *   socialProviders    how a platform is reached: through Buffer, or directly (Instagram so far)
 *   SOCIAL_EVENT_TYPES what can happen on an account (socials-events.ts)
 *
 * A connected account is one row in `provider_connections`. It names its platform and the provider it was
 * connected through, so the same Instagram account can be reached through Buffer now and directly later.
 * Posting never happens here: it goes through the approved schedule (schedule.ts), which asks this module
 * for the account's publisher.
 */
export const SOCIAL_PLATFORMS = {
  tiktok: { label: "TikTok", kind: "social" },
  instagram: { label: "Instagram", kind: "social" },
  linkedin: { label: "LinkedIn", kind: "social" },
  youtube: { label: "YouTube", kind: "social" },
  // A messaging channel rather than a feed: no posts, comments or likes, only messages. It lives in this
  // list because it shares the accounts, the providers and the webhook pipeline; `kind` tells clients apart.
  whatsapp: { label: "WhatsApp", kind: "messaging" },
} as const satisfies Record<string, { label: string; kind: "social" | "messaging" }>;
export type SocialPlatform = keyof typeof SOCIAL_PLATFORMS;
export const socialPlatformIds = Object.keys(SOCIAL_PLATFORMS) as SocialPlatform[];
export const isSocialPlatform = (value: string): value is SocialPlatform => Object.hasOwn(SOCIAL_PLATFORMS, value);

/** One account as a provider reports it. */
export interface ProviderAccount {
  platform: SocialPlatform;
  /** The account's own ID on the platform. Stable across providers, and what webhook deliveries name. */
  externalAccountId: string;
  /** The provider's handle for the account (a Buffer channel ID), used when posting through it. */
  providerAccountId: string;
  displayName: string;
  profileUrl: string | null;
  state: "connected" | "unavailable";
}
export interface PublishInput {
  credentials: any;
  account: Row;
  /** Stable per publish job, for providers that accept an idempotency key. */
  attemptKey: string;
  mediaUrl: string;
  /** The approved copy: caption, title, visibility, aiDisclosure. */
  payload: Row;
  scheduledAt: string;
}
export interface PostStatus {
  state: "pending" | "published" | "failed";
  url: string | null;
  publishedAt: string | null;
  error: string | null;
  /** The post's final ID, when it differs from the one `publish` returned (a post that was still being prepared). */
  providerPostId?: string;
}
/**
 * One way of reaching social platforms. To add a provider, implement this and add it to `socialProviders`.
 * Failures are EngineErrors: `quota_exceeded` and `provider_unavailable` are retried by the scheduler, anything
 * else fails the post with the message shown to the person.
 *
 * A provider is connected in one of two ways: a person pastes credentials for a service that already holds their
 * accounts (`listAccounts`, Buffer), or signs in to the platform itself and allows this deployment's app (`signIn`).
 */
export interface SocialProvider<Credentials = any> {
  id: string;
  label: string;
  /** Platforms this provider can connect and post to. */
  platforms: SocialPlatform[];
  /** The credentials kept for an account. Stored encrypted, never returned. For `listAccounts`, also what the person supplies. */
  credentialsSchema: z.ZodType<Credentials>;
  /** Checks pasted credentials with the provider and lists the accounts they reach. */
  listAccounts?(deps: EngineDeps, credentials: Credentials): Promise<ProviderAccount[]>;
  signIn?: {
    /** Where to send the person to allow access. Null: this deployment has no app registered with the platform. */
    authorizeUrl(deps: EngineDeps, input: { redirectUri: string; state: string }): string | null;
    /** Trades the one-time code the platform sent back for credentials, and names the account they belong to. */
    complete(deps: EngineDeps, input: { code: string; redirectUri: string }): Promise<{ credentials: Credentials; account: ProviderAccount; subscribed?: boolean }>;
  };
  /**
   * Asks the platform to send the account's activity (comments, messages) to this deployment. True once it will.
   * Asked when the account is connected, and again by the scheduler until it takes (subscribeProviderAccounts).
   */
  subscribe?(deps: EngineDeps, credentials: Credentials): Promise<boolean>;
  /** Keeps credentials that run out alive: the credentials to store from now on, or null when there is nothing to do yet. */
  refresh?(deps: EngineDeps, credentials: Credentials): Promise<Credentials | null>;
  /** Submits one approved post. Must not post twice for the same `attemptKey`. */
  publish(deps: EngineDeps, input: PublishInput): Promise<{ providerPostId: string; state: "submitted" | "verified_published"; url: string | null }>;
  /** Where a submitted post stands. Without it, a post stays "submitted". */
  postStatus?(deps: EngineDeps, input: { credentials: Credentials; account: Row; providerPostId: string }): Promise<PostStatus>;
}
export const socialProviders: Record<string, SocialProvider> = {
  [bufferProvider.id]: bufferProvider,
  [instagramProvider.id]: instagramProvider,
};

/* ───────────────────────── stored credentials ───────────────────────── */

const b64 = (bytes: Buffer) => bytes.toString("base64url");
function credentialKey(deps: EngineDeps) {
  const key = deps.config.socials.credentialKey;
  if (!key) throw new EngineError("provider_unavailable", "Connecting social accounts is not switched on for this deployment yet.");
  return key;
}
/** AES-256-GCM. The workspace and provider are bound in, so a ciphertext copied to another row does not open. */
function seal(key: Buffer, orgId: string, providerId: string, credentials: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`${orgId}:${providerId}`));
  const body = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(body)].join(".");
}
function open(key: Buffer, account: Row): unknown {
  try {
    const [version, iv, tag, body] = String(account.credentials_ciphertext ?? "").split(".");
    if (version !== "v1") throw new Error("unknown format");
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(`${account.org_id}:${account.provider}`));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8"));
  } catch {
    throw new EngineError("forbidden", `The saved ${account.provider} connection can no longer be read. Connect it again in the studio.`);
  }
}

/* ───────────────────────── reads ───────────────────────── */

const accountView = (row: Row) => ({
  id: row.id as string,
  platform: row.platform as SocialPlatform,
  provider: row.provider as string,
  displayName: row.display_name as string,
  profileUrl: (row.profile_url as string | null) ?? null,
  state: row.state as "connected" | "expired" | "unavailable",
  // When the platform was last asked to send this account's activity here. Null: it was never asked, or refused.
  webhookSubscribedAt: row.webhook_renewed_at ? new Date(row.webhook_renewed_at).toISOString() : null,
  connectedAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});
const providersFor = (platform: SocialPlatform) => Object.values(socialProviders).filter((provider) => provider.platforms.includes(platform));
/** A provider a workspace could connect on this deployment: credentials can be stored, and a sign-in provider has its app. */
const usable = (deps: EngineDeps, provider: SocialProvider) => Boolean(deps.config.socials.credentialKey) && (!provider.signIn || signInAddress(deps, provider) !== null);
export const usableProviders = (deps: EngineDeps) => Object.values(socialProviders).filter((provider) => usable(deps, provider)).map((provider) => provider.id);
/** True when some provider could post to this platform on this deployment, whether or not an account is connected yet. */
export function publishingAvailable(deps: EngineDeps, platform: string) {
  return isSocialPlatform(platform) && providersFor(platform).some((provider) => usable(deps, provider));
}
function platformView(deps: EngineDeps, id: SocialPlatform, accounts: Row[]) {
  const base = deps.config.appBaseUrl;
  return {
    id,
    ...SOCIAL_PLATFORMS[id],
    providers: providersFor(id).map((provider) => provider.id),
    accounts: accounts.filter((row) => row.platform === id).map(accountView),
    // Where this platform's activity is delivered (socials-events.ts), and whether its own format is accepted there.
    webhookUrl: base ? `${base}/v1/socials/${id}/webhook` : null,
    nativeWebhook: Boolean(deps.config.socials.native[id]),
  };
}
function requirePlatform(id: string): SocialPlatform {
  if (!isSocialPlatform(id)) throw new EngineError("not_found", "This platform is not supported.");
  return id;
}
function requireProvider(id: string): SocialProvider {
  if (!Object.hasOwn(socialProviders, id)) throw new EngineError("not_found", "This provider is not supported.");
  return socialProviders[id];
}

/** GET /v1/socials: every platform with this workspace's accounts, and every provider. */
export async function listSocials(deps: EngineDeps, ctx: Ctx) {
  requireScope(ctx, "campaign:read");
  const accounts = await deps.store.select("provider_connections", { org_id: ctx.org.id }, { order: ["created_at", "asc"] });
  return {
    platforms: socialPlatformIds.map((id) => platformView(deps, id, accounts)),
    providers: Object.values(socialProviders).map((provider) => ({
      id: provider.id,
      label: provider.label,
      platforms: provider.platforms,
      // How a person connects it: by pasting credentials, or by signing in to the platform.
      connect: provider.signIn ? ("sign_in" as const) : ("credentials" as const),
      available: usable(deps, provider),
      connected: accounts.some((row) => row.provider === provider.id),
    })),
    /** Whether THIS caller may connect or remove accounts (a signed-in owner or admin). */
    canManage: ctx.principal.kind === "human" && ctx.scopes.has("connections:manage"),
  };
}

/** GET /v1/socials/:platform. */
export async function getSocialPlatform(deps: EngineDeps, ctx: Ctx, platformId: string) {
  requireScope(ctx, "campaign:read");
  const platform = requirePlatform(platformId);
  return platformView(deps, platform, await deps.store.select("provider_connections", { org_id: ctx.org.id, platform }, { order: ["created_at", "asc"] }));
}

/* ───────────────────────── connecting ───────────────────────── */

function requireManager(ctx: Ctx, action: string) {
  requireHuman(ctx, action);
  requireScope(ctx, "connections:manage");
}

/** Brings this workspace's rows in line with what the provider reports. Accounts that disappeared are kept, marked unavailable. */
async function saveAccounts(deps: EngineDeps, ctx: Ctx, provider: SocialProvider, credentials: unknown, found: ProviderAccount[]) {
  const ciphertext = seal(credentialKey(deps), ctx.org.id, provider.id, credentials);
  const now = deps.now().toISOString();
  const existing = await deps.store.select("provider_connections", { org_id: ctx.org.id, provider: provider.id });
  const same = (row: Row, account: ProviderAccount) => row.platform === account.platform && row.external_account_id === account.externalAccountId;
  for (const account of found) {
    const patch = { display_name: account.displayName.slice(0, 200), provider_account_id: account.providerAccountId, profile_url: account.profileUrl, state: account.state, credentials_ciphertext: ciphertext, updated_at: now };
    const current = existing.find((row) => same(row, account));
    if (current) {
      await deps.store.update("provider_connections", { id: current.id, org_id: ctx.org.id }, patch);
      continue;
    }
    try {
      await deps.store.insert("provider_connections", {
        id: crypto.randomUUID(),
        org_id: ctx.org.id,
        platform: account.platform,
        provider: provider.id,
        external_account_id: account.externalAccountId,
        scopes: [],
        created_by: (ctx.principal as { userId: string }).userId,
        created_at: now,
        ...patch,
      });
    } catch (error) {
      // Two connects at once: the other one inserted this account first, with the same credentials.
      if (!(error instanceof StoreConflict)) throw error;
    }
  }
  for (const row of existing.filter((row) => !found.some((account) => same(row, account))))
    await deps.store.update("provider_connections", { id: row.id, org_id: ctx.org.id }, { state: "unavailable", credentials_ciphertext: ciphertext, updated_at: now });
  const rows = await deps.store.select("provider_connections", { org_id: ctx.org.id, provider: provider.id }, { order: ["created_at", "asc"] });
  return { provider: provider.id, accounts: rows.map(accountView) };
}

async function accountsFrom(deps: EngineDeps, provider: SocialProvider, credentials: unknown) {
  if (!provider.listAccounts) throw new EngineError("unsupported", `${provider.label} accounts are connected by signing in, one at a time.`);
  // Only the platforms in SOCIAL_PLATFORMS are kept; a provider may reach others this studio does not use yet.
  return (await provider.listAccounts(deps, credentials)).filter((account) => isSocialPlatform(account.platform) && provider.platforms.includes(account.platform));
}

/* Signing in. The person leaves for the platform and comes back with a one-time code, so three things must hold
 * when they return: the request was started here, by them, for this workspace, and recently. `state` carries that,
 * signed, and the connection is only completed by the same signed-in person (completeSocialSignIn). */

const SIGN_IN_MINUTES = 15;
const stateSignature = (key: Buffer, payload: string) => createHmac("sha256", key).update(`socials-sign-in:${payload}`).digest();
/** The address the platform sends the person back to. Null: the provider cannot be signed in to on this deployment. */
function signInAddress(deps: EngineDeps, provider: SocialProvider) {
  const base = deps.config.appBaseUrl;
  if (!provider.signIn || !base) return null;
  const redirectUri = `${base}/v1/socials/providers/${provider.id}/callback`;
  return provider.signIn.authorizeUrl(deps, { redirectUri, state: "-" }) === null ? null : redirectUri;
}
function readState(deps: EngineDeps, state: string): { org: string; user: string; provider: string; expires: number } | null {
  const [payload, signature] = state.split(".");
  const key = deps.config.socials.credentialKey;
  if (!key || !payload || !signature) return null;
  const given = Buffer.from(signature, "base64url");
  const expected = stateSignature(key, payload);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * POST /v1/socials/providers/:provider/connect.
 * A provider with pasted credentials (Buffer: `{ apiKey }`) is connected at once and answers with its accounts.
 * A provider the person signs in to answers `{ authorizeUrl }`: send them there, and they return to the studio.
 */
export async function connectSocialProvider(deps: EngineDeps, ctx: Ctx, providerId: string, raw: unknown) {
  requireManager(ctx, "Connecting social accounts");
  const provider = requireProvider(providerId);
  const key = credentialKey(deps);
  if (provider.signIn) {
    const redirectUri = signInAddress(deps, provider);
    if (!redirectUri) throw new EngineError("provider_unavailable", `Connecting ${provider.label} directly is not switched on for this deployment yet.`);
    const payload = b64(Buffer.from(JSON.stringify({ org: ctx.org.id, user: (ctx.principal as { userId: string }).userId, provider: provider.id, expires: deps.now().getTime() + SIGN_IN_MINUTES * 60_000, nonce: b64(randomBytes(12)) })));
    return { provider: provider.id, authorizeUrl: provider.signIn.authorizeUrl(deps, { redirectUri, state: `${payload}.${b64(stateSignature(key, payload))}` })! };
  }
  const credentials = parse(provider.credentialsSchema, raw);
  const result = await saveAccounts(deps, ctx, provider, credentials, await accountsFrom(deps, provider, credentials));
  await audit(deps, ctx, { action: `Connected ${provider.label}`, objectId: provider.id, outcome: `${result.accounts.filter((account) => account.state === "connected").length} account(s) available` });
  return result;
}

/**
 * GET /v1/socials/providers/:provider/callback: where the platform sends the person's browser after they answer.
 * Nothing is trusted or stored here, because this request carries no member session. The one-time code is handed
 * on to the studio's connect page, in the part of the address that is never sent to a server, and the signed-in
 * person completes it from there.
 */
export function socialSignInReturn(deps: EngineDeps, providerId: string, query: URLSearchParams) {
  const provider = requireProvider(providerId);
  if (!signInAddress(deps, provider)) throw new EngineError("not_found", "This provider is not connected by signing in here.");
  const code = query.get("code") ?? "";
  const state = query.get("state") ?? "";
  const usable = code.length > 0 && code.length <= 2000 && state.length > 0 && state.length <= 2000;
  // The platform reports a refusal as `error=access_denied`.
  const outcome: Record<string, string> = usable ? { grant: code, ticket: state } : { problem: query.get("error") === "access_denied" ? "declined" : "failed" };
  return `${deps.config.appBaseUrl}/studio/connect/${provider.id}#${new URLSearchParams(outcome)}`;
}

const completeInputSchema = z.object({ code: z.string().min(1).max(2000), state: z.string().min(1).max(2000) }).strict();

/** POST /v1/socials/providers/:provider/complete `{ code, state }`: the signed-in person finishes the sign-in they started. */
export async function completeSocialSignIn(deps: EngineDeps, ctx: Ctx, providerId: string, raw: unknown) {
  requireManager(ctx, "Connecting social accounts");
  const provider = requireProvider(providerId);
  const key = credentialKey(deps);
  const redirectUri = signInAddress(deps, provider);
  if (!provider.signIn || !redirectUri) throw new EngineError("provider_unavailable", `Connecting ${provider.label} directly is not switched on for this deployment yet.`);
  const input = parse(completeInputSchema, raw);
  const state = readState(deps, input.state);
  // Someone else's sign-in, sent to this person as a link, ends here: it is not theirs to complete.
  if (!state || state.provider !== provider.id || state.org !== ctx.org.id || state.user !== (ctx.principal as { userId: string }).userId || !(state.expires > deps.now().getTime()))
    throw new EngineError("forbidden", "This sign-in was not started by you in this workspace, or it has expired. Start again from the studio.");
  const { credentials, account, subscribed } = await provider.signIn.complete(deps, { code: input.code, redirectUri });
  if (!provider.platforms.includes(account.platform)) throw new EngineError("unsupported", "That kind of account is not supported here.");
  const now = deps.now().toISOString();
  const patch = {
    display_name: account.displayName.slice(0, 200),
    provider_account_id: account.providerAccountId,
    profile_url: account.profileUrl,
    state: account.state,
    credentials_ciphertext: seal(key, ctx.org.id, provider.id, credentials),
    ...(subscribed ? { webhook_renewed_at: now } : {}),
    updated_at: now,
  };
  // Signing in again with the same account renews it in place; other accounts of this provider are left alone.
  const identity = { org_id: ctx.org.id, provider: provider.id, platform: account.platform, external_account_id: account.externalAccountId };
  let [row] = await deps.store.update("provider_connections", identity, patch);
  if (!row)
    try {
      row = await deps.store.insert("provider_connections", { id: crypto.randomUUID(), ...identity, scopes: [], created_by: state.user, created_at: now, ...patch });
    } catch (error) {
      // The same sign-in completed twice at once: the other request saved the account.
      if (!(error instanceof StoreConflict)) throw error;
      [row] = await deps.store.select("provider_connections", identity, { limit: 1 });
    }
  await audit(deps, ctx, { action: `Connected ${provider.label} account ${account.displayName.slice(0, 80)}`, objectId: row.id, outcome: subscribed ? "Posting and activity are on" : "Posting is on" });
  return { provider: provider.id, accounts: [accountView(row)] };
}

/**
 * Keeps sign-in credentials alive (Instagram's last 60 days and can be renewed while they still work). Runs on the
 * scheduler tick. Credentials the platform no longer accepts mark the account expired, so the studio asks the
 * person to connect it again instead of failing a post later.
 */
export async function refreshSocialCredentials(deps: EngineDeps) {
  const outcome = { refreshed: 0, expired: 0, failed: 0 };
  const key = deps.config.socials.credentialKey;
  if (!key) return outcome;
  for (const provider of Object.values(socialProviders)) {
    if (!provider.refresh) continue;
    for (const account of await deps.store.select("provider_connections", { provider: provider.id, state: "connected" })) {
      try {
        const renewed = await provider.refresh(deps, parse(provider.credentialsSchema, open(key, account)));
        if (!renewed) continue;
        await deps.store.update("provider_connections", { id: account.id }, { credentials_ciphertext: seal(key, account.org_id, provider.id, renewed), updated_at: deps.now().toISOString() });
        outcome.refreshed++;
      } catch (error) {
        if (error instanceof EngineError && error.code === "forbidden") {
          await deps.store.update("provider_connections", { id: account.id }, { state: "expired", updated_at: deps.now().toISOString() });
          outcome.expired++;
        } else outcome.failed++;
      }
    }
  }
  return outcome;
}

/** How long an account whose activity was refused waits before it is asked again. */
const SUBSCRIBE_RETRY_HOURS = 6;

/**
 * Activity is connected without anyone setting it up: an account whose provider asks the platform for it (Instagram
 * directly) is subscribed when it connects, and one where that did not take is asked again here, on the scheduler
 * tick, at most every few hours, until it does. That subscription does not lapse, so a subscribed account is left
 * alone. (Subscriptions that lapse, like YouTube's, are renewed in socials-events.ts.)
 */
export async function subscribeProviderAccounts(deps: EngineDeps, orgId?: string) {
  const outcome = { subscribed: 0, failed: 0 };
  const key = deps.config.socials.credentialKey;
  if (!key) return outcome;
  const due = deps.now().getTime() - SUBSCRIBE_RETRY_HOURS * 3600_000;
  for (const provider of Object.values(socialProviders)) {
    if (!provider.subscribe) continue;
    for (const account of await deps.store.select("provider_connections", { provider: provider.id, state: "connected", ...(orgId ? { org_id: orgId } : {}) })) {
      // `updated_at` doubles as the time of the last ask, so an account the platform refuses is not asked on every tick.
      if (account.webhook_renewed_at || new Date(account.updated_at).getTime() > due) continue;
      const now = deps.now().toISOString();
      const subscribed = await provider.subscribe(deps, parse(provider.credentialsSchema, open(key, account))).catch(() => false);
      await deps.store.update("provider_connections", { id: account.id }, subscribed ? { webhook_renewed_at: now, updated_at: now } : { updated_at: now });
      outcome[subscribed ? "subscribed" : "failed"]++;
    }
  }
  return outcome;
}

/** POST /v1/socials/providers/:provider/sync. Re-reads the provider's accounts with the credentials saved at connect time. */
export async function syncSocialProvider(deps: EngineDeps, ctx: Ctx, providerId: string) {
  requireManager(ctx, "Refreshing social accounts");
  const provider = requireProvider(providerId);
  if (!provider.listAccounts) throw new EngineError("unsupported", `${provider.label} accounts are connected by signing in, one at a time.`);
  const [saved] = await deps.store.select("provider_connections", { org_id: ctx.org.id, provider: provider.id }, { limit: 1 });
  if (!saved) throw new EngineError("not_found", `${provider.label} is not connected to this workspace. Connect it first.`);
  const credentials = parse(provider.credentialsSchema, open(credentialKey(deps), saved));
  return saveAccounts(deps, ctx, provider, credentials, await accountsFrom(deps, provider, credentials));
}

/** Posts waiting for an account that is being removed can no longer be sent, so they are cancelled now, visibly, instead of failing later. */
async function cancelUnsentPosts(deps: EngineDeps, orgId: string, accounts: Row[]) {
  let cancelled = 0;
  for (const account of accounts)
    cancelled += (await deps.store.update("publish_jobs", { org_id: orgId, account_id: account.id, state: "scheduled" }, { state: "cancelled", error: "The account was disconnected before this post was sent.", updated_at: deps.now().toISOString() })).length;
  return cancelled;
}

/** DELETE /v1/socials/providers/:provider. Removes its accounts and the saved credentials from this workspace. */
export async function disconnectSocialProvider(deps: EngineDeps, ctx: Ctx, providerId: string) {
  requireManager(ctx, "Disconnecting social accounts");
  const provider = requireProvider(providerId);
  const accounts = await deps.store.select("provider_connections", { org_id: ctx.org.id, provider: provider.id });
  const cancelledPosts = await cancelUnsentPosts(deps, ctx.org.id, accounts);
  const removed = await deps.store.remove("provider_connections", { org_id: ctx.org.id, provider: provider.id });
  if (removed) await audit(deps, ctx, { action: `Disconnected ${provider.label}`, objectId: provider.id, outcome: `${removed} account(s) removed · ${cancelledPosts} unsent post(s) cancelled` });
  return { removed, cancelledPosts };
}

/**
 * DELETE /v1/socials/accounts/:id. Only for accounts connected through a provider here. A channel connected with
 * its platform elsewhere (YouTube with Google, channels.ts) is disconnected there, where the platform's access is
 * withdrawn as well; here it is simply not found.
 */
export async function removeSocialAccount(deps: EngineDeps, ctx: Ctx, accountId: string) {
  requireManager(ctx, "Removing a social account");
  const [account] = await deps.store.select("provider_connections", { id: accountId, org_id: ctx.org.id }, { limit: 1 });
  if (!connectedThroughProvider(account)) throw new EngineError("not_found", "This account was not found in your workspace.");
  const cancelledPosts = await cancelUnsentPosts(deps, ctx.org.id, [account]);
  await deps.store.remove("provider_connections", { id: account.id, org_id: ctx.org.id });
  await audit(deps, ctx, { action: "Removed a social account", objectId: account.id, outcome: `${String(account.display_name).slice(0, 80)} · ${cancelledPosts} unsent post(s) cancelled` });
  return { removed: true as const, cancelledPosts };
}

/* ───────────────────────── publishing ───────────────────────── */

/**
 * True when the account was connected through one of `socialProviders` (Buffer, or Instagram directly), so it posts
 * through that provider. Other rows are the platform's own connection made elsewhere (provider `direct`, such as a
 * YouTube channel connected in the studio with Google; channels.ts).
 */
export function connectedThroughProvider(account: Row | null | undefined): account is Row {
  return Boolean(account?.provider) && Object.hasOwn(socialProviders, account!.provider);
}

/**
 * The publisher for one connected account, or null when its provider cannot post for it on this deployment.
 * schedule.ts calls this at review time and again at send time; credentials are only opened when a post is sent.
 */
export function accountPublisher(deps: EngineDeps, account: Row | null | undefined): Publisher | null {
  if (!connectedThroughProvider(account)) return null;
  const provider = socialProviders[account.provider];
  const key = deps.config.socials.credentialKey;
  if (!key || !provider.platforms.includes(account.platform)) return null;
  const credentials = () => parse(provider.credentialsSchema, open(key, account));
  const { postStatus } = provider;
  return {
    // The scheduler holds the post until its approved time and hands it over then.
    schedulesNatively: false,
    publish: (input) => provider.publish(deps, { ...input, credentials: credentials(), account }),
    verify: postStatus
      ? async ({ providerPostId }) => {
          const status = await postStatus.call(provider, deps, { credentials: credentials(), account, providerPostId });
          const publishedAt = status.publishedAt && !Number.isNaN(Date.parse(status.publishedAt)) ? new Date(status.publishedAt).toISOString() : null;
          // A post the provider has not settled stays submitted: it is not guessed either way.
          return {
            state: status.state === "published" ? "verified_published" : status.state === "failed" ? "failed" : "submitted",
            publishedAt,
            note: status.error,
            url: status.url,
            providerPostId: status.providerPostId,
          };
        }
      : undefined,
  };
}
