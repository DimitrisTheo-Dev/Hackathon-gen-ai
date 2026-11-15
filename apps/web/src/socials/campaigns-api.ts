/**
 * The engine routes behind comment-to-DM campaigns (packages/engine/src/socials-campaigns.ts): listing and changing
 * campaigns, the conversations they hold, and "Try it", which sends a test comment or reply through the webhook
 * pipeline and answers with the test conversation. Every call carries the signed-in person's own session.
 */
import { z } from "zod";
import { errorSchema } from "@castroom/contracts";
import { ApiError } from "../data/client";

const followUpSchema = z.object({ delayMinutes: z.number(), text: z.string() });
const campaignSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  keywords: z.array(z.string()),
  openingMessage: z.string(),
  linkUrl: z.string().nullable(),
  publicReply: z.string().nullable(),
  aiEnabled: z.boolean(),
  aiInstructions: z.string().nullable(),
  followUps: z.array(followUpSchema),
  people: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
const messageSchema = z.object({
  id: z.string(),
  direction: z.enum(["in", "out"]),
  kind: z.string(),
  text: z.string(),
  status: z.string(),
  sendAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});
const conversationSchema = z.object({
  id: z.string(),
  campaignId: z.string().nullable(),
  contactName: z.string().nullable(),
  state: z.enum(["awaiting_reply", "open", "stopped"]),
  simulated: z.boolean(),
  aiTurns: z.number(),
  lastInboundAt: z.string().nullable(),
  updatedAt: z.string(),
  messages: z.array(messageSchema),
});
const overviewSchema = z.object({
  campaigns: z.array(campaignSchema),
  accounts: z.array(z.object({ id: z.string(), displayName: z.string(), provider: z.string(), canMessage: z.boolean(), activity: z.boolean() })),
  ai: z.boolean(),
  webhook: z.object({ url: z.string().nullable(), instagram: z.boolean(), signedTests: z.boolean() }),
  canManage: z.boolean(),
});
const savedSchema = z.object({ campaign: campaignSchema });
const deletedSchema = z.object({ cancelledMessages: z.number() });
const conversationsSchema = z.object({ conversations: z.array(conversationSchema) });
const testSchema = z.object({ via: z.enum(["webhook", "direct"]).nullable().optional(), conversation: conversationSchema.nullable() });

export type DmCampaign = z.infer<typeof campaignSchema>;
export type DmMessage = z.infer<typeof messageSchema>;
export type DmConversation = z.infer<typeof conversationSchema>;
export type CampaignOverview = z.infer<typeof overviewSchema>;
export type CampaignTest = z.infer<typeof testSchema>;
/** What the form sends. Empty optional texts are sent as empty strings and stored as nothing. */
export interface CampaignDraft {
  accountId: string;
  name: string;
  enabled: boolean;
  keywords: string[];
  openingMessage: string;
  linkUrl: string;
  publicReply: string;
  aiEnabled: boolean;
  aiInstructions: string;
  followUps: Array<{ delayMinutes: number; text: string }>;
}

export interface CampaignsApi {
  overview(): Promise<CampaignOverview>;
  create(draft: CampaignDraft): Promise<DmCampaign>;
  update(id: string, patch: Partial<Omit<CampaignDraft, "accountId">>): Promise<DmCampaign>;
  remove(id: string): Promise<z.infer<typeof deletedSchema>>;
  conversations(id: string): Promise<DmConversation[]>;
  /** The test conversation for this member, as it stands. */
  testState(id: string): Promise<CampaignTest>;
  /** A test comment or reply, sent through the webhook pipeline with nothing sent to Instagram; "reset" starts over. */
  test(id: string, input: { kind: "comment" | "reply"; text: string } | { kind: "reset" }): Promise<CampaignTest>;
}

export function createCampaignsApi(baseUrl: string, getToken: () => Promise<string | null>): CampaignsApi {
  const base = baseUrl.replace(/\/$/, "");
  async function request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError("unauthenticated", "Sign in to manage campaigns.");
    const sends = method === "POST" || method === "PATCH";
    let response: Response;
    try {
      response = await fetch(`${base}/v1/socials/campaigns${path}`, {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(sends ? { "Content-Type": "application/json" } : {}) },
        ...(sends ? { body: JSON.stringify(body ?? {}) } : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        // A test waits for the AI's answer.
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new ApiError("provider_unavailable", "Faceful could not be reached. Check the connection and try again.");
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z.object({ error: errorSchema }).safeParse(payload);
      if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.error);
      throw new ApiError(response.status === 401 ? "unauthenticated" : "provider_unavailable", `The request failed (${response.status}). Nothing was changed.`);
    }
    const result = schema.safeParse(payload);
    if (!result.success) throw new ApiError("unknown_outcome", "Faceful returned an unreadable response.");
    return result.data;
  }
  const one = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    overview: () => request("GET", "", overviewSchema),
    create: async (draft) => (await request("POST", "", savedSchema, draft)).campaign,
    update: async (id, patch) => (await request("PATCH", one(id), savedSchema, patch)).campaign,
    remove: (id) => request("DELETE", one(id), deletedSchema),
    conversations: async (id) => (await request("GET", `${one(id)}/conversations`, conversationsSchema)).conversations,
    testState: (id) => request("GET", `${one(id)}/test`, testSchema),
    test: (id, input) => request("POST", `${one(id)}/test`, testSchema, input),
  };
}
