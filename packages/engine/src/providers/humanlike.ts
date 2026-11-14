import { EngineError } from "../errors.js";

/**
 * Thin client for the Humanlike avatar API as documented at https://humanlike.co/docs/avatars
 * (checked 14 Nov 2026). The documented surface is REALTIME sessions over LiveKit:
 *   GET    /v1/avatar/avatars          → { default, data: [{ id, title, type, format, render_modes }] }
 *   POST   /v1/avatar/sessions         → starts a realtime avatar in a LiveKit room (201)
 *   DELETE /v1/avatar/sessions/{id}    → ends the session and stops billing
 * There is no documented script-to-file endpoint, job status, webhook or MP4 export. A playable
 * file therefore needs a recorder (LiveKit egress or equivalent) around a session; that recorder
 * runs in the render worker, not here. See INTEGRATION_CONTRACTS.md.
 */
export interface HumanlikeAvatar {
  id: string;
  title: string;
  type: string;
  renderModes: string[];
}
export interface HumanlikeSession {
  sessionId: string;
  raw: Record<string, unknown>;
}

const errorByCode: Record<string, { code: "provider_unavailable" | "quota_exceeded" | "validation_error" | "unsupported"; message: string }> = {
  invalid_api_key: { code: "provider_unavailable", message: "Humanlike rejected the API key. Replace HUMANLIKE_API_KEY with a current secret key." },
  missing_api_key: { code: "provider_unavailable", message: "Humanlike needs a secret API key (hk_live_…)." },
  publishable_key: { code: "provider_unavailable", message: "Humanlike needs a secret key; a publishable key was supplied." },
  missing_scope: { code: "provider_unavailable", message: "The Humanlike key lacks the “Start realtime avatars” scope." },
  insufficient_credits: { code: "quota_exceeded", message: "The Humanlike account has no credits left. Add credits before rendering." },
  rate_limited: { code: "quota_exceeded", message: "Humanlike is rate limiting this key. Try again shortly." },
  unknown_avatar: { code: "validation_error", message: "Humanlike does not recognise this avatar." },
  unknown_model: { code: "validation_error", message: "Humanlike does not recognise this model." },
  model_unavailable: { code: "unsupported", message: "This Humanlike model is not available yet." },
  model_not_live: { code: "unsupported", message: "This Humanlike model is not live yet." },
  render_unsupported: { code: "unsupported", message: "This avatar cannot be rendered as video; full-body avatars render in the browser only." },
};

export function normalizeHumanlikeError(status: number, body: unknown): EngineError {
  const code = typeof body === "object" && body !== null ? (body as { error?: { code?: unknown } }).error?.code : undefined;
  const known = typeof code === "string" ? errorByCode[code] : undefined;
  if (known) return new EngineError(known.code, known.message, { retryAfterSeconds: code === "rate_limited" ? 60 : null });
  return new EngineError("provider_unavailable", `Humanlike returned an unexpected response (${status}). No avatar work was started.`);
}

export function createHumanlikeClient(options: { apiKey: string; apiUrl: string; fetch: typeof fetch }) {
  async function call(method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<unknown> {
    let response: Response;
    try {
      response = await options.fetch(`${options.apiUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new EngineError("provider_unavailable", "Humanlike could not be reached. No avatar work was started.");
    }
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw normalizeHumanlikeError(response.status, payload);
    return payload;
  }
  return {
    async listAvatars(): Promise<{ defaultId: string | null; avatars: HumanlikeAvatar[] }> {
      const payload = (await call("GET", "/v1/avatar/avatars")) as { default?: unknown; data?: unknown };
      const avatars = Array.isArray(payload?.data)
        ? payload.data.flatMap((entry: any) =>
            typeof entry?.id === "string"
              ? [{ id: entry.id, title: typeof entry.title === "string" ? entry.title : entry.id, type: String(entry.type ?? ""), renderModes: Array.isArray(entry.render_modes) ? entry.render_modes.map(String) : [] }]
              : [],
          )
        : [];
      return { defaultId: typeof payload?.default === "string" ? payload.default : null, avatars };
    },
    /** `idempotencyKey` must be stable per render attempt: a repeat returns the same session, not a second avatar. */
    async startSession(input: { model: string; render: "client" | "video"; avatarId?: string; transport: Record<string, unknown> }, idempotencyKey: string): Promise<HumanlikeSession> {
      const payload = (await call("POST", "/v1/avatar/sessions", { model: input.model, render: input.render, transport: input.transport, ...(input.avatarId ? { avatar: { id: input.avatarId } } : {}) }, idempotencyKey)) as Record<string, unknown>;
      const sessionId = payload?.session_id ?? payload?.id;
      if (typeof sessionId !== "string") throw new EngineError("unknown_outcome", "Humanlike accepted the request but returned no session identifier. Check the Humanlike dashboard before retrying.");
      return { sessionId, raw: payload };
    },
    async endSession(sessionId: string): Promise<void> {
      await call("DELETE", `/v1/avatar/sessions/${encodeURIComponent(sessionId)}`);
    },
  };
}
