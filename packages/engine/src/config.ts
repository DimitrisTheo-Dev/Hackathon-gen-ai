import { z } from "zod";
import { voiceKeysFrom, type VoiceKeys } from "./voice-providers.js";

export interface AvatarConfig {
  id: string;
  name: string;
  languages: string[];
}
export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  /** Allowlisted price keys → sandbox Price IDs. Clients choose a key, never an ID or an amount. */
  prices: Record<string, string>;
  /** Render credits granted per paid invoice of each price key. */
  creditsPerPeriod: Record<string, number>;
}
export interface LlmConfig {
  provider: "anthropic" | "gateway" | "gemini";
  /** Null means "use the deployment's Vercel OIDC token" (AI Gateway only). */
  apiKey: string | null;
  model: string;
}
/** Gemini model the director uses when DIRECTOR_MODEL is unset. */
export const DEFAULT_GEMINI_MODEL = "gemini-4-hydrogen";
export interface YoutubeConfig {
  clientId: string;
  clientSecret: string;
  /** 32 raw bytes. Encrypts stored channel refresh tokens (AES-256-GCM). */
  encryptionKey: Uint8Array;
}
/** One fixed-window limit. `name` appears in the RateLimit-Policy / RateLimit response headers. */
export interface RateLimitPolicy {
  name: "principal" | "director" | "costly" | "anonymous" | "failed_auth";
  limit: number;
  windowSeconds: number;
}
export interface RateLimitConfig {
  enabled: boolean;
  /**
   * Whether `x-forwarded-for` / `x-real-ip` describe the real client. True only behind Vercel's edge, which
   * overwrites both headers with the connecting client's address, so a client cannot choose its own bucket.
   * Elsewhere (local dev, tests) the client address is unknown and per-IP limits are skipped rather than
   * shared by every caller.
   */
  trustProxyHeaders: boolean;
  /** Every authenticated `/v1/studio/*`, `/v1/socials/*` and `/mcp` request, per principal (user, OAuth agent or workspace token). */
  principal: RateLimitPolicy;
  /** `POST /v1/studio/director/turn`: each model-backed turn costs money. Per principal. */
  director: RateLimitPolicy;
  /** Operations that spend money, call providers or hand out upload links: render, checkout, channel connection, social provider connect/sync, file, face-scan and persona-photo uploads. Per principal. */
  costly: RateLimitPolicy;
  /** Requests that present no credential at all. Per client IP. */
  anonymous: RateLimitPolicy;
  /** Requests whose credential was rejected. Per client IP. */
  failedAuth: RateLimitPolicy;
}

export interface EngineConfig {
  appBaseUrl: string;
  supabaseUrl: string;
  starterCredits: number;
  renderCreditCost: number;
  maxActiveRendersPerOrg: number;
  renderQueueTimeoutMinutes: number;
  renderRunTimeoutMinutes: number;
  renderWorkerToken: string | null;
  renderAvatars: AvatarConfig[];
  avatarLanguages: string[];
  humanlikeApiKey: string | null;
  humanlikeApiUrl: string;
  /**
   * Signs single-use tokens for Humanlike's live transcription socket (`/transcribe/live`); it is the key
   * Humanlike's server holds as TRANSCRIBE_ADMIN_KEY. Null when not configured: the likeness capture then
   * falls back to the browser's own speech recognition.
   */
  humanlikeTranscribeKey: string | null;
  cronSecret: string | null;
  stripe: StripeConfig | null;
  /** Why billing is unavailable, in words safe to show an owner. Null when configured. */
  stripeProblem: string | null;
  llm: LlmConfig | null;
  /** YouTube channel connection and publishing. Null until all three settings are present and valid. */
  youtube: YoutubeConfig | null;
  /** Why channel connection is unavailable, in words safe to show an owner. Null when configured. */
  youtubeProblem: string | null;
  /** Connected social accounts and their activity (socials.ts, socials-events.ts). */
  socials: {
    /** Encrypts the provider credentials stored with each account. Null: no account can be connected, so nothing can be posted. */
    credentialKey: Buffer | null;
    /** Signs deliveries in the generic format to /v1/socials/:platform/webhook. Null: those are refused. */
    webhookSecret: string | null;
    /**
     * The app people connect Instagram with (socials-instagram.ts). Null: Instagram accounts cannot be connected directly.
     *   instagram  "Instagram API with Instagram Login": the Instagram app ID and secret from "Business login settings".
     *              Only Meta apps created before Unified login offer it.
     *   unified    "Instagram API with Unified Login": the Meta app's own ID and secret (App settings → Basic) and the
     *              Facebook Login for Business configuration the app dashboard creates for it. Newer apps get only this.
     */
    instagramLogin:
      | { mode: "instagram"; appId: string; appSecret: string; scopes: string[] }
      | { mode: "unified"; appId: string; appSecret: string; configId: string }
      | null;
    /**
     * The model that answers people in comment-to-DM conversations (socials-campaigns.ts): Gemini, with
     * GEMINI_API_KEY. Null: campaigns still send their opening message and follow-ups, but nobody is answered by AI.
     */
    campaignAi: { apiKey: string; model: string } | null;
    /**
     * This deployment's partner login at Humanlike (socials-humanlike.ts), from Humanlike's Admin > Partners, and the
     * mail domain its per-workspace Humanlike workspaces are named under. Null: Humanlike is connected with a pasted
     * workspace key only.
     */
    humanlikePartner: { clientId: string; clientSecret: string; tenantEmailDomain: string } | null;
    /**
     * The TikTok app people sign in to TikTok with (socials-tiktok.ts, Login Kit + Content Posting API): its client key
     * and secret from the TikTok developer portal. Null: TikTok accounts cannot be connected directly.
     */
    tiktokLogin: { clientKey: string; clientSecret: string; scopes: string[] } | null;
    /**
     * Each platform's own webhook credentials, from the app registered with that platform (socials-webhooks.ts).
     * Null: that platform's address takes the generic format only.
     */
    native: {
      instagram: { appSecret: string; verifyToken: string } | null;
      whatsapp: { appSecret: string; verifyToken: string } | null;
      tiktok: { clientSecret: string } | null;
      linkedin: { clientSecret: string } | null;
      youtube: { hubSecret: string } | null;
    };
  };
  /** Model-backed director turns allowed per organization per 24 hours. */
  directorDailyTurns: number;
  mediaUrlTtlSeconds: number;
  /** Cloudflare R2 bucket for private files (likeness recordings, persona photos, reel draft files). Null when not configured. */
  r2: { accountId: string; accessKeyId: string; secretAccessKey: string; bucket: string } | null;
  /** Bytes of draft files (pending and ready) one workspace may hold; upload links past it are refused (files.ts). */
  storageQuotaBytes: number;
  /**
   * Whether forwarded headers (`x-forwarded-for`, `x-forwarded-host`, `x-forwarded-proto`) were set by a proxy we
   * trust. True on Vercel, whose edge overwrites them; false elsewhere unless TRUST_PROXY_HEADERS says otherwise.
   */
  trustProxyHeaders: boolean;
  rateLimit: RateLimitConfig;
  /** Credential the Remotion render workers (VPS, boxd or containers) present to claim reel renders. */
  reelWorkerToken: string | null;
  /**
   * Speech services for voiceovers made during production (voice.ts): Microsoft Text to Speech (AZURE_SPEECH_KEY with
   * AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT), and ElevenLabs, Cartesia and fal for persona voices. Each is null
   * when not configured.
   */
  voice: VoiceKeys;
  /** Claude Code machines (machines.ts): who may have one, and the key the gateway checks its short-lived tokens with. */
  machines: {
    /** MACHINES_GATEWAY_KEY, the same value as the gateway's. A keyring "2:<secret>,1:<older>" signs with its first entry. Null: not set up. */
    gatewayKey: { version: number; secret: string } | null;
    /** MACHINE_ALLOWED_USERS: user ids, the same list as the gateway's. Empty lets nobody in. */
    allowedUsers: string[];
  };
}

const avatarsSchema = z.array(
  z.object({ id: z.string().min(1).max(160), name: z.string().min(1).max(120), languages: z.array(z.string().min(2).max(12)).min(1) }).strict(),
);

function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function r2From(env: Record<string, string | undefined>): EngineConfig["r2"] {
  const accountId = env.FACEFUL_R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.FACEFUL_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.FACEFUL_R2_SECRET_ACCESS_KEY?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey) return null;
  if (!/^[a-f0-9]{32}$/.test(accountId)) {
    console.error(JSON.stringify({ level: "error", event: "config_invalid", key: "FACEFUL_R2_ACCOUNT_ID" }));
    return null;
  }
  return { accountId, accessKeyId, secretAccessKey, bucket: env.FACEFUL_R2_BUCKET?.trim() || "faceful-media" };
}

function stripeFrom(env: Record<string, string | undefined>): { stripe: StripeConfig | null; problem: string | null } {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  const price = env.STRIPE_PRICE_ID_DEMO?.trim();
  if (!secretKey && !webhookSecret && !price) return { stripe: null, problem: "Stripe sandbox keys have not been added to this deployment." };
  // Sandbox only. A live key must never be usable here, whatever the deployment environment says.
  if ((env.STRIPE_MODE ?? "sandbox") !== "sandbox") return { stripe: null, problem: "STRIPE_MODE must be \"sandbox\". Live billing is not enabled in this build." };
  if (!secretKey || !/^(sk|rk)_test_/.test(secretKey)) return { stripe: null, problem: "STRIPE_SECRET_KEY must be a sandbox/test secret key (sk_test_… or rk_test_…). Live keys are rejected." };
  if (!webhookSecret || !webhookSecret.startsWith("whsec_")) return { stripe: null, problem: "STRIPE_WEBHOOK_SECRET (whsec_…) for this deployment's webhook endpoint is missing." };
  if (!price || !price.startsWith("price_")) return { stripe: null, problem: "STRIPE_PRICE_ID_DEMO must be a sandbox Price ID (price_…)." };
  return {
    stripe: { secretKey, webhookSecret, prices: { demo: price }, creditsPerPeriod: { demo: integer(env.STRIPE_DEMO_PLAN_CREDITS, 30, 1, 10_000) } },
    problem: null,
  };
}

function llmFrom(env: Record<string, string | undefined>): LlmConfig | null {
  const anthropic = env.ANTHROPIC_API_KEY?.trim();
  const gemini = env.GEMINI_API_KEY?.trim();
  // Google's Gemini API, called directly with a Gemini API key. Chosen when it is the only model key, or by name.
  if (gemini && (!anthropic || env.DIRECTOR_PROVIDER?.trim() === "gemini")) {
    const model = env.DIRECTOR_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    // The model name becomes part of the request path, so only plain Gemini model names are accepted.
    if (!/^[a-z0-9][a-z0-9.-]{0,79}$/.test(model)) {
      console.error(JSON.stringify({ level: "error", event: "config_invalid", key: "DIRECTOR_MODEL" }));
      return { provider: "gemini", apiKey: gemini, model: DEFAULT_GEMINI_MODEL };
    }
    return { provider: "gemini", apiKey: gemini, model };
  }
  if (anthropic) return { provider: "anthropic", apiKey: anthropic, model: env.DIRECTOR_MODEL?.trim() || "claude-opus-5-5" };
  // Vercel AI Gateway speaks the same Messages API; its model slugs use dots (anthropic/claude-opus-5.5).
  const gatewayModel = env.DIRECTOR_MODEL?.trim() || "anthropic/claude-opus-5.5";
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  if (gateway) return { provider: "gateway", apiKey: gateway, model: gatewayModel };
  // Explicit opt-in to the keyless path: the deployment's own OIDC token, billed to the team's AI Gateway credits.
  if (env.DIRECTOR_PROVIDER === "vercel-gateway") return { provider: "gateway", apiKey: null, model: gatewayModel };
  return null;
}

function flag(value: string | undefined, fallback: boolean) {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

/**
 * Defaults are sized for real use: the studio polls an open project every five seconds (12 requests a
 * minute per tab), a model turn takes several seconds, and a hackathon venue puts many people behind one
 * public IP. Each value can be overridden per deployment.
 */
function rateLimitFrom(env: Record<string, string | undefined>, trustProxyHeaders: boolean): RateLimitConfig {
  const perMinute = (name: RateLimitPolicy["name"], key: string, fallback: number, max: number): RateLimitPolicy => ({ name, limit: integer(env[key], fallback, 1, max), windowSeconds: 60 });
  return {
    enabled: flag(env.RATE_LIMIT_ENABLED, true),
    trustProxyHeaders,
    principal: perMinute("principal", "RATE_LIMIT_PRINCIPAL_PER_MINUTE", 240, 100_000),
    director: perMinute("director", "RATE_LIMIT_DIRECTOR_PER_MINUTE", 10, 10_000),
    costly: perMinute("costly", "RATE_LIMIT_COSTLY_PER_MINUTE", 10, 10_000),
    anonymous: perMinute("anonymous", "RATE_LIMIT_ANONYMOUS_PER_MINUTE", 120, 100_000),
    failedAuth: perMinute("failed_auth", "RATE_LIMIT_FAILED_AUTH_PER_MINUTE", 60, 100_000),
  };
}

/** The renderer API host is fixed; an override may only point at another Humanlike HTTPS host. */
const DEFAULT_HUMANLIKE_API_URL = "https://api.humanlike.co";
function humanlikeUrlFrom(value: string | undefined): string {
  const raw = value?.trim().replace(/\/$/, "");
  if (!raw) return DEFAULT_HUMANLIKE_API_URL;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && !url.username && !url.password && (url.hostname === "humanlike.co" || url.hostname.endsWith(".humanlike.co"))) return url.origin;
  } catch {
    /* fall through */
  }
  console.error(JSON.stringify({ level: "error", event: "config_invalid", key: "HUMANLIKE_API_URL" }));
  return DEFAULT_HUMANLIKE_API_URL;
}

function youtubeFrom(env: Record<string, string | undefined>): { youtube: YoutubeConfig | null; problem: string | null } {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const rawKey = env.CONNECTIONS_ENCRYPTION_KEY?.trim();
  if (!clientId && !clientSecret && !rawKey) return { youtube: null, problem: "YouTube publishing has not been set up on this deployment." };
  if (!clientId || !clientId.endsWith(".apps.googleusercontent.com")) return { youtube: null, problem: "GOOGLE_OAUTH_CLIENT_ID is missing or is not a Google OAuth client ID." };
  if (!clientSecret) return { youtube: null, problem: "GOOGLE_OAUTH_CLIENT_SECRET is missing, so channel access cannot be refreshed." };
  if (!rawKey) return { youtube: null, problem: "CONNECTIONS_ENCRYPTION_KEY is missing, so channel credentials cannot be stored safely." };
  // Standard or URL-safe base64 of exactly 32 bytes. Anything else is refused rather than padded or truncated.
  const key = Buffer.from(rawKey.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.byteLength !== 32) return { youtube: null, problem: "CONNECTIONS_ENCRYPTION_KEY must be 32 random bytes, base64-encoded." };
  return { youtube: { clientId, clientSecret, encryptionKey: new Uint8Array(key) }, problem: null };
}

function socialsFrom(env: Record<string, string | undefined>): EngineConfig["socials"] {
  const raw = env.SOCIALS_CREDENTIAL_KEY?.trim();
  // 32 random bytes, as 64 hex characters or as base64.
  const key = raw ? Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64") : null;
  if (key && key.length !== 32) console.error(JSON.stringify({ level: "error", event: "config_invalid", key: "SOCIALS_CREDENTIAL_KEY" }));
  const secret = env.SOCIALS_WEBHOOK_SECRET?.trim();
  const value = (name: string, min = 8) => {
    const found = env[name]?.trim();
    return found && found.length >= min ? found : null;
  };
  // Meta apps (Instagram, WhatsApp) need the app secret and the verify token typed into the app's webhook settings.
  const meta = (prefix: string) => {
    const appSecret = value(`${prefix}_APP_SECRET`);
    const verifyToken = value(`${prefix}_WEBHOOK_VERIFY_TOKEN`);
    return appSecret && verifyToken ? { appSecret, verifyToken } : null;
  };
  const tiktok = value("TIKTOK_CLIENT_SECRET");
  const linkedin = value("LINKEDIN_CLIENT_SECRET");
  const youtube = value("YOUTUBE_WEBHOOK_SECRET", 32);
  const tiktokKey = value("TIKTOK_CLIENT_KEY", 4);
  // Posting needs `video.publish`; `user.info.basic` names the account. Add `user.info.profile` for its @name and links.
  const tiktokScopes = (env.TIKTOK_LOGIN_SCOPES ?? "user.info.basic,video.publish").split(",").map((scope) => scope.trim()).filter((scope) => /^[a-z_.]{3,80}$/.test(scope));
  const loginId = value("INSTAGRAM_LOGIN_APP_ID", 1);
  const loginSecret = value("INSTAGRAM_LOGIN_APP_SECRET");
  // Unified login: the Meta app's own ID and secret (the secret also signs Instagram's webhook deliveries) and the
  // login configuration. Preferred when present: it is what Meta gives every app created since late 2026.
  const metaAppId = value("INSTAGRAM_APP_ID", 1);
  const metaAppSecret = value("INSTAGRAM_APP_SECRET");
  const configId = value("INSTAGRAM_LOGIN_CONFIG_ID", 1);
  const gemini = env.GEMINI_API_KEY?.trim();
  const campaignModel = env.CAMPAIGN_AI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  // What the person is asked to allow. Posting needs the first two; comments and messages are for the account's activity.
  const scopes = (env.INSTAGRAM_LOGIN_SCOPES ?? "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages").split(",").map((scope) => scope.trim()).filter((scope) => /^[a-z_]{3,80}$/.test(scope));
  return {
    credentialKey: key?.length === 32 ? key : null,
    humanlikePartner: humanlikePartnerFrom(env),
    tiktokLogin: tiktokKey && tiktok && /^[A-Za-z0-9_-]{4,64}$/.test(tiktokKey) ? { clientKey: tiktokKey, clientSecret: tiktok, scopes: tiktokScopes } : null,
    webhookSecret: secret && secret.length >= 32 ? secret : null,
    instagramLogin:
      metaAppId && /^\d{1,32}$/.test(metaAppId) && metaAppSecret && configId && /^\d{1,32}$/.test(configId)
        ? { mode: "unified", appId: metaAppId, appSecret: metaAppSecret, configId }
        : loginId && /^\d{1,32}$/.test(loginId) && loginSecret
          ? { mode: "instagram", appId: loginId, appSecret: loginSecret, scopes }
          : null,
    // The model name becomes part of the request path, so only plain Gemini model names are accepted.
    campaignAi: gemini && /^[a-z0-9][a-z0-9.-]{0,79}$/.test(campaignModel) ? { apiKey: gemini, model: campaignModel } : null,
    native: {
      instagram: meta("INSTAGRAM"),
      whatsapp: meta("WHATSAPP"),
      tiktok: tiktok ? { clientSecret: tiktok } : null,
      linkedin: linkedin ? { clientSecret: linkedin } : null,
      youtube: youtube ? { hubSecret: youtube } : null,
    },
  };
}

/** A host name with a dot in it, as an e-mail domain; null for anything else (localhost, an IP, junk). */
function mailDomain(value: string | undefined): string | null {
  const raw = value?.trim().toLowerCase() ?? "";
  if (!raw) return null;
  let host = raw;
  try {
    host = raw.includes("://") ? new URL(raw).hostname : raw;
  } catch {
    return null;
  }
  return /^(?=.{4,200}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) ? host : null;
}

function humanlikePartnerFrom(env: Record<string, string | undefined>): EngineConfig["socials"]["humanlikePartner"] {
  const clientId = env.HUMANLIKE_PARTNER_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.HUMANLIKE_PARTNER_CLIENT_SECRET?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  // The Humanlike workspaces are named under this domain; by default the app's own host.
  const domain = mailDomain(env.HUMANLIKE_TENANT_EMAIL_DOMAIN) ?? mailDomain(env.APP_BASE_URL ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : ""));
  const wrong = !/^hlpc_[a-f0-9]{24}$/.test(clientId) ? "HUMANLIKE_PARTNER_CLIENT_ID" : !/^hlps_[A-Za-z0-9_-]{43}$/.test(clientSecret) ? "HUMANLIKE_PARTNER_CLIENT_SECRET" : domain === null ? "HUMANLIKE_TENANT_EMAIL_DOMAIN" : null;
  if (wrong || !domain) {
    console.error(JSON.stringify({ level: "error", event: "config_invalid", key: wrong }));
    return null;
  }
  return { clientId, clientSecret, tenantEmailDomain: domain };
}

function machinesFrom(env: Record<string, string | undefined>): EngineConfig["machines"] {
  const first = env.MACHINES_GATEWAY_KEY?.split(",")[0]?.trim() ?? "";
  const versioned = /^(\d{1,3}):(.+)$/.exec(first);
  const [version, secret] = versioned ? [Number(versioned[1]), versioned[2]] : [1, first];
  if (first && (secret.length < 32 || version < 1)) console.error(JSON.stringify({ level: "error", event: "config_invalid", key: "MACHINES_GATEWAY_KEY" }));
  const allowedUsers = (env.MACHINE_ALLOWED_USERS ?? "").split(",").map((id) => id.trim().toLowerCase()).filter((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id));
  return { gatewayKey: secret.length >= 32 && version >= 1 ? { version, secret } : null, allowedUsers };
}

export function loadConfig(env: Record<string, string | undefined> = process.env): EngineConfig {
  const supabaseUrl = (env.SUPABASE_URL ?? env.VITE_SUPABASE_URL ?? "").trim().replace(/\/$/, "");
  const appBaseUrl = (env.APP_BASE_URL ?? (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : "")).trim().replace(/\/$/, "");
  let renderAvatars: AvatarConfig[] = [];
  if (env.RENDER_AVATARS) {
    try {
      renderAvatars = avatarsSchema.parse(JSON.parse(env.RENDER_AVATARS));
    } catch {
      console.error(JSON.stringify({ level: "error", event: "config_invalid", key: "RENDER_AVATARS" }));
    }
  }
  const { stripe, problem } = stripeFrom(env);
  const channels = youtubeFrom(env);
  // Vercel sets VERCEL=1 in every function, and its edge overwrites x-forwarded-for with the connecting client.
  const trustProxyHeaders = flag(env.TRUST_PROXY_HEADERS, env.VERCEL === "1");
  return {
    appBaseUrl,
    supabaseUrl,
    starterCredits: integer(env.STARTER_RENDER_CREDITS, 3, 0, 1000),
    renderCreditCost: integer(env.RENDER_CREDIT_COST, 1, 1, 100),
    maxActiveRendersPerOrg: integer(env.MAX_ACTIVE_RENDERS, 2, 1, 20),
    renderQueueTimeoutMinutes: integer(env.RENDER_QUEUE_TIMEOUT_MINUTES, 60, 1, 1440),
    renderRunTimeoutMinutes: integer(env.RENDER_RUN_TIMEOUT_MINUTES, 20, 1, 240),
    renderWorkerToken: env.RENDER_WORKER_TOKEN && env.RENDER_WORKER_TOKEN.trim().length >= 32 ? env.RENDER_WORKER_TOKEN.trim() : null,
    renderAvatars,
    avatarLanguages: (env.AVATAR_LANGUAGES ?? "en,el").split(",").map((value) => value.trim()).filter(Boolean),
    humanlikeApiKey: env.HUMANLIKE_API_KEY?.trim().startsWith("hk_live_") ? env.HUMANLIKE_API_KEY.trim() : null,
    humanlikeApiUrl: humanlikeUrlFrom(env.HUMANLIKE_API_URL),
    humanlikeTranscribeKey: env.HUMANLIKE_TRANSCRIBE_KEY && env.HUMANLIKE_TRANSCRIBE_KEY.trim().length >= 16 ? env.HUMANLIKE_TRANSCRIBE_KEY.trim() : null,
    cronSecret: env.CRON_SECRET?.trim() || null,
    stripe,
    stripeProblem: problem,
    llm: llmFrom(env),
    youtube: channels.youtube,
    youtubeProblem: channels.problem,
    socials: socialsFrom(env),
    directorDailyTurns: integer(env.DIRECTOR_DAILY_TURNS, 100, 1, 10_000),
    mediaUrlTtlSeconds: 3600,
    r2: r2From(env),
    storageQuotaBytes: integer(env.STORAGE_QUOTA_BYTES, 5 * 1024 ** 3, 1024 ** 2, 2 ** 50),
    trustProxyHeaders,
    rateLimit: rateLimitFrom(env, trustProxyHeaders),
    reelWorkerToken: env.REEL_WORKER_TOKEN && env.REEL_WORKER_TOKEN.trim().length >= 32 ? env.REEL_WORKER_TOKEN.trim() : null,
    voice: voiceKeysFrom(env),
    machines: machinesFrom(env),
  };
}
