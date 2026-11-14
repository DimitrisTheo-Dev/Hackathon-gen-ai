// Typed client for the Claude Code runner in apps/claude-runner.
export type RunnerAuth = { loggedIn: boolean; authMethod: string | null; email: string | null; subscriptionType: string | null; organization: string | null };
export type RunnerStatus = { runner: string; claudeVersion: string | null; auth: RunnerAuth; tokenStored: boolean; workspace: string; busy: boolean; loginPending: boolean };
export type Model = "fable" | "opus" | "sonnet" | "haiku";
export type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "plan";
export type RunInput = { prompt: string; sessionId?: string; model?: Model; permissionMode: PermissionMode };
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

export function createRunnerClient(baseUrl: string, accessKey: string, fetcher: typeof fetch = (...args) => fetch(...args)) {
  async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}${path}`, {
        method,
        signal,
        headers: { Authorization: `Bearer ${accessKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
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
    async run(input: RunInput, onEvent: (event: StreamEvent) => void, signal?: AbortSignal) {
      const response = await call<Response>("POST", "/v1/run", input, signal);
      if (!response.body) throw new RunnerError(0, "no_stream", "This browser can't read streamed responses.");
      await readNdjson(response.body, onEvent);
    },
  };
}
export type RunnerClient = ReturnType<typeof createRunnerClient>;
