// Claude Code runner: a small HTTP service that runs the official Claude Code CLI
// on your own server or a per-user cloud machine, signed in with your own Claude subscription.
// With a workspace store it autosaves each project after every run and survives a fresh disk.
// Zero dependencies; Node 24 runs this file directly (type stripping).
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { spawn, execFile } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const RUNNER_VERSION = "2";
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
  /** Workspace store (apps/workspace-store): saves land in this user's own R2 folder. */
  storeUrl: string | null;
  storeToken: string | null;
  /** 32 bytes that seal Claude's saved sign-in before it is uploaded (CLAUDE_HOME_KEY). Null: saved as is. */
  homeKey: Buffer | null;
};

function homeKeyFrom(value: string | undefined): Buffer | null {
  if (!value?.trim()) return null;
  const key = Buffer.from(value.trim(), "base64url"); // also reads standard base64, as `openssl rand -base64 32` prints
  if (key.length !== 32) throw new Error("CLAUDE_HOME_KEY must be 32 random bytes in base64. Generate one with: openssl rand -base64 32");
  return key;
}

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
    storeUrl: env.STORE_URL ? env.STORE_URL.replace(/\/+$/, "") : null,
    storeToken: env.STORE_TOKEN || null,
    homeKey: homeKeyFrom(env.CLAUDE_HOME_KEY),
  };
}

export const isProjectName = (value: string) => /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value);
export const saveKeyFor = (project: string, savedAt: Date) => `projects/${project}/saves/${savedAt.toISOString().replace(/[:.]/g, "-")}.tar.gz`;
export const autosaveKeyFor = (project: string) => `projects/${project}/autosave.tar.gz`;
/** Claude's sign-in, settings and session history: what a fresh disk needs to carry on. */
export const HOME_KEY = "private/claude-home.tar.gz";
const HOME_EXCLUDES = ["downloads", "shell-snapshots", "statsig", "telemetry", "cache", "ide"].map((name) => `--exclude=.claude/${name}`);
const WORKSPACE_EXCLUDES = ["--exclude=node_modules", "--exclude=.cache"];
const MAX_SAVE_BYTES = 95 * 1024 * 1024;
const isSaveKey = (project: string, key: string) => new RegExp(`^projects/${project}/saves/[0-9TZ-]+\\.tar\\.gz$`).test(key);

// ---------- pure helpers (exported for tests) ----------

/**
 * Claude's saved sign-in, sealed: "FCH1" | 12-byte IV | 16-byte GCM tag | AES-256-GCM(archive). The key is the user's
 * own and only the runner holds it, so the store, its logs and a leaked store token see ciphertext, and an archive
 * anyone else wrote (or changed) is refused instead of being unpacked into Claude's home.
 */
const SEALED = Buffer.from("FCH1");
export function sealHome(key: Buffer, archive: Buffer): Buffer<ArrayBuffer> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(SEALED);
  const body = Buffer.concat([cipher.update(archive), cipher.final()]);
  return Buffer.concat([SEALED, iv, cipher.getAuthTag(), body]);
}
export function openHome(key: Buffer, sealed: Buffer): Buffer | null {
  if (sealed.length < 32 || !sealed.subarray(0, 4).equals(SEALED)) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(4, 16));
    decipher.setAAD(SEALED);
    decipher.setAuthTag(sealed.subarray(16, 32));
    return Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]);
  } catch { return null; }
}

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
  // Terminal output: strip OSC 8 hyperlinks and ANSI escapes, which are control characters by design.
  // oxlint-disable-next-line no-control-regex
  const clean = output.replace(/\u001b\]8;;[^\u0007]*\u0007/g, "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
  // oxlint-disable-next-line no-control-regex
  const match = /https:\/\/[^\s\u0007\u001b]*\/oauth\/authorize\?[^\s\u0007\u001b]+/.exec(clean);
  return match ? match[0] : null;
}

export const isSubscriptionToken = (token: string) => /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/.test(token);
export const isLoginCode = (code: string) => /^[\x21-\x7e]{8,2048}$/.test(code);
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export type RunRequest = { prompt: string; project: string; sessionId?: string; model?: (typeof MODELS)[number]; permissionMode: (typeof PERMISSION_MODES)[number] };
export function parseRunRequest(body: unknown): RunRequest {
  if (!body || typeof body !== "object") throw new RequestError(400, "invalid_body", "Send a JSON object.");
  const { prompt, project, sessionId, model, permissionMode } = body as Record<string, unknown>;
  if (typeof prompt !== "string" || !prompt.trim()) throw new RequestError(400, "invalid_prompt", "Write a prompt first.");
  if (prompt.length > MAX_PROMPT_CHARS) throw new RequestError(400, "invalid_prompt", `Prompts are limited to ${MAX_PROMPT_CHARS} characters.`);
  const name = project === undefined || project === null || project === "" ? "default" : project;
  if (typeof name !== "string" || !isProjectName(name)) throw new RequestError(400, "invalid_project", "Project names use letters, digits and dashes (up to 64).");
  if (sessionId !== undefined && (typeof sessionId !== "string" || !isUuid(sessionId))) throw new RequestError(400, "invalid_session", "That session id is not valid.");
  if (model !== undefined && !MODELS.includes(model as never)) throw new RequestError(400, "invalid_model", `Model must be one of: ${MODELS.join(", ")}.`);
  const mode = permissionMode ?? "acceptEdits";
  if (!PERMISSION_MODES.includes(mode as never)) throw new RequestError(400, "invalid_permission_mode", `Permission mode must be one of: ${PERMISSION_MODES.join(", ")}.`);
  return { prompt, project: name, sessionId: sessionId as string | undefined, model: model as RunRequest["model"], permissionMode: mode as RunRequest["permissionMode"] };
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

// ---------- cloud sync (module level so boot and the server share it) ----------

export type SaveInfo = { key: string; project: string; kind: "auto" | "manual"; bytes: number; files: number; sha256: string; savedAt: string };
const hasStore = (config: RunnerConfig) => Boolean(config.storeUrl && config.storeToken);
const exists = (path: string) => stat(path).then(() => true, () => false);

function tar(args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile("tar", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? fail(new RequestError(500, "archive_failed", `Couldn't pack or unpack files: ${String(stderr).trim().slice(0, 300) || error.message}`)) : done(String(stdout)));
  });
}
async function pack(dir: string, entries: string[], excludes: string[]) {
  const scratch = await mkdtemp(join(tmpdir(), "runner-pack-"));
  const file = join(scratch, "archive.tar.gz");
  try {
    await tar(["-czf", file, ...excludes, "-C", dir, ...entries]);
    const files = (await tar(["-tzf", file])).split("\n").filter((line) => line && !line.endsWith("/")).length;
    const body = await readFile(file);
    if (body.length > MAX_SAVE_BYTES) throw new RequestError(413, "save_too_large", "This is larger than 95 MB compressed. Remove build output or large files, then save again.");
    return { body, files, sha256: createHash("sha256").update(body).digest("hex") };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
async function unpack(body: Buffer, dir: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), "runner-unpack-"));
  const file = join(scratch, "archive.tar.gz");
  try {
    await writeFile(file, body, { mode: 0o600 });
    await mkdir(dir, { recursive: true });
    await tar(["-xzf", file, "-C", dir]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
/** Calls the workspace store. A missing object resolves to null; other failures throw. */
async function storeFetch(config: RunnerConfig, path: string, init: RequestInit = {}): Promise<Response | null> {
  if (!hasStore(config)) throw new RequestError(409, "store_not_configured", "Cloud saving isn't set up on this runner. Add STORE_URL and STORE_TOKEN to its .env.");
  let response: Response;
  try { response = await fetch(`${config.storeUrl}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${config.storeToken}` } }); }
  catch { throw new RequestError(502, "store_unreachable", "Couldn't reach cloud storage. Try again."); }
  if (response.status === 404) return null;
  if (!response.ok) {
    // The folder's limits come back as they are, so the page can say what to do; anything else is the store's problem.
    const refused = (await response.json().catch(() => null)) as { error?: { code?: unknown; message?: unknown } } | null;
    if ([409, 507].includes(response.status) && typeof refused?.error?.code === "string" && typeof refused.error.message === "string") throw new RequestError(response.status, refused.error.code, refused.error.message);
    throw new RequestError(502, "store_error", `Cloud storage answered ${response.status}.`);
  }
  return response;
}
async function homeEntries(config: RunnerConfig): Promise<string[]> {
  const data = relative(config.homeDir, config.dataDir);
  const candidates = [".claude", ".claude.json", ...(data && !data.startsWith("..") && !data.startsWith("/") ? [data] : [])];
  const found: string[] = [];
  for (const entry of candidates) if (await exists(join(config.homeDir, entry))) found.push(entry);
  return found;
}
/** Saves Claude's sign-in and session history. Returns null when there is no store or nothing to save. */
export async function saveHome(config: RunnerConfig): Promise<{ key: string; bytes: number } | null> {
  if (!hasStore(config)) return null;
  const entries = await homeEntries(config);
  if (!entries.length) return null;
  const archive = await pack(config.homeDir, entries, HOME_EXCLUDES);
  const body = config.homeKey ? sealHome(config.homeKey, archive.body) : archive.body;
  const meta = { files: String(archive.files), sha256: createHash("sha256").update(body).digest("hex"), kind: "home", sealed: config.homeKey ? "1" : "0" };
  await storeFetch(config, `/v1/objects/${HOME_KEY}`, { method: "PUT", body, headers: { "Content-Type": config.homeKey ? "application/octet-stream" : "application/gzip", "x-store-meta": JSON.stringify(meta) } });
  return { key: HOME_KEY, bytes: body.length };
}
/** Puts Claude's sign-in and session history back on a fresh disk. True when something was restored. */
export async function restoreHome(config: RunnerConfig): Promise<boolean> {
  if (!hasStore(config)) return false;
  const response = await storeFetch(config, `/v1/objects/${HOME_KEY}`);
  if (!response) return false;
  const stored = Buffer.from(await response.arrayBuffer());
  // With a key, only an archive sealed with it is restored: an unsealed one is from before sealing, or not ours.
  const archive = config.homeKey ? openHome(config.homeKey, stored) : stored.subarray(0, 4).equals(SEALED) ? null : stored;
  if (!archive) {
    console.error("[runner] the saved sign-in can't be opened with this machine's key; sign in to Claude again to replace it");
    return false;
  }
  await unpack(archive, config.homeDir);
  return true;
}

// ---------- server ----------

type Exec = { code: number | null; stdout: string; stderr: string };

export function createRunner(config: RunnerConfig): Server & { stopWork: () => void } {
  const tokenFile = join(config.dataDir, "oauth-token");
  let run: ChildProcessWithoutNullStreams | null = null;
  let finishing = false; // a run has ended and its files are being saved
  let login: { child: ChildProcessWithoutNullStreams; output: string; url: string | null; timer: NodeJS.Timeout } | null = null;
  const opened = new Map<string, Promise<{ restored: boolean }>>();
  const projectDir = (project: string) => join(config.workspaceDir, project);
  const busy = () => run !== null || finishing;

  async function storedToken(): Promise<string | null> {
    try { return (await readFile(tokenFile, "utf8")).trim() || null; } catch { return null; }
  }
  async function childEnv(): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: config.homeDir, DISABLE_AUTOUPDATER: "1", NO_COLOR: "1" };
    delete env.RUNNER_ACCESS_KEY;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY; // always use the subscription, never API billing
    // The store token stays with the runner: Claude runs whatever a prompt or a project file tells it to, and the
    // token opens this user's whole folder, Claude's saved sign-in included. The runner saves projects for it.
    delete env.STORE_URL;
    delete env.STORE_TOKEN;
    delete env.CLAUDE_HOME_KEY; // with it, Claude could open the saved sign-in of any copy it got hold of
    const token = await storedToken();
    if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    return env;
  }
  const syncHome = () => saveHome(config).catch((error) => { console.error("[runner] saving Claude's sign-in failed", error instanceof Error ? error.message : error); return null; });

  /** Makes the project's folder, bringing back its last autosave on a fresh disk. Once per boot. */
  function ensureProject(project: string): Promise<{ restored: boolean }> {
    let pending = opened.get(project);
    if (!pending) {
      pending = (async () => {
        const dir = projectDir(project);
        if (await exists(dir)) return { restored: false };
        await mkdir(dir, { recursive: true });
        if (!hasStore(config)) return { restored: false };
        const saved = await storeFetch(config, `/v1/objects/${autosaveKeyFor(project)}`);
        if (!saved) return { restored: false };
        await unpack(Buffer.from(await saved.arrayBuffer()), dir);
        return { restored: true };
      })();
      opened.set(project, pending);
      pending.catch(() => opened.delete(project));
    }
    return pending;
  }
  async function saveProject(project: string, kind: SaveInfo["kind"]): Promise<SaveInfo> {
    const savedAt = new Date();
    const key = kind === "auto" ? autosaveKeyFor(project) : saveKeyFor(project, savedAt);
    const { body, files, sha256 } = await pack(projectDir(project), ["."], WORKSPACE_EXCLUDES);
    const put = () => storeFetch(config, `/v1/objects/${key}`, { method: "PUT", body, headers: { "Content-Type": "application/gzip", "x-store-meta": JSON.stringify({ files: String(files), sha256, project, kind }) } });
    try { await put(); }
    catch (error) {
      // A project keeps the newest versions the store allows: the oldest makes room for this one.
      const oldest = error instanceof RequestError && error.code === "too_many_versions" ? (await listSaves(project)).saves.at(-1) : undefined;
      if (!oldest) throw error;
      await storeFetch(config, `/v1/objects/${oldest.key}`, { method: "DELETE" });
      await put();
    }
    return { key, project, kind, bytes: body.length, files, sha256, savedAt: savedAt.toISOString() };
  }
  async function listSaves(project: string) {
    const response = await storeFetch(config, `/v1/objects?prefix=${encodeURIComponent(`projects/${project}/`)}&limit=200`);
    const body = (await response!.json()) as { objects: { key: string; size: number; uploaded: string; metadata?: Record<string, string> }[] };
    const describe = (item: (typeof body.objects)[number]) => ({ key: item.key, bytes: item.size, savedAt: item.uploaded, files: item.metadata?.files === undefined ? null : Number(item.metadata.files) });
    const auto = body.objects.find((item) => item.key === autosaveKeyFor(project));
    return {
      autosave: auto ? describe(auto) : null,
      saves: body.objects.filter((item) => isSaveKey(project, item.key)).sort((a, b) => b.key.localeCompare(a.key)).map(describe),
    };
  }
  async function saveWorkspace(project: string): Promise<SaveInfo> {
    if (!hasStore(config)) await storeFetch(config, "/"); // throws store_not_configured
    if (busy()) throw new RequestError(409, "busy", "Wait for Claude Code to finish before saving.");
    await ensureProject(project);
    return saveProject(project, "manual");
  }
  /** Replaces the project's files with a save. The current files are saved first, so nothing is lost. */
  async function restoreWorkspace(project: string, requested?: string) {
    if (!hasStore(config)) await storeFetch(config, "/");
    if (busy()) throw new RequestError(409, "busy", "Wait for Claude Code to finish before restoring.");
    const key = requested ?? (await listSaves(project)).saves[0]?.key;
    if (!key) throw new RequestError(404, "save_not_found", `No saves yet for ${project}.`);
    if (!isSaveKey(project, key)) throw new RequestError(400, "invalid_save", "That save doesn't belong to this project.");
    const response = await storeFetch(config, `/v1/objects/${key}`);
    if (!response) throw new RequestError(404, "save_not_found", "That save no longer exists.");
    const body = Buffer.from(await response.arrayBuffer());
    await ensureProject(project);
    const dir = projectDir(project);
    const current = await readdir(dir);
    const backup = current.length ? await saveProject(project, "manual") : null;
    for (const name of current) await rm(join(dir, name), { recursive: true, force: true });
    await unpack(body, dir);
    return { key, restoredAt: new Date().toISOString(), backupKey: backup?.key ?? null, autosave: await saveProject(project, "auto") };
  }
  /** Saves everything worth keeping: Claude's sign-in and every project opened since boot. */
  async function syncAll() {
    if (!hasStore(config)) return { configured: false, home: null, projects: [] as SaveInfo[] };
    if (busy()) throw new RequestError(409, "busy", "Claude Code is still working.");
    const projects: SaveInfo[] = [];
    for (const project of opened.keys()) if (await exists(projectDir(project))) projects.push(await saveProject(project, "auto"));
    return { configured: true, home: await saveHome(config), projects };
  }
  function projectFrom(value: unknown): string {
    const project = typeof value === "string" && value.trim() ? value.trim() : "default";
    if (!isProjectName(project)) throw new RequestError(400, "invalid_project", "Project names use letters, digits and dashes (up to 64).");
    return project;
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
      store: hasStore(config),
      busy: busy(),
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
    await syncHome(); // so the sign-in survives a fresh disk
    return authStatus();
  }

  async function saveToken(token: string): Promise<AuthSummary> {
    if (!isSubscriptionToken(token)) throw new RequestError(400, "invalid_token", "That isn't a Claude Code token. Run `claude setup-token` and paste the sk-ant-oat01-… value it prints.");
    await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
    await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
    await chmod(tokenFile, 0o600);
    await syncHome();
    return authStatus();
  }

  async function signOut(): Promise<AuthSummary> {
    endLogin();
    await rm(tokenFile, { force: true });
    await exec(["auth", "logout"]);
    // Drop the saved copy first, so a stale sign-in can't come back on the next boot.
    if (hasStore(config)) {
      await storeFetch(config, `/v1/objects/${HOME_KEY}`, { method: "DELETE" }).catch((error) => console.error("[runner] removing the saved sign-in failed", error instanceof Error ? error.message : error));
      await syncHome();
    }
    return authStatus();
  }

  async function startRun(request: RunRequest, res: ServerResponse, headers: Record<string, string>) {
    if (busy()) throw new RequestError(409, "busy", "Claude Code is already working. Stop the current run first.");
    finishing = true; // hold the slot while the project folder is prepared
    let child: ChildProcessWithoutNullStreams;
    let restored = false;
    try {
      restored = (await ensureProject(request.project)).restored;
      child = spawn(config.claudeBin, buildRunArgs(request), { env: await childEnv(), cwd: projectDir(request.project), stdio: "pipe" });
    } finally { finishing = false; }
    run = child;
    res.writeHead(200, { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    const send = (value: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(value)}\n`); };
    send({ type: "runner", event: "started", project: request.project, workspace: projectDir(request.project), restored });
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
    child.on("close", async (code, signal) => {
      clearTimeout(limit);
      finishing = true;
      if (run === child) run = null;
      send({ type: "runner", event: "exit", code, signal, stderr: code === 0 ? "" : stderr.trim() });
      try {
        // Autosave after every run, even when the page has gone away.
        if (hasStore(config)) {
          try { send({ type: "runner", event: "saved", save: await saveProject(request.project, "auto") }); }
          catch (error) { send({ type: "runner", event: "save_failed", message: error instanceof RequestError ? error.message : "Couldn't save the project to cloud storage." }); }
          await syncHome();
        }
      } finally {
        finishing = false;
        res.end();
      }
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

  const server = createServer(async (req, res) => {
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
      if (route === "GET /v1/workspace") {
        const project = projectFrom(new URL(req.url ?? "/", "http://runner").searchParams.get("project"));
        if (!hasStore(config)) return json(200, { configured: false, project, autosave: null, saves: [] });
        return json(200, { configured: true, project, ...(await listSaves(project)) });
      }
      if (route === "POST /v1/workspace/save") {
        const { project } = (await readJson(req)) as { project?: unknown };
        return json(201, { save: await saveWorkspace(projectFrom(project)) });
      }
      if (route === "POST /v1/workspace/restore") {
        const { project, key } = (await readJson(req)) as { project?: unknown; key?: unknown };
        return json(200, { restored: await restoreWorkspace(projectFrom(project), typeof key === "string" ? key : undefined) });
      }
      if (route === "POST /v1/sync") return json(200, await syncAll());
      if (route === "POST /v1/store-token") {
        // The machine renews its short-lived store token here while it stays awake. The gateway never forwards this route.
        const { token } = (await readJson(req)) as { token?: unknown };
        if (!config.storeUrl) throw new RequestError(409, "store_not_configured", "Cloud saving isn't set up on this runner.");
        if (typeof token !== "string" || !/^fst\d\.[A-Za-z0-9._-]{20,400}$/.test(token)) throw new RequestError(400, "invalid_token", "That isn't a store token.");
        config.storeToken = token;
        return json(200, { ok: true });
      }
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
  /** For shutdown: ends the run in progress (it still autosaves) and any sign-in that was waiting. */
  const stopWork = () => { run?.kill("SIGTERM"); endLogin(); };
  return Object.assign(server, { stopWork });
}

async function main() {
  const config = loadConfig();
  await mkdir(config.workspaceDir, { recursive: true });
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  // On a fresh disk (a machine waking up), bring Claude's sign-in and history back before serving.
  if (hasStore(config)) {
    try { console.log(`[runner] ${(await restoreHome(config)) ? "restored Claude's sign-in and history from cloud storage" : "no saved sign-in in cloud storage yet"}`); }
    catch (error) { console.error("[runner] couldn't restore the saved sign-in:", error instanceof Error ? error.message : error); }
  }
  const server = createRunner(config);
  server.listen(config.port, config.host, () => {
    console.log(`[runner] Claude Code runner listening on http://${config.host}:${config.port}`);
    console.log(`[runner] workspace ${config.workspaceDir}; cloud saves ${hasStore(config) ? "on" : "off"}`);
  });
  // In the container this is process 1, and process 1 ignores a signal it has no handler for.
  // Without this a cloud machine never goes to sleep and `docker stop` has to kill the runner.
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      console.log(`[runner] ${signal}: stopping`);
      server.stopWork();
      server.close(() => process.exit(0));
      // A run that was stopped just now still autosaves; its connection goes idle once that is sent.
      setInterval(() => server.closeIdleConnections(), 200).unref();
      setTimeout(() => process.exit(0), 60_000).unref();
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[runner] ${error instanceof Error ? error.message : error}`); process.exit(1); });
}
