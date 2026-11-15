// Typed client for the Claude Code runner in apps/claude-runner.
export type RunnerAuth = { loggedIn: boolean; authMethod: string | null; email: string | null; subscriptionType: string | null; organization: string | null };
export type RunnerStatus = { runner: string; claudeVersion: string | null; auth: RunnerAuth; tokenStored: boolean; workspace: string; store?: boolean; busy: boolean; loginPending: boolean };
export type WorkspaceSave = { key: string; bytes: number; savedAt: string; files: number | null };
export type Workspace = { configured: boolean; project: string; autosave: WorkspaceSave | null; saves: WorkspaceSave[] };
/** Present only when the address is a Faceful machines gateway (apps/machines), not a plain runner. */
export type Machine = { gateway: true; user: string; identity: "token" | "session"; instanceType: string; sleepAfterMinutes: number; live: string; running?: boolean; machine: { starts: number; last_started_at: string | null; last_stopped_at: string | null } | null };
export type Project = { id: string; title: string; session_id: string | null; runs: number; last_run_at: string | null; last_saved_at: string | null; autosave_bytes: number | null; autosave_files: number | null };
export type Model = "fable" | "opus" | "sonnet" | "haiku";
export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "plan";
export type RunInput = { prompt: string; project?: string; sessionId?: string; model?: Model; permissionMode: PermissionMode };
export type StreamEvent = Record<string, unknown> & { type: string };

export class RunnerError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const local = /^(localhost|127\.0\.0\.1|\[::1\])$/;
/** Accepts https:// anywhere, http:// only for this computer. */
export function normalizeRunnerUrl(input: string): string {
  const value = input.trim();
  let url: URL;
  try { url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`); } catch { throw new RunnerError(0, "invalid_url", "Enter the runner address, like https://claude.yourdomain.com."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local.test(url.hostname))) throw new RunnerError(0, "insecure_url", "Use https:// for a server. Plain http:// only works for this computer.");
  if (url.username || url.password || url.search || url.hash) throw new RunnerError(0, "invalid_url", "Enter just the runner address, without credentials or query text.");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const loginState = (loginUrl: string) => { try { return new URL(loginUrl).searchParams.get("state"); } catch { return null; } };
/**
 * Claude's code page shows `<code>#<state>`. False only when the state part names another sign-in than `loginUrl`,
 * such as a code copied from an earlier attempt, so the page can say so before the machine is asked.
 */
export function codeFitsLogin(code: string, loginUrl: string): boolean {
  const hash = code.lastIndexOf("#");
  const state = loginState(loginUrl);
  return hash < 0 || !state || code.slice(hash + 1) === state;
}
/** A code from Claude's page for exactly this sign-in. Only such text is taken from the clipboard without a paste. */
export function isCodeForLogin(text: string, loginUrl: string): boolean {
  const value = text.trim();
  const hash = value.lastIndexOf("#");
  return hash >= 8 && value.length <= 2048 && /^[\x21-\x7e]+$/.test(value) && loginState(loginUrl) === value.slice(hash + 1);
}

/** Splits a streamed NDJSON body into parsed objects, tolerating chunk boundaries. */
export async function readNdjson(body: ReadableStream<Uint8Array>, onValue: (value: StreamEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const flush = (line: string) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line) as StreamEvent;
      if (value && typeof value === "object" && typeof value.type === "string") onValue(value);
    } catch { /* ignore partial or foreign lines */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      flush(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  flush(buffer + decoder.decode());
}

/**
 * The machines gateway runs on another provider, so the page never sends it the Faceful session: the engine trades
 * the session for a ten-minute token that only the gateway accepts (POST /v1/studio/machines/token). A token is kept
 * for the session it came from until a minute before it expires; concurrent calls share one request.
 */
export function createMachineTokenSource(engineUrl: string, session: () => Promise<string | null>, fetcher: typeof fetch = (...args) => fetch(...args), now = () => Date.now()) {
  let kept: { session: string; token: string; expiresAt: number } | null = null;
  let pending: Promise<string> | null = null;
  async function mint(access: string): Promise<string> {
    let response: Response;
    try {
      response = await fetcher(`${engineUrl.replace(/\/+$/, "")}/v1/studio/machines/token`, { method: "POST", headers: { Authorization: `Bearer ${access}` }, credentials: "omit", cache: "no-store", redirect: "error" });
    } catch {
      throw new RunnerError(0, "unreachable", "Couldn't reach Faceful to open your machine. Check the connection and try again.");
    }
    const body = (await response.json().catch(() => null)) as { token?: unknown; expiresAt?: unknown; error?: { code?: string; message?: string } } | null;
    if (!response.ok || typeof body?.token !== "string" || typeof body.expiresAt !== "string") throw new RunnerError(response.status, body?.error?.code ?? "http_error", body?.error?.message ?? `Faceful answered ${response.status}.`);
    kept = { session: access, token: body.token, expiresAt: Date.parse(body.expiresAt) };
    return body.token;
  }
  return async (): Promise<string> => {
    const access = await session();
    if (!access) throw new RunnerError(401, "unauthenticated", "Sign in to Faceful again to reach your machine.");
    if (kept?.session === access && kept.expiresAt - now() > 60_000) return kept.token;
    pending ??= mint(access).finally(() => { pending = null; });
    return pending;
  };
}

/** `accessKey` is a fixed key, or a function for credentials that expire (a machines token from the engine). */
export function createRunnerClient(baseUrl: string, accessKey: string | (() => Promise<string>), fetcher: typeof fetch = (...args) => fetch(...args)) {
  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    // Outside the try below: a refusal from Faceful (403, 401) reaches the page as itself, not as "couldn't reach".
    const key = typeof accessKey === "string" ? accessKey : await accessKey();
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method,
        signal,
        headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      throw new RunnerError(0, "unreachable", "Couldn't reach the runner. Check the address, that it's running, and that this page's origin is in RUNNER_ALLOWED_ORIGINS.");
    }
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      throw new RunnerError(response.status, problem?.error?.code ?? "http_error", problem?.error?.message ?? `The runner answered ${response.status}.`);
    }
    return response as unknown as T;
  }
  const json = async <T>(method: string, path: string, body?: unknown) => (await call<Response>(method, path, body)).json() as Promise<T>;
  return {
    status: () => json<RunnerStatus>("GET", "/v1/status"),
    startLogin: () => json<{ url: string }>("POST", "/v1/login/start"),
    finishLogin: (code: string) => json<{ auth: RunnerAuth }>("POST", "/v1/login/finish", { code }),
    cancelLogin: () => json<{ ok: true }>("POST", "/v1/login/cancel"),
    saveToken: (token: string) => json<{ auth: RunnerAuth }>("POST", "/v1/token", { token }),
    signOut: () => json<{ auth: RunnerAuth }>("DELETE", "/v1/auth"),
    stop: () => json<{ stopped: boolean }>("POST", "/v1/run/stop"),
    workspace: (project: string) => json<Workspace>("GET", `/v1/workspace?project=${encodeURIComponent(project)}`),
    /** Null when the address is a plain runner. Never wakes a sleeping machine. */
    machine: async (): Promise<Machine | null> => {
      try { return await json<Machine>("GET", "/v1/machine"); }
      catch (error) { if (error instanceof RunnerError && error.status === 404) return null; throw error; }
    },
    sleepMachine: () => json<{ stopped: boolean }>("POST", "/v1/machine/sleep"),
    projects: () => json<{ projects: Project[] }>("GET", "/v1/projects"),
    createProject: (title: string) => json<{ project: Project }>("POST", "/v1/projects", { title }),
    saveWorkspace: (project: string) => json<{ save: WorkspaceSave }>("POST", "/v1/workspace/save", { project }),
    restoreWorkspace: (project: string, key: string) => json<{ restored: { key: string; restoredAt: string } }>("POST", "/v1/workspace/restore", { project, key }),
    async run(input: RunInput, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) {
      const response = await call<Response>("POST", "/v1/run", input, signal);
      if (!response.body) throw new RunnerError(0, "no_stream", "This browser can't read streamed responses.");
      await readNdjson(response.body, onEvent);
    },
  };
}
export type RunnerClient = ReturnType<typeof createRunnerClient>;
