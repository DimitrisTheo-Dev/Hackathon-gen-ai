import { z } from "zod";
import {
  connectionSchema,
  idSchema,
  instantSchema,
  type Campaign,
  type ContentItem,
  type GrantInput,
  type Operation,
  type StartCampaignInput,
  type ReviseInput,
  type ScheduleManifest,
  type StudioContext,
  type StudioError,
  type ContentVersion,
  type DirectorTurnInput,
  type DirectorTurnResult,
  type RestoreInput,
  type LibraryTemplate,
  type Template,
  type TemplateInput,
  type AddSourceInput,
  type Brand,
  type RemoveSourceInput,
  type UpdateBrandInput,
  type CreatePersonaInput,
  type CreatePersonaLookInput,
  type Persona,
  type UpdatePersonaInput,
  type UpdatePersonaLookInput,
  type CompositionDocument,
  type SaveCompositionInput,
  type DraftFile,
  type UploadTicket,
  type RequestUploadInput,
  type SaveTextFileInput,
  type ReelRender,
  type QueueRenderInput,
} from "@castroom/contracts";

export class ApiError extends Error {
  readonly code: StudioError["code"];
  readonly retryAfterSeconds: number | null;
  readonly reviewUrl: string | null;
  constructor(
    code: StudioError["code"],
    message: string,
    details: {
      retryAfterSeconds?: number | null;
      reviewUrl?: string | null;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.reviewUrl = details.reviewUrl ?? null;
  }
}

export const renderInputSchema = z
  .object({
    campaignId: idSchema,
    itemIds: z.array(idSchema).min(1).max(3),
    expectedRevisions: z.record(idSchema, z.number().int().positive()),
    operationKey: z.uuid(),
  })
  .strict();
export const prepareInputSchema = z
  .object({
    campaignId: idSchema,
    expectedRevision: z.number().int().positive(),
    operationKey: z.uuid(),
  })
  .strict();
export const manifestInputSchema = z
  .object({
    manifestId: idSchema,
    hash: z.string().min(1),
    operationKey: z.uuid(),
  })
  .strict();
export const cancelInputSchema = z
  .object({ jobIds: z.array(idSchema).min(1).max(100), operationKey: z.uuid() })
  .strict();
export const createConnectionInputSchema = z
  .object({
    displayName: z.string().min(1).max(80),
    scopes: z.array(z.string().min(1).max(80)).min(1).max(20),
    expiresAt: instantSchema,
    operationKey: z.uuid(),
  })
  .strict();
export const revokeConnectionInputSchema = z
  .object({ connectionId: idSchema, operationKey: z.uuid() })
  .strict();
export const connectionResultSchema = z.object({
  connection: connectionSchema,
  token: z.string().min(16),
});
export const grantResultSchema = z.object({
  id: idSchema,
  expiresAt: instantSchema,
});
/** Mirrors the engine's billing read model. Entitlement is whatever the server reports, never a redirect. */
export const billingStatusSchema = z.object({
  organizationId: idSchema,
  mode: z.enum(["sandbox", "not_configured"]),
  configurationProblem: z.string().nullable(),
  status: z.enum(["not_configured", "free", "checkout_pending", "trialing", "active", "past_due", "cancelled", "incomplete", "unpaid", "paused"]),
  planKey: z.string().nullable(),
  currentPeriodEnd: instantSchema.nullable(),
  cancelAtPeriodEnd: z.boolean(),
  creditBalance: z.number().int(),
  renderCreditCost: z.number().int().positive(),
  rendersRemaining: z.number().int().nonnegative(),
  plans: z.array(z.object({ key: z.string(), creditsPerPeriod: z.number().int().positive() })),
  canManage: z.boolean(),
  canCheckout: z.boolean(),
  hasCustomer: z.boolean(),
});
/** `confirmationGranted` is literal true: checkout is only ever requested after an explicit click. */
export const checkoutInputSchema = z
  .object({ priceKey: z.string().min(1).max(40), confirmationGranted: z.literal(true), operationKey: z.uuid() })
  .strict();
export const checkoutResultSchema = z.object({
  checkoutUrl: z.url({ protocol: /^https$/, hostname: /(^|\.)stripe\.com$/ }),
  sessionId: z.string().min(1),
  status: z.literal("created"),
});
export const portalResultSchema = z.object({ portalUrl: z.url({ protocol: /^https$/, hostname: /(^|\.)stripe\.com$/ }) });
export const sampleInputSchema = z.object({ operationKey: z.uuid() }).strict();
/** Mirrors the engine's publishing-destination read model (`GET /v1/studio/channels`). */
const channelPlatformSchema = z.enum(["youtube", "instagram", "tiktok"]);
export const channelConnectionSchema = z.object({
  id: idSchema,
  platform: channelPlatformSchema,
  displayName: z.string(),
  state: z.enum(["connected", "expired", "unavailable"]),
  connectedAt: instantSchema,
});
export const channelStatusSchema = z.object({
  platforms: z.array(
    z.object({
      platform: channelPlatformSchema,
      availability: z.enum(["ready", "not_configured", "unavailable"]),
      reason: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  connections: z.array(channelConnectionSchema),
  canManage: z.boolean(),
});
/**
 * The Google tokens are handed to the engine once, straight after Google's consent screen. They are
 * validated and stored server-side; this client never persists or echoes them.
 */
export const connectChannelInputSchema = z
  .object({ platform: z.literal("youtube"), accessToken: z.string().min(20).max(4096), refreshToken: z.string().min(10).max(4096), operationKey: z.uuid() })
  .strict();
export const connectChannelResultSchema = z.object({ connection: channelConnectionSchema });
export const disconnectChannelInputSchema = z.object({ connectionId: idSchema, operationKey: z.uuid() }).strict();
export const disconnectChannelResultSchema = z.object({ disconnected: z.literal(true), cancelledPosts: z.number().int().nonnegative(), revokedAtGoogle: z.boolean() });
export type ChannelStatus = z.infer<typeof channelStatusSchema>;
export type ChannelConnection = z.infer<typeof channelConnectionSchema>;
export type ConnectChannelInput = z.infer<typeof connectChannelInputSchema>;
export type DisconnectChannelInput = z.infer<typeof disconnectChannelInputSchema>;
export type DisconnectChannelResult = z.infer<typeof disconnectChannelResultSchema>;
export type BillingStatus = z.infer<typeof billingStatusSchema>;
export type CheckoutInput = z.infer<typeof checkoutInputSchema>;
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;
export type PortalResult = z.infer<typeof portalResultSchema>;
export type SampleInput = z.infer<typeof sampleInputSchema>;
export type RenderInput = z.infer<typeof renderInputSchema>;
export type PrepareInput = z.infer<typeof prepareInputSchema>;
export type ManifestInput = z.infer<typeof manifestInputSchema>;
export type CancelInput = z.infer<typeof cancelInputSchema>;
export type CreateConnectionInput = z.infer<typeof createConnectionInputSchema>;
export type RevokeConnectionInput = z.infer<typeof revokeConnectionInputSchema>;
export type ConnectionResult = z.infer<typeof connectionResultSchema>;
export type GrantResult = z.infer<typeof grantResultSchema>;

/** Both transports expose the same contract. UI checks never replace server authorization. */
export interface StudioClient {
  startCampaign(input: StartCampaignInput): Promise<Campaign>;
  getContext(): Promise<StudioContext>;
  listCampaigns(): Promise<Campaign[]>;
  getCampaign(id: string): Promise<Campaign>;
  reviseContent(input: ReviseInput): Promise<ContentItem>;
  renderContent(input: RenderInput): Promise<Operation>;
  prepareSchedule(input: PrepareInput): Promise<ScheduleManifest>;
  approveSchedule(input: ManifestInput): Promise<Operation>;
  commitSchedule(input: ManifestInput): Promise<Operation>;
  cancelJobs(input: CancelInput): Promise<Operation>;
  createConnection(input: CreateConnectionInput): Promise<ConnectionResult>;
  revokeConnection(input: RevokeConnectionInput): Promise<void>;
  createGrant(input: GrantInput): Promise<GrantResult>;
  /** One conversational turn. Drafting may be saved; nothing is rendered, approved, charged or published. */
  directorTurn(input: DirectorTurnInput): Promise<DirectorTurnResult>;
  listTemplates(): Promise<Template[]>;
  /** The video template library (rendered samples with signed media URLs). */
  listLibraryTemplates(): Promise<LibraryTemplate[]>;
  createFromTemplate(input: TemplateInput): Promise<Campaign>;
  createSampleProject(input: SampleInput): Promise<Campaign>;
  listVersions(contentId: string): Promise<ContentVersion[]>;
  restoreVersion(input: RestoreInput): Promise<ContentItem>;
  getBilling(): Promise<BillingStatus>;
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  createPortal(): Promise<PortalResult>;
  selectWorkspace(workspaceId: string): Promise<StudioContext>;
  /** Publishing destinations: what can be connected on this deployment and what already is. */
  getChannels(): Promise<ChannelStatus>;
  connectChannel(input: ConnectChannelInput): Promise<ChannelConnection>;
  disconnectChannel(input: DisconnectChannelInput): Promise<DisconnectChannelResult>;
  /** The workspace brand kit every draft starts from. Only the fields sent change. */
  updateBrand(input: UpdateBrandInput): Promise<Brand>;
  /** Adds a source to one project. The link is a reference only; nothing fetches it. */
  addSource(input: AddSourceInput): Promise<Campaign>;
  /** Removes a source from a project and from every draft that cited it. */
  removeSource(input: RemoveSourceInput): Promise<Campaign>;
  /** Presenters made from a face scan and spoken consent, each with its looks. Photo links are short-lived. */
  listPersonas(): Promise<Persona[]>;
  createPersona(input: CreatePersonaInput): Promise<Persona>;
  updatePersona(input: UpdatePersonaInput): Promise<Persona>;
  deletePersona(personaId: string): Promise<void>;
  /** Withdraws the persona's consent: its recordings are deleted and the persona can no longer be used. */
  withdrawPersonaConsent(personaId: string): Promise<void>;
  /** Stores a reference photo for one of the persona's looks and returns its key for createPersonaLook/updatePersonaLook. */
  uploadPersonaPhoto(personaId: string, photo: Blob): Promise<string>;
  createPersonaLook(input: CreatePersonaLookInput): Promise<Persona>;
  updatePersonaLook(input: UpdatePersonaLookInput): Promise<Persona>;
  deletePersonaLook(lookId: string): Promise<Persona>;
  /** The item's video composition, or a first draft from its script when none is saved (revision 0). */
  getComposition(contentId: string): Promise<CompositionDocument>;
  /** Saves the composition with compare-and-swap on its revision. Preview only: nothing is rendered. */
  saveComposition(input: SaveCompositionInput): Promise<CompositionDocument>;
  /** Draft files of a project: every component of a reel, versioned. */
  listFiles(campaignId: string): Promise<DraftFile[]>;
  /** Registers a media draft and returns a one-time upload link (null when identical bytes are already stored). */
  requestUpload(input: RequestUploadInput): Promise<UploadTicket>;
  completeUpload(input: { fileId: string; operationKey: string }): Promise<DraftFile>;
  saveTextFile(input: SaveTextFileInput): Promise<DraftFile>;
  archiveFile(input: { fileId: string; operationKey: string }): Promise<DraftFile>;
  /** Queues an MP4 render of the saved timeline; a render worker produces it as a draft file. */
  queueRender(input: QueueRenderInput): Promise<ReelRender>;
  listRenders(contentId: string): Promise<ReelRender[]>;
  cancelRender(input: { renderId: string; operationKey: string }): Promise<ReelRender>;
}

export function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ApiError(
      "validation_error",
      "The request does not match the studio contract. Check the fields and try again.",
    );
  return result.data;
}
