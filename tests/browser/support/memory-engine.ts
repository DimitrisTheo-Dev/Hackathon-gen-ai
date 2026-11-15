import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * TEST-ONLY harness. Mounted by scripts/serve-built.ts solely when FACEFUL_E2E_ENGINE=memory.
 *
 * It runs the REAL domain engine (packages/engine: routing, tenancy, idempotency, versions,
 * render admission, director) against the in-memory store, so browser tests exercise the live
 * transport end to end without Supabase, a model, Stripe or a renderer. Three things are stand-ins:
 *   • sessions: tokens whose payload says `iss: "faceful-e2e"` are accepted without a signature;
 *   • the model: a scripted planner returns fixed proposals (or is switched off per user);
 *   • the renderer: `/__e2e/complete-renders` finishes queued jobs through the real worker protocol
 *     with a one-second silent audio clip standing in for a rendered file.
 * The likeness capture ("Scan my face") can be tried by hand on it too:
 *   • `/__e2e/face-scan` signs this browser in as a stand-in person and opens the capture;
 *   • recordings are PUT to `/__e2e/files/<key>`, which checks the SHA-256 header the way R2 does, and are
 *     kept in memory only; with FACEFUL_R2_* in the environment they go to the real bucket instead, straight
 *     from the browser (serve on an origin the bucket's CORS rule allows). `/__e2e/likeness` lists what was saved;
 *   • stored files (scan stills, persona photos) are read back through GET `/__e2e/files/<key>`;
 *   • with HUMANLIKE_TRANSCRIBE_KEY in the environment, live transcription uses Humanlike's real socket.
 * The template library can be seeded two ways: `POST /__e2e/templates` adds two small stand-in templates, and
 * FACEFUL_E2E_TEMPLATES=<path to templates/_kit/library.json> loads the real rows and sample files at start.
 * Nothing here is imported by application code or by the deployed functions.
 */
import { createHash } from "node:crypto";
import { loadConfig } from "../../../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../../../packages/engine/src/http";
import type { Planner, PlannerOutput } from "../../../packages/engine/src/llm";
import { workerClaim, workerComplete, workerUploadUrl } from "../../../packages/engine/src/render";
import { MemoryFileStore, R2FileStore, type FileStore } from "../../../packages/engine/src/r2";
import { MemoryMedia, MemoryStore } from "../../../packages/engine/src/store-memory";
import { handleMcpRequest } from "../../../packages/engine/src/mcp";

const WORKER_TOKEN = "e2e-render-worker-token-not-a-real-credential-0001";
const AVATARS = JSON.stringify([{ id: "minas_kontis", name: "Minas", languages: ["en", "el"] }]);

/** One second of silence. A <video> element can load it, which is all the player tests need. */
function silentWav() {
  const samples = 8000;
  const buffer = Buffer.alloc(44 + samples, 128);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples, 4); buffer.write("WAVE", 8); buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22); buffer.writeUInt32LE(8000, 24);
  buffer.writeUInt32LE(8000, 28); buffer.writeUInt16LE(1, 32); buffer.writeUInt16LE(8, 34); buffer.write("data", 36); buffer.writeUInt32LE(samples, 40);
  return new Uint8Array(buffer);
}

class E2EMedia extends MemoryMedia {
  private issued = 0;
  constructor(private readonly origin: string) { super(); }
  // Every read returns a differently signed URL, like a real signer on a cold instance.
  override async signedUrls(paths: string[]) {
    return Object.fromEntries(paths.map((path) => [path, this.objects.has(path) ? `${this.origin}/__e2e/media/${encodeURIComponent(path)}?sig=${++this.issued}` : null]));
  }
}
class E2EStore extends MemoryStore {
  override readonly media: E2EMedia;
  constructor(origin: string) { super(); this.media = new E2EMedia(origin); }
}
/** A stored object with byte ranges, like the real storage: browsers will not seek or play media without them. */
function serveBytes(request: Request, bytes: Uint8Array, contentType: string) {
  const size = bytes.byteLength;
  const headers = { "Content-Type": contentType, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!range) return new Response(bytes, { headers });
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
  return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` } });
}

/**
 * Private files (face-scan recordings, persona photos, Video view draft files), kept in memory with upload and
 * download links that point back at this server instead of R2.
 */
class E2EFiles extends MemoryFileStore {
  constructor(private readonly origin: string) { super(); }
  override async uploadUrl(key: string, options: { sha256Hex: string; contentType: string }) {
    return { ...(await super.uploadUrl(key, options)), url: `${this.origin}/__e2e/files/${key}` };
  }
  override async downloadUrl(key: string, expiresSeconds: number) {
    await super.downloadUrl(key, expiresSeconds);
    return `${this.origin}/__e2e/files/${key}?ttl=${expiresSeconds}`;
  }
}
/** An unsigned session only this harness accepts (`claims` below), in the shape the Supabase client stores. */
function standInSession() {
  const id = `local-${crypto.randomUUID()}`;
  const user = { id, aud: "authenticated", role: "authenticated", email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const token = `${[{ alg: "none", typ: "JWT" }, { iss: "faceful-e2e", sub: id, email: user.email, exp, aud: "authenticated", role: "authenticated" }].map((part) => Buffer.from(JSON.stringify(part)).toString("base64url")).join(".")}.e2e`;
  return { access_token: token, refresh_token: "e2e-not-a-credential", token_type: "bearer", expires_in: 30 * 24 * 3600, expires_at: exp, user };
}

function claims(token: string) {
  const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (payload.iss !== "faceful-e2e" || typeof payload.sub !== "string") throw new Error("not an e2e session");
  return { sub: payload.sub as string, email: typeof payload.email === "string" ? payload.email : null, clientId: null };
}

function tag(text: string, name: string) {
  return text.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "";
}
/** Stand-in for the model: fixed, recognisable proposals keyed on the request wording. */
const scripted: Planner = {
  async plan({ user }) {
    const request = tag(user, "request").trim();
    const selected = tag(user, "selected_item_id").trim();
    const base: PlannerOutput = { intent: "answer", reply: "Tell me what you would like to make.", project: null, edits: [], renderItemIds: [], find: null, wantsCheckout: false };
    if (/^(create|make|draft)\b/i.test(request)) {
      const greek = /greek/i.test(request);
      return {
        ...base,
        intent: "create",
        reply: "I drafted a 15-second reel for BeWell.",
        project: {
          title: "BeWell launch reel", brandName: "BeWell", brandDescription: "A festival companion app.", audience: "Festival visitors", tone: "Friendly", language: greek ? "el" : "en",
          items: [{ title: greek ? "Γνώρισε το BeWell" : "Meet BeWell", script: greek ? "Γεια σου! Αυτό είναι το BeWell. Οργάνωσε τη μέρα σου στο φεστιβάλ." : "Hi! Meet BeWell. Plan your festival day in one place.", caption: "Meet BeWell.", avatarId: null, schedule: /monday/i.test(request) ? [{ platform: "instagram", localDateTime: "2026-11-16T09:00" }] : [] }],
        },
      };
    }
    if (selected && /shorten|rewrite|opening/i.test(request))
      return { ...base, intent: "edit", reply: "I propose a shorter opening.", edits: [{ itemId: selected, title: null, script: "Hi! This is BeWell.", avatarId: null, language: null, captions: [], burnedInCaptions: null, schedule: null }] };
    if (/credit|upgrade/i.test(request)) return { ...base, intent: "billing", reply: "Here is your billing status.", wantsCheckout: /upgrade/i.test(request) };
    return base;
  },
};

/** A row of public.templates for the stand-in library. */
function standInTemplate(id: string, position: number, family: "face" | "no_face") {
  const base = `templates/${id}/v1`;
  return {
    id, version: 1, family, name: family === "face" ? "Talking tip" : "Chat Q&A", summary: "A stand-in template for browser tests.",
    use_for: family === "face" ? "A quick practical tip." : "A frequent question with a short answer.", position, published: true,
    language: "el", languages: ["el"], aspect_ratio: "9:16", fps: 25, duration_min: 15, duration_max: 35, sample_topic: "Δείγμα",
    sample_seconds: 1, voice: "One stock voice", fonts: ["Inter"], inputs: [{ key: "say", label: "One line per beat" }],
    script: [{ id: "hook", text: "Μία γραμμή." }], spec: {}, video_path: `${base}/sample.mp4`, poster_path: `${base}/poster.jpg`,
    stills: [{ beat: "hook", path: `${base}/stills/01-hook.jpg` }], variants: [], qa: {},
  };
}
// A 1x1 JPEG, enough for an <img> to load.
const PIXEL = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

export function createMemoryEngine(origin: string) {
  const store = new E2EStore(origin);
  const settings = loadConfig({ SUPABASE_URL: "https://e2e.invalid", APP_BASE_URL: origin, RENDER_WORKER_TOKEN: WORKER_TOKEN, RENDER_AVATARS: AVATARS, HUMANLIKE_TRANSCRIBE_KEY: process.env.HUMANLIKE_TRANSCRIBE_KEY, FACEFUL_R2_ACCOUNT_ID: process.env.FACEFUL_R2_ACCOUNT_ID, FACEFUL_R2_ACCESS_KEY_ID: process.env.FACEFUL_R2_ACCESS_KEY_ID, FACEFUL_R2_SECRET_ACCESS_KEY: process.env.FACEFUL_R2_SECRET_ACCESS_KEY, FACEFUL_R2_BUCKET: process.env.FACEFUL_R2_BUCKET });
  const memoryFiles = new E2EFiles(origin);
  const files: FileStore = settings.r2 ? new R2FileStore(settings.r2, () => new Date(), globalThis.fetch) : memoryFiles;
  // The Supabase client keeps its session under a key named after the project the app was built for.
  const sessionKey = `sb-${new URL(process.env.VITE_SUPABASE_URL?.trim() || "https://hgsgvdujzatfhsjoojll.supabase.co").hostname.split(".")[0]}-auth-token`;
  // Real rows and files from the content-creator templates folder, when asked for (see the note at the top).
  const library = process.env.FACEFUL_E2E_TEMPLATES;
  if (library) {
    const { rows, files } = JSON.parse(readFileSync(library, "utf8")) as { rows: Array<Record<string, unknown>>; files: Array<{ path: string; file: string; mime: string }> };
    const root = dirname(dirname(library));
    for (const row of rows) void store.insert("templates", row);
    for (const f of files) void store.media.put(f.path, new Uint8Array(readFileSync(join(root, f.file))), f.mime);
    console.log(`in-memory engine: ${rows.length} templates and ${files.length} files from ${library}`);
  }
  const base: HttpDeps = {
    store,
    files,
    // `llm` only flips the reported director mode to "ai"; the scripted planner below is what actually answers.
    config: { ...settings, llm: { provider: "anthropic", apiKey: "e2e-not-a-key", model: "scripted" } },
    now: () => new Date(),
    verifyAccessToken: async (token) => claims(token),
    fetch: async () => new Response("{}", { status: 503 }),
    planner: scripted,
  };
  const plannerOff = new Set<string>();
  const wav = silentWav();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

  async function control(request: Request, pathname: string): Promise<Response> {
    if (request.method === "GET" && pathname.startsWith("/__e2e/media/")) {
      const object = store.media.objects.get(decodeURIComponent(pathname.slice("/__e2e/media/".length)));
      if (!object) return new Response("Not found", { status: 404 });
      // Render stand-ins are a silent WAV whatever their label; template files are served as what they are.
      return serveBytes(request, object.bytes, pathname.startsWith("/__e2e/media/templates") ? object.mime : "audio/wav");
    }
    if (pathname.startsWith("/__e2e/files/")) {
      // Stands in for R2's signed links: the link is the permission. Used by the face scan, persona photos and the
      // Video view's draft files; the reel uploader may PUT from another origin, hence the CORS answers.
      const key = decodeURIComponent(pathname.slice("/__e2e/files/".length));
      if (request.method === "PUT") {
        // Like R2 with a signed checksum: only the exact bytes the upload ticket declared are stored.
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (request.headers.get("x-amz-checksum-sha256") !== createHash("sha256").update(bytes).digest("base64")) return new Response("The body does not match the declared SHA-256.", { status: 400 });
        await memoryFiles.put(key, bytes, request.headers.get("content-type") ?? "application/octet-stream");
        return new Response(null, { status: 200, headers: { "Access-Control-Allow-Origin": "*" } });
      }
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "PUT", "Access-Control-Allow-Headers": "content-type, x-amz-checksum-sha256" } });
      const object = memoryFiles.objects.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      return serveBytes(request, object.bytes, object.contentType);
    }
    if (request.method === "GET" && pathname === "/__e2e/face-scan") {
      // Trying the capture by hand: sign this browser in as a stand-in person (kept across reloads), then open it.
      const page = `<!doctype html><meta charset="utf-8"><title>Opening the face scan…</title><script>if (!localStorage.getItem(${JSON.stringify(sessionKey)})) localStorage.setItem(${JSON.stringify(sessionKey)}, ${JSON.stringify(JSON.stringify(standInSession()))}); location.replace("/face-scan/");</script>`;
      return new Response(page, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    let user: ReturnType<typeof claims>;
    try { user = claims(token); } catch { return json({ error: "e2e session required" }, 401); }
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
    if (pathname === "/__e2e/templates" && request.method === "POST") {
      if (!(await store.select("templates", {})).length) {
        for (const [i, [id, family]] of ([["talking-tip", "face"], ["chat-qa", "no_face"]] as const).entries()) {
          const row = standInTemplate(id, i, family);
          await store.insert("templates", row);
          await store.media.put(row.video_path, wav, "video/mp4");
          await store.media.put(row.poster_path, new Uint8Array(PIXEL), "image/jpeg");
          await store.media.put(row.stills[0].path, new Uint8Array(PIXEL), "image/jpeg");
        }
      }
      return json({ count: (await store.select("templates", {})).length });
    }
    if (pathname === "/__e2e/planner") {
      if (body.mode === "none") plannerOff.add(user.sub); else plannerOff.delete(user.sub);
      return json({ mode: plannerOff.has(user.sub) ? "none" : "scripted" });
    }
    const org = (await store.select("organizations", { personal_owner_id: user.sub }))[0];
    if (!org) return json({ error: "open the studio once before using test controls" }, 409);
    if (pathname === "/__e2e/credits") {
      // Moves the balance to an exact number through the ledger, like an operator adjustment.
      const balance = (await store.select("credit_ledger", { org_id: org.id })).reduce((sum, row) => sum + row.delta, 0);
      const delta = Number(body.balance) - balance;
      if (delta) await store.insert("credit_ledger", { id: crypto.randomUUID(), org_id: org.id, delta, reason: "adjustment", ref: `e2e:${crypto.randomUUID()}`, created_at: new Date().toISOString() });
      return json({ balance: Number(body.balance) });
    }
    if (pathname === "/__e2e/complete-renders") {
      // Real worker protocol: claim → signed upload → verified completion.
      let completed = 0;
      for (;;) {
        const { job } = await workerClaim(base, { workerId: "e2e" });
        if (!job) break;
        const upload = await workerUploadUrl(base, job.id, { mime: "video/mp4" });
        await store.media.put(upload.path, wav, "video/mp4");
        await workerComplete(base, job.id, { durationSeconds: 1, hasAudio: true });
        completed++;
      }
      return json({ completed });
    }
    if (pathname === "/__e2e/likeness") {
      // What a capture left behind: the consent rows of this workspace and the size of every private file.
      const rows = await store.select("likeness_consents", { org_id: org.id });
      const consents = rows.map((row) => ({ id: row.id, subjectName: row.subject_name, statement: row.statement, passed: row.passed, revokedAt: row.revoked_at, transcript: row.transcript, checks: row.checks }));
      // Each key a consent names, as storage reports it now (asked of the real bucket when one is configured).
      const keys = rows.flatMap((row) => [row.scan_video_key, row.speech_video_key, row.manifest_key, ...Object.values((row.stills ?? {}) as Record<string, string>)]).filter((key): key is string => typeof key === "string");
      const stored = await Promise.all(keys.map(async (key) => ({ key, ...((await files.head(key)) ?? { missing: true }) })));
      return json({ storage: settings.r2 ? `r2:${settings.r2.bucket}` : "memory", consents, files: stored });
    }
    if (pathname === "/__e2e/render-jobs") return json({ count: (await store.select("render_jobs", { org_id: org.id })).length });
    return json({ error: "unknown test control" }, 404);
  }

  return async function handle(request: Request, pathname: string): Promise<Response | null> {
    if (pathname.startsWith("/__e2e/")) return control(request, pathname);
    // Agents (and the reel uploader) reach the same engine through the stateless MCP endpoint.
    if (pathname === "/mcp") return handleMcpRequest(base, request, pathname);
    if (!pathname.startsWith("/v1/")) return null;
    let off = false;
    try { off = plannerOff.has(claims(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "").sub); } catch { /* unauthenticated requests are answered by the engine */ }
    return handleEngineRequest(off ? { ...base, planner: null, config: { ...base.config, llm: null } } : base, request, pathname);
  };
}
