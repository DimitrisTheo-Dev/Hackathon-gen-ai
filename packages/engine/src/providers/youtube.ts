import { EngineError } from "../errors.js";

/**
 * YouTube Data API v3 client: only the calls Faceful needs to connect one channel and upload one
 * approved video. Every request goes through the injected `fetch`, so tests never reach Google.
 *
 * What YouTube does and does not let this build claim:
 *   • An upload returns a video ID. That is "submitted", not "published".
 *   • A public post is uploaded PRIVATE with `publishAt`; YouTube itself releases it at that time.
 *   • Google keeps videos uploaded through API projects that have not passed its API audit locked to
 *     private. So a "public" post can be uploaded and scheduled and still stay private. We report the
 *     status YouTube returns and never call a video published without `privacyStatus: "public"`.
 *
 * Tokens are never logged and never placed in a URL: Google's token endpoints take form bodies.
 */
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
export const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
export const YOUTUBE_READ_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
/** Uploads are buffered so the exact Content-Length is known; this bounds memory in a function instance. */
export const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

/** The stored grant no longer works (revoked, expired, password changed). The channel must be reconnected. */
export class ChannelGrantExpired extends EngineError {
  constructor() {
    super("forbidden", "Reconnect YouTube; the approved post was not sent.");
    this.name = "ChannelGrantExpired";
  }
}
/** The upload request was sent and its result could not be determined. Never retried automatically. */
export class UnknownPublishOutcome extends Error {
  constructor() {
    super("The upload outcome is unknown");
    this.name = "UnknownPublishOutcome";
  }
}

export interface YoutubeVideoInput {
  title: string;
  description: string;
  privacyStatus: "public" | "private" | "unlisted";
  /** RFC 3339 instant. Only valid together with `privacyStatus: "private"`. */
  publishAt: string | null;
  containsSyntheticMedia: boolean;
}
export interface YoutubeVideoStatus {
  uploadStatus: string | null;
  privacyStatus: string | null;
  publishAt: string | null;
  rejectionReason: string | null;
  failureReason: string | null;
}

/** A resumable-upload session URL must be HTTPS on a googleapis.com host, with no embedded credentials. */
export function isGoogleUploadUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (url.hostname === "www.googleapis.com" || url.hostname.endsWith(".googleapis.com"));
  } catch {
    return false;
  }
}

function reasonOf(body: unknown): string | null {
  const error = (body as { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown; details?: Array<{ reason?: unknown }> } } | null)?.error;
  const reason = error?.errors?.[0]?.reason ?? error?.details?.find((detail) => typeof detail?.reason === "string")?.reason ?? error?.status;
  return typeof reason === "string" ? reason : null;
}

/** Maps a Data API failure to a studio error. Google's own message text is not forwarded: it can name accounts. */
export function youtubeApiError(status: number, body: unknown): EngineError {
  const reason = reasonOf(body);
  if (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED")
    return new EngineError("unsupported", "The YouTube Data API is not enabled for this Google project. Enable “YouTube Data API v3” in the Google Cloud console, then connect again.");
  if (reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "rateLimitExceeded" || reason === "userRateLimitExceeded" || status === 429)
    return new EngineError("quota_exceeded", "YouTube’s API quota for this Google project is used up for now. Nothing was posted; try again later.", { retryAfterSeconds: 3600 });
  if (reason === "uploadLimitExceeded") return new EngineError("quota_exceeded", "This YouTube channel has reached its upload limit. Nothing was posted.");
  if (reason === "youtubeSignupRequired") return new EngineError("validation_error", "This Google account has no YouTube channel. Create a channel in YouTube, then connect again.");
  if (reason === "insufficientPermissions" || reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT")
    return new EngineError("forbidden", "Google did not grant permission to upload to YouTube. Connect again and allow the YouTube access it asks for.");
  if (status === 401) return new EngineError("forbidden", "Google no longer accepts this channel’s access. Reconnect YouTube.");
  if (reason === "forbidden" || status === 403) return new EngineError("forbidden", "YouTube refused this request for the connected channel. Check that the account can upload videos.");
  if (reason === "invalidTitle" || reason === "invalidDescription" || reason === "invalidPublishAt" || reason === "invalidVideoMetadata" || status === 400)
    return new EngineError("validation_error", "YouTube did not accept this post’s title, description or scheduled time. Adjust it and prepare the schedule again.");
  if (status >= 500) return new EngineError("provider_unavailable", "YouTube is temporarily unavailable. Nothing was posted.");
  return new EngineError("provider_unavailable", `YouTube returned an unexpected response (${status}). Nothing was posted.`);
}

export function createYoutubeClient(options: { clientId: string; clientSecret: string; fetch: typeof fetch }) {
  async function send(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
    try {
      return await options.fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new EngineError("provider_unavailable", "Google could not be reached. Nothing was changed.");
    }
  }
  const form = (fields: Record<string, string>): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: new URLSearchParams(fields).toString() });
  const bearer = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, Accept: "application/json" });

  return {
    /** Who the access token was issued to and what it may do. Rejects tokens Google does not recognise. */
    async tokenInfo(accessToken: string): Promise<{ audience: string | null; authorizedParty: string | null; scopes: string[] }> {
      const response = await send(TOKENINFO_URL, form({ access_token: accessToken }));
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok || !body) throw new EngineError("validation_error", "Google did not recognise the channel access it was sent. Connect YouTube again.");
      return {
        audience: typeof body.aud === "string" ? body.aud : null,
        authorizedParty: typeof body.azp === "string" ? body.azp : null,
        scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [],
      };
    },
    /** Exchanges the stored grant for a short-lived access token. A grant issued to another OAuth client fails here. */
    async refresh(refreshToken: string): Promise<{ accessToken: string; scopes: string[] }> {
      const response = await send(TOKEN_URL, form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: options.clientId, client_secret: options.clientSecret }));
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (response.ok && body && typeof body.access_token === "string")
        return { accessToken: body.access_token, scopes: typeof body.scope === "string" ? body.scope.split(" ").filter(Boolean) : [] };
      const code = typeof body?.error === "string" ? body.error : null;
      if (code === "invalid_grant" || code === "unauthorized_client") throw new ChannelGrantExpired();
      if (code === "invalid_client") {
        console.error(JSON.stringify({ level: "error", event: "youtube_oauth_client_rejected" }));
        throw new EngineError("provider_unavailable", "Google rejected this deployment’s OAuth client settings. Nothing was posted.");
      }
      throw new EngineError("provider_unavailable", "Google could not refresh the channel’s access right now. Nothing was posted.");
    },
    /** The channel that uploads with this token would go to. Null when the Google account has no channel. */
    async myChannel(accessToken: string): Promise<{ id: string; title: string } | null> {
      const response = await send(`${API}/channels?part=snippet&mine=true`, { headers: bearer(accessToken) });
      const body = (await response.json().catch(() => null)) as { items?: Array<{ id?: unknown; snippet?: { title?: unknown } }> } | null;
      if (!response.ok) throw youtubeApiError(response.status, body);
      const channel = body?.items?.[0];
      if (!channel || typeof channel.id !== "string") return null;
      return { id: channel.id, title: typeof channel.snippet?.title === "string" && channel.snippet.title ? channel.snippet.title : "YouTube channel" };
    },
    /** Best effort: a failure to revoke never blocks disconnecting on our side. */
    async revoke(token: string): Promise<boolean> {
      try {
        return (await send(REVOKE_URL, form({ token }), 10_000)).ok;
      } catch {
        return false;
      }
    },
    /**
     * Resumable upload in two requests: open a session with the metadata, then send the bytes.
     * A failure before the bytes are sent is definite (nothing was created). After that, the session
     * is asked once what it received; if even that cannot be answered, the outcome is unknown.
     */
    async upload(accessToken: string, video: YoutubeVideoInput, media: { bytes: Uint8Array; mime: string }): Promise<{ videoId: string }> {
      const metadata = {
        snippet: { title: video.title, description: video.description, categoryId: "22" },
        status: {
          privacyStatus: video.privacyStatus,
          ...(video.publishAt ? { publishAt: video.publishAt } : {}),
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: video.containsSyntheticMedia,
        },
      };
      const session = await send(UPLOAD_URL, {
        method: "POST",
        headers: { ...bearer(accessToken), "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(media.bytes.byteLength), "X-Upload-Content-Type": media.mime },
        body: JSON.stringify(metadata),
      });
      if (!session.ok) throw youtubeApiError(session.status, await session.json().catch(() => null));
      const location = session.headers.get("location");
      // The video bytes go only to a Google upload host, never to wherever a response header points.
      if (!location || !isGoogleUploadUrl(location)) throw new EngineError("provider_unavailable", "YouTube did not open an upload session. Nothing was posted.");

      const idFrom = async (response: Response) => {
        const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
        return typeof body?.id === "string" ? body.id : null;
      };
      let sent: Response | null = null;
      try {
        sent = await options.fetch(location, { method: "PUT", headers: { "Content-Type": media.mime, "Content-Length": String(media.bytes.byteLength) }, body: media.bytes as BodyInit, signal: AbortSignal.timeout(100_000) });
      } catch {
        sent = null;
      }
      if (sent && (sent.status === 200 || sent.status === 201)) {
        const id = await idFrom(sent);
        if (id) return { videoId: id };
        throw new UnknownPublishOutcome();
      }
      // A 4xx on the upload itself is a definite refusal: the session is dead and no video exists.
      if (sent && sent.status >= 400 && sent.status < 500) throw youtubeApiError(sent.status, await sent.json().catch(() => null));
      // Interrupted or 5xx: ask the session what it has. 200/201 = it finished; 308 = it did not.
      let probe: Response;
      try {
        probe = await options.fetch(location, { method: "PUT", headers: { "Content-Range": `bytes */${media.bytes.byteLength}`, "Content-Length": "0" }, signal: AbortSignal.timeout(20_000) });
      } catch {
        throw new UnknownPublishOutcome();
      }
      if (probe.status === 200 || probe.status === 201) {
        const id = await idFrom(probe);
        if (id) return { videoId: id };
        throw new UnknownPublishOutcome();
      }
      if (probe.status === 308 || probe.status === 404) throw new EngineError("provider_unavailable", "The upload to YouTube was interrupted before it finished. Nothing was posted.");
      throw new UnknownPublishOutcome();
    },
    /** YouTube's current view of one uploaded video. Null when the video no longer exists on the channel. */
    async videoStatus(accessToken: string, videoId: string): Promise<YoutubeVideoStatus | null> {
      const response = await send(`${API}/videos?part=status,processingDetails&id=${encodeURIComponent(videoId)}`, { headers: bearer(accessToken) });
      const body = (await response.json().catch(() => null)) as { items?: Array<{ status?: Record<string, unknown> }> } | null;
      if (!response.ok) throw youtubeApiError(response.status, body);
      const status = body?.items?.[0]?.status;
      if (!status) return null;
      const text = (value: unknown) => (typeof value === "string" ? value : null);
      return { uploadStatus: text(status.uploadStatus), privacyStatus: text(status.privacyStatus), publishAt: text(status.publishAt), rejectionReason: text(status.rejectionReason), failureReason: text(status.failureReason) };
    },
  };
}
export type YoutubeClient = ReturnType<typeof createYoutubeClient>;
