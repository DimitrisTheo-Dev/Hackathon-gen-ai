import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { audit, idempotent, requireHuman, requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError, StoreConflict } from "./errors.js";
import { ChannelGrantExpired, createYoutubeClient, MAX_UPLOAD_BYTES, YOUTUBE_UPLOAD_SCOPE } from "./providers/youtube.js";
import type { Publisher } from "./schedule.js";
import { selectOne, type Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * Publishing destinations. Exactly one is real: YouTube. Instagram and TikTok need each platform's
 * app review before any third-party app may post, so they are reported as unavailable, never faked.
 *
 * A connected channel is a row in `provider_connections` holding the channel identity and the Google
 * refresh token, encrypted. The token is accepted only after Google confirms it was issued to THIS
 * deployment's OAuth client with upload permission, and it never leaves the server again.
 */
export const NOT_AVAILABLE_YET = "Instagram and TikTok publishing need each platform’s app review; not available yet.";
/** Google's rule, stated wherever a person decides to post publicly. */
export const YOUTUBE_AUDIT_NOTE =
  "YouTube keeps videos uploaded by apps that have not passed its API audit private. Faceful uploads and schedules the video, then shows exactly what YouTube reports — it is only marked Published when YouTube says it is public.";

/* ───────────────────────── credential sealing ───────────────────────── */

const b64 = (value: Uint8Array) => Buffer.from(value).toString("base64url");

/** AES-256-GCM with a fresh IV per value. Format: `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function sealSecret(key: Uint8Array, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(data)}`;
}
/** Throws on any tampering, wrong key or unknown version; callers treat that as "reconnect". */
export function openSecret(key: Uint8Array, sealed: string): string {
  const [version, iv, tag, data] = sealed.split(".");
  if (version !== "v1" || !iv || !tag || !data) throw new Error("Unreadable credential");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

/* ───────────────────────── status ───────────────────────── */

function youtube(deps: EngineDeps) {
  const config = deps.config.youtube;
  if (!config) throw new EngineError("unsupported", `${deps.config.youtubeProblem ?? "YouTube publishing has not been set up on this deployment."} Schedules can still be drafted and reviewed.`);
  return { config, client: createYoutubeClient({ clientId: config.clientId, clientSecret: config.clientSecret, fetch: deps.fetch }) };
}

export const channelStatusSchema = z.object({
  platforms: z.array(
    z.object({
      platform: z.enum(["youtube", "instagram", "tiktok"]),
      /** "ready": can be connected now. "not_configured": this deployment lacks settings. "unavailable": not offered in this build. */
      availability: z.enum(["ready", "not_configured", "unavailable"]),
      reason: z.string().nullable(),
      note: z.string().nullable(),
    }),
  ),
  connections: z.array(z.object({ id: z.string(), platform: z.enum(["youtube", "instagram", "tiktok"]), displayName: z.string(), state: z.enum(["connected", "expired", "unavailable"]), connectedAt: z.string() })),
  /** Whether THIS caller may connect or disconnect (a signed-in owner or admin). */
  canManage: z.boolean(),
});
export type ChannelStatus = z.infer<typeof channelStatusSchema>;

export function canManageChannels(deps: EngineDeps, ctx: Ctx): boolean {
  return ctx.principal.kind === "human" && ctx.scopes.has("connections:manage") && deps.config.youtube !== null;
}

export async function getChannelStatus(deps: EngineDeps, ctx: Ctx): Promise<ChannelStatus> {
  requireScope(ctx, "campaign:read");
  const rows = await deps.store.select("provider_connections", { org_id: ctx.org.id }, { order: ["created_at", "asc"] });
  const configured = deps.config.youtube !== null;
  return parse(channelStatusSchema, {
    platforms: [
      { platform: "youtube", availability: configured ? "ready" : "not_configured", reason: configured ? null : deps.config.youtubeProblem, note: YOUTUBE_AUDIT_NOTE },
      { platform: "instagram", availability: "unavailable", reason: NOT_AVAILABLE_YET, note: null },
      { platform: "tiktok", availability: "unavailable", reason: NOT_AVAILABLE_YET, note: null },
    ],
    connections: rows.map((row) => ({ id: row.id, platform: row.platform, displayName: row.display_name, state: row.state, connectedAt: new Date(row.created_at).toISOString() })),
    canManage: canManageChannels(deps, ctx),
  });
}

/* ───────────────────────── connect / disconnect ───────────────────────── */

export const connectChannelInputSchema = z
  .object({ platform: z.literal("youtube"), accessToken: z.string().min(20).max(4096), refreshToken: z.string().min(10).max(4096), operationKey: z.uuid() })
  .strict();
export const disconnectChannelInputSchema = z.object({ connectionId: z.string().min(1).max(160), operationKey: z.uuid() }).strict();
const connectionResultSchema = z.object({ connection: channelStatusSchema.shape.connections.element });

export async function connectChannel(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  // Connecting a publishing destination is an owner's decision, made in person. Agents cannot do it.
  requireHuman(ctx, "Connecting a publishing channel");
  requireScope(ctx, "connections:manage");
  const { config, client } = youtube(deps);
  const input = parse(connectChannelInputSchema, raw);
  // The ledger stores only a hash of the request, so the tokens are not persisted by idempotency.
  return idempotent(deps, ctx, "connect_channel", input.operationKey, input, async () => {
    // 1. The access token must have been issued to this deployment's OAuth client, with upload permission.
    //    This stops a token minted for some other app from being planted here.
    const info = await client.tokenInfo(input.accessToken);
    if (info.audience !== config.clientId && info.authorizedParty !== config.clientId)
      throw new EngineError("forbidden", "That Google access was issued to a different application. Use “Connect YouTube” in the studio.");
    if (!info.scopes.includes(YOUTUBE_UPLOAD_SCOPE))
      throw new EngineError("validation_error", "Google did not grant permission to upload to YouTube. Connect again and allow the YouTube access it asks for.");
    // 2. The refresh token is what will publish later, so it must work with our client right now.
    let refreshed: { accessToken: string; scopes: string[] };
    try {
      refreshed = await client.refresh(input.refreshToken);
    } catch (error) {
      if (error instanceof ChannelGrantExpired) throw new EngineError("validation_error", "Google did not provide lasting access to the channel. Connect again and approve the request in full.");
      throw error;
    }
    if (refreshed.scopes.length && !refreshed.scopes.includes(YOUTUBE_UPLOAD_SCOPE))
      throw new EngineError("validation_error", "Google did not grant permission to upload to YouTube. Connect again and allow the YouTube access it asks for.");
    // 3. The channel is whatever that lasting grant uploads to — asked of Google, never taken from the request.
    const channel = await client.myChannel(refreshed.accessToken);
    if (!channel) throw new EngineError("validation_error", "This Google account has no YouTube channel. Create a channel in YouTube, then connect again.");

    const now = deps.now().toISOString();
    const fields = { display_name: channel.title.slice(0, 120), state: "connected", scopes: refreshed.scopes.length ? refreshed.scopes : info.scopes, credentials_ciphertext: sealSecret(config.encryptionKey, input.refreshToken), updated_at: now };
    const identity = { org_id: ctx.org.id, platform: "youtube", external_account_id: channel.id };
    let row = (await deps.store.update("provider_connections", identity, fields))[0];
    if (!row) {
      try {
        row = await deps.store.insert("provider_connections", { id: crypto.randomUUID(), ...identity, ...fields, created_by: (ctx.principal as { userId: string }).userId, created_at: now });
      } catch (error) {
        if (!(error instanceof StoreConflict)) throw error;
        row = (await deps.store.update("provider_connections", identity, fields))[0];
      }
    }
    if (!row) throw new EngineError("unknown_outcome", "The channel could not be saved. Nothing was connected; try again.");
    await audit(deps, ctx, { action: "Connected a YouTube channel", objectId: row.id, outcome: `Channel “${row.display_name}” · upload access verified with Google` });
    return parse(connectionResultSchema, { connection: { id: row.id, platform: "youtube", displayName: row.display_name, state: "connected", connectedAt: new Date(row.created_at).toISOString() } });
  });
}

export async function disconnectChannel(deps: EngineDeps, ctx: Ctx, raw: unknown) {
  requireHuman(ctx, "Disconnecting a publishing channel");
  requireScope(ctx, "connections:manage");
  const input = parse(disconnectChannelInputSchema, raw);
  return idempotent(deps, ctx, "disconnect_channel", input.operationKey, input, async () => {
    const row = await selectOne(deps.store, "provider_connections", { id: input.connectionId, org_id: ctx.org.id });
    if (!row) throw new EngineError("not_found", "This channel is not connected to your workspace.");
    // Posts that have not been sent can no longer be sent. Anything already uploaded stays on the channel.
    const cancelled = await deps.store.update("publish_jobs", { org_id: ctx.org.id, account_id: row.id, state: "scheduled" }, { state: "cancelled", error: "The channel was disconnected before this post was sent.", updated_at: deps.now().toISOString() });
    let revoked = false;
    if (deps.config.youtube && row.credentials_ciphertext) {
      try {
        const { config, client } = youtube(deps);
        revoked = await client.revoke(openSecret(config.encryptionKey, row.credentials_ciphertext));
      } catch {
        revoked = false; // Revocation is best effort; removing our copy below is what guarantees we can no longer post.
      }
    }
    await deps.store.remove("provider_connections", { id: row.id, org_id: ctx.org.id });
    await audit(deps, ctx, { action: "Disconnected a YouTube channel", objectId: row.id, outcome: `${cancelled.length} unsent post(s) cancelled · Google access ${revoked ? "revoked" : "removed here (revoke it in your Google account if needed)"}` });
    return { disconnected: true as const, cancelledPosts: cancelled.length, revokedAtGoogle: revoked };
  });
}

/* ───────────────────────── publisher ───────────────────────── */

const VISIBILITY = new Set(["public", "private", "unlisted"]);

/** The YouTube implementation of the publishing seam, or null when this deployment is not configured for it. */
export function youtubePublisher(deps: EngineDeps): Publisher | null {
  const config = deps.config.youtube;
  if (!config) return null;
  const client = createYoutubeClient({ clientId: config.clientId, clientSecret: config.clientSecret, fetch: deps.fetch });
  const accessFor = async (credentials: string | null) => {
    let refreshToken: string;
    try {
      if (!credentials) throw new Error("missing");
      refreshToken = openSecret(config.encryptionKey, credentials);
    } catch {
      throw new ChannelGrantExpired(); // unreadable with the current key: only a reconnect can fix it
    }
    return (await client.refresh(refreshToken)).accessToken;
  };
  return {
    // YouTube holds a private video until `publishAt`, so the upload happens when the schedule is committed.
    schedulesNatively: true,
    async publish(input) {
      const visibility = VISIBILITY.has(input.payload.visibility) ? (input.payload.visibility as "public" | "private" | "unlisted") : "private";
      const accessToken = await accessFor(input.credentials);
      let media: Response;
      try {
        media = await deps.fetch(input.mediaUrl, { signal: AbortSignal.timeout(60_000) });
      } catch {
        throw new EngineError("provider_unavailable", "The approved video could not be read from storage. Nothing was posted.");
      }
      if (!media.ok) throw new EngineError("provider_unavailable", "The approved video could not be read from storage. Nothing was posted.");
      const bytes = new Uint8Array(await media.arrayBuffer());
      if (!bytes.byteLength || bytes.byteLength > MAX_UPLOAD_BYTES) throw new EngineError("validation_error", "The approved video is empty or too large to upload from here.");
      const title = (String(input.payload.title ?? "").trim() || input.itemTitle.trim() || "Untitled video").replace(/[<>]/g, "").slice(0, 100);
      const { videoId } = await client.upload(
        accessToken,
        {
          title,
          description: String(input.payload.caption ?? "").replace(/[<>]/g, "").slice(0, 5000),
          // A public post goes up private with a release time; YouTube publishes it. Other visibilities upload as asked.
          privacyStatus: visibility === "public" ? "private" : visibility,
          publishAt: visibility === "public" ? new Date(input.scheduledAt).toISOString() : null,
          containsSyntheticMedia: input.payload.aiDisclosure !== false,
        },
        { bytes, mime: input.mediaMime },
      );
      // Uploaded and (for public posts) scheduled at YouTube. Not "published": that needs YouTube to say so.
      return { providerPostId: videoId, state: "submitted", url: `https://youtu.be/${videoId}` };
    },
    async verify(input) {
      const status = await client.videoStatus(await accessFor(input.credentials), input.providerPostId);
      if (!status) return { state: "failed", publishedAt: null, note: "YouTube no longer has this video. It may have been deleted on the channel." };
      if (status.uploadStatus === "rejected" || status.uploadStatus === "failed" || status.uploadStatus === "deleted")
        return { state: "failed", publishedAt: null, note: `YouTube reports this upload as ${status.uploadStatus}${status.rejectionReason || status.failureReason ? ` (${status.rejectionReason ?? status.failureReason})` : ""}.` };
      const requested = VISIBILITY.has(input.visibility) ? input.visibility : "private";
      if (requested !== "public") {
        // Private and unlisted videos are never "published"; the honest end state is "uploaded as requested".
        return { state: "submitted", publishedAt: null, note: status.uploadStatus === "processed" ? null : "YouTube is still processing this video." };
      }
      if (status.uploadStatus === "processed" && status.privacyStatus === "public") {
        const scheduled = new Date(input.scheduledAt);
        return { state: "verified_published", publishedAt: (scheduled <= deps.now() ? scheduled : deps.now()).toISOString(), note: null };
      }
      if (new Date(input.scheduledAt) <= deps.now())
        return { state: "submitted", publishedAt: null, note: "The scheduled time has passed and YouTube still lists this video as private. YouTube keeps uploads from apps that have not passed its API audit private; open the video in YouTube Studio to publish it." };
      return { state: "submitted", publishedAt: null, note: null };
    },
  };
}
