/**
 * TEST-ONLY harness. Mounted by scripts/serve-built.ts solely when FACEFUL_E2E_ENGINE=memory.
 *
 * It runs the REAL domain engine (packages/engine: routing, tenancy, idempotency, versions,
 * render admission, director) against the in-memory store, so browser tests exercise the live
 * transport end to end without Supabase, a model, Stripe or a renderer. Three things are stand-ins:
 *   • sessions: tokens whose payload says `iss: "faceful-e2e"` are accepted without a signature;
 *   • the model: a scripted planner returns fixed proposals (or is switched off per user);
 *   • the renderer: `/__e2e/complete-renders` finishes queued jobs through the real worker protocol
 *     with a one-second silent audio clip standing in for a rendered file;
 *   • the video platforms: YouTube's oEmbed answers with a fixed title and author (video ID AAAAAAAAAAA is
 *     "not found"); every other outside call fails, as if the network were down.
 * Nothing here is imported by application code or by the deployed functions.
 */
import { loadConfig } from "../../../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../../../packages/engine/src/http";
import type { Planner, PlannerOutput } from "../../../packages/engine/src/llm";
import { workerClaim, workerComplete, workerUploadUrl } from "../../../packages/engine/src/render";
import { MemoryMedia, MemoryStore } from "../../../packages/engine/src/store-memory";

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

export function createMemoryEngine(origin: string) {
  const store = new E2EStore(origin);
  const base: HttpDeps = {
    store,
    // `llm` only flips the reported director mode to "ai"; the scripted planner below is what actually answers.
    config: { ...loadConfig({ SUPABASE_URL: "https://e2e.invalid", APP_BASE_URL: origin, RENDER_WORKER_TOKEN: WORKER_TOKEN, RENDER_AVATARS: AVATARS }), llm: { provider: "anthropic", apiKey: "e2e-not-a-key", model: "scripted" } },
    now: () => new Date(),
    verifyAccessToken: async (token) => claims(token),
    fetch: async (input) => {
      const url = new URL(String(input));
      if (url.origin === "https://www.youtube.com" && url.pathname === "/oembed") {
        if (url.searchParams.get("url")?.includes("AAAAAAAAAAA")) return new Response("Not Found", { status: 404 });
        return Response.json({ title: "Stand-in video: five tips in thirty seconds", author_name: "Stand-in Channel", author_url: "https://www.youtube.com/@standin", type: "video" });
      }
      return new Response("{}", { status: 503 });
    },
    planner: scripted,
  };
  const plannerOff = new Set<string>();
  const wav = silentWav();
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

  async function control(request: Request, pathname: string): Promise<Response> {
    if (request.method === "GET" && pathname.startsWith("/__e2e/media/")) {
      const object = store.media.objects.get(decodeURIComponent(pathname.slice("/__e2e/media/".length)));
      if (!object) return new Response("Not found", { status: 404 });
      // Byte ranges, like the real storage: Safari will not play media from a server that cannot serve them.
      const bytes = object.bytes, size = bytes.byteLength;
      const headers = { "Content-Type": "audio/wav", "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
      if (!range) return new Response(bytes, { headers });
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}` } });
    }
    const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    let user: ReturnType<typeof claims>;
    try { user = claims(token); } catch { return json({ error: "e2e session required" }, 401); }
    const body = request.method === "POST" ? await request.json().catch(() => ({})) : {};
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
    if (pathname === "/__e2e/render-jobs") return json({ count: (await store.select("render_jobs", { org_id: org.id })).length });
    return json({ error: "unknown test control" }, 404);
  }

  return async function handle(request: Request, pathname: string): Promise<Response | null> {
    if (pathname.startsWith("/__e2e/")) return control(request, pathname);
    if (!pathname.startsWith("/v1/")) return null;
    let off = false;
    try { off = plannerOff.has(claims(request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "").sub); } catch { /* unauthenticated requests are answered by the engine */ }
    return handleEngineRequest(off ? { ...base, planner: null, config: { ...base.config, llm: null } } : base, request, pathname);
  };
}
