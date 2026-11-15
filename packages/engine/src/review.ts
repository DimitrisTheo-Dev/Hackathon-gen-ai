import {
  approveReviewInputSchema,
  basicClaims,
  blockingCount,
  compositionSchema,
  contentReviewSchema,
  deliveryFindings,
  detectDomain,
  isRegulated,
  REVIEW_BLOCKER_PREFIX,
  reviewContentInputSchema,
  reviewStatus,
  splitSentences,
  visualFindings,
  type ClaimKind,
  type Composition,
  type ContentReview,
  type Product,
  type RegulatedDomain,
  type ReviewClaim,
  type ReviewSeverity,
} from "../../contracts/src/index.js";
import { audit, idempotent, requireHuman, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { COMPOSITIONS_TABLE } from "./composition.js";
import { EngineError } from "./errors.js";
import { FILES_TABLE } from "./files.js";
import { createReviewModel, type ModelClaim, type ReviewModel } from "./review-model.js";
import { selectOne, type Row } from "./store.js";
import { brandContract, loadItem, loadProject, parse, workspaceProducts } from "./studio.js";

/**
 * Content review (contract: packages/contracts/src/quality.ts). One review describes one revision of one item, in
 * three passes, and records exactly what it examined:
 *   claims   — every checkable claim in the script, against approved product facts (basic: the shared rules in
 *              quality-rules.ts; ai: a model pass in review-model.ts, re-checked here, with the rules' blocking items kept);
 *   delivery — the saved timeline's spoken words, captions and labels against the script;
 *   visuals  — products shown when named, captions clear of platform UI, readable caption speed.
 * It never says "verified". Health and finance scripts need a named human approval (owner, admin or reviewer, never an
 * agent) before prepare_schedule lets them through; a newer script revision needs a new review.
 * Table: supabase/migrations/20261115160000_products_reviews.sql.
 */
export const REVIEWS_TABLE = "content_reviews";
const APPROVERS = new Set(["owner", "admin", "reviewer"]);
const iso = (value: string | Date) => new Date(value).toISOString();

/** Engine dependencies with an optional claims model. Absent: one is made from `config.llm` when that is set. */
export type ReviewDeps = EngineDeps & { reviewModel?: ReviewModel | null };

export const UNAVAILABLE_MESSAGE = "Content reviews aren’t available on this deployment yet: its database has not been updated for them, or could not be reached. Nothing was changed.";

function reviewContract(row: Row): ContentReview {
  return parse(contentReviewSchema, {
    id: row.id,
    campaignId: row.project_id,
    itemId: row.item_id,
    itemRevision: row.item_revision,
    compositionRevision: row.composition_revision ?? null,
    domain: row.domain,
    mode: row.mode,
    status: row.status,
    claims: row.claims ?? [],
    findings: row.findings ?? [],
    checked: row.checked,
    notes: row.notes ?? [],
    approval: row.approval ?? null,
    createdAt: iso(row.created_at),
  });
}

async function latestRow(deps: EngineDeps, ctx: Ctx, itemId: string): Promise<Row | null> {
  const rows = await deps.store.select(REVIEWS_TABLE, { org_id: ctx.org.id, item_id: itemId }, { order: ["created_at", "desc"], limit: 1 });
  return rows[0] ?? null;
}

/** A store call on the products or reviews tables. Where they are missing (or unreachable), the caller is told so plainly. */
async function reviewTables<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof EngineError && error.code === "provider_unavailable") throw new EngineError("provider_unavailable", UNAVAILABLE_MESSAGE);
    throw error;
  }
}

/** GET /v1/studio/items/:itemId/review: the item's latest review, or null when it has none. */
export async function getLatestReview(deps: EngineDeps, ctx: Ctx, itemId: string): Promise<ContentReview | null> {
  requireScope(ctx, "campaign:read");
  const item = await loadItem(deps, ctx, itemId);
  const row = await reviewTables(() => latestRow(deps, ctx, item.id));
  return row ? reviewContract(row) : null;
}

/* ───────────────────────── claims: the model's pass, re-checked ───────────────────────── */

const RANK: Record<ReviewSeverity, number> = { info: 0, warning: 1, blocking: 2 };
const stricter = (a: ReviewSeverity, b: ReviewSeverity) => (RANK[a] >= RANK[b] ? a : b);

/** The severity the shared rules would give this status, so a model can raise a severity but never lower one. */
function ruleSeverity(status: ReviewClaim["status"], kind: ClaimKind, domain: RegulatedDomain): ReviewSeverity {
  const regulated = isRegulated(domain);
  if (status === "supported") return "info";
  if (status === "risky_wording" || status === "contradicted") return "blocking";
  if (status === "needs_expert") return regulated ? "blocking" : "warning";
  return regulated && (kind === "number" || kind === "legal" || kind === "health" || kind === "finance") ? "blocking" : "warning";
}

interface ClaimMaterial {
  script: string;
  domain: RegulatedDomain;
  products: ReadonlyArray<Pick<Product, "id" | "facts">>;
  sources: ReadonlyArray<{ id: string; excerpt: string }>;
  brandRules: ReadonlyArray<string>;
}

/** True when `source` quotes, word for word, something that was really provided. */
function quotesProvided(source: NonNullable<ModelClaim["source"]>, material: ClaimMaterial): boolean {
  const quote = source.quote.trim();
  if (!quote) return false;
  if (source.type === "product_fact") return material.products.some((product) => product.id === source.id && product.facts.some((fact) => fact.includes(quote)));
  if (source.type === "source") return material.sources.some((entry) => entry.id === source.id && entry.excerpt.includes(quote));
  return material.brandRules.some((rule) => rule.includes(quote));
}

/**
 * The model's claims after the engine's own checks: quotes must be exact substrings of the script (others are
 * dropped); "supported" needs a product fact or source quoted exactly; severities follow the shared rule or stricter.
 */
export function checkModelClaims(raw: ReadonlyArray<ModelClaim>, material: ClaimMaterial): { claims: ReviewClaim[]; dropped: number; corrected: number } {
  const claims: ReviewClaim[] = [];
  let dropped = 0;
  let corrected = 0;
  for (const entry of raw) {
    const quote = entry.quote.trim();
    if (!quote || !material.script.includes(quote)) {
      dropped++;
      continue;
    }
    let { status, source, note } = entry;
    const valid = source !== null && quotesProvided(source, material);
    if (status === "supported" && (!valid || source?.type === "brand_rule")) {
      status = entry.kind === "health" || entry.kind === "finance" ? "needs_expert" : "unsupported";
      note = "The AI check called this supported but did not quote an approved fact or source word for word, so it still needs one.";
      source = null;
      corrected++;
    } else if (source && !valid) source = null;
    const rule = ruleSeverity(status, entry.kind, material.domain);
    claims.push({
      id: `a${claims.length + 1}`,
      quote,
      kind: entry.kind,
      status,
      severity: status === "supported" ? "info" : stricter(entry.severity, rule),
      source: source ? { type: source.type, id: source.type === "brand_rule" ? null : source.id, quote: source.quote.trim() } : null,
      note: note.trim() || "Checked against the approved facts and sources provided.",
      suggestion: status === "supported" ? null : entry.suggestion?.trim() || null,
    });
  }
  return { claims, dropped, corrected };
}

const overlaps = (a: string, b: string) => a.includes(b) || b.includes(a);

/**
 * Model claims plus every rule-based blocking claim the model's output does not cover (by quote). The rules are
 * deliberately conservative: a rule's risky-wording flag stays unless the model flags the same words as blocking too.
 */
export function mergeClaims(script: string, model: ReviewClaim[], basic: ReviewClaim[]): ReviewClaim[] {
  const kept = basic.filter(
    (claim) =>
      claim.severity === "blocking" &&
      !model.some((entry) => overlaps(entry.quote, claim.quote) && (claim.status !== "risky_wording" || entry.severity === "blocking")),
  );
  return [...model, ...kept].sort((a, b) => script.indexOf(a.quote) - script.indexOf(b.quote));
}

/* ───────────────────────── review_content ───────────────────────── */

function claimsModel(deps: ReviewDeps): ReviewModel | null {
  if (!deps.config.llm) return null;
  return deps.reviewModel ?? createReviewModel(deps.config.llm);
}

/** Reads one optional input; a failure (a table missing on this deployment, a database hiccup) becomes a note. */
async function optional<T>(read: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await read() };
  } catch {
    return { ok: false };
  }
}

/** review_content: runs the three passes on the item's current revision and stores the result. */
export async function reviewContent(deps: ReviewDeps, ctx: Ctx, raw: unknown): Promise<ContentReview> {
  requireScope(ctx, "campaign:read");
  // Editors (and agents with content:edit) run reviews; so do the reviewers who approve them.
  if (!ctx.scopes.has("schedule:approve")) requireScope(ctx, "content:edit");
  const input = parse(reviewContentInputSchema, raw);
  return idempotent(deps, ctx, "review_content", input.operationKey, input, async () => {
    const item = await loadItem(deps, ctx, input.itemId);
    const project = await loadProject(deps, ctx, item.project_id);
    const script = String(item.script ?? "");
    // The products and reviews tables first: where they are missing, nothing else (and no model call) runs.
    const [brandRow, products, previous] = await Promise.all([
      selectOne(deps.store, "brand_profiles", { org_id: ctx.org.id }),
      reviewTables(() => workspaceProducts(deps, ctx, { photos: false })),
      reviewTables(() => latestRow(deps, ctx, item.id)),
    ]);
    const brandRules = brandContract(brandRow, ctx.org.name).rules;
    const sources = (Array.isArray(project.sources) ? project.sources : []).map((source: Row) => ({ id: String(source.id), title: String(source.title ?? ""), excerpt: String(source.excerpt ?? "") }));
    const notes: string[] = [];

    // The saved timeline, when there is one. Without it, the voice, caption and on-screen checks wait.
    const stored = await optional(() => selectOne(deps.store, COMPOSITIONS_TABLE, { org_id: ctx.org.id, item_id: item.id }));
    let composition: Composition | null = null;
    let compositionRevision: number | null = null;
    if (stored.ok && stored.value) {
      const parsed = compositionSchema.safeParse(stored.value.composition);
      if (parsed.success) {
        composition = parsed.data;
        compositionRevision = stored.value.revision;
      } else notes.push("The saved timeline is in an older format, so the voice, caption and on-screen checks were skipped. Open the video editor and save it again.");
    } else if (!stored.ok) notes.push("The timeline could not be read on this deployment, so the voice, caption and on-screen checks were skipped.");
    else notes.push("There is no saved timeline yet, so the voice, caption and on-screen checks wait for one. Save the video edit, then review again.");

    // Which draft files are avatar clips, and which show which product (place_product records meta.productId).
    const avatarFileIds: string[] = [];
    const productFileIds: Record<string, string[]> = {};
    if (composition) {
      const files = await optional(() => deps.store.select(FILES_TABLE, { org_id: ctx.org.id, project_id: item.project_id, state: "ready" }, { limit: 500 }));
      if (files.ok)
        for (const file of files.value) {
          if (file.kind === "avatar_clip") avatarFileIds.push(file.id);
          const productId = file.meta?.productId;
          if (file.kind === "image" && typeof productId === "string") (productFileIds[productId] ??= []).push(file.id);
        }
      else notes.push("The project’s draft files could not be read, so product photos on the timeline could not be matched to products.");
    }
    const platforms = [...new Set(((item.targets as Row[] | null) ?? []).map((target) => String(target.platform)))];
    const domain = detectDomain(script, products);

    // Claims: the shared rules always run; a model pass refines them when this deployment has one.
    const basic = basicClaims(script, { products, brandRules, domain });
    let claims = basic;
    let mode: "ai" | "basic" = "basic";
    const model = claimsModel(deps);
    if (!model) notes.push("Claims were checked with rule-based wording checks against your approved product facts. No AI model checked them on this deployment.");
    else {
      const since = new Date(deps.now().getTime() - 24 * 3600_000).toISOString();
      const recent = await deps.store.select("operations", { org_id: ctx.org.id, name: "review_content", created_at: { gte: since } }, { limit: deps.config.directorDailyTurns + 1 });
      if (recent.length > deps.config.directorDailyTurns) notes.push("This workspace has reached today’s limit for AI checks, so only the rule-based wording checks ran.");
      else {
        try {
          const raw = await model.claims({
            domain,
            language: String(item.language ?? "en"),
            sentences: splitSentences(script),
            products: products.map((product) => ({ id: product.id, name: product.name, description: product.description, domain: product.domain, approvedFacts: product.facts })),
            sources,
            brandRules,
          });
          const checked = checkModelClaims(raw, { script, domain, products, sources, brandRules });
          claims = mergeClaims(script, checked.claims, basic);
          mode = "ai";
          notes.push("Claims were checked by an AI model against your approved product facts and this project’s sources only, not outside knowledge. Every rule-based blocking flag the model did not cover was kept.");
          if (checked.dropped) notes.push(`${checked.dropped} claim${checked.dropped === 1 ? "" : "s"} from the AI check ${checked.dropped === 1 ? "was" : "were"} left out because ${checked.dropped === 1 ? "its quote was" : "their quotes were"} not in the script word for word.`);
          if (checked.corrected) notes.push(`${checked.corrected} claim${checked.corrected === 1 ? "" : "s"} the AI check called supported did not quote a provided fact or source exactly, so ${checked.corrected === 1 ? "it was" : "they were"} marked as still needing one.`);
        } catch (error) {
          const reason = error instanceof EngineError ? error.message : "an unexpected error";
          if (!(error instanceof EngineError)) console.error(JSON.stringify({ level: "error", event: "review_model_unhandled", correlationId: ctx.correlationId, name: error instanceof Error ? error.name : "unknown" }));
          notes.push(`The AI claims check was unavailable (${reason}), so only the rule-based wording checks ran.`);
        }
      }
    }

    const findings = [...deliveryFindings(script, composition, { domain, avatarFileIds }), ...visualFindings(script, composition, { products, productFileIds, platforms })];
    const transcript = (composition?.transcript?.words.length ?? 0) > 0;
    if (composition && !transcript) notes.push("The timeline has no word timings yet, so the voice was not compared with the script.");
    notes.push("The rendered video’s frames and audio are not inspected in this build; these checks read the script and the saved timeline.");
    notes.push("This review flags wording that needs a source or an expert. It does not confirm that any claim is true.");
    const status = reviewStatus(domain, claims, findings, false);

    // Strictly increasing per item, so "the latest review" is never a tie.
    const now = deps.now().getTime();
    const createdAt = new Date(previous ? Math.max(now, new Date(previous.created_at).getTime() + 1) : now).toISOString();
    const row = await reviewTables(() => deps.store.insert(REVIEWS_TABLE, {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      project_id: item.project_id,
      item_id: item.id,
      item_revision: item.revision,
      composition_revision: compositionRevision,
      domain,
      mode,
      status,
      claims,
      findings,
      checked: { claims: true, timeline: composition !== null, transcript, renderedVideo: false },
      notes,
      approval: null,
      created_by: ctx.actorId,
      created_at: createdAt,
    }));
    const blocking = blockingCount({ claims, findings });
    await audit(deps, ctx, {
      projectId: item.project_id,
      action: "Reviewed the content",
      objectId: item.id,
      revision: item.revision,
      outcome: `${status.replaceAll("_", " ")} · ${domain} · ${claims.length} claim${claims.length === 1 ? "" : "s"}, ${findings.length} finding${findings.length === 1 ? "" : "s"}, ${blocking} blocking · ${mode} check`,
    });
    return reviewContract(row);
  });
}

/* ───────────────────────── approve_review ───────────────────────── */

/**
 * approve_review: a named human approval of the item's latest review, for its current revision. Owners, admins and
 * reviewers only; never agents. Health and finance need the approver's qualification, and accepting blocking items
 * needs a written reason of at least 20 characters.
 */
export async function approveReview(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<ContentReview> {
  requireHuman(ctx, "Approving a content review");
  if (!APPROVERS.has(ctx.role)) throw new EngineError("forbidden", "Only workspace owners, admins and reviewers can approve a content review.");
  const input = parse(approveReviewInputSchema, raw);
  return idempotent(deps, ctx, "approve_review", input.operationKey, input, async () => {
    const review = await reviewTables(() => selectOne(deps.store, REVIEWS_TABLE, { id: input.reviewId, org_id: ctx.org.id }));
    if (!review) throw new EngineError("not_found", "This review was not found in your workspace.");
    const item = await loadItem(deps, ctx, review.item_id);
    if (review.item_revision !== item.revision) throw new EngineError("revision_conflict", "The script changed after this review. Run a new review.");
    const latest = await reviewTables(() => latestRow(deps, ctx, item.id));
    if (latest && latest.id !== review.id) throw new EngineError("revision_conflict", "A newer review of this item exists. Open it and approve that one.");
    if (review.approval) return reviewContract(review);
    const domain = review.domain as RegulatedDomain;
    if (isRegulated(domain) && !input.credential)
      throw new EngineError(
        "validation_error",
        domain === "health"
          ? "Add the approver’s qualification, for example “MD, cardiologist”. Health scripts need a qualified approver."
          : "Add the approver’s qualification, for example “Certified financial adviser”. Finance scripts need a qualified approver.",
      );
    const blocking = blockingCount({ claims: review.claims ?? [], findings: review.findings ?? [] });
    if (blocking > 0 && input.note.length < 20)
      throw new EngineError("validation_error", `This review still has ${blocking} blocking item${blocking === 1 ? "" : "s"}. Write at least 20 characters saying why ${blocking === 1 ? "it is" : "they are"} acceptable.`);
    const approval = { by: input.by, credential: input.credential, note: input.note, principalId: ctx.actorId, at: deps.now().toISOString() };
    // Compare-and-swap: two approvers at once cannot both record theirs.
    const [row] = await reviewTables(() => deps.store.update(REVIEWS_TABLE, { id: review.id, org_id: ctx.org.id, approval: null }, { approval, status: "approved" }));
    if (!row) throw new EngineError("revision_conflict", "Someone approved this review just now. Reload it.");
    await audit(deps, ctx, {
      projectId: review.project_id,
      action: "Approved a content review",
      objectId: review.id,
      revision: item.revision,
      outcome: `${domain} · ${input.by}${input.credential ? `, ${input.credential}` : ""}${blocking ? ` · accepted ${blocking} flagged item${blocking === 1 ? "" : "s"}` : ""}`,
    });
    return reviewContract(row);
  });
}

/* ───────────────────────── schedule gate ───────────────────────── */

export const REVIEWS_NOT_SET_UP = `${REVIEW_BLOCKER_PREFIX} reviews are not set up on this deployment yet.`;

/**
 * prepare_schedule's review gate: a blocker message per regulated item (health or finance, by its current script and
 * the products it names) that lacks an approved review of its current revision. General items are not gated. Never
 * throws: when reviews cannot be read, regulated items are blocked with a message saying so.
 */
export async function reviewBlockers(deps: EngineDeps, ctx: Ctx, items: Row[]): Promise<Map<string, string>> {
  const blockers = new Map<string, string>();
  let products: Product[] = [];
  let available = true;
  try {
    products = await workspaceProducts(deps, ctx, { photos: false });
  } catch {
    available = false;
  }
  for (const item of items) {
    const domain = detectDomain(String(item.script ?? ""), products);
    if (!isRegulated(domain)) continue;
    if (!available) {
      blockers.set(item.id, REVIEWS_NOT_SET_UP);
      continue;
    }
    let latest: Row | null;
    try {
      latest = await latestRow(deps, ctx, item.id);
    } catch {
      blockers.set(item.id, REVIEWS_NOT_SET_UP);
      continue;
    }
    if (latest && latest.item_revision === item.revision && latest.status === "approved") continue;
    blockers.set(
      item.id,
      latest && latest.item_revision !== item.revision
        ? `${REVIEW_BLOCKER_PREFIX} the script changed after its last review. Run a new review and have it approved. Open Details → Review.`
        : `${REVIEW_BLOCKER_PREFIX} this ${domain} script needs an approved review. Open Details → Review.`,
    );
  }
  return blockers;
}
