// Starts a Claude Code routine over its API trigger.
// Docs: https://platform.claude.com/docs/en/api/claude-code/routines-fire
// The token is scoped to one routine and can only start it: no reading and no Claude use.
import { MAX_FIRE_TEXT_CHARS } from "./commands";

export const FIRE_ORIGIN = "https://api.anthropic.com";
export const API_VERSION = "2023-06-01";
export const ROUTINE_BETA = "experimental-cc-routine-2026-04-01";
const FIRE_PATH = /^\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{8,64})\/fire$/;
const TRIGGER_ID = /^trig_[A-Za-z0-9]{8,64}$/;

export type FireResult = { sessionId: string; sessionUrl: string };

export class RoutineError extends Error {
  status: number;
  code: string;
  retryAfterSeconds: number | null;
  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export const isRoutineToken = (token: string) => /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token);
const redact = (text: string) => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-…");

/** Accepts the Fire URL from the routine's API trigger, or just its trig_ id. Only Anthropic's endpoint passes, so the token never goes anywhere else. */
export function normalizeFireUrl(input: string): string {
  const value = input.trim();
  if (TRIGGER_ID.test(value)) return `${FIRE_ORIGIN}/v1/claude_code/routines/${value}/fire`;
  let url: URL;
  try { url = new URL(value); } catch { throw new RoutineError(0, "invalid_fire_url", "Paste the routine's Fire URL, like https://api.anthropic.com/v1/claude_code/routines/trig_…/fire."); }
  const path = url.pathname.replace(/\/+$/, "");
  if (url.origin !== FIRE_ORIGIN || url.username || url.password || url.search || url.hash || !FIRE_PATH.test(path)) {
    throw new RoutineError(0, "invalid_fire_url", "That isn't a routine Fire URL. It looks like https://api.anthropic.com/v1/claude_code/routines/trig_…/fire.");
  }
  return `${FIRE_ORIGIN}${path}`;
}

function minutes(seconds: number) {
  const value = Math.max(1, Math.ceil(seconds / 60));
  return `${value} minute${value === 1 ? "" : "s"}`;
}

/**
 * Starts one run. Never retried here: the endpoint has no idempotency key, so every retry
 * would start another session.
 */
export async function fireRoutine(options: { fireUrl: string; token: string; text?: string; fetch?: typeof fetch; timeoutMs?: number }): Promise<FireResult> {
  const url = normalizeFireUrl(options.fireUrl);
  const token = options.token.trim();
  if (!isRoutineToken(token)) throw new RoutineError(0, "invalid_token", "That isn't a routine token. Generate one in the routine's API trigger at claude.ai/code/routines; it starts with sk-ant-oat01-.");
  if (options.text !== undefined && options.text.length > MAX_FIRE_TEXT_CHARS) throw new RoutineError(0, "text_too_long", `A fire can carry at most ${MAX_FIRE_TEXT_CHARS} characters.`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-version": API_VERSION,
        "anthropic-beta": ROUTINE_BETA,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options.text === undefined ? {} : { text: options.text }),
      redirect: "manual", // a redirect would carry the token somewhere else
      signal: controller.signal,
    });
  } catch {
    throw controller.signal.aborted
      ? new RoutineError(0, "timeout", "Anthropic didn't answer within 30 seconds. Check the routine's runs at claude.ai/code/routines before firing again; it may have started.")
      : new RoutineError(0, "unreachable", "Couldn't reach api.anthropic.com. Check the internet connection and try again.");
  } finally { clearTimeout(timer); }

  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = (body?.error ?? {}) as { type?: unknown; message?: unknown };
    const detail = typeof error.message === "string" ? redact(error.message).slice(0, 300) : "";
    const retryAfter = Number(response.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    const code = typeof error.type === "string" ? error.type : `http_${response.status}`;
    const message =
      response.status === 401 ? "The token doesn't match this routine. It may have been regenerated or deleted; generate a new one in the routine's API trigger."
      : response.status === 403 ? "This Claude account can't start routines over the API."
      : response.status === 404 ? "No routine at that URL. Copy the Fire URL from the routine's API trigger again."
      : response.status === 429 ? `The routine has reached its hourly limit (30 starts per routine, 100 per account).${wait ? ` Try again in ${minutes(wait)}.` : ""}`
      : response.status === 400 ? `Anthropic refused the request${detail ? `: ${detail}` : "."}${/paused/i.test(detail) ? " Resume the routine at claude.ai/code/routines." : ""}`
      : `Anthropic's routine service answered ${response.status}${detail ? `: ${detail}` : "."} Nothing is retried automatically, because each retry would start another session.`;
    throw new RoutineError(response.status, code, message, wait);
  }

  const sessionId = body?.claude_code_session_id;
  const sessionUrl = body?.claude_code_session_url;
  if (body?.type !== "routine_fire" || typeof sessionId !== "string" || typeof sessionUrl !== "string" || !sessionUrl.startsWith("https://claude.ai/")) {
    throw new RoutineError(response.status, "unexpected_response", "The routine started, but Anthropic's answer had no session link. Check its runs at claude.ai/code/routines.");
  }
  return { sessionId, sessionUrl };
}
