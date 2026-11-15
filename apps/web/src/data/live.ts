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
  directorTurnInputSchema,
  directorTurnResultSchema,
  restoreInputSchema,
  templateInputSchema,
  templateSchema,
  libraryTemplateSchema,
  versionSchema,
  addSourceInputSchema,
  brandSchema,
  cloneJobInputSchema,
  cloneJobSchema,
  cloneSourceSchema,
  removeSourceInputSchema,
  updateBrandInputSchema,
  createPersonaInputSchema,
  createPersonaLookInputSchema,
  likenessUploadTicketSchema,
  personaImageUploadInputSchema,
  personaSchema,
  updatePersonaInputSchema,
  updatePersonaLookInputSchema,
  compositionDocumentSchema,
  saveCompositionInputSchema,
  draftFileSchema,
  uploadTicketSchema,
  requestUploadInputSchema,
  completeUploadInputSchema,
  saveTextFileInputSchema,
  archiveFileInputSchema,
  reelRenderSchema,
  queueRenderInputSchema,
  approveReviewInputSchema,
  contentReviewSchema,
  createProductInputSchema,
  placeProductInputSchema,
  placeProductResultSchema,
  productImageTicketSchema,
  productImageUploadInputSchema,
  productSchema,
  reviewContentInputSchema,
  updateProductInputSchema,
} from "@castroom/contracts";
import {
  ApiError,
  billingStatusSchema,
  checkoutInputSchema,
  checkoutResultSchema,
  portalResultSchema,
  sampleInputSchema,
  channelStatusSchema,
  connectChannelInputSchema,
  connectChannelResultSchema,
  disconnectChannelInputSchema,
  disconnectChannelResultSchema,
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
    options: { timeoutMs?: number; headers?: Record<string, string> } = {},
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
          ...options.headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
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
        // Committing uploads approved videos to destinations that schedule natively (YouTube), which takes longer than a read.
        { timeoutMs: 115_000 },
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
    // A model may take a while to draft; the engine function allows up to two minutes.
    directorTurn: (input) =>
      request(
        "/director/turn",
        directorTurnResultSchema.refine((value) => !value.created || value.created.mode === "live"),
        validate(directorTurnInputSchema, input),
        { timeoutMs: 110_000 },
      ),
    listTemplates: () => request("/templates", z.array(templateSchema)),
    listLibraryTemplates: () => request("/templates/library", z.array(libraryTemplateSchema)),
    // The engine asks the platform's oEmbed (and may follow a TikTok short link), so this can take a few seconds.
    lookupCloneSource: (url) => request(`/clone/source?url=${encodeURIComponent(url)}`, cloneSourceSchema, undefined, { timeoutMs: 20_000 }),
    listCloneJobs: () => request("/clone/jobs", z.array(cloneJobSchema)),
    createCloneJob: (input) =>
      request("/operations/create_clone_job", cloneJobSchema, validate(cloneJobInputSchema, input), { timeoutMs: 30_000 }),
    createFromTemplate: (input) =>
      request(
        "/operations/create_from_template",
        campaignSchema.refine((value) => value.mode === "live"),
        validate(templateInputSchema, input),
      ),
    createSampleProject: (input) =>
      request(
        "/operations/create_sample_project",
        campaignSchema.refine((value) => value.mode === "live" && value.origin === "sample"),
        validate(sampleInputSchema, input),
      ),
    listVersions: (contentId) =>
      request(
        `/items/${encodeURIComponent(validate(idSchema, contentId))}/versions`,
        z.array(versionSchema),
      ),
    restoreVersion: (input) =>
      request(
        "/operations/restore_version",
        contentSchema,
        validate(restoreInputSchema, input),
      ),
    getBilling: () => request("/billing", billingStatusSchema),
    createCheckout: (input) =>
      request(
        "/operations/create_checkout",
        checkoutResultSchema,
        validate(checkoutInputSchema, input),
        { timeoutMs: 30_000 },
      ),
    createPortal: () =>
      request("/operations/create_portal", portalResultSchema, {}, { timeoutMs: 30_000 }),
    selectWorkspace: (workspaceId) =>
      request(
        "/workspace/select",
        contextSchema.refine((value) => value.capabilities.mode === "live"),
        {},
        { headers: { "X-Faceful-Workspace": validate(idSchema, workspaceId) } },
      ),
    getChannels: () => request("/channels", channelStatusSchema),
    connectChannel: async (input) =>
      (
        await request(
          "/operations/connect_channel",
          connectChannelResultSchema,
          validate(connectChannelInputSchema, input),
          { timeoutMs: 45_000 },
        )
      ).connection,
    disconnectChannel: (input) =>
      request(
        "/operations/disconnect_channel",
        disconnectChannelResultSchema,
        validate(disconnectChannelInputSchema, input),
        { timeoutMs: 30_000 },
      ),
    // Async, so a request that fails validation is a rejected promise like any other failure.
    updateBrand: async (input) =>
      request(
        "/operations/update_brand",
        brandSchema.strict(),
        validate(updateBrandInputSchema, input),
      ),
    addSource: async (input) => {
      const body = validate(addSourceInputSchema, input);
      return request(
        "/operations/add_source",
        campaignSchema.refine((value) => value.mode === "live" && value.id === body.campaignId),
        body,
      );
    },
    removeSource: async (input) => {
      const body = validate(removeSourceInputSchema, input);
      return request(
        "/operations/remove_source",
        campaignSchema.refine(
          (value) =>
            value.mode === "live" &&
            value.id === body.campaignId &&
            value.sources.every((source) => source.id !== body.sourceId) &&
            value.items.every((item) => !item.sourceIds.includes(body.sourceId)),
        ),
        body,
      );
    },
    listPersonas: () => request("/personas", z.array(personaSchema)),
    createPersona: async (input) => request("/operations/create_persona", personaSchema, validate(createPersonaInputSchema, input)),
    updatePersona: async (input) => request("/operations/update_persona", personaSchema, validate(updatePersonaInputSchema, input)),
    deletePersona: async (personaId) => {
      await request("/operations/delete_persona", z.object({ deleted: z.literal(true) }), { personaId: validate(idSchema, personaId) });
    },
    withdrawPersonaConsent: async (personaId) => {
      await request("/operations/withdraw_persona_consent", z.object({ revoked: z.literal(true) }), { personaId: validate(idSchema, personaId) }, { timeoutMs: 30_000 });
    },
    uploadPersonaPhoto: async (personaId, photo) => {
      const digest = await crypto.subtle.digest("SHA-256", await photo.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const input = personaImageUploadInputSchema.safeParse({ personaId, type: photo.type, size: photo.size, sha256 });
      if (!input.success) throw new ApiError("validation_error", "Use a JPEG, PNG or WebP photo under 15 MB.");
      const ticket = await request("/operations/persona_image_upload_url", likenessUploadTicketSchema, input.data);
      let put: Response;
      try {
        // Straight to private storage; the link accepts exactly these bytes.
        put = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body: photo, credentials: "omit", cache: "no-store" });
      } catch {
        throw new ApiError("provider_unavailable", "The photo did not upload. Check the connection and try again.");
      }
      if (!put.ok) throw new ApiError("provider_unavailable", "The photo did not upload. Check the connection and try again.");
      return ticket.key;
    },
    createPersonaLook: async (input) => request("/operations/create_persona_look", personaSchema, validate(createPersonaLookInputSchema, input)),
    updatePersonaLook: async (input) => request("/operations/update_persona_look", personaSchema, validate(updatePersonaLookInputSchema, input)),
    deletePersonaLook: async (lookId) => request("/operations/delete_persona_look", personaSchema, { lookId: validate(idSchema, lookId) }),
    getComposition: (contentId) =>
      request(
        `/items/${encodeURIComponent(validate(idSchema, contentId))}/composition`,
        compositionDocumentSchema,
      ),
    saveComposition: (input) =>
      request(
        "/operations/save_composition",
        compositionDocumentSchema,
        validate(saveCompositionInputSchema, input),
      ),
    listFiles: (campaignId) =>
      request(`/campaigns/${encodeURIComponent(validate(idSchema, campaignId))}/files`, z.array(draftFileSchema)),
    requestUpload: (input) => request("/operations/request_file_upload", uploadTicketSchema, validate(requestUploadInputSchema, input)),
    completeUpload: (input) => request("/operations/complete_file_upload", draftFileSchema, validate(completeUploadInputSchema, input)),
    saveTextFile: (input) => request("/operations/save_text_file", draftFileSchema, validate(saveTextFileInputSchema, input)),
    archiveFile: (input) => request("/operations/archive_file", draftFileSchema, validate(archiveFileInputSchema, input)),
    queueRender: (input) => request("/operations/queue_reel_render", reelRenderSchema, validate(queueRenderInputSchema, input)),
    listRenders: (contentId) =>
      request(`/items/${encodeURIComponent(validate(idSchema, contentId))}/renders`, z.array(reelRenderSchema)),
    cancelRender: (input) =>
      request("/operations/cancel_reel_render", reelRenderSchema, validate(z.object({ renderId: idSchema, operationKey: z.uuid() }).strict(), input)),
    createProduct: async (input) => request("/operations/create_product", productSchema, validate(createProductInputSchema, input)),
    updateProduct: async (input) => request("/operations/update_product", productSchema, validate(updateProductInputSchema, input)),
    deleteProduct: async (productId) => {
      await request("/operations/delete_product", z.object({ deleted: z.literal(true) }), { productId: validate(idSchema, productId) });
    },
    uploadProductImage: async (photo) => {
      const digest = await crypto.subtle.digest("SHA-256", await photo.arrayBuffer());
      const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const input = productImageUploadInputSchema.safeParse({ type: photo.type, size: photo.size, sha256 });
      if (!input.success) throw new ApiError("validation_error", "Use a JPEG, PNG or WebP photo under 15 MB.");
      const ticket = await request("/operations/product_image_upload_url", productImageTicketSchema, input.data);
      let put: Response;
      try {
        // Straight to private storage with exactly the headers the ticket names; the link accepts these bytes only.
        put = await fetch(ticket.uploadUrl, { method: "PUT", headers: ticket.headers, body: photo, credentials: "omit", cache: "no-store" });
      } catch {
        throw new ApiError("provider_unavailable", "The photo did not upload. Check the connection and try again.");
      }
      if (!put.ok) throw new ApiError("provider_unavailable", "The photo did not upload. Check the connection and try again.");
      return ticket.key;
    },
    placeProduct: async (input) => request("/operations/place_product", placeProductResultSchema, validate(placeProductInputSchema, input), { timeoutMs: 30_000 }),
    getReview: (itemId) => request(`/items/${encodeURIComponent(validate(idSchema, itemId))}/review`, contentReviewSchema.nullable()),
    // A model may read the script against the approved facts and sources; give it the time the engine allows.
    reviewContent: async (input) => request("/operations/review_content", contentReviewSchema, validate(reviewContentInputSchema, input), { timeoutMs: 90_000 }),
    approveReview: async (input) => request("/operations/approve_review", contentReviewSchema, validate(approveReviewInputSchema, input)),
  };
}
