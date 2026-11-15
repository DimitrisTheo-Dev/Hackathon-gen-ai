import { z } from "zod";

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
