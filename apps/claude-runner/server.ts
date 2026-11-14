// Claude Code runner: a small HTTP service that runs the official Claude Code CLI
// on your own server (VPS), signed in with your own Claude subscription.
// Zero dependencies; Node 24 runs this file directly (type stripping).
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { spawn, execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_VERSION = "1";
export const MODELS = ["fable", "opus", "sonnet", "haiku"] as const;
export const PERMISSION_MODES = ["acceptEdits", "auto", "bypassPermissions", "plan"] as const;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_PROMPT_CHARS = 100_000;

export type RunnerConfig = {
  port: number;
  host: string;
  accessKey: string;
  allowedOrigins: string[];
  claudeBin: string;
  homeDir: string;
  workspaceDir: string;
  dataDir: string;
  maxRunMinutes: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const accessKey = env.RUNNER_ACCESS_KEY ?? "";
  if (accessKey.length < 32) throw new Error("RUNNER_ACCESS_KEY must be at least 32 characters. Generate one with: openssl rand -hex 32");
  const home = resolve(env.HOME ?? homedir());
  return {
    port: Number(env.PORT ?? 8787),
    host: env.HOST ?? "127.0.0.1",
    accessKey,
    allowedOrigins: (env.RUNNER_ALLOWED_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173").split(",").map((origin) => origin.trim().replace(/\/$/, "")).filter(Boolean),
    claudeBin: env.CLAUDE_BIN ?? "claude",
    homeDir: home,
    workspaceDir: resolve(env.WORKSPACE_DIR ?? join(home, "work")),
    dataDir: resolve(env.RUNNER_DATA_DIR ?? join(home, ".claude-runner")),
    maxRunMinutes: Number(env.RUNNER_MAX_RUN_MINUTES ?? 30),
  };
}

// ---------- pure helpers (exported for tests) ----------

const digest = (value: string) => createHash("sha256").update(value).digest();
export function keyMatches(expected: string, authorization: string | undefined): boolean {
  const match = /^Bearer\s+(\S+)$/i.exec(authorization ?? "");
  if (!match || !expected) return false;
  return timingSafeEqual(digest(expected), digest(match[1]));
}

export function corsHeaders(origin: string | undefined, allowed: string[]): Record<string, string> | null {
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, content-type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

// The CLI prints the sign-in link plainly when piped, or wrapped in OSC 8 hyperlink codes in a terminal.
export function extractLoginUrl(output: string): string | null {
  const clean = output.replace(/\u001b\]8;;[^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  const match = /https:\/\/[^\s\u0007\u001b]*\/oauth\/authorize\?[^\s\u0007\u001b]+/.exec(clean);
  return match ? match[0] : null;
}

export const isSubscriptionToken = (token: string) => /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token);
export const isLoginCode = (code: string) => /^[\x21-\x7e]{8,2048}$/.test(code);
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export type RunRequest = { prompt: string; sessionId?: string; model?: (typeof MODELS)[number]; permissionMode: (typeof PERMISSION_MODES)[number] };
export function parseRunRequest(body: unknown): RunRequest {
  if (!body || typeof body !== "object") throw new RequestError(400, "invalid_body", "Send a JSON object.");
  const { prompt, sessionId, model, permissionMode } = body as Record<string, unknown>;
  if (typeof prompt !== "string" || !prompt.trim()) throw new RequestError(400, "invalid_prompt", "Write a prompt first.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new RequestError(400, "invalid_prompt", `Prompts are limited to ${MAX_PROMPT_CHARS} characters.`);
  if (sessionId !== undefined && (typeof sessionId !== "string" || !isUuid(sessionId))) throw new RequestError(400, "invalid_session", "That session id is not valid.");
  if (model !== undefined && !MODELS.includes(model as never)) throw new RequestError(400, "invalid_model", `Model must be one of: ${MODELS.join(", ")}.`);
  const mode = permissionMode ?? "acceptEdits";
  if (!PERMISSION_MODES.includes(mode as never)) throw new RequestError(400, "invalid_permission_mode", `Permission mode must be one of: ${PERMISSION_MODES.join(", ")}.`);
  return { prompt, sessionId: sessionId as string | undefined, model: model as RunRequest["model"], permissionMode: mode as RunRequest["permissionMode"] };
}

// The prompt goes in on stdin, never as an argument, so it can't be read as a flag.
export function buildRunArgs(request: RunRequest): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--permission-mode", request.permissionMode,
    "--permission-prompts", "none",
    ...(request.sessionId ? ["--resume", request.sessionId] : []),
    ...(request.model ? ["--model", request.model] : []),
  ];
}

export type AuthSummary = { loggedIn: boolean; authMethod: string | null; email: string | null; subscriptionType: string | null; organization: string | null };
export function summarizeAuth(raw: unknown): AuthSummary {
  const value = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (...keys: string[]) => {
    for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string;
    return null;
  };
  return {
    loggedIn: value.loggedIn === true,
    authMethod: text("authMethod"),
    email: text("email", "emailAddress", "accountEmail"),
    subscriptionType: text("subscriptionType", "subscription", "plan"),
    organization: text("orgName", "organizationName", "organization"),
  };
}

export class RequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------- server ----------

type Exec = { code: number | null; stdout: string; stderr: string };

export function createRunner(config: RunnerConfig): Server {
  const tokenFile = join(config.dataDir, "oauth-token");
  let run: ChildProcessWithoutNullStreams | null = null;
  let login: { child: ChildProcessWithoutNullStreams; output: string; url: string | null; timer: NodeJS.Timeout } | null = null;

  async function storedToken(): Promise<string | null> {
    try { return (await readFile(tokenFile, "utf8")).trim() || null; } catch { return null; }
  }
  async function childEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: config.homeDir, DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" };
    delete env.RUNNER_ACCESS_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY; // always use the subscription, never API billing
    const token = await storedToken();
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return env;
  }
  async function exec(args: string[], timeoutMs = 20_000): Promise<Exec> {
    const env = await childEnv();
    return new Promise((done) => {
      execFile(config.claudeBin, args, { env, cwd: config.workspaceDir, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : null) : 0;
        done({ code, stdout: String(stdout), stderr: String(stderr) });
      });
    });
  }
  async function authStatus(): Promise<AuthSummary> {
    const result = await exec(["auth", "status", "--json"]);
    try { return summarizeAuth(JSON.parse(result.stdout)); } catch { return summarizeAuth(null); }
  }
  async function status() {
    const version = await exec(["--version"]);
    return {
      runner: RUNNER_VERSION,
      claudeVersion: version.code === 0 ? version.stdout.trim().replace(/\s*\(Claude Code\)$/, "") : null,
      auth: await authStatus(),
      tokenStored: (await storedToken()) !== null,
      workspace: config.workspaceDir,
      busy: run !== null,
      loginPending: login !== null,
    };
  }
  function endLogin() {
    if (!login) return;
    clearTimeout(login.timer);
    if (login.child.exitCode === null) login.child.kill("SIGTERM");
    login = null;
  }

  async function startLogin(): Promise<{ url: string }> {
    endLogin();
    const child = spawn(config.claudeBin, ["auth", "login", "--claudeai"], { env: { ...(await childEnv()), BROWSER: "true" }, cwd: config.workspaceDir, stdio: "pipe" });
    const session = { child, output: "", url: null as string | null, timer: setTimeout(() => { if (login?.child === child) endLogin(); }, 10 * 60_000) };
    login = session;
    const collect = (chunk: Buffer) => { session.output = (session.output + chunk.toString("utf8")).slice(-16_000); session.url ??= extractLoginUrl(session.output); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", () => { if (login?.child === child && !session.url) endLogin(); });
    const url = await new Promise<string | null>((done) => {
      const started = Date.now();
      const tick = setInterval(() => {
        if (session.url || child.exitCode !== null || Date.now() - started > 20_000) { clearInterval(tick); done(session.url); }
      }, 100);
    });
    if (!url) { endLogin(); throw new RequestError(502, "login_unavailable", "Claude Code did not return a sign-in link. Check the server's internet access and try again."); }
    return { url };
  }

  async function finishLogin(code: string): Promise<AuthSummary> {
    const session = login;
    if (!session) throw new RequestError(409, "login_not_started", "Start sign-in again; the previous attempt expired.");
    if (!isLoginCode(code)) throw new RequestError(400, "invalid_code", "Paste the full code from the Claude page.");
    const before = session.output.length;
    session.child.stdin.write(`${code}\n`);
    // Settles when the CLI exits, reports an error, asks for the code again, or 45 s pass.
    const outcome = await new Promise<"exited" | "rejected" | "timeout">((done) => {
      const started = Date.now();
      const tick = setInterval(() => {
        const settled = session.child.exitCode !== null || session.child.signalCode !== null ? "exited" : /error|invalid|failed|expired|Paste code/i.test(session.output.slice(before)) ? "rejected" : Date.now() - started > 45_000 ? "timeout" : null;
        if (settled) { clearInterval(tick); done(settled); }
      }, 200);
    });
    endLogin();
    const auth = await authStatus();
    if (!auth.loggedIn) throw new RequestError(400, "login_failed", outcome === "timeout" ? "Sign-in timed out. Start again and paste the newest code." : "Claude didn't accept that code. Start sign-in again and paste the newest code.");
    await rm(tokenFile, { force: true }); // the signed-in account replaces any pasted token
    return authStatus();
  }

  async function saveToken(token: string): Promise<AuthSummary> {
    if (!isSubscriptionToken(token)) throw new RequestError(400, "invalid_token", "That isn't a Claude Code token. Run `claude setup-token` and paste the sk-ant-oat01-… value it prints.");
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    return authStatus();
  }

  async function signOut(): Promise<AuthSummary> {
    endLogin();
    await rm(tokenFile, { force: true });
    await exec(["auth", "logout"]);
    return authStatus();
  }

  async function startRun(request: RunRequest, res: ServerResponse, headers: Record<string, string>) {
    if (run) throw new RequestError(409, "busy", "Claude Code is already working. Stop the current run first.");
    const child = spawn(config.claudeBin, buildRunArgs(request), { env: await childEnv(), cwd: config.workspaceDir, stdio: "pipe" });
    run = child;
    res.writeHead(200, { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const send = (value: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(value)}\n`); };
    send({ type: "runner", event: "started", workspace: config.workspaceDir });
    let buffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try { send(JSON.parse(line)); } catch { send({ type: "runner", event: "log", text: line.slice(0, 2000) }); }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000); });
    const limit = setTimeout(() => { if (child.exitCode === null) child.kill("SIGTERM"); }, config.maxRunMinutes * 60_000);
    child.on("error", (error) => send({ type: "runner", event: "error", message: `Couldn't start Claude Code: ${error.message}` }));
    child.on("close", (code, signal) => {
      clearTimeout(limit);
      if (run === child) run = null;
      send({ type: "runner", event: "exit", code, signal, stderr: code === 0 ? "" : stderr.trim() });
      res.end();
    });
    // Stop Claude when the page goes away mid-run.
    res.on("close", () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
    child.stdin.end(request.prompt);
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY_BYTES) throw new RequestError(413, "body_too_large", "Request is too large.");
      chunks.push(chunk as Buffer);
    }
    if (!chunks.length) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new RequestError(400, "invalid_json", "Request body must be JSON."); }
  }

  return createServer(async (req, res) => {
    const cors = corsHeaders(req.headers.origin, config.allowedOrigins) ?? {};
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { ...cors, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url ?? "/", "http://runner").pathname;
    try {
      if (req.method === "OPTIONS") {
        res.writeHead(req.headers.origin && !Object.keys(cors).length ? 403 : 204, cors);
        return res.end();
      }
      if (path === "/health" && req.method === "GET") return json(200, { ok: true, runner: RUNNER_VERSION });
      if (!path.startsWith("/v1/")) throw new RequestError(404, "not_found", "Unknown endpoint.");
      if (req.headers.origin && !Object.keys(cors).length) throw new RequestError(403, "origin_not_allowed", `This runner doesn't accept requests from ${req.headers.origin}. Add it to RUNNER_ALLOWED_ORIGINS.`);
      if (!keyMatches(config.accessKey, req.headers.authorization)) throw new RequestError(401, "unauthorized", "The access key is wrong or missing.");

      const route = `${req.method} ${path}`;
      if (route === "GET /v1/status") return json(200, await status());
      if (route === "POST /v1/login/start") return json(200, await startLogin());
      if (route === "POST /v1/login/finish") {
        const { code } = (await readJson(req)) as { code?: unknown };
        return json(200, { auth: await finishLogin(typeof code === "string" ? code.trim() : "") });
      }
      if (route === "POST /v1/login/cancel") { endLogin(); return json(200, { ok: true }); }
      if (route === "POST /v1/token") {
        const { token } = (await readJson(req)) as { token?: unknown };
        return json(200, { auth: await saveToken(typeof token === "string" ? token.trim() : "") });
      }
      if (route === "DELETE /v1/auth") return json(200, { auth: await signOut() });
      if (route === "POST /v1/run") return await startRun(parseRunRequest(await readJson(req)), res, cors);
      if (route === "POST /v1/run/stop") {
        const stopped = run !== null;
        run?.kill("SIGTERM");
        return json(200, { stopped });
      }
      throw new RequestError(404, "not_found", "Unknown endpoint.");
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      if (error instanceof RequestError) return json(error.status, { error: { code: error.code, message: error.message } });
      console.error("[runner] unexpected error", error);
      return json(500, { error: { code: "internal", message: "The runner hit an unexpected error. Check its logs." } });
    }
  });
}

async function main() {
  const config = loadConfig();
  await mkdir(config.workspaceDir, { recursive: true });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  createRunner(config).listen(config.port, config.host, () => {
    console.log(`[runner] Claude Code runner listening on http://${config.host}:${config.port}`);
    console.log(`[runner] workspace ${config.workspaceDir}; allowed origins ${config.allowedOrigins.join(", ")}`);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[runner] ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
