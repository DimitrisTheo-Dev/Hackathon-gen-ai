/**
 * Live integration check of the domain engine against the configured Supabase project:
 * real Auth sessions (JWKS-verified), real Postgres through PostgREST, real RLS, real Storage.
 * It uses two dedicated smoke-test accounts and removes the project it creates.
 *
 *   node --env-file=.env.local --import tsx scripts/smoke-engine.ts
 *
 * Nothing here calls Humanlike, Stripe or a publisher. The storage round trip uploads a few
 * labelled test bytes (not a video) to prove the renderer upload/verify/playback path, then deletes them.
 */
import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { createTokenVerifier } from "../packages/engine/src/runtime";
import { SupabaseStore } from "../packages/engine/src/store-supabase";

const env = process.env;
const url = env.SUPABASE_URL!;
const secret = env.SUPABASE_SECRET_KEY!;
const publishable = env.VITE_SUPABASE_PUBLISHABLE_KEY!;
const password = env.SMOKE_USER_PASSWORD!;
if (!url || !secret || !publishable || !password || !env.SMOKE_USER_EMAIL || !env.SMOKE_USER_B_EMAIL) throw new Error("Set SUPABASE_URL, SUPABASE_SECRET_KEY, VITE_SUPABASE_PUBLISHABLE_KEY and SMOKE_USER_* in .env.local");

const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
async function session(email: string) {
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error && !/already/i.test(created.error.message)) throw created.error;
  if (created.error) {
    // Keep the stored password authoritative for an existing smoke account.
    const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
    const user = data.users.find((entry) => entry.email === email);
    if (user) await admin.auth.admin.updateUserById(user.id, { password });
  }
  const client = createClient(url, publishable, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error ?? new Error("no session");
  return { token: data.session.access_token, client, userId: data.user.id };
}

function deps(extra: Record<string, string> = {}): HttpDeps {
  const config = loadConfig({ ...env, ...extra });
  return { store: new SupabaseStore(url, secret), config, now: () => new Date(), verifyAccessToken: createTokenVerifier(url), fetch, planner: null };
}
async function call(d: HttpDeps, token: string, path: string, body?: unknown) {
  const response = (await handleEngineRequest(d, new Request(`https://local.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }), path))!;
  return { status: response.status, json: (await response.json().catch(() => null)) as any };
}
const key = () => crypto.randomUUID();

const a = await session(env.SMOKE_USER_EMAIL!);
const b = await session(env.SMOKE_USER_B_EMAIL!);
const plain = deps({ RENDER_WORKER_TOKEN: "", RENDER_AVATARS: "" });
const WORKER = `smoke-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const withRenderer = deps({ RENDER_WORKER_TOKEN: WORKER, RENDER_AVATARS: JSON.stringify([{ id: "minas_kontis", name: "Minas (Humanlike head)", languages: ["en", "el"] }]) });
let projectId: string | null = null;
const storagePaths: string[] = [];

try {
  check("rejects a forged token (JWKS signature check)", (await call(plain, `${a.token.slice(0, -6)}AAAAAA`, "/v1/studio/context")).status === 401);
  const context = await call(plain, a.token, "/v1/studio/context");
  check("context for a real Supabase session", context.status === 200 && context.json.capabilities.mode === "live" && context.json.workspace.role === "owner", `workspace “${context.json?.workspace?.name}”`);
  const again = await call(plain, a.token, "/v1/studio/context");
  check("provisioning is idempotent", again.json.workspace.id === context.json.workspace.id);
  check("rendering reported as not connected", context.json.capabilities.canRender === false && typeof context.json.capabilities.renderBlocker === "string");

  const sample = await call(plain, a.token, "/v1/studio/operations/create_sample_project", { operationKey: key() });
  projectId = sample.json?.id ?? null;
  check("sample project persisted with 3 labelled drafts", sample.status === 200 && sample.json.origin === "sample" && sample.json.items.length === 3);
  const item = sample.json.items[0];
  const revise = { contentId: item.id, expectedRevision: 1, operationKey: key(), patch: { script: "A festival day is full of choices. BeWell helps you plan yours." } };
  const saved = await call(plain, a.token, "/v1/studio/operations/revise_content", revise);
  check("revise saves revision 2", saved.status === 200 && saved.json.revision === 2);
  const replay = await call(plain, a.token, "/v1/studio/operations/revise_content", revise);
  check("same operation key replays, no duplicate revision", replay.status === 200 && replay.json.revision === 2);
  const stale = await call(plain, a.token, "/v1/studio/operations/revise_content", { ...revise, operationKey: key() });
  check("stale revision → 409 revision_conflict", stale.status === 409 && stale.json.error.code === "revision_conflict");
  const versions = await call(plain, a.token, `/v1/studio/items/${item.id}/versions`);
  check("both versions retrievable", versions.status === 200 && versions.json.length === 2);
  const reloaded = await call(plain, a.token, `/v1/studio/campaigns/${projectId}`);
  check("state survives a fresh read", reloaded.json.revision === 2 && reloaded.json.items[0].revision === 2 && reloaded.json.activity.length >= 2);

  check("other account cannot list it", !(await call(plain, b.token, "/v1/studio/campaigns")).json.some((entry: any) => entry.id === projectId));
  check("other account cannot read it by ID (404)", (await call(plain, b.token, `/v1/studio/campaigns/${projectId}`)).status === 404);
  check("other account cannot edit it (404)", (await call(plain, b.token, "/v1/studio/operations/revise_content", { ...revise, operationKey: key(), expectedRevision: 2 })).status === 404);

  // RLS, straight through PostgREST with the browser's publishable key and the member's own JWT.
  const mine = await a.client.from("projects").select("id,org_id");
  check("RLS: member reads only their own org's projects", !mine.error && mine.data!.some((row) => row.id === projectId) && new Set(mine.data!.map((row) => row.org_id)).size === 1);
  const theirs = await b.client.from("projects").select("id").eq("id", projectId!);
  check("RLS: another member sees zero rows for it", !theirs.error && theirs.data!.length === 0);
  check("RLS: browser cannot write projects", Boolean((await a.client.from("projects").update({ title: "hacked" }).eq("id", projectId!).select()).error));
  check("RLS: credit ledger is not readable by browsers", Boolean((await a.client.from("credit_ledger").select("*")).error));
  check("RLS: agent tokens are not readable by browsers", Boolean((await a.client.from("agent_connections").select("*")).error));
  const chat = await a.client.from("castroom_director_access").select("campaign_id").eq("campaign_id", projectId!);
  check("conversation access was provisioned by the engine", !chat.error && chat.data!.length === 1);

  const find = await call(plain, a.token, "/v1/studio/director/turn", { campaignId: null, itemId: null, scope: "item", instruction: "Find my latest BeWell video and play it.", sourceIds: [], history: [], operationKey: key() });
  check("director retrieval opens existing content without generation", find.status === 200 && find.json.open?.campaignId === projectId && find.json.open.play === false && /Nothing was generated|No generation/.test(find.json.summary), find.json?.summary);

  const billing = await call(plain, a.token, "/v1/studio/billing");
  check("billing status from server truth", billing.status === 200 && Number.isInteger(billing.json.creditBalance), `mode ${billing.json?.mode}, ${billing.json?.creditBalance} credits`);
  const refused = await call(plain, a.token, "/v1/studio/operations/render_content", { campaignId: projectId, itemIds: [item.id], expectedRevisions: { [item.id]: 2 }, operationKey: key() });
  check("render refused honestly when no renderer is attached (503)", refused.status === 503 && refused.json.error.code === "provider_unavailable");

  // Renderer protocol against real Storage, using an isolated one-off worker credential.
  const worker = (path: string, body: unknown) => call(withRenderer, WORKER, path, body);
  const picked = await call(withRenderer, a.token, "/v1/studio/operations/revise_content", { contentId: item.id, expectedRevision: 2, operationKey: key(), patch: { avatarId: "minas_kontis" } });
  check("presenter from the configured catalog can be selected", picked.status === 200 && picked.json.avatarId === "minas_kontis");
  const before = (await call(withRenderer, a.token, "/v1/studio/billing")).json.creditBalance;
  const queued = await call(withRenderer, a.token, "/v1/studio/operations/render_content", { campaignId: projectId, itemIds: [item.id], expectedRevisions: { [item.id]: 3 }, operationKey: key() });
  check("render admitted and one credit held atomically (Postgres function)", queued.status === 200 && queued.json.jobIds.length === 1 && (await call(withRenderer, a.token, "/v1/studio/billing")).json.creditBalance === before - 1);
  const jobId = queued.json.jobIds[0];
  const claim = await worker("/v1/worker/render/claim", { workerId: "smoke" });
  check("worker claims the queued job", claim.json.job?.id === jobId, `claimed ${claim.json.job?.id === jobId ? "the smoke job" : "a different job"}`);
  const early = await worker(`/v1/worker/render/${jobId}/complete`, { durationSeconds: 1, hasAudio: false });
  check("completion without an uploaded file is refused", early.status === 400);
  const upload = await worker(`/v1/worker/render/${jobId}/upload-url`, { mime: "video/mp4" });
  storagePaths.push(upload.json.path);
  const bytes = new TextEncoder().encode(`faceful storage smoke test ${new Date().toISOString()} — not a video`);
  const put = await fetch(upload.json.uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes });
  check("signed upload URL accepts the renderer's PUT", put.ok, `HTTP ${put.status}`);
  const complete = await worker(`/v1/worker/render/${jobId}/complete`, { durationSeconds: 1, hasAudio: false });
  check("completion verified against the stored object", complete.status === 200 && complete.json.state === "succeeded", JSON.stringify(complete.json).slice(0, 160));
  const ready = await call(withRenderer, a.token, `/v1/studio/campaigns/${projectId}`);
  const media = ready.json.items[0].media;
  check("item is ready with a signed playback URL", ready.json.items[0].status === "ready" && Boolean(media?.url) && media.revision === 3);
  if (media?.url) {
    const playback = await fetch(media.url);
    const body = new Uint8Array(await playback.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", body)), (byte) => byte.toString(16).padStart(2, "0")).join("");
    check("signed URL serves exactly the uploaded bytes (sha256 matches)", playback.ok && digest === media.sha256);
    check("media is private without the signature", !(await fetch(media.url.split("?")[0])).ok);
  }
  const status = await call(withRenderer, a.token, `/v1/studio/jobs/${jobId}`);
  check("job status and event trail readable", status.json.status === "succeeded" && status.json.events.map((entry: any) => entry.type).join(",") === "queued,claimed,succeeded", status.json?.events?.map((entry: any) => entry.type).join(" → "));
} finally {
  // Remove everything this run created. The smoke accounts and their personal workspaces remain.
  const store = new SupabaseStore(url, secret);
  for (const path of storagePaths) await store.media.remove(path).catch(() => undefined);
  if (projectId) {
    await store.remove("castroom_director_access", { campaign_id: projectId }).catch(() => undefined);
    await store.remove("projects", { id: projectId }).catch(() => undefined);
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length}/${results.length} live checks passed${failed.length ? ` — FAILED: ${failed.map((entry) => entry.check).join("; ")}` : ""}`);
  process.exitCode = failed.length ? 1 : 0;
}
