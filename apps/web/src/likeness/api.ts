/**
 * The engine routes behind the likeness capture (packages/engine/src/likeness.ts). Everything is tied to
 * the signed-in person's own session; recordings go from the browser straight to private storage through
 * a one-file upload link, never through the engine.
 */
import { z } from "zod";
import {
  errorSchema,
  likenessConsentInputSchema,
  likenessConsentResultSchema,
  likenessLiveTokenSchema,
  likenessUploadInputSchema,
  likenessUploadTicketSchema,
  type LikenessConsentInput,
  type LikenessConsentResult,
  type LikenessLiveToken,
  type LikenessUploadInput,
  type LikenessUploadTicket,
} from "@castroom/contracts";
import { ApiError, validate } from "../data/client";

export interface LikenessApi {
  /** A link that accepts exactly one file: the one with this type, size and SHA-256. */
  uploadTicket(input: LikenessUploadInput): Promise<LikenessUploadTicket>;
  /** A single-use token for the live transcription socket. Rejects when live transcription is not connected. */
  liveToken(): Promise<LikenessLiveToken>;
  saveConsent(input: LikenessConsentInput): Promise<LikenessConsentResult>;
}

export function createLikenessApi(baseUrl: string, getToken: () => Promise<string | null>): LikenessApi {
  const base = baseUrl.replace(/\/$/, "");
  async function post<T>(path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
    const token = await getToken();
    if (!token) throw new ApiError("unauthenticated", "Sign in to scan your face.");
    let response: Response;
    try {
      response = await fetch(`${base}/v1/studio/likeness${path}`, {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new ApiError("provider_unavailable", "Faceful could not be reached. Check the connection and try again.");
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z.object({ error: errorSchema }).safeParse(payload);
      if (parsed.success) throw new ApiError(parsed.data.error.code, parsed.data.error.message, parsed.data.error);
      throw new ApiError(response.status === 401 ? "unauthenticated" : "provider_unavailable", `The request failed (${response.status}). Nothing was saved.`);
    }
    const result = schema.safeParse(payload);
    if (!result.success) throw new ApiError("unknown_outcome", "Faceful returned an unreadable response. Nothing was saved.");
    return result.data;
  }
  return {
    uploadTicket: (input) => post("/upload-url", likenessUploadTicketSchema, validate(likenessUploadInputSchema, input)),
    liveToken: () => post("/live-token", likenessLiveTokenSchema, {}),
    saveConsent: (input) => post("/consents", likenessConsentResultSchema, validate(likenessConsentInputSchema, input)),
  };
}

/** Lower-case hex SHA-256 of a recording, as the upload link expects. */
export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Sends one recording or still to private storage and returns its key. */
export async function uploadLikenessFile(api: LikenessApi, blob: Blob): Promise<string> {
  const type = blob.type.split(";")[0];
  const input = likenessUploadInputSchema.safeParse({ type, size: blob.size, sha256: await sha256Hex(blob) });
  if (!input.success) throw new ApiError("validation_error", "This browser recorded in a format Faceful cannot store. Try Chrome, Edge or Safari.");
  const ticket = await api.uploadTicket(input.data);
  let put: Response;
  try {
    put = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body: blob, credentials: "omit", cache: "no-store" });
  } catch {
    throw new ApiError("provider_unavailable", "A recording did not upload. Check the connection and try again.");
  }
  if (!put.ok) throw new ApiError("provider_unavailable", "A recording did not upload. Check the connection and try again.");
  return ticket.key;
}
