import { z } from 'zod'

/** Proposed boundary v0.1. Minas agreement pending; see docs/product/contract-handoff.md. */
export const idSchema = z.string().min(1).max(160)
export const instantSchema = z.iso.datetime({ offset: true })
export const platformSchema = z.enum(['instagram', 'tiktok', 'youtube'])
export const kindSchema = z.enum(['avatar_video', 'image', 'text'])
export const errorSchema = z.object({ code: z.enum(['unauthenticated', 'forbidden', 'not_found', 'revision_conflict', 'idempotency_conflict', 'approval_required', 'stale_manifest', 'quota_exceeded', 'unsupported', 'provider_unavailable', 'validation_error', 'unknown_outcome']), message: z.string(), retryAfterSeconds: z.number().nullable().default(null), reviewUrl: z.string().nullable().default(null) })
export const variantSchema = z.object({ platform: platformSchema, title: z.string().max(150), caption: z.string().max(2200), accountId: idSchema.nullable(), visibility: z.enum(['public', 'private', 'unlisted']), aiDisclosure: z.boolean() })
export const targetSchema = z.object({ platform: platformSchema, accountId: idSchema.nullable(), scheduledAt: instantSchema, timezone: z.string(), state: z.enum(['draft', 'approval_required', 'queued', 'accepted', 'published', 'failed', 'unknown', 'cancel_requested', 'cancelled']), publishedAt: instantSchema.nullable(), providerId: z.string().nullable(), publishedUrl: z.url().nullable(), error: z.string().nullable() })
export const mediaSchema = z.object({ id: idSchema, url: z.url(), expiresAt: instantSchema.nullable(), sha256: z.string(), revision: z.number().int().positive(), durationSeconds: z.number().positive(), hasAudio: z.boolean() })
export const contentSchema = z.object({ id: idSchema, workspaceId: idSchema, campaignId: idSchema, title: z.string().min(1).max(120), kind: kindSchema, script: z.string().max(5000), avatarId: idSchema.nullable(), language: z.string(), revision: z.number().int().positive(), renderRevision: z.number().int().positive().nullable(), status: z.enum(['draft', 'queued', 'rendering', 'ready', 'needs_review', 'failed']), media: mediaSchema.nullable(), variants: z.array(variantSchema), targets: z.array(targetSchema), style: z.object({ captions: z.boolean(), brandColor: z.string().regex(/^#[0-9a-f]{6}$/i), captionPosition: z.enum(['bottom', 'center']) }), sourceIds: z.array(idSchema), updatedAt: instantSchema })
export const jobSchema = z.object({ id: idSchema, itemId: idSchema.nullable(), stage: z.enum(['draft', 'brand_check', 'render', 'compose', 'publish']), state: z.enum(['queued', 'running', 'succeeded', 'failed', 'unknown', 'cancel_requested', 'cancelled']), createdAt: instantSchema, updatedAt: instantSchema, providerCorrelationId: z.string().nullable(), error: errorSchema.nullable(), nextPollAfterMs: z.number().int().min(1000) })
export const auditSchema = z.object({ id: idSchema, actor: z.string(), action: z.string(), objectId: idSchema, revision: z.number().int().nullable(), at: instantSchema, outcome: z.string() })
export const sourceSchema = z.object({ id: idSchema, title: z.string(), url: z.url().nullable(), excerpt: z.string(), permittedAssetIds: z.array(idSchema), retrievedAt: instantSchema })
export const campaignSchema = z.object({ id: idSchema, workspaceId: idSchema, title: z.string(), brief: z.string(), revision: z.number().int().positive(), createdAt: instantSchema, updatedAt: instantSchema, timezone: z.string(), items: z.array(contentSchema), sources: z.array(sourceSchema), jobs: z.array(jobSchema), activity: z.array(auditSchema), humanInterventions: z.number().int().nonnegative(), mode: z.enum(['live', 'fixture']) })
export const connectionSchema = z.object({ id: idSchema, displayName: z.string(), scopes: z.array(z.string()), expiresAt: instantSchema, lastSeenAt: instantSchema.nullable(), revokedAt: instantSchema.nullable() })
export const contextSchema = z.object({
  workspace: z.object({ id: idSchema, name: z.string(), timezone: z.string(), role: z.enum(['owner', 'creator']), type: z.enum(['personal', 'company', 'agency']) }),
  principal: z.object({ id: idSchema, kind: z.enum(['human', 'agent']), scopes: z.array(z.string()) }),
  brand: z.object({ name: z.string(), description: z.string(), rules: z.array(z.string()), color: z.string() }),
  avatars: z.array(z.object({ id: idSchema, name: z.string(), languages: z.array(z.string()), permission: z.enum(['authorized', 'unavailable']), previewUrl: z.url().nullable() })),
  channels: z.array(z.object({ id: idSchema, platform: platformSchema, displayName: z.string(), state: z.enum(['connected', 'expired', 'unavailable']) })),
  capabilities: z.object({ mode: z.enum(['live', 'fixture']), canRender: z.boolean(), canConnectChannels: z.boolean(), canRetry: z.boolean(), canCancel: z.boolean(), canCreateAgentToken: z.boolean(), canCreateGrant: z.boolean(), formats: z.array(z.object({ kind: kindSchema, platform: platformSchema, supported: z.boolean(), reason: z.string().nullable() })), visibility: z.array(z.enum(['public', 'private', 'unlisted'])), renderUnitsRemaining: z.number().nonnegative(), postsRemaining: z.number().int().nonnegative(), mcpUrl: z.url().nullable(), openapiUrl: z.url().nullable() }),
  connections: z.array(connectionSchema),
})
export const patchSchema = z.object({ title: z.string().min(1).max(120).optional(), script: z.string().max(5000).optional(), avatarId: idSchema.nullable().optional(), language: z.string().optional(), style: contentSchema.shape.style.optional(), variants: z.array(variantSchema).optional() }).strict()
export const reviseInputSchema = z.object({ contentId: idSchema, expectedRevision: z.number().int().positive(), operationKey: z.string().uuid(), patch: patchSchema }).strict()
export const manifestSchema = z.object({ id: idSchema, campaignId: idSchema, campaignRevision: z.number().int().positive(), hash: z.string(), createdAt: instantSchema, expiresAt: instantSchema, reviewUrl: z.string(), approval: z.enum(['required', 'approved', 'stale']), entries: z.array(z.object({ itemId: idSchema, revision: z.number().int().positive(), assetId: idSchema, assetHash: z.string(), platform: platformSchema, accountId: idSchema, scheduledAt: instantSchema, timezone: z.string(), caption: z.string(), title: z.string(), visibility: variantSchema.shape.visibility, aiDisclosure: z.boolean() })), blockers: z.array(z.object({ itemId: idSchema, message: z.string() })) })
export const operationSchema = z.object({ operationId: idSchema, state: z.enum(['accepted', 'blocked', 'completed']), jobIds: z.array(idSchema), nextPollAfterMs: z.number().int().min(1000), reviewUrl: z.string().nullable() })
export const grantInputSchema = z.object({ campaignId: idSchema, campaignRevision: z.number().int().positive(), operationKey: z.string().uuid(), accountIds: z.array(idSchema).min(1), avatarIds: z.array(idSchema).min(1), maximumItems: z.number().int().min(1).max(3), maximumPosts: z.number().int().min(1).max(9), maximumRenderSeconds: z.number().int().min(1).max(180), expiresAt: instantSchema, windowStart: instantSchema, windowEnd: instantSchema, acknowledgesFuturePublication: z.literal(true) }).strict()
export type StudioContext = z.infer<typeof contextSchema>
export type Campaign = z.infer<typeof campaignSchema>
export type ContentItem = z.infer<typeof contentSchema>
export type ContentPatch = z.infer<typeof patchSchema>
export type ReviseInput = z.infer<typeof reviseInputSchema>
export type ScheduleManifest = z.infer<typeof manifestSchema>
export type Operation = z.infer<typeof operationSchema>
export type GrantInput = z.infer<typeof grantInputSchema>
export type Platform = z.infer<typeof platformSchema>
export type StudioError = z.infer<typeof errorSchema>
