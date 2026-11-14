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
} from "@castroom/contracts";
import {
  ApiError,
  prepareInputSchema,
  validate,
  type StudioClient,
} from "./client";
import { FIXTURE_UPLOAD_PREFIX, fixtureBlobs } from "./fixture-uploads";

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
    title: "A familiar feeling",
    script:
      "The BeWell app extended the festival’s visual identity into a digital companion, keeping the experience energetic and calming.",
    caption: "A brand that feels familiar.",
    day: "20",
  },
];

function initialCampaign(): Campaign {
  return campaignSchema.parse({
    id: campaignId,
    workspaceId,
    title: "A week of BeWell",
    brief:
      "Three independent demo angles: visitor planning, cross-platform engineering, and brand continuity. No endorsement implied.",
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
    return fixtureBlobs.get(file.id) ?? null;
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
    getContext: async () => ({ ...structuredClone(context), brand: structuredClone(read().brand ?? context.brand) }),
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
  };
}
