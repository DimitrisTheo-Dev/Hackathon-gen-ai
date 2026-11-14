import { z } from "zod";

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
  provider: "anthropic" | "gateway";
  /** Null means "use the deployment's Vercel OIDC token" (AI Gateway only). */
  apiKey: string | null;
  model: string;
}
export interface YoutubeConfig {
  clientId: string;
  clientSecret: string;
  /** 32 raw bytes. Encrypts stored channel refresh tokens (AES-256-GCM). */
  encryptionKey: Uint8Array;
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
  cronSecret: string | null;
  stripe: StripeConfig | null;
  /** Why billing is unavailable, in words safe to show an owner. Null when configured. */
  stripeProblem: string | null;
  llm: LlmConfig | null;
  /** YouTube channel connection and publishing. Null until all three settings are present and valid. */
  youtube: YoutubeConfig | null;
  /** Why channel connection is unavailable, in words safe to show an owner. Null when configured. */
  youtubeProblem: string | null;
  /** Model-backed director turns allowed per organization per 24 hours. */
  directorDailyTurns: number;
  mediaUrlTtlSeconds: number;
}

const avatarsSchema = z.array(
  z.object({ id: z.string().min(1).max(160), name: z.string().min(1).max(120), languages: z.array(z.string().min(2).max(12)).min(1) }).strict(),
);

function integer(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
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
  if (anthropic) return { provider: "anthropic", apiKey: anthropic, model: env.DIRECTOR_MODEL?.trim() || "claude-opus-5-5" };
  // Vercel AI Gateway speaks the same Messages API; its model slugs use dots (anthropic/claude-opus-5.5).
  const gatewayModel = env.DIRECTOR_MODEL?.trim() || "anthropic/claude-opus-5.5";
  const gateway = env.AI_GATEWAY_API_KEY?.trim();
  if (gateway) return { provider: "gateway", apiKey: gateway, model: gatewayModel };
  // Explicit opt-in to the keyless path: the deployment's own OIDC token, billed to the team's AI Gateway credits.
  if (env.DIRECTOR_PROVIDER === "vercel-gateway") return { provider: "gateway", apiKey: null, model: gatewayModel };
  return null;
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
    humanlikeApiUrl: (env.HUMANLIKE_API_URL ?? "https://api.humanlike.co").trim().replace(/\/$/, ""),
    cronSecret: env.CRON_SECRET?.trim() || null,
    stripe,
    stripeProblem: problem,
    llm: llmFrom(env),
    youtube: channels.youtube,
    youtubeProblem: channels.problem,
    directorDailyTurns: integer(env.DIRECTOR_DAILY_TURNS, 100, 1, 10_000),
    mediaUrlTtlSeconds: 3600,
  };
}
