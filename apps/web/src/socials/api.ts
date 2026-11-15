/**
 * The engine routes behind connecting a social account by signing in to its platform
 * (packages/engine/src/socials.ts). Every call carries the signed-in person's own session.
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
  platforms: z.array(z.object({ id: z.string(), accounts: z.array(accountSchema) })),
  providers: z.array(z.object({ id: z.string(), label: z.string(), connect: z.enum(["credentials", "sign_in"]), available: z.boolean() })),
});
// Only an https address is ever followed out of the studio.
const startedSchema = z.object({ authorizeUrl: z.url({ protocol: /^https$/ }) });
const completedSchema = z.object({ accounts: z.array(accountSchema) });
export type SocialAccount = z.infer<typeof accountSchema>;
export type SocialProviderInfo = z.infer<typeof catalogSchema>["providers"][number];

export interface SocialsApi {
  catalog(): Promise<z.infer<typeof catalogSchema>>;
  /** Where to send the person to allow access. */
  start(provider: string): Promise<z.infer<typeof startedSchema>>;
  /** Finishes the sign-in with what the platform sent back. The code works once. */
  complete(provider: string, code: string, state: string): Promise<z.infer<typeof completedSchema>>;
}

export function createSocialsApi(baseUrl: string, getToken: () => Promise<string | null>): SocialsApi {
  const base = baseUrl.replace(/\/$/, "");
  async function request<T>(method: "GET" | "POST", path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError("unauthenticated", "Sign in to connect an account.");
    let response: Response;
    try {
      response = await fetch(`${base}/v1/socials${path}`, {
        method,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
        body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
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
      throw new ApiError(response.status === 401 ? "unauthenticated" : "provider_unavailable", `The request failed (${response.status}). Nothing was connected.`);
    }
    const result = schema.safeParse(payload);
    if (!result.success) throw new ApiError("unknown_outcome", "Faceful returned an unreadable response.");
    return result.data;
  }
  return {
    catalog: () => request("GET", "", catalogSchema),
    start: (provider) => request("POST", `/providers/${encodeURIComponent(provider)}/connect`, startedSchema),
    complete: (provider, code, state) => request("POST", `/providers/${encodeURIComponent(provider)}/complete`, completedSchema, { code, state }),
  };
}
