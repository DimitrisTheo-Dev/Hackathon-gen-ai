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
