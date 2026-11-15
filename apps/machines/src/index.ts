// Faceful machines gateway: one Claude Code container per user, on Cloudflare.
//
//   Browser ──► this Worker ──► UserMachine (Durable Object + Container, one per user id)
//                  │                 └─ apps/claude-runner inside, reached only through the Durable Object
//                  └─ D1 faceful-machines: machines, projects, saves
//
// The Worker decides who is calling (a short-lived token the engine trades for a Faceful session, or a personal
// token), lets in only listed accounts, and never lets a caller name another user's machine. The container's disk
// is fresh on every wake; the runner restores the user's Claude sign-in and each project from their own R2 folder,
// and autosaves after every run.
import { Container, getContainer } from "@cloudflare/containers";
import { MACHINE_STORE_TOKEN_TTL, mintToken } from "../../workspace-store/src/index";
import { asSaveRecord, corsFor, createLineScanner, identify, isProjectId, limitProblem, limitsFrom, machineUsage, NOT_ENABLED, parseAllowlist, parseOrigins, parseRunEvent, slugify, usageSince, WAKE_SQL, type Identity, type LimitProblem, type SaveRecord, type Wake } from "./lib";

export type Env = {
  MACHINE: DurableObjectNamespace<UserMachine>;
  DB: D1Database;
  /** Same value as the workspace store's secret: lets this Worker mint each machine's folder token. */
  STORE_SIGNING_KEY: string;
  /** Keyring that signs personal gateway tokens (fgw2.…, expiring). Optional: without it no personal token is accepted. */
  GATEWAY_SIGNING_KEY?: string;
  /** Same value as the engine's: checks the ten-minute tokens the engine trades for a Faceful session (fgs1.…). */
  MACHINES_GATEWAY_KEY?: string;
  STORE_URL: string;
  ALLOWED_ORIGINS: string;
  INSTANCE_TYPE: string;
  /** Secret. Comma-separated user ids that may have a machine; unset or empty lets nobody in. */
  MACHINE_ALLOWED_USERS?: string;
  /** Per-user limits (lib.ts limitsFrom): wakes in any hour, and minutes awake per UTC day. */
  MACHINE_WAKES_PER_HOUR?: string;
  MACHINE_AWAKE_MINUTES_PER_DAY?: string;
};

const PORT = 8787;
const SLEEP_AFTER_MINUTES = 15;
const now = () => new Date().toISOString();
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const problem = (status: number, code: string, message: string) => json(status, { error: { code, message } });
const logFailure = (what: string) => (error: unknown) => console.error(`${what} failed:`, error instanceof Error ? error.message : error);
const limited = (refused: LimitProblem) => {
  const response = json(429, { error: { code: refused.code, message: refused.message, retryAfterSeconds: refused.retryAfterSeconds } });
  response.headers.set("retry-after", String(refused.retryAfterSeconds));
  return response;
};
class LimitReached extends Error {
  constructor(readonly refused: LimitProblem) { super(refused.message); }
}

// ---------- database ----------

async function ensureProject(db: D1Database, uid: string, id: string, title = id) {
  await db.prepare("insert into projects (user_id, id, title) values (?, ?, ?) on conflict (user_id, id) do nothing").bind(uid, id, title).run();
}
async function recordRun(db: D1Database, uid: string, project: string, sessionId: string) {
  await ensureProject(db, uid, project);
  await db.prepare("update projects set session_id = ?, runs = runs + 1, last_run_at = ?, updated_at = ? where user_id = ? and id = ?").bind(sessionId, now(), now(), uid, project).run();
}
async function recordSave(db: D1Database, uid: string, save: SaveRecord) {
  await ensureProject(db, uid, save.project);
  await db.batch([
    db.prepare("insert into saves (user_id, r2_key, project_id, kind, bytes, files, sha256, saved_at) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict (user_id, r2_key) do update set bytes = excluded.bytes, files = excluded.files, sha256 = excluded.sha256, saved_at = excluded.saved_at")
      .bind(uid, save.key, save.project, save.kind, save.bytes, save.files, save.sha256, save.savedAt),
    save.kind === "auto"
      ? db.prepare("update projects set last_saved_at = ?, autosave_key = ?, autosave_bytes = ?, autosave_files = ?, updated_at = ? where user_id = ? and id = ?").bind(save.savedAt, save.key, save.bytes, save.files, now(), uid, save.project)
      : db.prepare("update projects set last_saved_at = ?, updated_at = ? where user_id = ? and id = ?").bind(save.savedAt, now(), uid, save.project),
  ]);
}
async function touchMachine(db: D1Database, uid: string, via: Identity["via"], instanceType: string) {
  await db.prepare("insert into machines (user_id, instance_type, identity, last_seen_at) values (?, ?, ?, ?) on conflict (user_id) do update set instance_type = excluded.instance_type, identity = excluded.identity, last_seen_at = excluded.last_seen_at, updated_at = excluded.last_seen_at")
    .bind(uid, instanceType, via, now()).run();
}

// ---------- one container per user ----------

export class UserMachine extends Container<Env> {
  defaultPort = PORT;
  sleepAfter = `${SLEEP_AFTER_MINUTES}m`;
  enableInternet = true;

  /** Only this Durable Object can reach the container's port, so its id works as the runner's access key. */
  private readonly innerSecret = this.ctx.id.toString();
  private ready: Promise<void> | null = null;
  private booted = false;
  /** When the runner's store token (12 hours) is due for a new one: halfway through its life. */
  private storeTokenRenewAt = 0;

  private api(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.innerSecret}`);
    return this.containerFetch(`http://container${path}`, { ...init, headers }, PORT);
  }
  private async isUp(): Promise<boolean> {
    const state = await this.getState();
    return state.status === "running" || state.status === "healthy";
  }

  /** This user's limits as of now: `waking` also counts the wakes in the last hour. */
  private async usageProblem(uid: string, waking: boolean): Promise<LimitProblem | null> {
    const at = Date.now();
    const { results } = await this.env.DB.prepare(WAKE_SQL.usage).bind(uid, usageSince(at)).all<Wake>();
    return limitProblem(machineUsage(results, at), limitsFrom(this.env), at, { waking });
  }

  /** Hands the runner a fresh store token once the one it holds is halfway through its life. */
  private async renewStoreToken(uid: string): Promise<void> {
    if (Date.now() < this.storeTokenRenewAt) return;
    const token = await mintToken(this.env.STORE_SIGNING_KEY, uid, MACHINE_STORE_TOKEN_TTL);
    const response = await this.api("/v1/store-token", { method: "POST", body: JSON.stringify({ token }), headers: { "content-type": "application/json" } });
    if (!response.ok) throw new Error(`the runner answered ${response.status}`);
    this.storeTokenRenewAt = Date.now() + MACHINE_STORE_TOKEN_TTL * 500;
  }

  /** Starts the container with this user's own storage token. Once per wake, within the user's limits. */
  private boot(uid: string, via: Identity["via"]): Promise<void> {
    // A container that went away by itself (a deploy, a crash) needs a full start, not the remembered one.
    if (this.booted && this.ctx.container?.running !== true) { this.booted = false; this.ready = null; }
    this.ready ??= (async () => {
      const db = this.env.DB;
      await this.ctx.storage.put("uid", uid);
      await touchMachine(db, uid, via, this.env.INSTANCE_TYPE);
      const waking = !(await this.isUp());
      if (waking) {
        // A stop that was never recorded is charged until now: rare, and it errs on the side of the spend cap.
        await db.prepare(WAKE_SQL.close).bind(now(), uid).run();
        const refused = await this.usageProblem(uid, true);
        if (refused) throw new LimitReached(refused);
        await db.batch([
          db.prepare(WAKE_SQL.open).bind(uid, now()),
          db.prepare(WAKE_SQL.prune).bind(uid, new Date(Date.now() - 7 * 86_400_000).toISOString()),
          db.prepare("update machines set state = 'starting', updated_at = ? where user_id = ?").bind(now(), uid),
        ]);
      }
      // Kept on the object, so every start of this container gets the same settings, whoever triggers it.
      this.envVars = {
        HOST: "0.0.0.0",
        PORT: String(PORT),
        RUNNER_ACCESS_KEY: this.innerSecret,
        RUNNER_ALLOWED_ORIGINS: "http://container",
        STORE_URL: this.env.STORE_URL,
        STORE_TOKEN: await mintToken(this.env.STORE_SIGNING_KEY, uid),
      };
      await this.startAndWaitForPorts({ ports: PORT, cancellationOptions: { instanceGetTimeoutMS: 60_000, portReadyTimeoutMS: 90_000 } });
      // A container that was already up kept the token from its own start, of unknown age: renew it right away.
      this.storeTokenRenewAt = waking ? Date.now() + MACHINE_STORE_TOKEN_TTL * 500 : 0;
      this.booted = true;
    })().catch(async (error) => {
      this.ready = null;
      if (!(error instanceof LimitReached)) await this.env.DB.prepare(WAKE_SQL.close).bind(now(), uid).run().catch(logFailure("closing the failed wake"));
      throw error;
    });
    return this.ready;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const uid = request.headers.get("x-faceful-uid") ?? "";
    const via: Identity["via"] = request.headers.get("x-faceful-via") === "session" ? "session" : "token";
    if (url.pathname === "/internal/state") return json(200, { state: await this.getState(), running: this.ctx.container?.running === true });
    if (url.pathname === "/internal/sleep") {
      const outcome = await this.saveAndStop();
      return outcome === "busy" ? problem(409, "busy", "Claude Code is still working. Stop the run, then put the machine to sleep.") : json(200, { stopped: outcome === "stopped" });
    }

    // An awake machine that has used up today's time takes no more work, and goes to sleep as soon as it is idle.
    if (this.ctx.container?.running === true) {
      const refused = await this.usageProblem(uid, false);
      if (refused) {
        this.ctx.waitUntil(this.saveAndStop().catch(logFailure("putting an over-limit machine to sleep")));
        return limited(refused);
      }
    }
    try { await this.boot(uid, via); }
    catch (error) {
      if (error instanceof LimitReached) return limited(error.refused);
      logFailure(`starting the machine for ${uid}`)(error);
      await this.env.DB.prepare("update machines set state = 'failed', updated_at = ? where user_id = ?").bind(now(), uid).run().catch(logFailure("marking the machine failed"));
      return problem(503, "machine_unavailable", "Your machine couldn't start. Try again in a moment.");
    }
    await this.renewStoreToken(uid).catch(logFailure("renewing the store token"));
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const response = await this.api(`${url.pathname}${url.search}`, { method: request.method, body, headers: body ? { "content-type": "application/json" } : {} });
    return this.observe(uid, `${request.method} ${url.pathname}`, body, response);
  }

  /** Mirrors what happened on the machine into the database, without changing the response. */
  private observe(uid: string, route: string, body: string | undefined, response: Response): Response {
    const db = this.env.DB;
    const later = (work: Promise<unknown>, what: string) => this.ctx.waitUntil(work.catch(logFailure(what)));
    if (!response.ok) return response;

    if (route === "POST /v1/run" && response.body) {
      let project = "default";
      try { const named = (JSON.parse(body || "{}") as { project?: unknown }).project; if (typeof named === "string" && isProjectId(named)) project = named; } catch { /* the runner already validated it */ }
      later(ensureProject(db, uid, project), "creating the project row");
      const scanner = createLineScanner((line) => {
        const event = parseRunEvent(line);
        if (event?.kind === "result") later(recordRun(db, uid, project, event.sessionId), "recording the run");
        if (event?.kind === "saved") later(recordSave(db, uid, event.save), "recording the autosave");
      });
      return new Response(response.body.pipeThrough(scanner), { status: response.status, headers: response.headers });
    }
    if (route === "POST /v1/workspace/save" || route === "POST /v1/workspace/restore") {
      later(response.clone().json().then(async (data) => {
        const payload = data as { save?: unknown; restored?: { autosave?: unknown } };
        for (const candidate of [payload.save, payload.restored?.autosave]) {
          const save = asSaveRecord(candidate);
          if (save) await recordSave(db, uid, save);
        }
      }), "recording the save");
    }
    if (route === "GET /v1/status") {
      later(response.clone().json().then((data) => {
        const signedIn = (data as { auth?: { loggedIn?: unknown } }).auth?.loggedIn === true ? 1 : 0;
        return db.prepare("update machines set claude_signed_in = ?, last_seen_at = ?, updated_at = ? where user_id = ?").bind(signedIn, now(), now(), uid).run();
      }), "recording the machine status");
    }
    return response;
  }

  /** Saves Claude's sign-in and every open project, then stops the container. A run still working is left alone. */
  private async saveAndStop(): Promise<"stopped" | "asleep" | "busy"> {
    if (!(await this.isUp())) return "asleep";
    const uid = await this.ctx.storage.get<string>("uid");
    try {
      if (uid) await this.renewStoreToken(uid).catch(logFailure("renewing the store token"));
      const synced = await this.api("/v1/sync", { method: "POST" });
      if (synced.status === 409) return "busy"; // the run autosaves by itself when it ends
      if (synced.ok && uid) {
        const { projects } = (await synced.json()) as { projects?: unknown[] };
        for (const candidate of projects ?? []) {
          const save = asSaveRecord(candidate);
          if (save) await recordSave(this.env.DB, uid, save);
        }
      }
    } catch (error) { logFailure("saving before sleep")(error); }
    await this.stop();
    // The runner exits on that signal. A container that is still up after 10 seconds is ended:
    // everything is saved by now, and a machine that never sleeps is billed for every hour.
    const running = () => this.ctx.container?.running === true;
    for (let waited = 0; waited < 20 && running(); waited++) await new Promise((done) => setTimeout(done, 500));
    if (running()) {
      console.warn(`machine ${uid ?? "?"} ignored the stop signal for 10 s; ending it`);
      await this.destroy();
    }
    await this.stop(); // nothing left to signal; this records the stop now instead of on the next alarm
    return "stopped";
  }

  /** Nobody has asked for anything for a while: stay up for a run still working, otherwise save and sleep. */
  override async onActivityExpired(): Promise<void> {
    const status = await this.api("/v1/status").then((response) => (response.ok ? (response.json() as Promise<{ busy?: boolean }>) : null)).catch(() => null);
    if (status?.busy) {
      this.renewActivityTimeout();
      return;
    }
    await this.saveAndStop();
  }

  override async onStart(): Promise<void> {
    const uid = await this.ctx.storage.get<string>("uid");
    if (uid) await this.env.DB.prepare("update machines set state = 'running', starts = starts + 1, last_started_at = ?, updated_at = ? where user_id = ?").bind(now(), now(), uid).run().catch(logFailure("recording the start"));
  }

  override async onStop(): Promise<void> {
    this.ready = null;
    this.booted = false;
    const uid = await this.ctx.storage.get<string>("uid");
    const db = this.env.DB;
    if (uid) await db.batch([
      db.prepare("update machines set state = 'stopped', last_stopped_at = ?, updated_at = ? where user_id = ?").bind(now(), now(), uid),
      db.prepare(WAKE_SQL.close).bind(now(), uid),
    ]).catch(logFailure("recording the stop"));
  }

  override onError(error: unknown): unknown {
    console.error("container error", error);
    return error;
  }
}

// ---------- the gateway ----------

async function route(request: Request, url: URL, env: Env, who: Identity): Promise<Response> {
  const machine = getContainer(env.MACHINE, who.uid);
  const identity = { "x-faceful-uid": who.uid, "x-faceful-via": who.via };
  const key = `${request.method} ${url.pathname}`;

  if (key === "GET /v1/machine") {
    const [row, live] = await Promise.all([
      env.DB.prepare("select state, instance_type, identity, claude_signed_in, starts, last_started_at, last_stopped_at, last_seen_at, created_at from machines where user_id = ?").bind(who.uid).first(),
      machine.fetch(new Request("http://machine/internal/state", { headers: identity })).then((response) => response.json() as Promise<{ state: { status: string }; running: boolean }>),
    ]);
    // The stored status can lag behind a container that has just gone away; `running` is the container itself.
    const status = !live.running && (live.state.status === "running" || live.state.status === "healthy") ? "stopped" : live.state.status;
    return json(200, { gateway: true, user: who.uid, identity: who.via, instanceType: env.INSTANCE_TYPE, sleepAfterMinutes: SLEEP_AFTER_MINUTES, live: status, running: live.running, machine: row });
  }
  if (key === "POST /v1/machine/sleep") return machine.fetch(new Request("http://machine/internal/sleep", { method: "POST", headers: identity }));

  if (key === "GET /v1/projects") {
    const { results } = await env.DB.prepare("select id, title, session_id, runs, last_run_at, last_saved_at, autosave_bytes, autosave_files, created_at from projects where user_id = ? order by coalesce(last_run_at, created_at) desc limit 200").bind(who.uid).all();
    return json(200, { projects: results });
  }
  if (key === "POST /v1/projects") {
    const body = (await request.json().catch(() => null)) as { id?: unknown; title?: unknown } | null;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title || title.length > 120) return problem(400, "invalid_title", "Give the project a name of up to 120 characters.");
    const id = typeof body?.id === "string" && body.id ? body.id : slugify(title) || crypto.randomUUID();
    if (!isProjectId(id)) return problem(400, "invalid_project", "Project ids use letters, digits and dashes (up to 64).");
    const created = await env.DB.prepare("insert into projects (user_id, id, title) values (?, ?, ?) on conflict (user_id, id) do nothing").bind(who.uid, id, title).run();
    if (!created.meta.changes) return problem(409, "project_exists", "You already have a project with that id.");
    return json(201, { project: { id, title, session_id: null, runs: 0, last_run_at: null, last_saved_at: null, autosave_bytes: null, autosave_files: null } });
  }
  const saves = /^\/v1\/projects\/([^/]+)\/saves$/.exec(url.pathname);
  if (saves && request.method === "GET") {
    if (!isProjectId(saves[1])) return problem(400, "invalid_project", "That project id isn't valid.");
    const { results } = await env.DB.prepare("select r2_key, kind, bytes, files, sha256, saved_at from saves where user_id = ? and project_id = ? order by saved_at desc limit 100").bind(who.uid, saves[1]).all();
    return json(200, { saves: results });
  }

  // Only the machine itself hands its runner a store token.
  if (url.pathname === "/v1/store-token") return problem(404, "not_found", "Unknown endpoint.");
  // Everything else is the runner's own API, on this user's machine. This wakes the machine if it sleeps.
  const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
  return machine.fetch(new Request(`http://machine${url.pathname}${url.search}`, { method: request.method, headers: identity, body }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const cors = corsFor(origin, parseOrigins(env.ALLOWED_ORIGINS));
    const withCors = (response: Response) => {
      if (!cors) return response;
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) headers.set(name, value);
      return new Response(response.body, { status: response.status, headers });
    };
    if (request.method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    if (url.pathname === "/health") return withCors(json(200, { ok: true, service: "faceful-machines" }));
    if (!url.pathname.startsWith("/v1/")) return withCors(problem(404, "not_found", "Unknown endpoint."));
    if (origin && !cors) return problem(403, "origin_not_allowed", `This gateway doesn't accept requests from ${origin}.`);

    const who = await identify(request.headers.get("authorization"), { personal: env.GATEWAY_SIGNING_KEY, session: env.MACHINES_GATEWAY_KEY });
    if (!who) return withCors(problem(401, "unauthorized", "Sign in again, or check your access token."));
    // Default deny: an account only reaches any route once it is on the list.
    if (!parseAllowlist(env.MACHINE_ALLOWED_USERS).has(who.uid)) return withCors(problem(403, "machine_not_enabled", NOT_ENABLED));
    try { return withCors(await route(request, url, env, who)); }
    catch (error) {
      logFailure(`${request.method} ${url.pathname}`)(error);
      return withCors(problem(500, "internal", "The gateway hit an unexpected error."));
    }
  },
};
