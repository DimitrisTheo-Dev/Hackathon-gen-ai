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
  };
}
