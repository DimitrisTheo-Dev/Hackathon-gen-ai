import { z } from "zod";
import {
  startCampaignInputSchema,
  campaignSchema,
  contentSchema,
  contextSchema,
  errorSchema,
  grantInputSchema,
  idSchema,
  manifestSchema,
  operationSchema,
  reviseInputSchema,
} from "@castroom/contracts";
import {
  ApiError,
  cancelInputSchema,
  connectionResultSchema,
  createConnectionInputSchema,
  grantResultSchema,
  manifestInputSchema,
  prepareInputSchema,
  renderInputSchema,
  revokeConnectionInputSchema,
  validate,
  type StudioClient,
} from "./client";

/** The route adapter is provisional until Minas confirms the backend contract. */
export function createLiveClient(
  baseUrl: string,
  getToken: () => Promise<string | null>,
): StudioClient {
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new ApiError(
      "validation_error",
      "The studio API address is invalid.",
    );
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new ApiError(
      "validation_error",
      "The studio API requires a secure address without credentials or query parameters.",
    );
  }
  const base = origin.href.replace(/\/$/, "");

  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const token = await getToken();
    if (!token)
      throw new ApiError(
        "unauthenticated",
        "Sign in to access this workspace.",
      );
    let response: Response;
    try {
      response = await fetch(`${base}/v1/studio${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      if (body !== undefined)
        throw new ApiError(
          "unknown_outcome",
          "The response was interrupted. Check the current status before retrying; keep the same operation key.",
        );
      throw new ApiError(
        "provider_unavailable",
        "The studio API could not be reached. Your drafts have not been changed.",
      );
    }
    let payload: unknown;
    try {
      payload = response.status === 204 ? undefined : await response.json();
    } catch {
      throw new ApiError(
        body === undefined ? "provider_unavailable" : "unknown_outcome",
        "The studio API returned an unreadable response. Refresh status before continuing.",
      );
    }
    if (!response.ok) {
      const parsed = z.object({ error: errorSchema }).safeParse(payload);
      if (parsed.success)
        throw new ApiError(
          parsed.data.error.code,
          parsed.data.error.message,
          parsed.data.error,
        );
      const code =
        response.status === 401
          ? "unauthenticated"
          : response.status === 403
            ? "forbidden"
            : response.status === 404
              ? "not_found"
              : response.status === 429
                ? "quota_exceeded"
                : body === undefined
                  ? "provider_unavailable"
                  : "unknown_outcome";
      const retry = Number(response.headers.get("Retry-After"));
      throw new ApiError(
        code,
        `The studio request failed (${response.status}). No simulated result was substituted.`,
        {
          retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
        },
      );
    }
    const result = schema.safeParse(payload);
    if (!result.success)
      throw new ApiError(
        body === undefined ? "provider_unavailable" : "unknown_outcome",
        "The studio response does not match the agreed data format. Refresh status before continuing.",
      );
    return result.data;
  }
  return {
    startCampaign: (input) =>
      request(
        "/operations/start_campaign",
        campaignSchema.refine((value) => value.mode === "live"),
        validate(startCampaignInputSchema, input),
      ),
    getContext: () =>
      request(
        "/context",
        contextSchema.refine((value) => value.capabilities.mode === "live"),
      ),
    listCampaigns: () =>
      request(
        "/campaigns",
        z.array(campaignSchema.refine((value) => value.mode === "live")),
      ),
    getCampaign: (id) =>
      request(
        `/campaigns/${encodeURIComponent(validate(idSchema, id))}`,
        campaignSchema.refine((value) => value.mode === "live"),
      ),
    reviseContent: (input) =>
      request(
        "/operations/revise_content",
        contentSchema,
        validate(reviseInputSchema, input),
      ),
    renderContent: (input) =>
      request(
        "/operations/render_content",
        operationSchema,
        validate(renderInputSchema, input),
      ),
    prepareSchedule: (input) =>
      request(
        "/operations/prepare_schedule",
        manifestSchema,
        validate(prepareInputSchema, input),
      ),
    approveSchedule: (input) =>
      request(
        "/operations/approve_schedule",
        operationSchema,
        validate(manifestInputSchema, input),
      ),
    commitSchedule: (input) =>
      request(
        "/operations/commit_schedule",
        operationSchema,
        validate(manifestInputSchema, input),
      ),
    cancelJobs: (input) =>
      request(
        "/operations/cancel_jobs",
        operationSchema,
        validate(cancelInputSchema, input),
      ),
    createConnection: (input) =>
      request(
        "/operations/create_agent_connection",
        connectionResultSchema,
        validate(createConnectionInputSchema, input),
      ),
    revokeConnection: async (input) => {
      await request(
        "/operations/revoke_agent_connection",
        z.union([z.undefined(), z.object({ revoked: z.literal(true) })]),
        validate(revokeConnectionInputSchema, input),
      );
    },
    createGrant: (input) =>
      request(
        "/operations/create_run_grant",
        grantResultSchema,
        validate(grantInputSchema, input),
      ),
  };
}
