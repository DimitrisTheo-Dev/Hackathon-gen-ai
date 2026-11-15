import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit, requireHuman, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import type { Publisher } from "./schedule.js";
import { bufferProvider } from "./socials-buffer.js";
import type { Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * Social accounts, served under /v1/socials. Three lists drive everything here, and each grows by one entry:
 *
 *   SOCIAL_PLATFORMS   where content and conversations happen (TikTok, Instagram, ...)
 *   socialProviders    how a platform is reached: Buffer today, Faceful's own integration later
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
}
/**
 * One way of reaching social platforms. To add a provider, implement this and add it to `socialProviders`.
 * Failures are EngineErrors: `quota_exceeded` and `provider_unavailable` are retried by the scheduler, anything
 * else fails the post with the message shown to the person.
 */
export interface SocialProvider<Credentials = any> {
  id: string;
  label: string;
  /** Platforms this provider can connect and post to. */
  platforms: SocialPlatform[];
  /** What a person supplies to connect it. Stored encrypted, never returned. */
  credentialsSchema: z.ZodType<Credentials>;
  /** Checks the credentials with the provider and lists the accounts they reach. */
  listAccounts(deps: EngineDeps, credentials: Credentials): Promise<ProviderAccount[]>;
  /** Submits one approved post. Must not post twice for the same `attemptKey`. */
  publish(deps: EngineDeps, input: PublishInput): Promise<{ providerPostId: string; state: "submitted" | "verified_published"; url: string | null }>;
  /** Where a submitted post stands. Without it, a post stays "submitted". */
  postStatus?(deps: EngineDeps, input: { credentials: Credentials; account: Row; providerPostId: string }): Promise<PostStatus>;
}
export const socialProviders: Record<string, SocialProvider> = {
  [bufferProvider.id]: bufferProvider,
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
  connectedAt: new Date(row.created_at).toISOString(),
  updatedAt: new Date(row.updated_at).toISOString(),
});
const providersFor = (platform: SocialPlatform) => Object.values(socialProviders).filter((provider) => provider.platforms.includes(platform));
/** True when some provider could post to this platform on this deployment, whether or not an account is connected yet. */
export function publishingAvailable(deps: EngineDeps, platform: string) {
  return Boolean(deps.config.socials.credentialKey) && isSocialPlatform(platform) && providersFor(platform).length > 0;
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
      available: Boolean(deps.config.socials.credentialKey),
      connected: accounts.some((row) => row.provider === provider.id),
    })),
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
  // Only the platforms in SOCIAL_PLATFORMS are kept; a provider may reach others this studio does not use yet.
  return (await provider.listAccounts(deps, credentials)).filter((account) => isSocialPlatform(account.platform) && provider.platforms.includes(account.platform));
}

/** POST /v1/socials/providers/:provider/connect. The body is the provider's own credentials (Buffer: `{ apiKey }`). */
export async function connectSocialProvider(deps: EngineDeps, ctx: Ctx, providerId: string, raw: unknown) {
  requireManager(ctx, "Connecting social accounts");
  const provider = requireProvider(providerId);
  credentialKey(deps);
  const credentials = parse(provider.credentialsSchema, raw);
  const result = await saveAccounts(deps, ctx, provider, credentials, await accountsFrom(deps, provider, credentials));
  await audit(deps, ctx, { action: `Connected ${provider.label}`, objectId: provider.id, outcome: `${result.accounts.filter((account) => account.state === "connected").length} account(s) available` });
  return result;
}

/** POST /v1/socials/providers/:provider/sync. Re-reads the provider's accounts with the credentials saved at connect time. */
export async function syncSocialProvider(deps: EngineDeps, ctx: Ctx, providerId: string) {
  requireManager(ctx, "Refreshing social accounts");
  const provider = requireProvider(providerId);
  const [saved] = await deps.store.select("provider_connections", { org_id: ctx.org.id, provider: provider.id }, { limit: 1 });
  if (!saved) throw new EngineError("not_found", `${provider.label} is not connected to this workspace. Connect it first.`);
  const credentials = parse(provider.credentialsSchema, open(credentialKey(deps), saved));
  return saveAccounts(deps, ctx, provider, credentials, await accountsFrom(deps, provider, credentials));
}

/** DELETE /v1/socials/providers/:provider. Removes its accounts and the saved credentials from this workspace. */
export async function disconnectSocialProvider(deps: EngineDeps, ctx: Ctx, providerId: string) {
  requireManager(ctx, "Disconnecting social accounts");
  const provider = requireProvider(providerId);
  const removed = await deps.store.remove("provider_connections", { org_id: ctx.org.id, provider: provider.id });
  if (removed) await audit(deps, ctx, { action: `Disconnected ${provider.label}`, objectId: provider.id, outcome: `${removed} account(s) removed. Posts already scheduled to them will not be sent` });
  return { removed };
}

/** DELETE /v1/socials/accounts/:id. */
export async function removeSocialAccount(deps: EngineDeps, ctx: Ctx, accountId: string) {
  requireManager(ctx, "Removing a social account");
  const removed = await deps.store.remove("provider_connections", { id: accountId, org_id: ctx.org.id });
  if (!removed) throw new EngineError("not_found", "This account was not found in your workspace.");
  await audit(deps, ctx, { action: "Removed a social account", objectId: accountId, outcome: "Posts already scheduled to it will not be sent" });
  return { removed: true as const };
}

/* ───────────────────────── publishing ───────────────────────── */

/**
 * True when the account was connected through one of `socialProviders` (Buffer), so it posts through that provider.
 * Other rows are the platform's own connection (provider `direct`, such as a YouTube channel connected in the studio).
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
          return { state: status.state === "published" ? "verified_published" : status.state === "failed" ? "failed" : "submitted", publishedAt, note: status.error, url: status.url };
        }
      : undefined,
  };
}
