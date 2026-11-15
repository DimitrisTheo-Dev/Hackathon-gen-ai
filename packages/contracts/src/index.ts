import { z } from "zod";
import { productSchema } from "./quality.js";

/** Proposed boundary v0.1. Minas agreement pending; see docs/product/contract-handoff.md. */
export const httpUrlSchema = z.url({ protocol: /^https?$/ }).refine((value) => {
  // Zod still runs this check after the URL format check has failed; an unparseable value is simply invalid.
  try {
    const url = new URL(value);
    return !url.username && !url.password;
  } catch {
    return false;
  }
}, "URLs must not contain credentials");
export const timezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, "Use a valid IANA timezone");
export const idSchema = z.string().min(1).max(160);
export const instantSchema = z.iso.datetime({ offset: true });
export const platformSchema = z.enum(["instagram", "tiktok", "youtube"]);
export const kindSchema = z.enum(["avatar_video", "image", "text"]);
export const errorSchema = z.object({
  code: z.enum([
    "unauthenticated",
    "forbidden",
    "not_found",
    "revision_conflict",
    "idempotency_conflict",
    "approval_required",
    "stale_manifest",
    "quota_exceeded",
    "unsupported",
    "provider_unavailable",
    "validation_error",
    "unknown_outcome",
  ]),
  message: z.string(),
  retryAfterSeconds: z.number().nullable().default(null),
  reviewUrl: z.string().nullable().default(null),
});
export const variantSchema = z.object({
  platform: platformSchema,
  title: z.string().max(150),
  caption: z.string().max(2200),
  accountId: idSchema.nullable(),
  visibility: z.enum(["public", "private", "unlisted"]),
  aiDisclosure: z.boolean(),
});
export const targetSchema = z.object({
  platform: platformSchema,
  accountId: idSchema.nullable(),
  scheduledAt: instantSchema,
  timezone: timezoneSchema,
  state: z.enum([
    "draft",
    "approval_required",
    "queued",
    "accepted",
    "published",
    "failed",
    "unknown",
    "cancel_requested",
    "cancelled",
  ]),
  publishedAt: instantSchema.nullable(),
  providerId: z.string().nullable(),
  publishedUrl: httpUrlSchema.nullable(),
  error: z.string().nullable(),
});
export const mediaSchema = z.object({
  id: idSchema,
  url: httpUrlSchema,
  expiresAt: instantSchema.nullable(),
  sha256: z.string(),
  revision: z.number().int().positive(),
  durationSeconds: z.number().positive(),
  hasAudio: z.boolean(),
});
export const contentSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  campaignId: idSchema,
  title: z.string().min(1).max(120),
  kind: kindSchema,
  script: z.string().max(5000),
  avatarId: idSchema.nullable(),
  language: z.string(),
  revision: z.number().int().positive(),
  renderRevision: z.number().int().positive().nullable(),
  status: z.enum([
    "draft",
    "queued",
    "rendering",
    "ready",
    "needs_review",
    "failed",
  ]),
  media: mediaSchema.nullable(),
  variants: z.array(variantSchema),
  targets: z.array(targetSchema),
  style: z.object({
    captions: z.boolean(),
    brandColor: z.string().regex(/^#[0-9a-f]{6}$/i),
    captionPosition: z.enum(["bottom", "center"]),
  }),
  sourceIds: z.array(idSchema),
  updatedAt: instantSchema,
});
export const jobSchema = z.object({
  id: idSchema,
  itemId: idSchema.nullable(),
  stage: z.enum(["draft", "brand_check", "render", "compose", "publish"]),
  state: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "unknown",
    "cancel_requested",
    "cancelled",
  ]),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  providerCorrelationId: z.string().nullable(),
  error: errorSchema.nullable(),
  nextPollAfterMs: z.number().int().min(1000),
});
export const auditSchema = z.object({
  id: idSchema,
  actor: z.string(),
  action: z.string(),
  objectId: idSchema,
  revision: z.number().int().nullable(),
  at: instantSchema,
  outcome: z.string(),
});
export const sourceSchema = z.object({
  id: idSchema,
  title: z.string(),
  url: httpUrlSchema.nullable(),
  excerpt: z.string(),
  permittedAssetIds: z.array(idSchema),
  retrievedAt: instantSchema,
});
export const companyContextSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1500),
    audience: z.string().max(500),
    tone: z.string().max(500),
    sourceText: z.string().max(5000),
    sourceUrl: httpUrlSchema.nullable(),
    missingInformation: z.string().max(1500),
  })
  .strict();
export const campaignSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  title: z.string(),
  brief: z.string(),
  companyContext: companyContextSchema.nullable().default(null),
  revision: z.number().int().positive(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
  timezone: timezoneSchema,
  items: z.array(contentSchema),
  sources: z.array(sourceSchema),
  jobs: z.array(jobSchema),
  activity: z.array(auditSchema),
  humanInterventions: z.number().int().nonnegative(),
  mode: z.enum(["live", "fixture"]),
  /** "sample" marks seeded demonstration content; it is never presented as the user's own work. */
  origin: z.enum(["user", "agent", "sample"]).default("user"),
  templateId: idSchema.nullable().default(null),
});
export const connectionSchema = z.object({
  id: idSchema,
  displayName: z.string(),
  scopes: z.array(z.string()),
  expiresAt: instantSchema,
  lastSeenAt: instantSchema.nullable(),
  revokedAt: instantSchema.nullable(),
});
/**
 * The workspace brand kit. Every draft starts from it, for people and connected agents alike.
 * It is data the model reads, never instructions it follows. `tone` and `audience` default to ""
 * so responses from engines that predate them still parse.
 */
export const brandSchema = z.object({
  name: z.string(),
  description: z.string(),
  rules: z.array(z.string()),
  color: z.string(),
  tone: z.string().default(""),
  audience: z.string().default(""),
});
export const BRAND_LIMITS = { name: 120, description: 500, tone: 500, audience: 500, rules: 12, rule: 200 } as const;
export const brandColorSchema = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a colour in #RRGGBB form");
export const contextSchema = z.object({
  workspace: z.object({
    id: idSchema,
    name: z.string(),
    timezone: timezoneSchema,
    role: z.enum(["owner", "admin", "editor", "reviewer", "creator", "agent"]),
    type: z.enum(["personal", "company", "agency"]),
  }),
  principal: z.object({
    id: idSchema,
    kind: z.enum(["human", "agent"]),
    scopes: z.array(z.string()),
  }),
  brand: brandSchema,
  avatars: z.array(
    z.object({
      id: idSchema,
      name: z.string(),
      languages: z.array(z.string()),
      permission: z.enum(["authorized", "unavailable"]),
      previewUrl: httpUrlSchema.nullable(),
    }),
  ),
  channels: z.array(
    z.object({
      id: idSchema,
      platform: platformSchema,
      displayName: z.string(),
      state: z.enum(["connected", "expired", "unavailable"]),
    }),
  ),
  /** Brand kit products: photo, description and approved facts. Defaults to [] for engines that predate products. */
  products: z.array(productSchema).default([]),
  capabilities: z.object({
    mode: z.enum(["live", "fixture"]),
    canCreateCampaign: z.boolean().default(false),
    canPlanWithDirector: z.boolean().default(false),
    /** "ai": a model drafts and rewrites. "basic": only exact edits, templates and lookups work. */
    directorMode: z.enum(["ai", "basic"]).default("basic"),
    /** Why rendering is unavailable, in words safe to show. Null when a renderer is connected. */
    renderBlocker: z.string().nullable().default(null),
    canRender: z.boolean(),
    canConnectChannels: z.boolean(),
    canRetry: z.boolean(),
    canCancel: z.boolean(),
    canCreateAgentToken: z.boolean(),
    canCreateGrant: z.boolean(),
    formats: z.array(
      z.object({
        kind: kindSchema,
        platform: platformSchema,
        supported: z.boolean(),
        reason: z.string().nullable(),
      }),
    ),
    visibility: z.array(z.enum(["public", "private", "unlisted"])),
    renderUnitsRemaining: z.number().nonnegative(),
    postsRemaining: z.number().int().nonnegative(),
    mcpUrl: httpUrlSchema.nullable(),
    openapiUrl: httpUrlSchema.nullable(),
  }),
  connections: z.array(connectionSchema),
  /** Every workspace this principal can switch to. Empty in fixtures. */
  workspaces: z
    .array(z.object({ id: idSchema, name: z.string(), role: z.string(), type: z.string() }))
    .default([]),
});
export const scheduleTargetInputSchema = z
  .object({
    platform: platformSchema,
    accountId: idSchema.nullable(),
    scheduledAt: instantSchema,
    timezone: timezoneSchema,
  })
  .strict();
/** Draft only: source text is data, no URL fetching, provider work or publication authority. */
export const startCampaignInputSchema = z
  .object({
    operationKey: z.uuid(),
    title: z.string().trim().min(1).max(120),
    companyContext: companyContextSchema,
    items: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            script: z.string().trim().min(1).max(5000),
          })
          .strict(),
      )
      .min(1)
      .max(3),
  })
  .strict();
export type StartCampaignInput = z.infer<typeof startCampaignInputSchema>;
export const patchSchema = z
  .object({
    title: z.string().min(1).max(120).optional(),
    script: z.string().max(5000).optional(),
    avatarId: idSchema.nullable().optional(),
    language: z.string().optional(),
    style: contentSchema.shape.style.optional(),
    variants: z.array(variantSchema).optional(),
    targets: z.array(scheduleTargetInputSchema).optional(),
  })
  .strict();
export const versionSchema = z.object({
  revision: z.number().int().positive(),
  createdAt: instantSchema,
  actor: z.string(),
  actorKind: z.enum(["human", "agent", "system"]),
  summary: z.string(),
  affectsRender: z.boolean(),
  title: z.string(),
  script: z.string(),
  avatarId: idSchema.nullable(),
  language: z.string(),
  hasMedia: z.boolean(),
});
export type ContentVersion = z.infer<typeof versionSchema>;
export const restoreInputSchema = z
  .object({
    contentId: idSchema,
    revision: z.number().int().positive(),
    expectedRevision: z.number().int().positive(),
    operationKey: z.uuid(),
  })
  .strict();
export type RestoreInput = z.infer<typeof restoreInputSchema>;
export const reviseInputSchema = z
  .object({
    contentId: idSchema,
    expectedRevision: z.number().int().positive(),
    operationKey: z.string().uuid(),
    patch: patchSchema,
  })
  .strict();
export const manifestSchema = z.object({
  id: idSchema,
  campaignId: idSchema,
  campaignRevision: z.number().int().positive(),
  hash: z.string(),
  createdAt: instantSchema,
  expiresAt: instantSchema,
  reviewUrl: z.string(),
  approval: z.enum(["required", "approved", "stale"]),
  entries: z.array(
    z.object({
      itemId: idSchema,
      revision: z.number().int().positive(),
      assetId: idSchema,
      assetHash: z.string(),
      platform: platformSchema,
      accountId: idSchema,
      scheduledAt: instantSchema,
      timezone: timezoneSchema,
      caption: z.string(),
      title: z.string(),
      visibility: variantSchema.shape.visibility,
      aiDisclosure: z.boolean(),
    }),
  ),
  blockers: z.array(z.object({ itemId: idSchema, message: z.string() })),
});
export const operationSchema = z.object({
  operationId: idSchema,
  state: z.enum(["accepted", "blocked", "completed"]),
  jobIds: z.array(idSchema),
  nextPollAfterMs: z.number().int().min(1000),
  reviewUrl: z.string().nullable(),
});
export const grantInputSchema = z
  .object({
    campaignId: idSchema,
    campaignRevision: z.number().int().positive(),
    operationKey: z.string().uuid(),
    accountIds: z.array(idSchema).min(1),
    avatarIds: z.array(idSchema).min(1),
    maximumItems: z.number().int().min(1).max(3),
    maximumPosts: z.number().int().min(1).max(9),
    maximumRenderSeconds: z.number().int().min(1).max(180),
    expiresAt: instantSchema,
    windowStart: instantSchema,
    windowEnd: instantSchema,
    acknowledgesFuturePublication: z.literal(true),
  })
  .strict();
/** Edits the workspace brand kit. Only the fields sent change; text stays data for the model, never instructions. */
export const updateBrandInputSchema = z
  .object({
    name: z.string().trim().min(1, "Give the brand a name").max(BRAND_LIMITS.name).optional(),
    description: z.string().trim().max(BRAND_LIMITS.description).optional(),
    tone: z.string().trim().max(BRAND_LIMITS.tone).optional(),
    audience: z.string().trim().max(BRAND_LIMITS.audience).optional(),
    color: brandColorSchema.optional(),
    rules: z
      .array(z.string().trim().min(1, "A guardrail cannot be empty").max(BRAND_LIMITS.rule))
      .max(BRAND_LIMITS.rules)
      .refine((rules) => new Set(rules.map((rule) => rule.toLowerCase())).size === rules.length, "Each guardrail must be different")
      .optional(),
    operationKey: z.uuid(),
  })
  .strict()
  .refine((input) => Object.entries(input).some(([key, value]) => key !== "operationKey" && value !== undefined), "The edit contains no changes.");
/**
 * Operation `draft_brand_from_website`: reads one public https page and proposes brand kit fields from it.
 * Nothing is saved; the person accepts fields one by one and they are saved through `update_brand`.
 */
export const draftBrandInputSchema = z
  .object({
    url: z.string().trim().min(1, "Paste your website’s address").max(2048, "That address is too long"),
    operationKey: z.uuid(),
  })
  .strict();
export const brandDraftSchema = z.object({
  source: z.object({
    /** The page that was read, after any redirects. */
    url: z.string(),
    host: z.string(),
    title: z.string().nullable(),
    /** The page's declared language (BCP 47), or null when it declares none. */
    language: z.string().nullable(),
    /** Visible characters read from the page, after the cap. */
    characters: z.number().int().min(0),
    /** The page was longer than Faceful reads; the rest was skipped. */
    truncated: z.boolean(),
    /** Almost no text on the page: it is probably built in the browser with JavaScript. */
    thin: z.boolean(),
  }),
  /** `ai`: written by the configured model from the page. `page`: copied from what the page itself states. */
  writer: z.enum(["ai", "page"]),
  /** Why the proposal is page-only, in a sentence, or null. */
  note: z.string().nullable(),
  proposal: z.object({
    name: z.string().max(BRAND_LIMITS.name).nullable(),
    description: z.string().max(BRAND_LIMITS.description).nullable(),
    tone: z.string().max(BRAND_LIMITS.tone).nullable(),
    audience: z.string().max(BRAND_LIMITS.audience).nullable(),
    color: brandColorSchema.nullable(),
    rules: z.array(z.string().max(BRAND_LIMITS.rule)).max(BRAND_LIMITS.rules),
  }),
  /** Products or services the page names. Suggestions only: products and their approved facts are added by a person. */
  offerings: z.array(z.object({ name: z.string().max(120), description: z.string().max(300) })).max(6),
});
export const SOURCE_LIMITS = { title: 160, url: 2048, excerpt: 5000, perProject: 20 } as const;
/**
 * Adds a source to one project. The link is a reference only: Faceful never fetches it. The excerpt is
 * the exact text drafts may use, stored as data.
 */
export const addSourceInputSchema = z
  .object({
    campaignId: idSchema,
    title: z.string().trim().min(1, "Give the source a title").max(SOURCE_LIMITS.title),
    url: z.string().trim().max(SOURCE_LIMITS.url).pipe(httpUrlSchema).nullable().optional(),
    excerpt: z.string().trim().min(1, "Paste the text Faceful may use").max(SOURCE_LIMITS.excerpt),
    operationKey: z.uuid(),
  })
  .strict();
export const removeSourceInputSchema = z
  .object({ campaignId: idSchema, sourceId: idSchema, operationKey: z.uuid() })
  .strict();
export type Brand = z.infer<typeof brandSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type UpdateBrandInput = z.input<typeof updateBrandInputSchema>;
export type DraftBrandInput = z.input<typeof draftBrandInputSchema>;
export type BrandDraft = z.infer<typeof brandDraftSchema>;
export type AddSourceInput = z.input<typeof addSourceInputSchema>;
export type RemoveSourceInput = z.infer<typeof removeSourceInputSchema>;
export type StudioContext = z.infer<typeof contextSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type ContentItem = z.infer<typeof contentSchema>;
export type ContentPatch = z.infer<typeof patchSchema>;
export type ReviseInput = z.infer<typeof reviseInputSchema>;
export type ScheduleManifest = z.infer<typeof manifestSchema>;
export type Operation = z.infer<typeof operationSchema>;
export type GrantInput = z.infer<typeof grantInputSchema>;
export type Platform = z.infer<typeof platformSchema>;
export type StudioError = z.infer<typeof errorSchema>;

/* ───────────── AI Creative Director (shared by the studio UI, the engine and MCP) ───────────── */

/** Every action is executed through the same typed domain operations a person uses; none can approve or publish. */
export const directorActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("revise"), itemId: idSchema, expectedRevision: z.number().int().positive(), patch: patchSchema }).strict(),
  z.object({ kind: z.literal("render"), itemId: idSchema, expectedRevision: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("review_schedule"), campaignId: idSchema, expectedRevision: z.number().int().positive() }).strict(),
  /** Opens Stripe-hosted sandbox Checkout after the person confirms. Card details never pass through chat. */
  z.object({ kind: z.literal("checkout"), priceKey: z.string().min(1).max(40) }).strict(),
]);
export type DirectorAction = z.infer<typeof directorActionSchema>;
export const directorPlanSchema = z
  .object({ summary: z.string().min(1).max(1000), actions: z.array(directorActionSchema).min(1).max(3) })
  .strict();
export type DirectorPlan = z.infer<typeof directorPlanSchema>;
export const directorTurnInputSchema = z
  .object({
    campaignId: idSchema.nullable(),
    itemId: idSchema.nullable(),
    scope: z.enum(["item", "project"]),
    instruction: z.string().trim().min(1).max(5000),
    sourceIds: z.array(idSchema).max(20).default([]),
    /** Earlier turns for continuity. Treated as conversation, never as authority. */
    history: z.array(z.object({ instruction: z.string().max(5000), summary: z.string().max(1000) }).strict()).max(8).default([]),
    operationKey: z.uuid(),
  })
  .strict();
export type DirectorTurnInput = z.infer<typeof directorTurnInputSchema>;
export const directorAssetSchema = z.object({
  campaignId: idSchema,
  campaignTitle: z.string(),
  itemId: idSchema,
  title: z.string(),
  status: z.string(),
  revision: z.number().int().positive(),
  hasVideo: z.boolean(),
  updatedAt: instantSchema,
});
export const directorTurnResultSchema = z.object({
  /** "ai": a model interpreted the request. "basic": matched by fixed rules only; nothing was written by a model. */
  mode: z.enum(["ai", "basic"]),
  summary: z.string().min(1).max(2000),
  /** Proposed changes awaiting the person's review. Null when nothing needs approval. */
  plan: directorPlanSchema.nullable(),
  /** A new project whose drafts were just saved. Drafting is free and reversible; nothing was rendered. */
  created: campaignSchema.nullable(),
  /** Existing content to open (and play when it has a video). No generation was started. */
  open: z.object({ campaignId: idSchema, itemId: idSchema.nullable(), play: z.boolean() }).nullable(),
  assets: z.array(directorAssetSchema).max(20),
  suggestions: z.array(z.string().max(80)).max(4),
});
export type DirectorTurnResult = z.infer<typeof directorTurnResultSchema>;

export const templateSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  name: z.string(),
  description: z.string(),
  aspectRatio: z.literal("9:16"),
  durationSeconds: z.number().int().positive(),
  channels: z.array(platformSchema),
  languages: z.array(z.string()),
  itemCount: z.number().int().min(1).max(3),
  inputs: z.array(z.object({ key: z.string(), label: z.string(), placeholder: z.string(), required: z.boolean(), maxLength: z.number().int().positive() })),
  preview: z.array(z.object({ title: z.string(), script: z.string() })),
  /** Reserved for a future marketplace. Only first-party curated templates exist today. */
  visibility: z.literal("curated"),
});
export type Template = z.infer<typeof templateSchema>;
export const templateInputSchema = z
  .object({ templateId: idSchema, language: z.string().min(2).max(12), inputs: z.record(z.string(), z.string().max(400)), operationKey: z.uuid() })
  .strict();
export type TemplateInput = z.infer<typeof templateInputSchema>;

// ── Likeness capture ("Scan my face"): a guided face scan plus spoken consent, kept as private recordings. ──
export const likenessLanguageSchema = z.enum(["en", "el"]);
export type LikenessLanguage = z.infer<typeof likenessLanguageSchema>;
export const likenessPoseSchema = z.enum(["center", "left", "right", "up", "down"]);
export type LikenessPose = z.infer<typeof likenessPoseSchema>;

/**
 * The spoken permission, word for word as stored. Built here so the sentence a person reads in the
 * browser is exactly the one the engine keeps with their recordings; the engine never trusts a supplied one.
 */
export function likenessConsentStatement(name: string, language: LikenessLanguage): string {
  const who = name.trim().replace(/\s+/g, " ");
  return language === "el"
    ? `Εγώ, ${who}, συμφωνώ να δημιουργήσει η Faceful ένα avatar με το πρόσωπο και τη φωνή μου.`
    : `I, ${who}, agree that Faceful may create an avatar of my face and voice.`;
}

export const LIKENESS_MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const LIKENESS_MAX_STILL_BYTES = 15 * 1024 * 1024;
export const likenessUploadInputSchema = z
  .object({
    // What MediaRecorder produces: MP4 (Safari, current Chrome), WebM, or Matroska (Chrome's H.264 "WebM").
    type: z.enum(["video/mp4", "video/webm", "video/x-matroska", "image/jpeg"]),
    size: z.number().int().positive().max(LIKENESS_MAX_VIDEO_BYTES),
    /** SHA-256 of the exact bytes. Storage refuses any other body, so an upload link is good for one file only. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type LikenessUploadInput = z.infer<typeof likenessUploadInputSchema>;
export const likenessUploadTicketSchema = z.object({
  key: z.string().min(1).max(512),
  // https always. Plain http is accepted only for a loopback address, which is how local test storage is reached.
  uploadUrl: z.url({ protocol: /^https?$/ }).refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  }, "Upload links must use https"),
  /** Headers the PUT must send verbatim; they are part of the signature. */
  headers: z.record(z.string(), z.string()),
  expiresAt: instantSchema,
});
export type LikenessUploadTicket = z.infer<typeof likenessUploadTicketSchema>;

export const likenessLiveTokenSchema = z.object({
  /** Single use; opens one live transcription socket. */
  token: z.string().min(1).max(200),
  url: z.url({ protocol: /^wss?$/ }),
  expiresInSeconds: z.number().int().positive(),
});
export type LikenessLiveToken = z.infer<typeof likenessLiveTokenSchema>;

export const likenessCheckSchema = z.object({
  id: z.string().min(1).max(40),
  label: z.string().max(80),
  passed: z.boolean(),
  /** Whether a failure blocks saving. */
  required: z.boolean(),
  /** The measured value, kept with the consent for review. */
  value: z.number(),
});
export const likenessReportSchema = z.object({ passed: z.boolean(), checks: z.array(likenessCheckSchema).min(1).max(20) });
export type LikenessReport = z.infer<typeof likenessReportSchema>;
export const likenessConsentInputSchema = z
  .object({
    subjectName: z.string().trim().min(2).max(120),
    language: likenessLanguageSchema,
    /** Two random phrases, then the consent statement. */
    phrases: z.array(z.string().max(300)).length(3),
    transcript: z.string().max(5000),
    scanVideoKey: z.string().min(1).max(512),
    speechVideoKey: z.string().min(1).max(512),
    stills: z.partialRecord(likenessPoseSchema, z.string().min(1).max(512)),
    report: likenessReportSchema,
    /** The persona this consent is recorded for (the Personas tab sends people to /face-scan?persona=<id>). */
    personaId: idSchema.optional(),
  })
  .strict();
export type LikenessConsentInput = z.infer<typeof likenessConsentInputSchema>;
export const likenessConsentResultSchema = z.object({
  id: idSchema,
  passed: z.boolean(),
  /** The persona the consent now backs, or null when none was named or it could not take this consent. */
  personaId: idSchema.nullable().optional(),
});
export type LikenessConsentResult = z.infer<typeof likenessConsentResultSchema>;

// ── Personas: presenters made from one person's face scan and spoken consent, each with one or more looks. ──
export const PERSONA_LIMIT = 50;
export const PERSONA_LOOK_LIMIT = 20;
export const PERSONA_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
/** needs_consent: no scan yet; ready: backed by a live consent; consent_withdrawn: the person withdrew it. */
export const personaStatusSchema = z.enum(["needs_consent", "ready", "consent_withdrawn"]);
export type PersonaStatus = z.infer<typeof personaStatusSchema>;
export const personaConsentSchema = z.object({
  id: idSchema,
  subjectName: z.string(),
  language: likenessLanguageSchema,
  createdAt: instantSchema,
  revokedAt: instantSchema.nullable(),
  /** Short-lived link to the straight-on still from the scan. Null once withdrawn, for agents, or without storage. */
  photoUrl: z.url().nullable(),
  /** The person who recorded it, and workspace owners and admins, can withdraw it. */
  canWithdraw: z.boolean(),
});
export type PersonaConsent = z.infer<typeof personaConsentSchema>;
export const personaLookSchema = z.object({
  id: idSchema,
  personaId: idSchema,
  name: z.string(),
  description: z.string(),
  hasImage: z.boolean(),
  /** Short-lived link to the reference photo; null when there is none, for agents, or without storage. */
  imageUrl: z.url().nullable(),
  position: z.number().int().nonnegative(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type PersonaLook = z.infer<typeof personaLookSchema>;
export const personaSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  language: likenessLanguageSchema,
  status: personaStatusSchema,
  consent: personaConsentSchema.nullable(),
  looks: z.array(personaLookSchema),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type Persona = z.infer<typeof personaSchema>;

const personaName = z.string().trim().min(1).max(80);
const personaText = z.string().trim().max(1000);
export const createPersonaInputSchema = z
  .object({ name: personaName, description: personaText.default(""), language: likenessLanguageSchema.default("en"), operationKey: z.uuid() })
  .strict();
export type CreatePersonaInput = z.input<typeof createPersonaInputSchema>;
export const updatePersonaInputSchema = z
  .object({ personaId: idSchema, name: personaName.optional(), description: personaText.optional(), language: likenessLanguageSchema.optional() })
  .strict();
export type UpdatePersonaInput = z.infer<typeof updatePersonaInputSchema>;
export const personaRefInputSchema = z.object({ personaId: idSchema }).strict();
export type PersonaRefInput = z.infer<typeof personaRefInputSchema>;
export const personaImageUploadInputSchema = z
  .object({
    personaId: idSchema,
    type: z.enum(["image/jpeg", "image/png", "image/webp"]),
    size: z.number().int().positive().max(PERSONA_MAX_IMAGE_BYTES),
    /** SHA-256 of the exact bytes; the link accepts this one file only. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type PersonaImageUploadInput = z.infer<typeof personaImageUploadInputSchema>;
export const createPersonaLookInputSchema = z
  .object({
    personaId: idSchema,
    name: personaName,
    description: personaText.default(""),
    /** A key from a persona image upload link for this persona, once the photo is stored. */
    imageKey: z.string().min(1).max(512).nullable().default(null),
    operationKey: z.uuid(),
  })
  .strict();
export type CreatePersonaLookInput = z.input<typeof createPersonaLookInputSchema>;
export const updatePersonaLookInputSchema = z
  .object({ lookId: idSchema, name: personaName.optional(), description: personaText.optional(), imageKey: z.string().min(1).max(512).nullable().optional() })
  .strict();
export type UpdatePersonaLookInput = z.infer<typeof updatePersonaLookInputSchema>;
export const personaLookRefInputSchema = z.object({ lookId: idSchema }).strict();
export type PersonaLookRefInput = z.infer<typeof personaLookRefInputSchema>;
// ── Template library: first-party short-form video templates (built with OpenMontage), each with a rendered sample. ──
/** One library template. Media URLs are short-lived signed links; null when a file is missing from storage. */
export const libraryTemplateSchema = z.object({
  id: idSchema,
  version: z.number().int().positive(),
  /** "face": a lip-synced presenter (a fictional person or an illustrated character). "no_face": type, diagrams, charts. */
  family: z.enum(["face", "no_face"]),
  name: z.string(),
  summary: z.string(),
  useFor: z.string(),
  /** The sample's language; `languages` lists every language a sample exists in. */
  language: z.string(),
  languages: z.array(z.string()),
  aspectRatio: z.literal("9:16"),
  fps: z.number().int().positive(),
  /** Seconds a video made from this template should last. */
  durationRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
  sampleTopic: z.string(),
  sampleSeconds: z.number().positive(),
  voice: z.string(),
  fonts: z.array(z.string()),
  /** What a new video needs, beyond topic, brand and call to action. */
  inputs: z.array(z.object({ key: z.string(), label: z.string() })),
  /** The sample's lines, as shown on screen. */
  script: z.array(z.object({ id: z.string(), text: z.string() })),
  videoUrl: httpUrlSchema.nullable(),
  posterUrl: httpUrlSchema.nullable(),
  stills: z.array(z.object({ beat: z.string(), url: httpUrlSchema.nullable() })),
  variants: z.array(z.object({ language: z.string(), url: httpUrlSchema.nullable() })),
  /** When the signed URLs stop working. */
  expiresAt: instantSchema,
});
export type LibraryTemplate = z.infer<typeof libraryTemplateSchema>;
/* Video compositions previewed with Remotion. */
export * from "./composition.js";
export * from "./quality.js";
export * from "./quality-rules.js";
// ── Clone a video: a short video posted on YouTube, TikTok or Instagram becomes the model for a new one. ──
/** What a clone may borrow from the source video. Only what the person ticks is carried over. */
export const CLONE_TRAITS = ["structure", "pacing", "transitions", "captions", "graphics", "sound", "music", "voice", "colours"] as const;
export const cloneTraitSchema = z.enum(CLONE_TRAITS);
export type CloneTrait = z.infer<typeof cloneTraitSchema>;
export const CLONE_BRIEF_MAX = 4000;

/**
 * A source link, understood without any network call. `embedUrl` is the platform's own player for the video;
 * a TikTok short link (vm.tiktok.com) has none until the engine has followed it to the video it leads to.
 */
export interface CloneLink {
  platform: Platform;
  kind: "video" | "short" | "reel" | "post" | "short_link";
  /** The platform's ID for the video (or the short link's code). */
  sourceId: string;
  /** Canonical address, without tracking parameters. */
  url: string;
  embedUrl: string | null;
  orientation: "portrait" | "landscape";
}
export type CloneLinkResult = { ok: true; link: CloneLink } | { ok: false; reason: string };

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const TIKTOK_ID = /^\d{8,25}$/;
const TIKTOK_CODE = /^[A-Za-z0-9]{5,20}$/;
const TIKTOK_USER = /^@[A-Za-z0-9._]{1,40}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,40}$/;

function youtubeLink(id: string | null | undefined, short: boolean): CloneLinkResult {
  if (!id || !YOUTUBE_ID.test(id)) return { ok: false, reason: "That YouTube link does not point to a video. Copy the link from the video's Share button." };
  return {
    ok: true,
    link: {
      platform: "youtube",
      kind: short ? "short" : "video",
      sourceId: id,
      url: short ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
      // Privacy-enhanced mode: YouTube sets no cookies until the person plays the video.
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}?rel=0&playsinline=1`,
      orientation: short ? "portrait" : "landscape",
    },
  };
}
/** A TikTok video by ID, through TikTok's embed player. */
export function tiktokVideoLink(id: string, user?: string | null): CloneLink {
  return {
    platform: "tiktok",
    kind: "video",
    sourceId: id,
    url: `https://www.tiktok.com/${user && TIKTOK_USER.test(user) ? user : "@"}/video/${id}`,
    embedUrl: `https://www.tiktok.com/player/v1/${id}?music_info=1&description=1&rel=0`,
    orientation: "portrait",
  };
}

/**
 * Reads a YouTube (videos and Shorts), TikTok (videos and short links) or Instagram (reels and posts) link.
 * Shared by the studio, for an instant preview, and the engine, which never trusts the browser's reading.
 */
export function parseCloneLink(raw: string): CloneLinkResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "Paste a link to a YouTube, TikTok or Instagram video." };
  if (text.length > 2048) return { ok: false, reason: "That link is too long to be a video link." };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false, reason: "That does not look like a link. Paste the video's address." };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.port)
    return { ok: false, reason: "That does not look like a video link. Paste the address from the platform's Share button." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^(www|m)\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  const unsupported = { ok: false as const, reason: "Faceful can clone videos from YouTube, TikTok and Instagram. Paste a link from one of those." };

  if (host === "youtu.be") return youtubeLink(parts[0], false);
  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtube-nocookie.com") {
    if (parts[0] === "watch") return youtubeLink(url.searchParams.get("v"), false);
    if (parts[0] === "shorts") return youtubeLink(parts[1], true);
    if (["live", "embed", "v"].includes(parts[0] ?? "")) return youtubeLink(parts[1], false);
    return { ok: false, reason: "That YouTube link is not a single video. Open the video or Short and copy its link." };
  }

  if (host === "vm.tiktok.com" || host === "vt.tiktok.com" || (host === "tiktok.com" && parts[0] === "t")) {
    const code = host === "tiktok.com" ? parts[1] : parts[0];
    if (!code || !TIKTOK_CODE.test(code)) return { ok: false, reason: "That TikTok link looks cut short. Copy it again from the Share button." };
    const base = host === "tiktok.com" ? "https://www.tiktok.com/t" : `https://${host}`;
    return { ok: true, link: { platform: "tiktok", kind: "short_link", sourceId: code, url: `${base}/${code}/`, embedUrl: null, orientation: "portrait" } };
  }
  if (host === "tiktok.com") {
    if (parts[1] === "photo") return { ok: false, reason: "That is a TikTok photo post. Paste a link to a video." };
    if (parts[1] === "live") return { ok: false, reason: "Live streams cannot be cloned. Paste a link to a TikTok video." };
    let id: string | undefined;
    let user: string | null = null;
    if (parts[0]?.startsWith("@") && parts[1] === "video") [user, id] = [parts[0], parts[2]];
    else if (parts[0] === "embed") id = parts[1] === "v2" ? parts[2] : parts[1];
    else if (parts[0] === "player" && parts[1] === "v1") id = parts[2];
    else if (parts[0] === "v") id = parts[1]?.replace(/\.html$/, "");
    else if (parts[0] === "video") id = parts[1];
    if (id && TIKTOK_ID.test(id)) return { ok: true, link: tiktokVideoLink(id, user) };
    if (parts[0]?.startsWith("@") && parts.length === 1) return { ok: false, reason: "That is a TikTok profile. Paste a link to one of its videos." };
    return { ok: false, reason: "That TikTok link does not point to a video. Copy the link from the video's Share button." };
  }

  if (host === "instagram.com" || host === "instagr.am") {
    if (parts[0] === "stories") return { ok: false, reason: "Stories cannot be cloned. Paste a link to a reel or a post." };
    // Share links can start with the account name: instagram.com/<account>/reel/<code>/.
    const at = ["p", "reel", "reels", "tv"].includes(parts[0] ?? "") ? 0 : ["p", "reel", "reels", "tv"].includes(parts[1] ?? "") ? 1 : -1;
    const code = at >= 0 ? parts[at + 1] : undefined;
    if (!code || !INSTAGRAM_CODE.test(code))
      return { ok: false, reason: parts.length === 1 ? "That is an Instagram profile. Paste a link to one reel or post." : "That Instagram link does not point to a reel or a post." };
    const reel = parts[at] !== "p";
    const path = `${reel ? "reel" : "p"}/${code}`;
    return { ok: true, link: { platform: "instagram", kind: reel ? "reel" : "post", sourceId: code, url: `https://www.instagram.com/${path}/`, embedUrl: `https://www.instagram.com/${path}/embed/`, orientation: "portrait" } };
  }
  return unsupported;
}

/** A source video as the engine resolved it. Title and author come from the platform's oEmbed when it gives them. */
export const cloneSourceSchema = z.object({
  platform: platformSchema,
  kind: z.enum(["video", "short", "reel", "post"]),
  sourceId: z.string().min(1).max(64),
  url: httpUrlSchema,
  embedUrl: httpUrlSchema,
  orientation: z.enum(["portrait", "landscape"]),
  title: z.string().max(300).nullable(),
  author: z.string().max(200).nullable(),
  authorUrl: httpUrlSchema.nullable(),
  thumbnailUrl: httpUrlSchema.nullable(),
});
export type CloneSource = z.infer<typeof cloneSourceSchema>;

export const cloneJobInputSchema = z
  .object({
    url: z.string().min(1).max(2048),
    brief: z.string().trim().min(1).max(CLONE_BRIEF_MAX),
    clone: z
      .array(cloneTraitSchema)
      .min(1)
      .max(CLONE_TRAITS.length)
      .refine((traits) => new Set(traits).size === traits.length, "Each trait once"),
    operationKey: z.uuid(),
  })
  .strict();
export type CloneJobInput = z.infer<typeof cloneJobInputSchema>;

/**
 * One clone job. It is a request for work: a worker turns it into a project and a video later. Until then it
 * stays `queued`; nothing is made, charged or published by creating it.
 */
export const cloneJobSchema = z.object({
  id: idSchema,
  source: cloneSourceSchema,
  brief: z.string(),
  clone: z.array(cloneTraitSchema),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
  /** Why a job failed, in words for people; null otherwise. */
  error: z.string().nullable(),
  /** The project the result lives in, once a worker has made one. */
  projectId: idSchema.nullable(),
  /** The finished video as a short-lived signed link; null until there is one. */
  resultUrl: httpUrlSchema.nullable(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type CloneJob = z.infer<typeof cloneJobSchema>;
