import { z } from "zod";

/**
 * Products and content review: the contract the engine, the studio, the local fixture and agents (MCP) share.
 *
 * Products live in the workspace brand kit: a photo, a short description and the facts the brand has approved. Scripts
 * may restate an approved fact; any other product claim needs a source or an expert. A product marked `health` or
 * `finance` makes every script that names it a regulated script.
 *
 * A content review checks one item revision in three passes and records exactly what it examined:
 *   claims   — every factual claim in the script, matched against approved facts (`ai` mode adds a model check);
 *   delivery — the timeline's spoken words, captions and on-screen labels against the approved script;
 *   visuals  — products shown when named, captions clear of platform UI, readable caption speed.
 * A review never says "verified". Regulated scripts (health, finance) need a named human approval, bound to the item
 * revision it was given for; a newer revision needs a new review.
 *
 * Routes (studio API, same auth and scopes as the rest of /v1/studio):
 *   GET  /v1/studio/items/:itemId/review            → contentReviewSchema | null (latest review of the item)
 *   POST /v1/studio/operations/create_product       createProductInputSchema       → productSchema
 *   POST /v1/studio/operations/update_product       updateProductInputSchema       → productSchema
 *   POST /v1/studio/operations/delete_product       productRefInputSchema          → { deleted: true }
 *   POST /v1/studio/operations/product_image_upload_url  productImageUploadInputSchema → productImageTicketSchema
 *   POST /v1/studio/operations/place_product        placeProductInputSchema        → placeProductResultSchema
 *   POST /v1/studio/operations/review_content       reviewContentInputSchema       → contentReviewSchema
 *   POST /v1/studio/operations/approve_review       approveReviewInputSchema       → contentReviewSchema
 * Products are also returned on the studio context (`context.products`).
 * MCP: list_products, place_product, review_content, get_review. Agents can never approve a review.
 *
 * Standalone like composition.ts: it imports nothing from index.ts, so the re-export there cannot form a cycle.
 */

const idSchema = z.string().min(1).max(160);
const instantSchema = z.iso.datetime({ offset: true });

/* ───────────────────────── products ───────────────────────── */

export const PRODUCT_LIMITS = { products: 24, name: 80, description: 300, facts: 12, fact: 200 } as const;
export const PRODUCT_MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const PRODUCT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

/** `health` and `finance` are regulated: scripts that touch them need an expert's approval before scheduling. */
export const regulatedDomainSchema = z.enum(["general", "health", "finance"]);
export type RegulatedDomain = z.infer<typeof regulatedDomainSchema>;

export const productSchema = z.object({
  id: idSchema,
  name: z.string(),
  description: z.string(),
  domain: regulatedDomainSchema,
  /** Facts the brand stands behind, in its own words. The only product claims a script may make without a source. */
  facts: z.array(z.string()),
  hasImage: z.boolean(),
  /** Short-lived link to the product photo; null without a photo, for agents without media access, or without storage. */
  imageUrl: z.url().nullable(),
  position: z.number().int().nonnegative(),
  createdAt: instantSchema,
  updatedAt: instantSchema,
});
export type Product = z.infer<typeof productSchema>;

const productName = z.string().trim().min(1, "Give the product a name").max(PRODUCT_LIMITS.name);
const productDescription = z.string().trim().max(PRODUCT_LIMITS.description);
const productFacts = z
  .array(z.string().trim().min(1, "A fact cannot be empty").max(PRODUCT_LIMITS.fact))
  .max(PRODUCT_LIMITS.facts)
  .refine((facts) => new Set(facts.map((fact) => fact.toLowerCase())).size === facts.length, "Each fact must be different");
/** A key returned by `product_image_upload_url` for this workspace, once the photo is stored. */
const productImageKey = z.string().min(1).max(512);

export const createProductInputSchema = z
  .object({
    name: productName,
    description: productDescription.default(""),
    domain: regulatedDomainSchema.default("general"),
    facts: productFacts.default([]),
    imageKey: productImageKey.nullable().default(null),
    operationKey: z.uuid(),
  })
  .strict();
export type CreateProductInput = z.input<typeof createProductInputSchema>;

/** Only the fields sent change. `imageKey: null` removes the photo. */
export const updateProductInputSchema = z
  .object({
    productId: idSchema,
    name: productName.optional(),
    description: productDescription.optional(),
    domain: regulatedDomainSchema.optional(),
    facts: productFacts.optional(),
    imageKey: productImageKey.nullable().optional(),
  })
  .strict();
export type UpdateProductInput = z.infer<typeof updateProductInputSchema>;

export const productRefInputSchema = z.object({ productId: idSchema }).strict();
export type ProductRefInput = z.infer<typeof productRefInputSchema>;

export const productImageUploadInputSchema = z
  .object({
    type: z.enum(PRODUCT_IMAGE_TYPES),
    size: z.number().int().positive().max(PRODUCT_MAX_IMAGE_BYTES),
    /** SHA-256 of the exact bytes; the link accepts this one file only. */
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type ProductImageUploadInput = z.infer<typeof productImageUploadInputSchema>;

/** PUT the bytes to `uploadUrl` with exactly `headers`, then pass `key` as `imageKey` to create or update a product. */
export const productImageTicketSchema = z.object({
  key: z.string(),
  uploadUrl: z.url(),
  headers: z.record(z.string(), z.string()),
  expiresAt: instantSchema,
});
export type ProductImageTicket = z.infer<typeof productImageTicketSchema>;

/**
 * Puts a product's photo on an item's timeline: the photo is copied into the project as an `image` draft file, placed
 * on the overlay layer when the script names the product (or at `at` seconds), and optionally on a closing CTA card.
 */
export const placeProductInputSchema = z
  .object({
    itemId: idSchema,
    productId: idSchema,
    /** The timeline revision this placement is based on; a newer timeline is a conflict, never overwritten. */
    expectedCompositionRevision: z.number().int().nonnegative(),
    layout: z.enum(["full", "split", "window"]).default("window"),
    /** Seconds on the timeline; null places it where the script first names the product (or at one third in). */
    at: z.number().finite().nonnegative().nullable().default(null),
    seconds: z.number().finite().min(1).max(10).default(3),
    endCard: z.boolean().default(true),
    operationKey: z.uuid(),
  })
  .strict();
export type PlaceProductInput = z.input<typeof placeProductInputSchema>;
export const placeProductResultSchema = z.object({
  itemId: idSchema,
  compositionRevision: z.number().int().positive(),
  /** The project draft file holding the copied photo. */
  fileId: idSchema,
  placedAt: z.number().nonnegative(),
  /** True when the time came from the script naming the product; false when it fell back to a default. */
  matchedMention: z.boolean(),
});
export type PlaceProductResult = z.infer<typeof placeProductResultSchema>;

/* ───────────────────────── content review ───────────────────────── */

export const claimKindSchema = z.enum(["health", "finance", "legal", "number", "comparative", "price"]);
export type ClaimKind = z.infer<typeof claimKindSchema>;
/**
 * supported     — an approved fact (or cited source) says the same thing, numbers included.
 * contradicted  — an approved fact covers this but says something different (usually a number).
 * unsupported   — nothing approved backs it.
 * risky_wording — a promise regulators and platforms reject on sight ("cures", "no side effects", "guaranteed returns").
 * needs_expert  — it may be true, but only a qualified person can say so.
 */
export const claimStatusSchema = z.enum(["supported", "contradicted", "unsupported", "risky_wording", "needs_expert"]);
export type ClaimStatus = z.infer<typeof claimStatusSchema>;
/** blocking holds back scheduling (or, for regulated scripts, needs an approver's written reason); warning is advice. */
export const reviewSeveritySchema = z.enum(["blocking", "warning", "info"]);
export type ReviewSeverity = z.infer<typeof reviewSeveritySchema>;

export const reviewSourceSchema = z.object({
  type: z.enum(["product_fact", "source", "brand_rule"]),
  /** Product id, source id, or null for a brand rule. */
  id: idSchema.nullable(),
  /** The exact words the claim is checked against. */
  quote: z.string(),
});
export const reviewClaimSchema = z.object({
  id: z.string(),
  /** Exact text from the script. */
  quote: z.string(),
  kind: claimKindSchema,
  status: claimStatusSchema,
  severity: reviewSeveritySchema,
  source: reviewSourceSchema.nullable(),
  /** One plain sentence: why it got this status. */
  note: z.string(),
  /** Safer wording that says only what is supported, or null when there is nothing to change or no safe rewrite. */
  suggestion: z.string().nullable(),
});
export type ReviewClaim = z.infer<typeof reviewClaimSchema>;

export const reviewFindingSchema = z.object({
  id: z.string(),
  pass: z.enum(["delivery", "visuals"]),
  code: z.string(),
  severity: reviewSeveritySchema,
  message: z.string(),
  /** Seconds on the timeline, when the finding has a place. */
  at: z.number().nonnegative().nullable(),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewApprovalSchema = z.object({
  /** Name as the approver typed it, e.g. "Dr. Eleni Papadopoulou". */
  by: z.string(),
  /** Qualification, e.g. "MD, cardiologist" or "Certified financial adviser". Required for regulated scripts. */
  credential: z.string(),
  note: z.string(),
  principalId: idSchema,
  at: instantSchema,
});
export type ReviewApproval = z.infer<typeof reviewApprovalSchema>;

export const reviewStatusSchema = z.enum(["passed", "needs_changes", "needs_approval", "approved"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const contentReviewSchema = z.object({
  id: idSchema,
  campaignId: idSchema,
  itemId: idSchema,
  /** The item revision this review describes. A newer revision makes it stale. */
  itemRevision: z.number().int().positive(),
  compositionRevision: z.number().int().nonnegative().nullable(),
  domain: regulatedDomainSchema,
  /** ai: a model checked the claims against the approved facts and sources; basic: rule-based wording checks only. */
  mode: z.enum(["ai", "basic"]),
  status: reviewStatusSchema,
  claims: z.array(reviewClaimSchema),
  findings: z.array(reviewFindingSchema),
  /** What was actually examined. Anything false here was not checked, and `notes` says why. */
  checked: z.object({
    claims: z.boolean(),
    timeline: z.boolean(),
    transcript: z.boolean(),
    renderedVideo: z.boolean(),
  }),
  notes: z.array(z.string()),
  approval: reviewApprovalSchema.nullable(),
  createdAt: instantSchema,
});
export type ContentReview = z.infer<typeof contentReviewSchema>;

export const reviewContentInputSchema = z.object({ itemId: idSchema, operationKey: z.uuid() }).strict();
export type ReviewContentInput = z.input<typeof reviewContentInputSchema>;

/**
 * Human approval of one review (owners, admins and reviewers; never agents). Regulated scripts need a credential.
 * Approving a review that still has blocking items needs a note of at least 20 characters saying why they are acceptable.
 */
export const approveReviewInputSchema = z
  .object({
    reviewId: idSchema,
    by: z.string().trim().min(2, "Write the approver's name").max(120),
    credential: z.string().trim().max(160).default(""),
    note: z.string().trim().max(800).default(""),
    operationKey: z.uuid(),
  })
  .strict();
export type ApproveReviewInput = z.input<typeof approveReviewInputSchema>;

/** The wording schedule blockers use for review gates, so the readiness checklist can file them under "Claims". */
export const REVIEW_BLOCKER_PREFIX = "Claims review:";
