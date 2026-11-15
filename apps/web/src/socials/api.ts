/**
 * The engine routes behind social accounts (packages/engine/src/socials.ts): what is connected, connecting by
 * signing in to a platform or with a provider's credentials, and removing. Every call carries the signed-in
 * person's own session.
 */
import { z } from "zod";
import { errorSchema } from "@castroom/contracts";
import { ApiError } from "../data/client";

const accountSchema = z.object({
  id: z.string(),
  platform: z.string(),
  provider: z.string(),
  displayName: z.string(),
  profileUrl: z.string().nullable(),
  state: z.enum(["connected", "expired", "unavailable"]),
  webhookSubscribedAt: z.string().nullable(),
});
const catalogSchema = z.object({
  platforms: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      kind: z.enum(["social", "messaging"]),
      accounts: z.array(accountSchema),
      /** Whether this deployment takes the platform's own deliveries (YouTube: whether channels are subscribed at all). */
      nativeWebhook: z.boolean(),
    }),
  ),
  providers: z.array(z.object({ id: z.string(), label: z.string(), platforms: z.array(z.string()), connect: z.enum(["credentials", "sign_in"]), available: z.boolean(), connected: z.boolean() })),
  canManage: z.boolean(),
});
// Only an https address is ever followed out of the studio.
const startedSchema = z.object({ authorizeUrl: z.url({ protocol: /^https$/ }) });
const accountsSchema = z.object({ accounts: z.array(accountSchema) });
const removedSchema = z.object({ cancelledPosts: z.number() });
export type SocialAccount = z.infer<typeof accountSchema>;
export type SocialCatalog = z.infer<typeof catalogSchema>;
export type SocialProviderInfo = SocialCatalog["providers"][number];

export interface SocialsApi {
  catalog(): Promise<SocialCatalog>;
  /** Where to send the person to allow access. */
  start(provider: string): Promise<z.infer<typeof startedSchema>>;
  /** Finishes the sign-in with what the platform sent back. The code works once. */
  complete(provider: string, code: string, state: string): Promise<z.infer<typeof accountsSchema>>;
  /** Connects a provider with credentials the person supplies (Buffer: `{ apiKey }`). They are stored encrypted by the engine. */
  connectWithCredentials(provider: string, credentials: Record<string, string>): Promise<z.infer<typeof accountsSchema>>;
  /** Re-reads the provider's accounts with the credentials saved when it was connected. */
  sync(provider: string): Promise<z.infer<typeof accountsSchema>>;
  disconnect(provider: string): Promise<z.infer<typeof removedSchema>>;
  removeAccount(accountId: string): Promise<z.infer<typeof removedSchema>>;
}

export function createSocialsApi(baseUrl: string, getToken: () => Promise<string | null>): SocialsApi {
  const base = baseUrl.replace(/\/$/, "");
  async function request<T>(method: "GET" | "POST" | "DELETE", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError("unauthenticated", "Sign in to connect an account.");
    let response: Response;
    try {
      response = await fetch(`${base}/v1/socials${path}`, {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        ...(method === "POST" ? { body: JSON.stringify(body ?? {}) } : {}),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
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
  const provider = (id: string) => `/providers/${encodeURIComponent(id)}`;
  return {
    catalog: () => request("GET", "", catalogSchema),
    start: (id) => request("POST", `${provider(id)}/connect`, startedSchema),
    complete: (id, code, state) => request("POST", `${provider(id)}/complete`, accountsSchema, { code, state }),
    connectWithCredentials: (id, credentials) => request("POST", `${provider(id)}/connect`, accountsSchema, credentials),
    sync: (id) => request("POST", `${provider(id)}/sync`, accountsSchema),
    disconnect: (id) => request("DELETE", provider(id), removedSchema),
    removeAccount: (accountId) => request("DELETE", `/accounts/${encodeURIComponent(accountId)}`, removedSchema),
  };
}
