import { z } from "zod";
import {
  addSourceInputSchema,
  brandSchema,
  removeSourceInputSchema,
  startCampaignInputSchema,
  updateBrandInputSchema,
  SOURCE_LIMITS,
  campaignSchema,
  contextSchema,
  contentSchema,
  manifestSchema,
  reviseInputSchema,
  type Brand,
  compositionDocumentSchema,
  compositionSchema,
  draftComposition,
  saveCompositionInputSchema,
  draftFileSchema,
  referencedFileIds,
  requestUploadInputSchema,
  saveTextFileInputSchema,
  uploadTicketSchema,
  type DraftFile,
  type ResolvedMedia,
  type Campaign,
  type ContentItem,
  type Platform,
  type StudioContext,
  type ScheduleManifest,
  PRODUCT_LIMITS,
  REVIEW_BLOCKER_PREFIX,
  approveReviewInputSchema,
  basicClaims,
  blockingCount,
  contentReviewSchema,
  createProductInputSchema,
  deliveryFindings,
  detectDomain,
  isRegulated,
  placeProductInputSchema,
  placeProductResultSchema,
  productImageUploadInputSchema,
  productPlacementTime,
  productSchema,
  regulatedDomainSchema,
  reviewContentInputSchema,
  reviewStatus,
  updateProductInputSchema,
  visualFindings,
  type ContentReview,
  type Product,
  type VideoClip,
  beatsFromText,
  completeTakeInputSchema,
  draftScriptInputSchema,
  draftScriptResultSchema,
  startTakeInputSchema,
  TAKE_MAX_PARTS,
  TAKE_PART_BYTES,
  takePartInputSchema,
  takeUploadSchema,
  workingTitle,
} from "@castroom/contracts";
import {
  ApiError,
  prepareInputSchema,
  validate,
  type StudioClient,
} from "./client";
import { dropFixtureParts, FIXTURE_UPLOAD_PREFIX, fixtureBlobs, joinFixtureParts } from "./fixture-uploads";
import { samplePersonas } from "./sample-personas";
import { nextClipId, windowAt } from "../video/model";

/** Explicit development-only transport. Never import it from the live transport. */
export const FIXTURE_STORAGE_KEY = "castroom-development-v1";
const platforms: Platform[] = ["instagram", "tiktok", "youtube"];
const initialAt = "2026-11-14T13:00:00.000Z";
const workspaceId = "fixture-quintessential";
const campaignId = "fixture-bewell-week";
const angles = [
  {
    title: "Find your next moment",
    script:
      "A festival day is full of choices. The BeWell app helped visitors explore activities, choose interests and save sessions for their day.",
    caption: "A day, planned your way.",
    day: "16",
  },
  {
    title: "One idea. Two platforms.",
    script:
      "Quintessential built the BeWell app with React Native. One shared codebase brought the festival experience to both iOS and Android.",
    caption: "The same experience, both platforms.",
    day: "18",
  },
  {
    // The sample health draft: one claim an approved fact supports, one the review flags.
    title: "A familiar feeling",
    script:
      "BeWell Omega brings the calm of the festival home. Each capsule has 500 mg of omega-3. It cures joint pain, with no side effects. Talk to your doctor before you start.",
    caption: "The festival calm, at home.",
    day: "20",
  },
];

/** The sample product's photo: a 480 × 480 illustration, inline so the local preview never needs the network. */
const OMEGA_PHOTO_KEY = "fixture-seed:bewell-omega";
const OMEGA_PHOTO =
  "data:image/jpeg;base64,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";
const SEED_PHOTOS: Record<string, { url: string; mime: string }> = { [OMEGA_PHOTO_KEY]: { url: OMEGA_PHOTO, mime: "image/jpeg" } };
function seedProducts() {
  return [
    {
      id: "fixture-product-omega",
      name: "BeWell Omega",
      description: "Fish-oil capsules. A sample product for this local preview.",
      domain: "health" as const,
      facts: [
        "Each capsule has 500 mg of omega-3 from fish oil.",
        "Made with fish oil from sustainable fisheries.",
        "Take one capsule a day with food.",
      ],
      imageKey: OMEGA_PHOTO_KEY,
      position: 0,
      createdAt: initialAt,
      updatedAt: initialAt,
    },
  ];
}

function initialCampaign(): Campaign {
  return campaignSchema.parse({
    id: campaignId,
    workspaceId,
    title: "A week of BeWell",
    brief:
      "Three independent demo angles: visitor planning, cross-platform engineering, and a sample health product. No endorsement implied.",
    revision: 1,
    createdAt: initialAt,
    updatedAt: initialAt,
    timezone: "Europe/Athens",
    mode: "fixture",
    humanInterventions: 0,
    sources: [
      {
        id: "source-bewell",
        title: "BeWell Festival · Quintessential case study",
        url: "https://www.quintessential.gr/work/bewell-festival",
        excerpt:
          "Published app case study: visitor planning, cross-platform development, brand continuity.",
        permittedAssetIds: [],
        retrievedAt: initialAt,
      },
    ],
    jobs: [],
    activity: [],
    items: angles.map((angle, index) => ({
      id: `fixture-video-${index + 1}`,
      workspaceId,
      campaignId,
      title: angle.title,
      kind: "avatar_video",
      script: angle.script,
      avatarId: null,
      language: "en",
      revision: 1,
      renderRevision: null,
      status: "draft",
      media: null,
      style: {
        captions: true,
        brandColor: ["#8A7D6D", "#6E6C66", "#5F6C66"][index],
        captionPosition: "bottom",
      },
      sourceIds: ["source-bewell"],
      updatedAt: initialAt,
      variants: platforms.map((platform) => ({
        platform,
        title: platform === "youtube" ? angle.title : "",
        caption: `${angle.caption}${platform === "instagram" ? " #BeWell" : platform === "tiktok" ? " #Festival" : ""}`,
        accountId: null,
        visibility: "public",
        aiDisclosure: true,
      })),
      targets: platforms.map((platform) => ({
        platform,
        accountId: null,
        scheduledAt: `2026-11-${angle.day}T07:00:00.000Z`,
        timezone: "Europe/Athens",
        state: "draft",
        publishedAt: null,
        providerId: null,
        publishedUrl: null,
        error: null,
      })),
    })),
  });
}

const context: StudioContext = contextSchema.parse({
  workspace: {
    id: workspaceId,
    name: "Quintessential",
    timezone: "Europe/Athens",
    role: "owner",
    type: "agency",
  },
  principal: {
    id: "fixture-local-operator",
    kind: "human",
    scopes: ["campaign:read", "content:edit"],
  },
  brand: {
    name: "BeWell",
    description:
      "Independent demo using Quintessential’s published BeWell case study. Not an endorsement or partnership.",
    rules: [
      "Use factual statements supported by the source.",
      "Avoid medical or wellbeing guarantees.",
      "Do not imply a client endorsement or partnership.",
      "Keep the tone clear, inviting and calm.",
    ],
    color: "#5F6C66",
    tone: "Clear, inviting, calm",
    audience: "Festival visitors",
  },
  avatars: [],
  channels: platforms.map((platform) => ({
    id: `unavailable-${platform}`,
    platform,
    displayName: `${platform[0].toUpperCase()}${platform.slice(1)} account not connected`,
    state: "unavailable",
  })),
  connections: [],
  capabilities: {
    mode: "fixture",
    canCreateCampaign: true,
    canRender: false,
    canConnectChannels: false,
    canRetry: false,
    canCancel: false,
    canCreateAgentToken: false,
    canCreateGrant: false,
    formats: platforms.flatMap((platform) =>
      ["avatar_video", "image", "text"].map((kind) => ({
        kind,
        platform,
        supported: false,
        reason:
          "Production providers are not available in this development fixture.",
      })),
    ),
    visibility: [],
    renderUnitsRemaining: 0,
    postsRemaining: 0,
    mcpUrl: null,
    openapiUrl: null,
  },
});

const storedProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  domain: regulatedDomainSchema,
  facts: z.array(z.string()),
  imageKey: z.string().nullable(),
  position: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type StoredProduct = z.infer<typeof storedProductSchema>;

const stateSchema = z.object({
  version: z.literal(1),
  /** The brand kit as edited on this device. Absent until the first edit; older saved states have none. */
  brand: brandSchema.optional(),
  campaigns: z.array(campaignSchema),
  operations: z.record(
    z.string(),
    z.object({ hash: z.string(), result: z.unknown() }),
  ),
  // Added after v1 shipped; older saved fixture state simply has none yet.
  // A composition in an older shape is ignored on read, so it cannot lock the whole fixture.
  compositions: z
    .record(
      z.string(),
      z.object({ revision: z.number().int().positive(), updatedAt: z.string(), composition: z.unknown() }),
    )
    .default({}),
  files: z.array(draftFileSchema).default([]),
  fileTexts: z.record(z.string(), z.string()).default({}),
  /** Binary draft files kept as data URLs (product photos copied into a project), so they survive a reload. */
  fileUrls: z.record(z.string(), z.string()).default({}),
  /** Brand kit products. Older saved states get the sample product, like a fresh one. */
  products: z.array(storedProductSchema).default(seedProducts),
  /** Product photos uploaded on this device, as data URLs, by the key the product stores. */
  productImages: z.record(z.string(), z.object({ url: z.string(), mime: z.string() })).default({}),
  /** The latest review of each item. Parsed on read, so an older shape is dropped instead of locking the fixture. */
  reviews: z.record(z.string(), z.unknown()).default({}),
});

type State = z.infer<typeof stateSchema>;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
async function requestHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function createFixtureClient(storage?: Storage): StudioClient {
  let selectedStorage: Storage | undefined;
  try {
    selectedStorage =
      storage ??
      (typeof window !== "undefined" ? window.localStorage : undefined);
  } catch {
    throw new ApiError(
      "provider_unavailable",
      "Browser storage is unavailable. Enable it to save development drafts.",
    );
  }
  let memory: State = {
    version: 1,
    campaigns: [initialCampaign()],
    operations: {},
    compositions: {},
    files: [],
    fileTexts: {},
    fileUrls: {},
    products: seedProducts(),
    productImages: {},
    reviews: {},
  };
  function read(): State {
    if (!selectedStorage) return structuredClone(memory);
    let raw: string | null;
    try {
      raw = selectedStorage.getItem(FIXTURE_STORAGE_KEY);
    } catch {
      throw new ApiError(
        "provider_unavailable",
        "Browser storage is unavailable. Enable it to save development drafts.",
      );
    }
    if (!raw) return structuredClone(memory);
    try {
      return stateSchema.parse(JSON.parse(raw));
    } catch {
      throw new ApiError(
        "validation_error",
        "Saved development drafts could not be read. Export or clear the Faceful development storage before restarting.",
      );
    }
  }
  function write(state: State) {
    try {
      selectedStorage?.setItem(FIXTURE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      throw new ApiError(
        "provider_unavailable",
        "The development draft could not be saved. Browser storage may be full.",
      );
    }
    memory = structuredClone(state);
  }
  // Persist seed once; reopening a fixture retains local edits without inventing background progress.
  try {
    if (
      selectedStorage &&
      selectedStorage.getItem(FIXTURE_STORAGE_KEY) === null
    )
      write(memory);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      "provider_unavailable",
      "Browser storage is unavailable. Enable it to save development drafts.",
    );
  }

  function campaignFrom(state: State, id: string): Campaign {
    const campaign = state.campaigns.find((entry) => entry.id === id);
    if (!campaign)
      throw new ApiError(
        "not_found",
        "This development campaign was not found.",
      );
    return campaign;
  }
  async function mutate<T>(
    name: string,
    input: { operationKey: string },
    resultSchema: z.ZodType<T>,
    apply: (state: State) => T,
  ): Promise<T> {
    const hash = await requestHash({ name, input });
    // Read after hashing: no await between revision check and persistence.
    const state = read();
    const previous = state.operations[input.operationKey];
    if (previous) {
      if (previous.hash !== hash)
        throw new ApiError(
          "idempotency_conflict",
          "This operation key was already used with different content. Use a new key for a new edit.",
        );
      return resultSchema.parse(previous.result);
    }
    const result = resultSchema.parse(apply(state));
    state.operations[input.operationKey] = { hash, result };
    write(state);
    return structuredClone(result);
  }
  /** A project-level change: the revision moves on, and the activity says it stayed on this device. */
  function touch(campaign: Campaign, now: string, action: string, objectId: string) {
    campaign.revision += 1;
    campaign.updatedAt = now;
    campaign.humanInterventions += 1;
    campaign.activity.push({
      id: crypto.randomUUID(),
      actor: "You · development fixture",
      action,
      objectId,
      revision: campaign.revision,
      at: now,
      outcome: "Saved in this browser only",
    });
  }
  function itemFrom(state: State, id: string): ContentItem {
    const item = state.campaigns.flatMap((entry) => entry.items).find((entry) => entry.id === id);
    if (!item)
      throw new ApiError(
        "not_found",
        "This development content item was not found.",
      );
    return item;
  }
  const hour = () => new Date(Date.now() + 3600_000).toISOString();
  function fileUrl(state: State, file: DraftFile) {
    if (file.state !== "ready") return null;
    const text = state.fileTexts[file.id];
    if (text !== undefined) return `data:${file.mime};charset=utf-8,${encodeURIComponent(text)}`;
    return state.fileUrls[file.id] ?? fixtureBlobs.get(file.id) ?? null;
  }
  /* ── products and reviews ── */
  const photoOf = (state: State, key: string | null) => (key ? (SEED_PHOTOS[key] ?? state.productImages[key] ?? null) : null);
  function productOut(state: State, stored: StoredProduct): Product {
    const { imageKey, ...rest } = stored;
    const photo = photoOf(state, imageKey);
    return productSchema.parse({ ...rest, hasImage: Boolean(photo), imageUrl: photo?.url ?? null });
  }
  const productsOf = (state: State) => [...state.products].sort((a, b) => a.position - b.position).map((stored) => productOut(state, stored));
  function storedProduct(state: State, id: string) {
    const product = state.products.find((entry) => entry.id === id);
    if (!product) throw new ApiError("not_found", "This product is no longer in the brand kit.");
    return product;
  }
  function checkProduct(state: State, fields: { name?: string; imageKey?: string | null }, except = "") {
    if (fields.name !== undefined && state.products.some((entry) => entry.id !== except && entry.name.toLocaleLowerCase() === fields.name!.toLocaleLowerCase()))
      throw new ApiError("validation_error", "A product with this name is already in the brand kit.");
    if (fields.imageKey && !photoOf(state, fields.imageKey))
      throw new ApiError("validation_error", "The photo didn’t finish uploading. Add it again.");
  }
  function latestReview(state: State, itemId: string): ContentReview | null {
    const parsed = contentReviewSchema.safeParse(state.reviews[itemId]);
    return parsed.success ? parsed.data : null;
  }
  /** Project files that hold each product's photo, from earlier placements. */
  function productFileIds(state: State, campaignId: string) {
    const out: Record<string, string[]> = {};
    for (const file of state.files)
      if (file.campaignId === campaignId && file.state === "ready" && typeof file.meta.productId === "string")
        (out[file.meta.productId] ??= []).push(file.id);
    return out;
  }
  /**
   * What the review gate holds back, once a draft has been checked: a review with items to fix, a regulated script
   * without a named approval, and a regulated script that changed after its review. A draft that was never checked is
   * not held here, so the fresh sample schedules exactly as it always has; the engine also gates unchecked regulated drafts.
   */
  function claimsBlockers(state: State, item: ContentItem) {
    const review = latestReview(state, item.id);
    if (!review) return [];
    const domain = detectDomain(item.script, productsOf(state));
    const blocking = blockingCount(review);
    const message =
      review.itemRevision !== item.revision
        ? isRegulated(domain)
          ? `The ${domain} script changed after its review. Check it again and get a named approval.`
          : null
        : review.status === "approved" || review.status === "passed"
          ? null
          : blocking > 0
            ? `${blocking} ${blocking === 1 ? "item" : "items"} to fix${isRegulated(review.domain) ? ", or an approver’s written reason" : ""}.`
            : `A ${review.domain} script needs a named approval.`;
    return message ? [{ itemId: item.id, message: `${REVIEW_BLOCKER_PREFIX} ${message}` }] : [];
  }
  /** Fits a photo inside 640 px as a JPEG data URL, so a saved product stays well inside browser storage. */
  async function storablePhoto(photo: Blob): Promise<string> {
    try {
      const bitmap = await createImageBitmap(photo);
      const scale = Math.min(1, 640 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const draw = canvas.getContext("2d");
      if (!draw) throw new Error("no canvas");
      draw.fillStyle = "#FFFFFF";
      draw.fillRect(0, 0, canvas.width, canvas.height);
      draw.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      return canvas.toDataURL("image/jpeg", 0.85);
    } catch {
      throw new ApiError("validation_error", "This photo couldn’t be read. Try a JPEG, PNG or WebP.");
    }
  }
  function withUrl(state: State, file: DraftFile): DraftFile {
    const url = fileUrl(state, file);
    return { ...file, url, urlExpiresAt: url ? hour() : null };
  }
  function compositionDocument(state: State, id: string) {
    const item = itemFrom(state, id);
    const saved = state.compositions[id];
    const stored = saved ? compositionSchema.safeParse(saved.composition) : null;
    const composition = stored?.success
      ? stored.data
      : draftComposition({
          title: item.title,
          script: item.script,
          brandColor: item.style.brandColor,
          captionPosition: item.style.captionPosition,
          mediaDurationSeconds: item.media?.durationSeconds ?? null,
        });
    const files: Record<string, ResolvedMedia> = {};
    for (const fileId of referencedFileIds(composition)) {
      const file = state.files.find((entry) => entry.id === fileId && entry.state === "ready");
      const url = file && fileUrl(state, file);
      if (file && url) files[fileId] = { url, mime: file.mime, expiresAt: hour(), durationSeconds: file.durationSeconds, name: file.name };
    }
    return compositionDocumentSchema.parse({
      itemId: item.id,
      campaignId: item.campaignId,
      itemRevision: item.revision,
      revision: saved?.revision ?? 0,
      updatedAt: saved?.updatedAt ?? null,
      composition,
      itemMedia: item.media
        ? { url: item.media.url, mime: "video/mp4", expiresAt: item.media.expiresAt, durationSeconds: item.media.durationSeconds, name: item.title }
        : null,
      files,
    });
  }
  function newFile(state: State, input: { campaignId: string; itemId: string | null; kind: DraftFile["kind"]; name: string; mime: string; bytes: number; sha256: string; durationSeconds: number | null; meta: DraftFile["meta"] }, ready: boolean): DraftFile {
    campaignFrom(state, input.campaignId);
    if (input.itemId && itemFrom(state, input.itemId).campaignId !== input.campaignId)
      throw new ApiError("validation_error", "That item belongs to a different project.");
    const version = 1 + Math.max(0, ...state.files.filter((file) => file.campaignId === input.campaignId && file.itemId === input.itemId && file.name === input.name).map((file) => file.version));
    const file: DraftFile = { id: crypto.randomUUID(), ...input, state: ready ? "ready" : "pending", version, createdBy: "You · development fixture", createdAt: new Date().toISOString(), url: null, urlExpiresAt: null };
    state.files.unshift(file);
    return file;
  }
  async function digest(text: string) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  async function unavailable(): Promise<never> {
    throw new ApiError(
      "unsupported",
      "This is a development fixture. Connect the live backend to render, authorize or publish content.",
    );
  }
  return {
    startCampaign: async (raw) => {
      const input = validate(startCampaignInputSchema, raw);
      return mutate("start_campaign", input, campaignSchema, (state) => {
        const id = `fixture-campaign-${crypto.randomUUID()}`;
        const now = new Date().toISOString();
        const sourceId = `source-${id}`;
        const source = input.companyContext.sourceText
          ? [
              {
                id: sourceId,
                title: `${input.companyContext.name} · supplied source`,
                url: input.companyContext.sourceUrl,
                excerpt: input.companyContext.sourceText,
                permittedAssetIds: [],
                retrievedAt: now,
              },
            ]
          : [];
        const campaign = campaignSchema.parse({
          id,
          workspaceId,
          title: input.title,
          brief: input.companyContext.description,
          companyContext: input.companyContext,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          timezone: context.workspace.timezone,
          mode: "fixture",
          humanInterventions: 1,
          sources: source,
          jobs: [],
          activity: [
            {
              id: crypto.randomUUID(),
              actor: "You · development fixture",
              action: "Created drafts from supplied brief",
              objectId: id,
              revision: 1,
              at: now,
              outcome: "Saved in this browser only",
            },
          ],
          items: input.items.map((item) => ({
            id: crypto.randomUUID(),
            workspaceId,
            campaignId: id,
            title: item.title,
            kind: "avatar_video",
            script: item.script,
            avatarId: null,
            language: "en",
            revision: 1,
            renderRevision: null,
            status: "draft",
            media: null,
            variants: platforms.map((platform) => ({
              platform,
              title: item.title,
              caption: "",
              accountId: null,
              visibility: "public",
              aiDisclosure: true,
            })),
            targets: [],
            style: {
              captions: true,
              brandColor: (state.brand ?? context.brand).color,
              captionPosition: "bottom",
            },
            sourceIds: source.map((s) => s.id),
            updatedAt: now,
          })),
        });
        state.campaigns.unshift(campaign);
        return campaign;
      });
    },
    getContext: async () => {
      const state = read();
      return { ...structuredClone(context), brand: structuredClone(state.brand ?? context.brand), products: productsOf(state) };
    },
    listCampaigns: async () => structuredClone(read().campaigns),
    getCampaign: async (id) => structuredClone(campaignFrom(read(), id)),
    reviseContent: async (raw) => {
      const input = validate(reviseInputSchema, raw);
      return mutate("revise_content", input, contentSchema, (state) => {
        const campaign = state.campaigns.find((entry) =>
          entry.items.some((item) => item.id === input.contentId),
        );
        if (!campaign)
          throw new ApiError(
            "not_found",
            "This development content item was not found.",
          );
        const index = campaign.items.findIndex(
          (item) => item.id === input.contentId,
        );
        const current = campaign.items[index];
        if (current.revision !== input.expectedRevision)
          throw new ApiError(
            "revision_conflict",
            "This item changed after you opened it. Reload its latest version before saving.",
          );
        if (
          input.patch.avatarId &&
          !context.avatars.some(
            (avatar) =>
              avatar.id === input.patch.avatarId &&
              avatar.permission === "authorized",
          )
        )
          throw new ApiError(
            "forbidden",
            "Choose an authorized avatar. No authorized avatars are connected in this fixture.",
          );
        const { targets, ...patch } = input.patch;
        const affectsRender = ["script", "avatarId", "language", "style"].some(
          (field) =>
            field in patch &&
            canonical(patch[field as keyof typeof patch]) !==
              canonical(current[field as keyof ContentItem]),
        );
        const now = new Date().toISOString();
        const item: ContentItem = {
          ...current,
          ...patch,
          revision: current.revision + 1,
          updatedAt: now,
          renderRevision: affectsRender ? null : current.renderRevision,
          status: affectsRender ? "draft" : current.status,
          // Retain an old asset for explicit stale-preview display; renderRevision null forbids reuse.
          targets: targets
            ? targets.map((target) => ({
                ...target,
                state: "draft",
                publishedAt: null,
                providerId: null,
                publishedUrl: null,
                error: null,
              }))
            : current.targets.map((target) => ({ ...target, state: "draft" })),
        };
        campaign.items[index] = contentSchema.parse(item);
        campaign.revision += 1;
        campaign.updatedAt = now;
        campaign.humanInterventions += 1;
        campaign.activity.push({
          id: crypto.randomUUID(),
          actor: "You · development fixture",
          action: affectsRender
            ? "Saved a new draft; video needs regeneration"
            : "Saved content changes; schedule needs review",
          objectId: item.id,
          revision: item.revision,
          at: now,
          outcome: "Saved in this browser only",
        });
        return item;
      });
    },
    prepareSchedule: async (raw) => {
      const input = validate(prepareInputSchema, raw);
      return mutate("prepare_schedule", input, manifestSchema, (state) => {
        const campaign = campaignFrom(state, input.campaignId);
        if (campaign.revision !== input.expectedRevision)
          throw new ApiError(
            "revision_conflict",
            "The campaign changed. Refresh it before preparing the schedule.",
          );
        const now = new Date();
        const manifest: ScheduleManifest = {
          id: `fixture-review-${crypto.randomUUID()}`,
          campaignId: campaign.id,
          campaignRevision: campaign.revision,
          hash: `fixture-only-revision-${campaign.revision}`,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 15 * 60 * 1000).toISOString(),
          reviewUrl: "/dev/studio/?view=review",
          approval: "required",
          entries: [],
          blockers: campaign.items.flatMap((item) => [
            // The review gate, worded the way the engine words it so the checklist files it under "Claims".
            ...claimsBlockers(state, item),
            {
              itemId: item.id,
              message:
                "Connect an authorized Humanlike presenter and generate the final video.",
            },
            {
              itemId: item.id,
              message:
                "Connect publishing accounts in the live backend. Development fixtures cannot be approved or published.",
            },
          ]),
        };
        return manifest;
      });
    },
    renderContent: unavailable,
    approveSchedule: unavailable,
    commitSchedule: unavailable,
    cancelJobs: unavailable,
    createConnection: unavailable,
    revokeConnection: unavailable,
    createGrant: unavailable,
    // The fixture never drafts, bills or switches workspaces. Exact local edits stay in the Director panel.
    directorTurn: unavailable,
    listTemplates: async () => [],
    // The library's media lives in private storage behind the signed-in studio.
    listLibraryTemplates: async () => [],
    // Cloning needs the engine (it asks the platforms about the link and stores the job); the tab is hidden here.
    lookupCloneSource: unavailable,
    listCloneJobs: async () => [],
    createCloneJob: unavailable,
    createFromTemplate: unavailable,
    createSampleProject: unavailable,
    listVersions: unavailable,
    restoreVersion: unavailable,
    getBilling: unavailable,
    createCheckout: unavailable,
    createPortal: unavailable,
    selectWorkspace: unavailable,
    // The local preview never connects an account or stores a credential.
    getChannels: unavailable,
    connectChannel: unavailable,
    disconnectChannel: unavailable,
    // Personas are made from a face scan kept in private storage, which the local preview does not have.
    // `?faces=sample` lists fictional presenters instead, to see the New project Look step with faces.
    listPersonas: async () => samplePersonas(),
    createPersona: unavailable,
    updatePersona: unavailable,
    deletePersona: unavailable,
    withdrawPersonaConsent: unavailable,
    uploadPersonaPhoto: unavailable,
    createPersonaLook: unavailable,
    updatePersonaLook: unavailable,
    deletePersonaLook: unavailable,
    updateBrand: async (raw) => {
      const input = validate(updateBrandInputSchema, raw);
      return mutate("update_brand", input, brandSchema, (state) => {
        const { operationKey: _key, ...patch } = input;
        const brand: Brand = { ...(state.brand ?? context.brand) };
        if (patch.name !== undefined) brand.name = patch.name;
        if (patch.description !== undefined) brand.description = patch.description;
        if (patch.tone !== undefined) brand.tone = patch.tone;
        if (patch.audience !== undefined) brand.audience = patch.audience;
        if (patch.color !== undefined) brand.color = patch.color.toUpperCase();
        if (patch.rules !== undefined) brand.rules = patch.rules;
        state.brand = brand;
        return brand;
      });
    },
    addSource: async (raw) => {
      const input = validate(addSourceInputSchema, raw);
      return mutate("add_source", input, campaignSchema, (state) => {
        const campaign = campaignFrom(state, input.campaignId);
        if (campaign.sources.length >= SOURCE_LIMITS.perProject)
          throw new ApiError(
            "quota_exceeded",
            `A project holds up to ${SOURCE_LIMITS.perProject} sources. Remove one before adding another.`,
          );
        const now = new Date().toISOString();
        // A link is a reference only: the fixture, like the engine, never fetches it.
        const source = {
          id: `source-${crypto.randomUUID()}`,
          title: input.title,
          url: input.url ?? null,
          excerpt: input.excerpt,
          permittedAssetIds: [],
          retrievedAt: now,
        };
        campaign.sources.push(source);
        touch(campaign, now, "Added a source", source.id);
        return campaign;
      });
    },
    removeSource: async (raw) => {
      const input = validate(removeSourceInputSchema, raw);
      return mutate("remove_source", input, campaignSchema, (state) => {
        const campaign = campaignFrom(state, input.campaignId);
        if (!campaign.sources.some((source) => source.id === input.sourceId))
          throw new ApiError("not_found", "This source was not found in the project.");
        campaign.sources = campaign.sources.filter((source) => source.id !== input.sourceId);
        for (const item of campaign.items)
          item.sourceIds = item.sourceIds.filter((id) => id !== input.sourceId);
        touch(campaign, new Date().toISOString(), "Removed a source", input.sourceId);
        return campaign;
      });
    },
    getComposition: async (id) => compositionDocument(read(), id),
    saveComposition: async (raw) => {
      const input = validate(saveCompositionInputSchema, raw);
      return mutate("save_composition", input, compositionDocumentSchema, (state) => {
        const item = itemFrom(state, input.contentId);
        const missing = referencedFileIds(input.composition).filter((fileId) => !state.files.some((file) => file.id === fileId && file.state === "ready" && file.campaignId === item.campaignId));
        if (missing.length) throw new ApiError("validation_error", "The timeline uses a file that is not ready in this project.");
        if ((state.compositions[item.id]?.revision ?? 0) !== input.expectedRevision)
          throw new ApiError(
            "revision_conflict",
            "This video edit changed after you opened it. Reload the latest version before saving.",
          );
        const now = new Date().toISOString();
        state.compositions[item.id] = { revision: input.expectedRevision + 1, updatedAt: now, composition: input.composition };
        const campaign = campaignFrom(state, item.campaignId);
        campaign.activity.push({
          id: crypto.randomUUID(),
          actor: "You · development fixture",
          action: "Saved the video edit",
          objectId: item.id,
          revision: input.expectedRevision + 1,
          at: now,
          outcome: "Saved in this browser only",
        });
        return compositionDocument(state, item.id);
      });
    },
    listFiles: async (campaignId) => {
      const state = read();
      campaignFrom(state, campaignId);
      return state.files.filter((file) => file.campaignId === campaignId && file.state !== "archived").map((file) => withUrl(state, file));
    },
    requestUpload: async (raw) => {
      const input = validate(requestUploadInputSchema, raw);
      return mutate("request_file_upload", input, uploadTicketSchema, (state) => {
        const file = newFile(state, input, false);
        return { file, upload: { url: `${FIXTURE_UPLOAD_PREFIX}${file.id}`, method: "PUT" as const, headers: {}, expiresAt: hour() } };
      });
    },
    completeUpload: async ({ fileId, operationKey }) =>
      mutate("complete_file_upload", { fileId, operationKey } as { fileId: string; operationKey: string }, draftFileSchema, (state) => {
        const file = state.files.find((entry) => entry.id === fileId);
        if (!file || file.state === "archived") throw new ApiError("not_found", "This development file was not found.");
        if (!fixtureBlobs.has(fileId)) throw new ApiError("validation_error", "The upload has not arrived yet.");
        file.state = "ready";
        return withUrl(state, file);
      }),
    saveTextFile: async (raw) => {
      const input = validate(saveTextFileInputSchema, raw);
      const sha256 = await digest(input.text);
      return mutate("save_text_file", input, draftFileSchema, (state) => {
        const { text, operationKey: _key, ...rest } = input;
        const file = newFile(state, { ...rest, bytes: new TextEncoder().encode(text).byteLength, sha256 }, true);
        state.fileTexts[file.id] = text;
        return withUrl(state, file);
      });
    },
    // No model runs in this browser-only workspace: the description is split into lines, exactly as a workspace
    // without AI writing does, and a rewrite keeps the script as it is.
    draftScript: async (raw) => {
      const input = validate(draftScriptInputSchema, raw);
      return draftScriptResultSchema.parse({
        mode: "basic",
        title: workingTitle(input.brief),
        beats: input.beats?.length ? input.beats : beatsFromText(input.brief),
        reply: input.beats?.length
          ? "Development workspace: no AI writing runs here, so nothing was rewritten. Edit any line directly."
          : "Development workspace: no AI writing runs here, so your description was split into lines to edit.",
      });
    },
    startTake: async (raw) => {
      const input = validate(startTakeInputSchema, raw);
      return mutate("start_take_upload", input, takeUploadSchema, (state) => {
        const file = newFile(state, { campaignId: input.campaignId, itemId: input.itemId, kind: input.kind, name: input.name, mime: input.mime, bytes: 0, sha256: "0".repeat(64), durationSeconds: null, meta: { source: "recorded in the studio" } }, false);
        return { fileId: file.id, partBytes: TAKE_PART_BYTES, maxParts: TAKE_MAX_PARTS };
      });
    },
    takePartUrl: async (raw) => {
      const input = validate(takePartInputSchema, raw);
      const file = read().files.find((entry) => entry.id === input.fileId);
      if (!file || file.state !== "pending") throw new ApiError("not_found", "This development recording was not found.");
      return { url: `${FIXTURE_UPLOAD_PREFIX}part:${input.fileId}:${input.partNumber}`, headers: {} };
    },
    completeTake: async (raw) => {
      const input = validate(completeTakeInputSchema, raw);
      return mutate("complete_take_upload", input, draftFileSchema, (state) => {
        const file = state.files.find((entry) => entry.id === input.fileId);
        if (!file || file.state === "archived") throw new ApiError("not_found", "This development recording was not found.");
        if (file.state === "ready") return withUrl(state, file);
        const bytes = joinFixtureParts(file.id, input.parts.map((part) => part.partNumber), file.mime);
        if (bytes === null || bytes !== input.bytes) throw new ApiError("validation_error", "The recording is missing a part. Record again.");
        Object.assign(file, { state: "ready", bytes, sha256: input.sha256, durationSeconds: input.durationSeconds });
        return withUrl(state, file);
      });
    },
    abortTake: async ({ fileId }) => {
      dropFixtureParts(fileId);
      const state = read();
      const file = state.files.find((entry) => entry.id === fileId);
      if (file?.state === "pending") {
        file.state = "archived";
        write(state);
      }
    },
    archiveFile: async ({ fileId, operationKey }) =>
      mutate("archive_file", { fileId, operationKey } as { fileId: string; operationKey: string }, draftFileSchema, (state) => {
        const file = state.files.find((entry) => entry.id === fileId);
        if (!file) throw new ApiError("not_found", "This development file was not found.");
        file.state = "archived";
        return withUrl(state, file);
      }),
    // Rendering needs the live engine and a render worker; the fixture says so instead of pretending.
    queueRender: async () => {
      throw new ApiError("unsupported", "The development studio cannot render. Use the live studio with a connected render worker.");
    },
    listRenders: async () => [],
    cancelRender: unavailable,

    /* ── products ── */
    createProduct: async (raw) => {
      const input = validate(createProductInputSchema, raw);
      return mutate("create_product", input, productSchema, (state) => {
        if (state.products.length >= PRODUCT_LIMITS.products)
          throw new ApiError("quota_exceeded", `A brand kit holds up to ${PRODUCT_LIMITS.products} products. Remove one to add another.`);
        checkProduct(state, input);
        const now = new Date().toISOString();
        const stored: StoredProduct = {
          id: `fixture-product-${crypto.randomUUID()}`,
          name: input.name,
          description: input.description,
          domain: input.domain,
          facts: input.facts,
          imageKey: input.imageKey,
          position: 1 + Math.max(-1, ...state.products.map((entry) => entry.position)),
          createdAt: now,
          updatedAt: now,
        };
        state.products.push(stored);
        return productOut(state, stored);
      });
    },
    // No operation key in the contract: an update or delete is safe to repeat as it stands.
    updateProduct: async (raw) => {
      const input = validate(updateProductInputSchema, raw);
      const state = read();
      const stored = storedProduct(state, input.productId);
      checkProduct(state, input, stored.id);
      const { productId: _id, ...patch } = input;
      Object.assign(stored, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)), { updatedAt: new Date().toISOString() });
      write(state);
      return productOut(state, stored);
    },
    deleteProduct: async (productId) => {
      const state = read();
      storedProduct(state, productId);
      state.products = state.products.filter((entry) => entry.id !== productId);
      write(state);
    },
    uploadProductImage: async (photo) => {
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await photo.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (!productImageUploadInputSchema.safeParse({ type: photo.type, size: photo.size, sha256 }).success)
        throw new ApiError("validation_error", "Use a JPEG, PNG or WebP photo under 15 MB.");
      // No storage service here: the photo is kept, made smaller, in this browser only.
      const url = await storablePhoto(photo);
      const key = `fixture-product-image:${sha256}`;
      const state = read();
      state.productImages[key] = { url, mime: "image/jpeg" };
      write(state);
      return key;
    },
    placeProduct: async (raw) => {
      const input = validate(placeProductInputSchema, raw);
      const preview = read();
      const photo = photoOf(preview, storedProduct(preview, input.productId).imageKey);
      const sha256 = photo ? await digest(photo.url) : "";
      return mutate("place_product", input, placeProductResultSchema, (state) => {
        const item = itemFrom(state, input.itemId);
        const product = storedProduct(state, input.productId);
        if (!photo) throw new ApiError("validation_error", "Add a photo to this product in the brand kit first.");
        const saved = state.compositions[item.id];
        const revision = saved?.revision ?? 0;
        if (revision !== input.expectedCompositionRevision)
          throw new ApiError("revision_conflict", "The timeline changed after you opened it. Reload it, then show the product again.");
        let composition = compositionDocument(state, item.id).composition;
        const ext = photo.mime === "image/png" ? ".png" : photo.mime === "image/webp" ? ".webp" : ".jpg";
        const file = newFile(
          state,
          { campaignId: item.campaignId, itemId: item.id, kind: "image", name: `${product.name.slice(0, 150)}${ext}`, mime: photo.mime, bytes: Math.round((photo.url.length - photo.url.indexOf(",") - 1) * 0.75), sha256, durationSeconds: null, meta: { productId: product.id, origin: "Brand kit" } },
          true,
        );
        state.fileUrls[file.id] = photo.url;
        const placed = productPlacementTime(item.script, composition, { id: product.id, name: product.name }, input.at);
        const mention = placed.matchedMention;
        const at = placed.time;
        const span = windowAt(composition, at, input.seconds);
        const clip: VideoClip = {
          id: nextClipId(composition, "product"),
          ...span,
          source: { kind: "file", fileId: file.id },
          media: "image",
          in: 0,
          layer: 1,
          layout: input.layout,
          volume: 0,
          syncOffsetFrames: 0,
          transitionIn: { kind: "fade", duration: 0.25 },
          transitionOut: { kind: "fade", duration: 0.2 },
        };
        composition = { ...composition, video: [...composition.video, clip].sort((a, b) => a.start - b.start || a.end - b.end) };
        if (input.endCard) {
          // A closing call to action already on the timeline gets the photo; otherwise one is added.
          const closing = composition.cards.find((card) => card.kind === "cta" && card.end >= composition.durationSeconds - 0.05);
          composition = closing
            ? { ...composition, cards: composition.cards.map((card) => (card === closing ? { ...card, imageFileId: file.id } : card)) }
            : {
                ...composition,
                cards: [...composition.cards, { id: nextClipId(composition, "card"), ...windowAt(composition, composition.durationSeconds, 2.5), kind: "cta" as const, title: product.name.slice(0, 80), subtitle: "", imageFileId: file.id }].sort((a, b) => a.start - b.start || a.end - b.end),
              };
        }
        const now = new Date().toISOString();
        state.compositions[item.id] = { revision: revision + 1, updatedAt: now, composition: compositionSchema.parse(composition) };
        campaignFrom(state, item.campaignId).activity.push({
          id: crypto.randomUUID(),
          actor: "You · development fixture",
          action: `Showed ${product.name} in the video`,
          objectId: item.id,
          revision: revision + 1,
          at: now,
          outcome: "Saved in this browser only",
        });
        return { itemId: item.id, compositionRevision: revision + 1, fileId: file.id, placedAt: span.start, matchedMention: Boolean(mention) };
      });
    },

    /* ── content review: the shared basic rules, run here exactly as the engine runs them in basic mode ── */
    getReview: async (itemId) => {
      const state = read();
      itemFrom(state, itemId);
      return latestReview(state, itemId);
    },
    reviewContent: async (raw) => {
      const input = validate(reviewContentInputSchema, raw);
      return mutate("review_content", input, contentReviewSchema, (state) => {
        const item = itemFrom(state, input.itemId);
        const products = productsOf(state);
        const brand = state.brand ?? context.brand;
        const domain = detectDomain(item.script, products);
        const document = compositionDocument(state, item.id);
        const composition = document.composition;
        const claims = basicClaims(item.script, { products, brandRules: brand.rules, domain });
        const avatarFileIds = state.files.filter((file) => file.campaignId === item.campaignId && file.kind === "avatar_clip").map((file) => file.id);
        const findings = [
          ...deliveryFindings(item.script, composition, { domain, avatarFileIds }),
          ...visualFindings(item.script, composition, { products, productFileIds: productFileIds(state, item.campaignId), platforms: item.variants.map((variant) => variant.platform) }),
        ];
        const timed = Boolean(composition.transcript?.words.length);
        const now = new Date().toISOString();
        const review: ContentReview = {
          id: `fixture-content-review-${crypto.randomUUID()}`,
          campaignId: item.campaignId,
          itemId: item.id,
          itemRevision: item.revision,
          compositionRevision: document.revision,
          domain,
          mode: "basic",
          status: reviewStatus(domain, claims, findings, false),
          claims,
          findings,
          checked: { claims: true, timeline: true, transcript: timed, renderedVideo: false },
          notes: [
            ...(timed ? [] : ["No word timings yet, so the voice was not compared with the script."]),
            "The rendered video was not watched: this local preview has no renderer.",
          ],
          approval: null,
          createdAt: now,
        };
        state.reviews[item.id] = review;
        campaignFrom(state, item.campaignId).activity.push({
          id: crypto.randomUUID(),
          actor: "You · development fixture",
          action: "Checked a draft against the approved facts",
          objectId: item.id,
          revision: item.revision,
          at: now,
          outcome: "Saved in this browser only",
        });
        return review;
      });
    },
    approveReview: async (raw) => {
      const input = validate(approveReviewInputSchema, raw);
      return mutate("approve_review", input, contentReviewSchema, (state) => {
        const itemId = Object.keys(state.reviews).find((id) => latestReview(state, id)?.id === input.reviewId);
        const review = itemId ? latestReview(state, itemId) : null;
        if (!itemId || !review) throw new ApiError("not_found", "This review is no longer the latest one. Check the draft again.");
        if (context.principal.kind !== "human") throw new ApiError("forbidden", "An agent can’t approve a review. A person has to.");
        if (!["owner", "admin", "reviewer"].includes(context.workspace.role))
          throw new ApiError("forbidden", "Only a workspace owner, admin or reviewer can approve a review.");
        if (itemFrom(state, itemId).revision !== review.itemRevision)
          throw new ApiError("revision_conflict", "The script changed after this review. Check it again, then approve.");
        if (review.approval) return review;
        if (isRegulated(review.domain) && !input.credential)
          throw new ApiError("validation_error", `A ${review.domain} script needs the approver’s credential, like “MD, cardiologist”.`);
        if (blockingCount(review) > 0 && input.note.length < 20)
          throw new ApiError("validation_error", "Say why the items left to fix are acceptable, in at least 20 characters.");
        const now = new Date().toISOString();
        const approved: ContentReview = { ...review, status: "approved", approval: { by: input.by, credential: input.credential, note: input.note, principalId: context.principal.id, at: now } };
        state.reviews[itemId] = approved;
        campaignFrom(state, review.campaignId).activity.push({
          id: crypto.randomUUID(),
          actor: "You · development fixture",
          action: `Approved the review as ${input.by}`,
          objectId: itemId,
          revision: review.itemRevision,
          at: now,
          outcome: "Saved in this browser only",
        });
        return approved;
      });
    },
  };
}
