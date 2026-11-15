import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createProductInputSchema,
  placeProductInputSchema,
  placeProductResultSchema,
  PRODUCT_LIMITS,
  PRODUCT_MAX_IMAGE_BYTES,
  productImageTicketSchema,
  productImageUploadInputSchema,
  productRefInputSchema,
  productPlacementTime,
  updateProductInputSchema,
  type Composition,
  type PlaceProductResult,
  type Product,
  type VideoClip,
} from "../../contracts/src/index.js";
import { audit, idempotent, requireScope, sha256Hex, type Ctx, type EngineDeps } from "./access.js";
import { getComposition, saveComposition } from "./composition.js";
import { EngineError } from "./errors.js";
import { FILES_TABLE, fileKey } from "./files.js";
import { UnconfiguredFileStore, type FileStore } from "./r2.js";
import { selectOne, type Row } from "./store.js";
import { loadItem, parse, PRODUCTS_TABLE, productContract, workspaceProducts } from "./studio.js";

/**
 * Brand kit products (the studio's Brand tab): a photo, a short description and the facts the brand has approved.
 * The Director writes from them, place_product puts one on a video's timeline, and the content review checks
 * claims against them (review.ts). Table: supabase/migrations/20261115160000_products_reviews.sql.
 *
 *   • Same permission as the rest of the brand kit (update_brand): content:edit, for people and agents alike.
 *   • Photos go from the browser straight to private R2 through a one-file link, under orgs/<org>/products/.
 *     A submitted key must sit in this workspace's products folder and exist; replaced and removed photos are deleted.
 *   • Photo links are for people in the studio; agents see `hasImage` and a null `imageUrl`, like persona photos.
 *   • Placing a product copies its photo into the item's project as an `image` draft file (meta.productId names the
 *     product), so the timeline never depends on the brand kit, and deleting a product never breaks a video.
 */
const UPLOAD_TTL_SECONDS = 10 * 60;
const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const MIMES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Every product photo of one workspace. No key under it can be reached from another workspace. */
export const productFolder = (orgId: string) => `orgs/${orgId}/products/`;
const ownsImage = (folder: string, key: string) =>
  key.startsWith(folder) && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.(?:jpg|png|webp)$/.test(key.slice(folder.length));
const isUuid = (value: string) => z.uuid().safeParse(value).success;

function storage(deps: EngineDeps): FileStore {
  const files = deps.files ?? new UnconfiguredFileStore();
  if (!files.configured) throw new EngineError("provider_unavailable", "Private file storage isn’t connected on this deployment yet, so a product photo can’t be saved. Add the FACEFUL_R2_* settings.");
  return files;
}
async function findProduct(deps: EngineDeps, ctx: Ctx, productId: string): Promise<Row> {
  const row = isUuid(productId) ? await selectOne(deps.store, PRODUCTS_TABLE, { id: productId, org_id: ctx.org.id }) : null;
  if (!row) throw new EngineError("not_found", "This product was not found in your brand kit.");
  return row;
}

/** GET-side list for agents (MCP list_products) and anyone with read access. The studio reads `context.products`. */
export async function listProducts(deps: EngineDeps, ctx: Ctx): Promise<Product[]> {
  requireScope(ctx, "campaign:read");
  return workspaceProducts(deps, ctx);
}

/** Checks that a photo key came from this workspace's product upload link, finished uploading, and is not another product's. */
async function claimImage(deps: EngineDeps, ctx: Ctx, key: string, productId: string | null) {
  if (!ownsImage(productFolder(ctx.org.id), key)) throw new EngineError("validation_error", "That photo does not belong to this workspace’s products. Upload it again.");
  const files = storage(deps);
  const object = await files.head(key);
  if (!object) throw new EngineError("validation_error", "The photo did not finish uploading. Try again.");
  if (object.bytes > PRODUCT_MAX_IMAGE_BYTES) {
    await files.remove(key).catch(() => undefined);
    throw new EngineError("validation_error", "That photo is too large. Use one under 15 MB.");
  }
  const users = await deps.store.select(PRODUCTS_TABLE, { org_id: ctx.org.id, image_key: key }, { limit: 2 });
  if (users.some((row) => row.id !== productId)) throw new EngineError("validation_error", "That photo is already used by another product. Upload it again.");
}

/** product_image_upload_url: a link that accepts one product photo (these exact bytes) and nothing else. */
export async function productImageUploadUrl(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  requireScope(ctx, "content:edit");
  const input = parse(productImageUploadInputSchema, raw);
  const files = storage(deps);
  const key = `${productFolder(ctx.org.id)}${crypto.randomUUID()}.${EXTENSIONS[input.type]}`;
  const { url, headers } = await files.uploadUrl(key, { sha256Hex: input.sha256, contentType: input.type, expiresSeconds: UPLOAD_TTL_SECONDS });
  return parse(productImageTicketSchema, { key, uploadUrl: url, headers, expiresAt: new Date(deps.now().getTime() + UPLOAD_TTL_SECONDS * 1000).toISOString() });
}

/** create_product: adds a product at the end of the brand kit. */
export async function createProduct(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Product> {
  // Permission first, so a caller who cannot edit never writes an idempotency record.
  requireScope(ctx, "content:edit");
  const input = parse(createProductInputSchema, raw);
  return idempotent(deps, ctx, "create_product", input.operationKey, input, async () => {
    const existing = await deps.store.select(PRODUCTS_TABLE, { org_id: ctx.org.id }, { limit: PRODUCT_LIMITS.products + 1 });
    if (existing.length >= PRODUCT_LIMITS.products) throw new EngineError("validation_error", `A brand kit holds up to ${PRODUCT_LIMITS.products} products. Delete one to add another.`);
    if (input.imageKey) await claimImage(deps, ctx, input.imageKey, null);
    const now = deps.now().toISOString();
    const row = await deps.store.insert(PRODUCTS_TABLE, {
      id: crypto.randomUUID(),
      org_id: ctx.org.id,
      name: input.name,
      description: input.description,
      domain: input.domain,
      facts: input.facts,
      image_key: input.imageKey,
      position: existing.reduce((next, entry) => Math.max(next, Number(entry.position) + 1), 0),
      created_at: now,
      updated_at: now,
    });
    const facts = input.facts.length;
    await audit(deps, ctx, {
      action: "Added a product to the brand kit",
      objectId: row.id,
      outcome: `${input.domain} · ${facts} approved fact${facts === 1 ? "" : "s"} · ${input.imageKey ? "with a photo" : "without a photo"}`,
    });
    return productContract(deps, ctx, row);
  });
}

/** update_product: only the fields sent change. `imageKey: null` removes the photo; the old one is deleted. */
export async function updateProduct(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<Product> {
  requireScope(ctx, "content:edit");
  const input = parse(updateProductInputSchema, raw);
  const product = await findProduct(deps, ctx, input.productId);
  const current: string | null = product.image_key ?? null;
  const replacing = input.imageKey !== undefined && input.imageKey !== current;
  if (replacing && input.imageKey) await claimImage(deps, ctx, input.imageKey, product.id);
  const patch: Row = { updated_at: deps.now().toISOString() };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.domain !== undefined) patch.domain = input.domain;
  if (input.facts !== undefined) patch.facts = input.facts;
  if (replacing) patch.image_key = input.imageKey;
  // Compare-and-swap on the photo, so two edits at once cannot both think they replaced the same one.
  const [row] = await deps.store.update(PRODUCTS_TABLE, { id: product.id, org_id: ctx.org.id, image_key: current }, patch);
  if (!row) throw new EngineError("revision_conflict", "This product changed while you were editing it. Reload and try again.");
  // The old photo goes once nothing points at it. A failure leaves an unreferenced file, never a broken product.
  if (replacing && current)
    await storage(deps)
      .remove(current)
      .catch(() => console.error(JSON.stringify({ level: "error", event: "product_photo_delete_failed", correlationId: ctx.correlationId })));
  const changed = Object.keys(patch).filter((key) => key !== "updated_at").map((key) => (key === "image_key" ? "photo" : key));
  await audit(deps, ctx, { action: "Edited a product", objectId: product.id, outcome: `Changed ${changed.join(", ") || "nothing"}` });
  return productContract(deps, ctx, row);
}

/** delete_product: deletes the product and its brand-kit photo. Copies already placed on videos stay with those videos. */
export async function deleteProduct(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  requireScope(ctx, "content:edit");
  const input = parse(productRefInputSchema, raw);
  const product = await findProduct(deps, ctx, input.productId);
  // The photo first: a failure leaves the product in place, and deleting again finishes the job.
  if (product.image_key) await storage(deps).remove(product.image_key);
  await deps.store.remove(PRODUCTS_TABLE, { id: product.id, org_id: ctx.org.id });
  await audit(deps, ctx, { action: "Deleted a product from the brand kit", objectId: product.id, outcome: product.image_key ? "Its photo was deleted" : "It had no photo" });
  return { deleted: true as const };
}

/* ───────────────────────── place_product ───────────────────────── */

const round = (value: number) => Math.round(value * 100) / 100;
/** A stable UUID per step, derived from the caller's key, so a retried placement replays its timeline save. */
function stepKey(base: string, label: string): string {
  const hex = sha256Hex(`faceful-place-product-v1:${base}:${label}`);
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The product photo as an `image` draft file of the item's project. Bytes are read through a short-lived signed
 * link and stored content-addressed under the project (files.ts), so the same photo is kept once per project.
 */
async function productPhotoFile(deps: EngineDeps, ctx: Ctx, item: Row, product: Row): Promise<string> {
  const files = storage(deps);
  const key = String(product.image_key);
  const mime = MIMES[key.split(".").pop() ?? ""];
  if (!mime) throw new EngineError("validation_error", "This product’s photo is not a JPEG, PNG or WebP image. Upload it again in the brand kit.");
  let bytes: Uint8Array;
  try {
    const response = await deps.fetch(await files.downloadUrl(key, 60));
    if (!response.ok) throw new Error(`status ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof EngineError) throw error;
    throw new EngineError("provider_unavailable", "The product photo could not be read from storage. Nothing was changed; try again.");
  }
  if (!bytes.byteLength || bytes.byteLength > PRODUCT_MAX_IMAGE_BYTES) throw new EngineError("validation_error", "This product’s photo is missing or too large. Upload it again in the brand kit.");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  // The same photo placed before in this project is reused, not copied again.
  const copies = await deps.store.select(FILES_TABLE, { org_id: ctx.org.id, project_id: item.project_id, kind: "image", sha256, state: "ready" }, { limit: 50 });
  const copy = copies.find((row) => row.meta?.productId === product.id);
  if (copy) return copy.id;
  const storageKey = fileKey(ctx.org.id, item.project_id, sha256, mime);
  if (!(await files.head(storageKey))) await files.put(storageKey, bytes, mime);
  const name = `${product.name} · product photo`.slice(0, 160);
  const previous = await deps.store.select(FILES_TABLE, { org_id: ctx.org.id, project_id: item.project_id, item_id: item.id, name }, { order: ["version", "desc"], limit: 1 });
  const now = deps.now().toISOString();
  const row = await deps.store.insert(FILES_TABLE, {
    id: crypto.randomUUID(),
    org_id: ctx.org.id,
    project_id: item.project_id,
    item_id: item.id,
    kind: "image",
    name,
    mime,
    bytes: bytes.byteLength,
    sha256,
    duration_seconds: null,
    meta: { productId: product.id, source: "brand_kit" },
    state: "ready",
    version: (previous[0]?.version ?? 0) + 1,
    storage_key: storageKey,
    created_by: ctx.actorLabel,
    actor_id: ctx.actorId,
    created_at: now,
    updated_at: now,
  });
  await audit(deps, ctx, { projectId: item.project_id, action: `Added draft file ${name}`, objectId: row.id, revision: row.version, outcome: "image, copied from the brand kit" });
  return row.id;
}

/** Where the photo goes: at `at`, else where the script first names the product, else one third in; always inside the timeline. */
export function placement(script: string, composition: Composition, product: { id: string; name: string }, at: number | null, seconds: number) {
  const duration = composition.durationSeconds;
  const length = Math.min(seconds, duration);
  const { time, matchedMention } = productPlacementTime(script, composition, product, at);
  const start = round(Math.min(Math.max(0, time), duration - length));
  return { start, end: round(Math.min(duration, start + length)), matchedMention };
}

function freeId(taken: Set<string>, base: string) {
  for (let n = 1; ; n++) {
    const id = `${base}-${n}`.slice(0, 40);
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/**
 * place_product: copies the product photo into the item's project and saves a new timeline revision with the photo
 * on the overlay layer (and, with `endCard`, a closing call-to-action card). A timeline newer than
 * `expectedCompositionRevision` is a conflict and is never overwritten. Saved through save_composition's own path.
 */
export async function placeProduct(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<PlaceProductResult> {
  requireScope(ctx, "content:edit");
  requireScope(ctx, "campaign:read");
  const input = parse(placeProductInputSchema, raw);
  return idempotent(deps, ctx, "place_product", input.operationKey, input, async () => {
    const item = await loadItem(deps, ctx, input.itemId);
    if (item.kind !== "avatar_video") throw new EngineError("unsupported", "Only presenter videos have a timeline to place a product on.");
    const product = await findProduct(deps, ctx, input.productId);
    if (!product.image_key) throw new EngineError("validation_error", "Add a photo to this product in the brand kit before placing it on a video.");
    const document = await getComposition(deps, ctx, item.id);
    if (document.revision !== input.expectedCompositionRevision)
      throw new EngineError("revision_conflict", "This video edit changed after you opened it. Reload the latest version before placing the product.");
    const fileId = await productPhotoFile(deps, ctx, item, product);
    const composition = document.composition;
    const { start, end, matchedMention } = placement(item.script, composition, { id: product.id, name: product.name }, input.at, input.seconds);
    const taken = new Set([...composition.video, ...composition.audio, ...composition.cards, ...composition.captions].map((clip) => clip.id));
    const short = String(product.id).slice(0, 8);
    const clip: VideoClip = {
      id: freeId(taken, `product-${short}`),
      start,
      end,
      source: { kind: "file", fileId },
      media: "image",
      in: 0,
      layer: 1,
      layout: input.layout,
      volume: 0,
      syncOffsetFrames: 0,
      transitionIn: { kind: "fade", duration: 0.25 },
      transitionOut: { kind: "fade", duration: 0.25 },
    };
    const cards = [...composition.cards];
    const duration = composition.durationSeconds;
    if (input.endCard && !cards.some((card) => card.kind === "cta" && card.imageFileId === fileId))
      cards.push({ id: freeId(taken, `cta-${short}`), start: round(Math.max(0, duration - Math.min(3, duration))), end: duration, kind: "cta", title: String(product.name).slice(0, 80), subtitle: "", imageFileId: fileId });
    const next: Composition = { ...composition, video: [...composition.video, clip], cards };
    const saved = await saveComposition(deps, ctx, { contentId: item.id, expectedRevision: document.revision, composition: next, operationKey: stepKey(input.operationKey, "save") });
    await audit(deps, ctx, {
      projectId: item.project_id,
      action: "Placed a product on the video",
      objectId: item.id,
      revision: saved.revision,
      outcome: `“${product.name}” at ${start.toFixed(1)} s${matchedMention ? ", where the script names it" : ""}${input.endCard ? ", with a closing card" : ""}`,
    });
    return parse(placeProductResultSchema, { itemId: item.id, compositionRevision: saved.revision, fileId, placedAt: start, matchedMention });
  });
}
