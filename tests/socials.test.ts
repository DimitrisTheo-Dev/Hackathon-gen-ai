import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { processDuePublishJobs, verifySubmittedPublishJobs } from "../packages/engine/src/schedule";
import { signSocialWebhook, webhookAdapters } from "../packages/engine/src/socials-events";
import { instagramTiming } from "../packages/engine/src/socials-instagram";
import { MemoryStore } from "../packages/engine/src/store-memory";
import { ApiError } from "../apps/web/src/data/client";
import { createSocialsApi } from "../apps/web/src/socials/api";
import { accountSource, cancelledNote, managedHere, settingsTabFrom, webhookAcceptance } from "../apps/web/src/socials/model";

/** /v1/socials on the real engine, with an in-memory store and a stand-in for Buffer's GraphQL API. "user:<id>" stands in for a verified session. */
const BASE = "https://faceful.test";
const CREDENTIAL_KEY = "ab".repeat(32);
const WEBHOOK_SECRET = "s".repeat(40);
const BUFFER_KEY = "buffer-personal-key-0123456789";
const INSTAGRAM_ID = "17841400000000000";
const switchedOn = { SOCIALS_CREDENTIAL_KEY: CREDENTIAL_KEY, SOCIALS_WEBHOOK_SECRET: WEBHOOK_SECRET };
/** Every platform's own webhook credentials, as a deployment with its own platform apps would have them. */
const HUB_SECRET = "y".repeat(40);
const NATIVE = {
  ...switchedOn,
  INSTAGRAM_APP_SECRET: "ig-app-secret",
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: "ig-verify-token",
  WHATSAPP_APP_SECRET: "wa-app-secret",
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: "wa-verify-token",
  TIKTOK_CLIENT_SECRET: "tiktok-client-secret",
  LINKEDIN_CLIENT_SECRET: "linkedin-client-secret",
  YOUTUBE_WEBHOOK_SECRET: HUB_SECRET,
};
const hmac = (algorithm: "sha256" | "sha1", secret: string, message: string) => createHmac(algorithm, secret).update(message).digest("hex");

function buffer() {
  const channel = (id: string, service: string, serviceId: string, extra: Record<string, unknown> = {}) => ({ id, name: `${service}-handle`, displayName: `Faceful on ${service}`, service, serviceId, externalLink: `https://${service}.com/faceful`, isDisconnected: false, isLocked: false, ...extra });
  const state = {
    channels: [channel("ch_ig", "instagram", INSTAGRAM_ID), channel("ch_li", "linkedin", "urn:li:organization:1", { displayName: null }), channel("ch_yt", "youtube", "UC123", { isLocked: true }), channel("ch_fb", "facebook", "fb1")],
    posts: new Map<string, Record<string, any>>(),
    requests: [] as Array<{ query: string; variables: any }>,
    fail: null as null | "network" | "rate",
  };
  const answer = (data: unknown, code?: string) => Response.json(code ? { data: null, errors: [{ message: code, extensions: { code } }] } : { data });
  const fetch = (async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), "https://api.buffer.com");
    const { query, variables } = JSON.parse(String(init?.body));
    state.requests.push({ query, variables });
    if (state.fail === "network") throw new Error("socket hang up");
    if (state.fail === "rate") return answer(null, "RATE_LIMIT_EXCEEDED");
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${BUFFER_KEY}`) return answer(null, "UNAUTHORIZED");
    if (query.includes("organizations")) return answer({ account: { organizations: [{ id: "org_1" }] } });
    if (query.includes("channels(")) return answer({ channels: state.channels });
    if (query.includes("createPost")) {
      const id = `post_${state.posts.size + 1}`;
      state.posts.set(id, { status: "sending", externalLink: null, sentAt: null, error: null });
      return answer({ createPost: { post: { id, status: "sending", externalLink: null } } });
    }
    if (query.includes("post(")) return answer({ post: state.posts.get(variables.input.id) });
    throw new Error(`unexpected Buffer query: ${query}`);
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

/** This deployment's own Instagram app, as "Business login settings" in the Meta app shows it. */
const LOGIN = { ...switchedOn, INSTAGRAM_LOGIN_APP_ID: "990602627938098", INSTAGRAM_LOGIN_APP_SECRET: "ig-login-secret" };

/** A stand-in for Instagram's sign-in and Graph API, answering in the shapes Meta's documentation shows. */
function instagram() {
  const state = {
    /** One-time codes waiting to be exchanged, as if a person had just allowed access. */
    codes: new Set(["code-1", "code-2"]),
    containers: new Map<string, { status_code: string; input: any; checks: number; media?: string }>(),
    /** How many status checks a new video stays IN_PROGRESS for. */
    processing: 0,
    /** "lost": the publish goes through but its answer never arrives. */
    publishAnswer: "normal" as "normal" | "lost",
    revoked: false,
    subscribed: [] as string[],
    requests: [] as Array<{ method: string; path: string; token: string | null; body: any }>,
  };
  const oauth = (code: number, message: string, extra: Record<string, unknown> = {}) => Response.json({ error: { message, type: "OAuthException", code, ...extra } }, { status: 400 });
  const fetch = (async (url: unknown, init?: RequestInit) => {
    const target = new URL(String(url));
    const method = init?.method ?? "GET";
    const raw = typeof init?.body === "string" ? init.body : "";
    const body = raw.startsWith("{") ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? target.searchParams.get("access_token");
    const path = target.pathname.replace(/^\/v27\.0/, "");
    state.requests.push({ method, path: `${target.host}${path}`, token, body });
    if (target.host === "api.instagram.com") {
      if (body.client_id !== LOGIN.INSTAGRAM_LOGIN_APP_ID || body.client_secret !== LOGIN.INSTAGRAM_LOGIN_APP_SECRET || body.grant_type !== "authorization_code" || body.redirect_uri !== `${BASE}/v1/socials/providers/instagram/callback`)
        return Response.json({ error_type: "OAuthException", code: 400, error_message: "Invalid request" }, { status: 400 });
      if (!state.codes.delete(body.code)) return Response.json({ error_type: "OAuthException", code: 400, error_message: "Matching code was not found or was already used" }, { status: 400 });
      return Response.json({ data: [{ access_token: "short-token", user_id: "1020", permissions: "instagram_business_basic,instagram_business_content_publish" }] });
    }
    assert.equal(target.host, "graph.instagram.com");
    if (path === "/access_token") return target.searchParams.get("client_secret") === LOGIN.INSTAGRAM_LOGIN_APP_SECRET && token === "short-token" ? Response.json({ access_token: "long-token-1", token_type: "bearer", expires_in: 5183944 }) : oauth(190, "Invalid token");
    if (state.revoked || !token?.startsWith("long-token-")) return oauth(190, "Error validating access token: the user has not authorized application");
    if (path === "/refresh_access_token") return Response.json({ access_token: `long-token-${Number(token.split("-")[2]) + 1}`, token_type: "bearer", expires_in: 5183944 });
    if (path === "/me") return Response.json({ data: [{ user_id: INSTAGRAM_ID, username: "faceful" }] });
    if (path === "/me/subscribed_apps") {
      state.subscribed.push(target.searchParams.get("subscribed_fields") ?? "");
      return Response.json({ success: true });
    }
    if (path === "/me/media" && method === "POST") {
      const id = `1788961569192${state.containers.size}`;
      state.containers.set(id, { status_code: "FINISHED", input: body, checks: 0 });
      return Response.json({ id });
    }
    if (path === "/me/media_publish" && method === "POST") {
      const container = state.containers.get(body.creation_id);
      if (!container || container.status_code !== "FINISHED" || container.checks < state.processing) return oauth(9007, "The media is not ready for publishing, please wait for a moment", { error_subcode: 2207027 });
      Object.assign(container, { status_code: "PUBLISHED", media: `1792023842203${state.containers.size}` });
      if (state.publishAnswer === "lost") throw new Error("socket hang up");
      return Response.json({ id: container.media });
    }
    const container = state.containers.get(path.slice(1));
    if (container) return Response.json({ id: path.slice(1), status_code: container.status_code === "FINISHED" && container.checks++ < state.processing ? "IN_PROGRESS" : container.status_code });
    if (target.searchParams.get("fields") === "permalink") return Response.json({ id: path.slice(1), permalink: `https://www.instagram.com/reel/${path.slice(1)}/` });
    throw new Error(`unexpected Instagram request: ${method} ${target.pathname}`);
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

function engine(env: Record<string, string> = switchedOn) {
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  const remote = buffer();
  const meta = instagram();
  const store = new MemoryStore();
  // Rate-limit windows follow the test's clock, as the database's would follow real time.
  store.clock = () => new Date(clock);
  /** What the engine asked Google's hub for (YouTube). Instagram and Buffer each have their stand-in. */
  const hub: URLSearchParams[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
    if (/^https:\/\/(api|graph)\.instagram\.com\//.test(String(url))) return meta.fetch(url as string, init);
    if (String(url) !== "https://pubsubhubbub.appspot.com/subscribe") return remote.fetch(url as string, init);
    hub.push(new URLSearchParams(String(init?.body)));
    return new Response(null, { status: 202 });
  }) as typeof globalThis.fetch;
  const deps: HttpDeps = {
    store,
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: BASE, ...env }),
    now: () => new Date(clock),
    verifyAccessToken: async (token) => {
      const [kind, id, client] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: client ?? null };
    },
    fetch,
    planner: null,
  };
  const call = async (path: string, init: { as?: string; method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.as) headers.authorization = `Bearer ${init.as}`;
    const method = init.method ?? "GET";
    const body = init.raw ?? (method === "POST" ? JSON.stringify(init.body ?? {}) : undefined);
    const response = await handleEngineRequest(deps, new Request(`${BASE}${path}`, { method, headers, body }), path.split("?")[0]);
    const text = await response!.text();
    return { status: response!.status, text, body: (text.startsWith("{") ? JSON.parse(text) : null) as any, location: response!.headers.get("location") };
  };
  /** Signs in to Instagram the way a person does: start in the studio, allow access at Instagram, come back with its one-time code. */
  const signIn = async (code: string, as = "user:u1") => {
    const started = await call("/v1/socials/providers/instagram/connect", { as, method: "POST" });
    assert.equal(started.status, 200, started.text);
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    return { state, authorizeUrl: started.body.authorizeUrl as string, finish: () => call("/v1/socials/providers/instagram/complete", { as, method: "POST", body: { code, state } }) };
  };
  /** An approved, rendered post waiting for its time, for `accountId`. Returns a reader for the job as it changes. */
  let minute = 0;
  const due = async (accountId: string, payload: Record<string, unknown> = {}) => {
    const [org] = await store.select("organizations", { personal_owner_id: "u1" });
    const item = { id: crypto.randomUUID(), org_id: org.id, approved_revision: 3 };
    const asset = { id: crypto.randomUUID(), org_id: org.id, sha256: "f".repeat(64), storage_path: `orgs/${org.id}/${crypto.randomUUID()}.mp4` };
    await store.insert("content_items", item);
    await store.insert("media_assets", asset);
    await store.media.put(asset.storage_path, new Uint8Array([1, 2, 3]), "video/mp4");
    const job = { id: crypto.randomUUID(), org_id: org.id, item_id: item.id, revision: 3, media_asset_id: asset.id, platform: "instagram", account_id: accountId, scheduled_at: new Date(Date.parse("2026-11-15T09:00:00.000Z") + minute++ * 60_000).toISOString(), payload: { caption: "Hello from Faceful", title: "", visibility: "public", aiDisclosure: true, assetHash: asset.sha256, ...payload }, state: "scheduled", attempt: 0, next_attempt_at: null, provider_post_id: null, published_url: null, published_at: null, error: null, updated_at: new Date(clock).toISOString() };
    await store.insert("publish_jobs", job);
    return async () => (await store.select("publish_jobs", { id: job.id }))[0];
  };
  const connect = async (as = "user:u1") => {
    const connected = await call("/v1/socials/providers/buffer/connect", { as, method: "POST", body: { apiKey: BUFFER_KEY } });
    assert.equal(connected.status, 200, connected.text);
    return connected.body.accounts as Array<{ id: string; platform: string; state: string; displayName: string }>;
  };
  /** Sends one delivery the way a sender does: the exact bytes, signed with the shared secret at `signedAt`. */
  const deliver = (platform: string, payload: unknown, options: { secret?: string; signedAt?: Date; unsigned?: boolean } = {}) => {
    const raw = JSON.stringify(payload);
    const headers = options.unsigned ? {} : { "x-faceful-signature": signSocialWebhook(options.secret ?? WEBHOOK_SECRET, raw, options.signedAt ?? new Date(clock)) };
    return call(`/v1/socials/${platform}/webhook`, { method: "POST", raw, headers });
  };
  /** A connected account placed straight into the first person's workspace, as Faceful's own integration would leave it. */
  const own = async (platform: string, externalAccountId: string) => {
    await call("/v1/socials", { as: "user:u1" });
    const [org] = await store.select("organizations", { personal_owner_id: "u1" });
    const now = new Date(clock).toISOString();
    return store.insert("provider_connections", { id: crypto.randomUUID(), org_id: org.id, platform, provider: "direct", display_name: `${platform} account`, external_account_id: externalAccountId, provider_account_id: null, profile_url: null, state: "connected", scopes: [], credentials_ciphertext: null, created_by: "u1", created_at: now, updated_at: now });
  };
  /** A delivery in a platform's own format: its exact bytes and its own signature header. */
  const send = (platform: string, raw: string, headers: Record<string, string>) => call(`/v1/socials/${platform}/webhook`, { method: "POST", raw, headers });
  const activity = async (query = "") => (await call(`/v1/socials/events${query}`, { as: "user:u1" })).body.events as any[];
  return { deps, store, remote, meta, hub, call, connect, signIn, due, deliver, own, send, activity, advance: (minutes: number) => (clock += minutes * 60_000) };
}

test("the catalog lists every platform and provider, and nothing connects until the deployment switches it on", async () => {
  const { call } = engine({});
  assert.equal((await call("/v1/socials")).status, 401);
  const catalog = await call("/v1/socials", { as: "user:u1" });
  assert.equal(catalog.status, 200, catalog.text);
  assert.deepEqual(catalog.body.platforms.map((platform: any) => platform.id), ["tiktok", "instagram", "linkedin", "youtube", "whatsapp"]);
  const whatsapp = catalog.body.platforms.find((platform: any) => platform.id === "whatsapp");
  assert.deepEqual([whatsapp.kind, whatsapp.providers, whatsapp.accounts], ["messaging", [], []]);
  const instagram = catalog.body.platforms.find((platform: any) => platform.id === "instagram");
  // Instagram can be reached two ways: through Buffer, or directly by signing in to Instagram.
  assert.deepEqual([instagram.kind, instagram.providers, instagram.webhookUrl], ["social", ["buffer", "instagram"], `${BASE}/v1/socials/instagram/webhook`]);
  assert.deepEqual(catalog.body.providers, [
    { id: "buffer", label: "Buffer", platforms: ["tiktok", "instagram", "linkedin", "youtube"], connect: "credentials", available: false, connected: false },
    { id: "instagram", label: "Instagram", platforms: ["instagram"], connect: "sign_in", available: false, connected: false },
  ]);

  assert.equal((await call("/v1/socials/linkedin", { as: "user:u1" })).body.label, "LinkedIn");
  assert.equal((await call("/v1/socials/myspace", { as: "user:u1" })).status, 404);

  const refused = await call("/v1/socials/providers/buffer/connect", { as: "user:u1", method: "POST", body: { apiKey: BUFFER_KEY } });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, "provider_unavailable");
  const off = (await call("/v1/health")).body;
  assert.deepEqual([off.publishing.adapters, off.socials], [[], { connections: false, webhooks: false, nativeWebhooks: [] }]);
  const on = (await engine().call("/v1/health")).body;
  assert.deepEqual([on.publishing.adapters, on.socials], [["buffer"], { connections: true, webhooks: true, nativeWebhooks: [] }]);
  // The direct Instagram connection counts as a way to post only once this deployment has its own Instagram app.
  assert.deepEqual((await engine(LOGIN).call("/v1/health")).body.publishing.adapters, ["buffer", "instagram"]);
  // Each platform's own format is switched on by that platform's credentials, and shows on its entry.
  const native = engine(NATIVE);
  assert.deepEqual((await native.call("/v1/health")).body.socials.nativeWebhooks, ["instagram", "whatsapp", "tiktok", "linkedin", "youtube"]);
  assert.deepEqual([instagram.nativeWebhook, (await native.call("/v1/socials/instagram", { as: "user:u1" })).body.nativeWebhook], [false, true]);
});

test("connecting Buffer is an owner's act; it keeps the accounts this studio uses and never the key in the clear", async () => {
  const { call, connect, store, remote, due, own } = engine();
  const input = { apiKey: BUFFER_KEY };
  // An agent acting for the same person cannot connect accounts, and a bad key or an unknown field is refused.
  const agent = await call("/v1/socials/providers/buffer/connect", { as: "user:u1:claude-code", method: "POST", body: input });
  assert.deepEqual([agent.status, agent.body.error.code], [403, "approval_required"]);
  const wrongKey = await call("/v1/socials/providers/buffer/connect", { as: "user:u1", method: "POST", body: { apiKey: "not-the-right-key-000000" } });
  assert.deepEqual([wrongKey.status, wrongKey.body.error.code], [403, "forbidden"]);
  assert.equal((await call("/v1/socials/providers/buffer/connect", { as: "user:u1", method: "POST", body: { ...input, admin: true } })).status, 400);
  assert.equal((await call("/v1/socials/providers/nope/connect", { as: "user:u1", method: "POST", body: input })).status, 404);
  assert.equal((await store.select("provider_connections", {})).length, 0);

  const connected = await call("/v1/socials/providers/buffer/connect", { as: "user:u1", method: "POST", body: input });
  assert.equal(connected.status, 200, connected.text);
  // Facebook is not a platform here yet, so it is left out; a channel locked in Buffer is listed but unavailable.
  assert.deepEqual(connected.body.accounts.map((account: any) => [account.platform, account.state, account.displayName]), [
    ["instagram", "connected", "Faceful on instagram"],
    ["linkedin", "connected", "linkedin-handle"],
    ["youtube", "unavailable", "Faceful on youtube"],
  ]);
  const rows = await store.select("provider_connections", {});
  assert.ok(!connected.text.includes(BUFFER_KEY) && !JSON.stringify(rows).includes(BUFFER_KEY), "the key is never returned or stored in the clear");
  const instagram = rows.find((row) => row.platform === "instagram")!;
  assert.deepEqual([instagram.provider, instagram.provider_account_id, instagram.external_account_id], ["buffer", "ch_ig", INSTAGRAM_ID]);
  assert.match(instagram.credentials_ciphertext, /^v1\./);
  assert.ok((await store.select("audit_events", {})).some((event) => event.action === "Connected Buffer" && event.outcome === "2 account(s) available"));

  // Another person's workspace sees none of it, and the studio still loads with a LinkedIn account it cannot schedule to.
  const other = await call("/v1/socials", { as: "user:u2" });
  assert.ok(other.body.platforms.every((platform: any) => platform.accounts.length === 0) && other.body.providers[0].connected === false);
  const studio = await call("/v1/studio/context", { as: "user:u1" });
  assert.equal(studio.status, 200, studio.text);
  assert.deepEqual(studio.body.channels.map((channel: any) => [channel.platform, channel.state]).sort(), [["instagram", "connected"], ["tiktok", "unavailable"], ["youtube", "unavailable"]]);

  // Refreshing follows Buffer: a renamed channel is renamed, a removed one stays but cannot be posted to.
  remote.state.channels = remote.state.channels.filter((channel) => channel.id !== "ch_li").map((channel) => (channel.id === "ch_ig" ? { ...channel, displayName: "Faceful HQ" } : channel));
  const synced = await call("/v1/socials/providers/buffer/sync", { as: "user:u1", method: "POST" });
  assert.deepEqual(synced.body.accounts.map((account: any) => [account.platform, account.state, account.displayName]), [
    ["instagram", "connected", "Faceful HQ"],
    ["linkedin", "unavailable", "linkedin-handle"],
    ["youtube", "unavailable", "Faceful on youtube"],
  ]);
  assert.equal((await call("/v1/socials/providers/buffer/sync", { as: "user:u2", method: "POST" })).status, 404);

  // Removing: one account, then the provider. A post still waiting for a removed account is cancelled, not left to
  // fail. Someone else's account is not found here, and neither is a channel connected with Google: that one is
  // disconnected where it was connected, where Google's access is withdrawn too.
  const [first] = await connect();
  const waiting = await due(first.id);
  const channel = await own("youtube", "UCconnectedWithGoogle");
  assert.equal((await call(`/v1/socials/accounts/${first.id}`, { as: "user:u2", method: "DELETE" })).status, 404);
  assert.equal((await call(`/v1/socials/accounts/${channel.id}`, { as: "user:u1", method: "DELETE" })).status, 404);
  assert.deepEqual((await call(`/v1/socials/accounts/${first.id}`, { as: "user:u1", method: "DELETE" })).body, { removed: true, cancelledPosts: 1 });
  assert.deepEqual([(await waiting()).state, (await waiting()).error], ["cancelled", "The account was disconnected before this post was sent."]);
  assert.deepEqual((await call("/v1/socials/providers/buffer", { as: "user:u1", method: "DELETE" })).body, { removed: 2, cancelledPosts: 0 });
  assert.deepEqual((await store.select("provider_connections", {})).map((row) => row.provider), ["direct"]);
});

test("an approved post goes out through the account's provider, and counts as published only when Buffer says so", async () => {
  const { deps, store, remote, call, connect } = engine();
  const account = (await connect()).find((entry) => entry.platform === "instagram")!;
  const [org] = await store.select("organizations", {});
  const item = { id: crypto.randomUUID(), org_id: org.id, approved_revision: 3 };
  const asset = { id: crypto.randomUUID(), org_id: org.id, sha256: "f".repeat(64), storage_path: `orgs/${org.id}/video.mp4` };
  await store.insert("content_items", item);
  await store.insert("media_assets", asset);
  await store.media.put(asset.storage_path, new Uint8Array([1, 2, 3]), "video/mp4");
  let minute = 0;
  const schedule = async (payload: Record<string, unknown> = {}) => {
    const job = { id: crypto.randomUUID(), org_id: org.id, item_id: item.id, revision: 3, media_asset_id: asset.id, platform: "instagram", account_id: account.id, scheduled_at: new Date(Date.parse("2026-11-15T09:00:00.000Z") + minute++ * 60_000).toISOString(), payload: { caption: "Hello from Faceful", title: "", visibility: "public", aiDisclosure: true, assetHash: asset.sha256, ...payload }, state: "scheduled", attempt: 0, next_attempt_at: null, provider_post_id: null, published_url: null, published_at: null, error: null, updated_at: deps.now().toISOString() };
    await store.insert("publish_jobs", job);
    return async () => (await store.select("publish_jobs", { id: job.id }))[0];
  };
  const posts = () => remote.state.requests.filter((request) => request.query.includes("createPost"));

  const sent = await schedule();
  assert.deepEqual(await processDuePublishJobs(deps), { processed: 1, submitted: 1, failed: 0, retried: 0, unknown: 0, verified: 0, swept: 0 });
  const { input } = posts()[0].variables;
  assert.deepEqual([input.channelId, input.text, input.mode, input.schedulingType], ["ch_ig", "Hello from Faceful", "shareNow", "automatic"]);
  assert.match(input.assets[0].video.url, /^https:\/\/media\.test\//);
  assert.deepEqual(input.metadata, { instagram: { type: "reel", shouldShareToFeed: true, isAiGenerated: true } });
  assert.deepEqual([(await sent()).state, (await sent()).provider_post_id], ["submitted", "post_1"]);

  // Still sending: nothing is claimed. Once Buffer reports it sent, the job is published and joins the account's activity.
  assert.deepEqual(await verifySubmittedPublishJobs(deps), { checked: 1, verified: 0, failed: 0 });
  assert.equal((await sent()).state, "submitted");
  Object.assign(remote.state.posts.get("post_1")!, { status: "sent", externalLink: "https://instagram.com/reel/abc", sentAt: "2026-11-15T10:00:30.000Z" });
  assert.deepEqual(await verifySubmittedPublishJobs(deps), { checked: 1, verified: 1, failed: 0 });
  const published = await sent();
  assert.deepEqual([published.state, published.published_url, published.published_at], ["verified_published", "https://instagram.com/reel/abc", "2026-11-15T10:00:30.000Z"]);
  const activity = await call("/v1/socials/events?type=post.created", { as: "user:u1" });
  assert.deepEqual(activity.body.events.map((event: any) => [event.source, event.accountId, event.subject.url, event.text]), [["buffer", account.id, "https://instagram.com/reel/abc", "Hello from Faceful"]]);

  // Buffer cannot post privately to Instagram, so a post approved as private is refused before anything is sent.
  const hidden = await schedule({ visibility: "private" });
  await processDuePublishJobs(deps);
  assert.equal(posts().length, 1);
  assert.deepEqual([(await hidden()).state, /only post publicly/.test((await hidden()).error)], ["failed", true]);

  // An unclear outcome is never retried (it could post twice); a rate limit is, because nothing was accepted.
  remote.state.fail = "network";
  const unclear = await schedule();
  assert.deepEqual(await processDuePublishJobs(deps), { processed: 1, submitted: 0, failed: 1, retried: 0, unknown: 0, verified: 0, swept: 0 });
  assert.match((await unclear()).error, /did not confirm/);
  remote.state.fail = "rate";
  const limited = await schedule();
  assert.deepEqual(await processDuePublishJobs(deps), { processed: 1, submitted: 0, failed: 0, retried: 1, unknown: 0, verified: 0, swept: 0 });
  assert.deepEqual([(await limited()).state, Boolean((await limited()).next_attempt_at)], ["scheduled", true]);
});

test("deliveries are signed, stored once, matched to the workspace that owns the account, and read by its members only", async () => {
  const { call, connect, deliver, store, advance } = engine();
  const accounts = await connect();
  const account = { externalAccountId: INSTAGRAM_ID };
  const events = [
    { id: "c1", type: "comment.created", ...account, occurredAt: "2026-11-15T09:59:00.000Z", actor: { id: "u9", name: "Maria" }, subject: { id: "c1", parentId: "media_7" }, text: "Love this!" },
    { id: "l1", type: "like.created", ...account, actor: { id: "u9" }, subject: { id: "media_7" } },
    { id: "m1", type: "message.received", accountId: accounts.find((entry) => entry.platform === "instagram")!.id, text: "Do you ship to Greece?" },
    { id: "s1", type: "story.created", ...account, subject: { id: "story_1", url: "https://instagram.com/stories/faceful/1" } },
    { id: "x1", type: "comment.created", externalAccountId: "someone-elses-account", text: "not ours" },
  ];
  // No signature, the wrong secret, or a signature older than five minutes: refused, and nothing is stored.
  // Without the generic signature header a delivery is taken as Instagram's own format, which is not switched on here.
  assert.equal((await deliver("instagram", { events }, { unsigned: true })).status, 503);
  assert.equal((await deliver("instagram", { events }, { secret: "x".repeat(40) })).status, 401);
  assert.equal((await deliver("instagram", { events }, { signedAt: new Date(Date.parse("2026-11-15T09:50:00.000Z")) })).status, 401);
  assert.equal((await engine({ SOCIALS_CREDENTIAL_KEY: CREDENTIAL_KEY }).deliver("instagram", { events })).status, 503);
  assert.equal((await store.select("social_events", {})).length, 0);

  const first = await deliver("instagram", { source: "faceful", events });
  assert.deepEqual([first.status, first.body], [200, { received: 5, stored: 4, duplicates: 0, unmatched: 1 }]);
  advance(1);
  assert.deepEqual((await deliver("instagram", { source: "faceful", events })).body, { received: 5, stored: 0, duplicates: 4, unmatched: 1 });
  // The address names the platform: an Instagram account's event sent to LinkedIn's address matches nothing.
  assert.deepEqual((await deliver("linkedin", { events: [events[0]] })).body, { received: 1, stored: 0, duplicates: 0, unmatched: 1 });
  assert.equal((await deliver("instagram", { events: [{ id: "z", type: "comment.exploded", ...account }] })).status, 400);
  assert.equal((await deliver("instagram", { events: [{ id: "z", type: "comment.created" }] })).status, 400);
  assert.equal((await deliver("myspace", { events })).status, 404);
  assert.equal((await call("/v1/socials/instagram/webhook")).status, 404);

  const all = await call("/v1/socials/events", { as: "user:u1" });
  assert.deepEqual(all.body.events.map((event: any) => event.type).sort(), ["comment.created", "like.created", "message.received", "story.created"]);
  const comment = (await call("/v1/socials/events?type=comment.created&platform=instagram", { as: "user:u1" })).body.events[0];
  assert.deepEqual([comment.source, comment.externalId, comment.occurredAt, comment.actor, comment.subject, comment.text], ["faceful", "c1", "2026-11-15T09:59:00.000Z", { id: "u9", name: "Maria", url: null }, { id: "c1", url: null, parentId: "media_7" }, "Love this!"]);
  // Paging walks back through one delivery without skipping or repeating anything.
  const page = (await call("/v1/socials/events?limit=2", { as: "user:u1" })).body;
  const rest = (await call(`/v1/socials/events?limit=2&before=${encodeURIComponent(page.nextBefore)}`, { as: "user:u1" })).body;
  assert.deepEqual([...page.events, ...rest.events].map((event: any) => event.externalId), ["s1", "m1", "l1", "c1"]);
  assert.equal((await call("/v1/socials/events?colour=blue", { as: "user:u1" })).status, 400);
  // Private messages are in here: another workspace reads nothing, and an agent is not let in at all.
  assert.deepEqual((await call("/v1/socials/events", { as: "user:u2" })).body.events, []);
  assert.equal((await call("/v1/socials/events", { as: "user:u1:claude-code" })).status, 403);

  // The platform says access was withdrawn: the account stops being schedulable until it is connected again.
  await deliver("instagram", { events: [{ id: "d1", type: "account.disconnected", ...account }] });
  assert.equal((await call("/v1/socials/instagram", { as: "user:u1" })).body.accounts[0].state, "expired");
});

test("a platform's own delivery format replaces the generic one for that platform only", async () => {
  const { call, connect, store } = engine();
  await connect();
  const original = webhookAdapters.instagram;
  webhookAdapters.instagram = {
    source: "instagram",
    handshake: (_deps, query) => (query.get("hub.verify_token") === "expected" ? { body: query.get("hub.challenge") ?? "", contentType: "text/plain; charset=utf-8" } : null),
    verify: (_deps, headers) => headers.get("x-hub-signature-256") === "sha256=valid",
    parse: (raw) => ({ events: JSON.parse(raw).entry.map((entry: any) => ({ id: entry.comment, type: "comment.created" as const, externalAccountId: entry.id, text: entry.text })) }),
  };
  try {
    assert.equal((await call("/v1/socials/instagram/webhook?hub.verify_token=expected&hub.challenge=12345")).text, "12345");
    assert.equal((await call("/v1/socials/instagram/webhook?hub.verify_token=wrong&hub.challenge=12345")).status, 404);
    const raw = JSON.stringify({ entry: [{ id: INSTAGRAM_ID, comment: "native-1", text: "From Instagram itself" }] });
    assert.equal((await call("/v1/socials/instagram/webhook", { method: "POST", raw, headers: { "x-hub-signature-256": "sha256=forged" } })).status, 401);
    assert.deepEqual((await call("/v1/socials/instagram/webhook", { method: "POST", raw, headers: { "x-hub-signature-256": "sha256=valid" } })).body, { received: 1, stored: 1, duplicates: 0, unmatched: 0 });
    assert.deepEqual((await store.select("social_events", {})).map((event) => [event.source, event.text]), [["instagram", "From Instagram itself"]]);
    // Another platform is not affected: TikTok's own format is not switched on in this engine.
    assert.equal((await call("/v1/socials/tiktok/webhook", { method: "POST", raw, headers: { "x-hub-signature-256": "sha256=valid" } })).status, 503);
  } finally {
    webhookAdapters.instagram = original;
  }
});

test("Instagram's own format: the address is confirmed with the verify token, and comments, mentions and messages are read from Meta's signed payload", async () => {
  const { call, own, send, deliver, activity } = engine(NATIVE);
  await own("instagram", INSTAGRAM_ID);
  // Registering the address in the Meta app: the challenge comes back only for the right verify token.
  const check = (token: string) => call(`/v1/socials/instagram/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=1158201444`);
  const confirmed = await check("ig-verify-token");
  assert.deepEqual([confirmed.status, confirmed.text], [200, "1158201444"]);
  assert.equal((await check("a-guess")).status, 404);
  assert.equal((await engine().call("/v1/socials/instagram/webhook?hub.mode=subscribe&hub.verify_token=ig-verify-token&hub.challenge=1")).status, 404);

  const raw = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: INSTAGRAM_ID,
        time: 1520383571,
        changes: [
          { field: "comments", value: { from: { id: "232323232", username: "maria" }, media: { id: "17918195224117851", media_product_type: "REELS" }, comment_id: "17865799348089039", parent_id: "1231231234", text: "This is an example." } },
          { field: "mentions", value: { comment_id: "17894227972186120", media_id: "17918195224117851" } },
          { field: "story_insights", value: { media_id: "1", impressions: 4 } },
        ],
      },
      // The other login type: one field on the entry itself, and the comment's ID under `id`.
      { id: INSTAGRAM_ID, time: 1520383572, field: "comments", value: { id: "17900000000000001", from: { id: "99", username: "nikos" }, text: "Business Login shape", media: { id: "m2", media_product_type: "FEED" } } },
      {
        id: INSTAGRAM_ID,
        time: 1569262486134,
        messaging: [
          { sender: { id: "igsid-1" }, recipient: { id: INSTAGRAM_ID }, timestamp: 1569262485349, message: { mid: "mid-1", text: "Do you ship to Greece?" } },
          { sender: { id: INSTAGRAM_ID }, recipient: { id: "igsid-1" }, timestamp: 1569262485400, message: { mid: "mid-2", text: "Yes!", is_echo: true } },
          { sender: { id: "igsid-1" }, recipient: { id: INSTAGRAM_ID }, timestamp: 1569262485500, reaction: { mid: "mid-2", action: "react", reaction: "love", emoji: "❤️" } },
          { sender: { id: "igsid-1" }, recipient: { id: INSTAGRAM_ID }, timestamp: 1569262485600, read: { mid: "mid-2" } },
          { sender: { id: "igsid-1" }, recipient: { id: INSTAGRAM_ID }, timestamp: 1569262485700, postback: { mid: "mid-3", title: "Menu", payload: "x" } },
        ],
      },
      { id: "someone-elses-account", time: 1520383571, changes: [{ field: "comments", value: { id: "c-x", text: "not ours" } }] },
    ],
  });
  const signed = { "x-hub-signature-256": `sha256=${hmac("sha256", "ig-app-secret", raw)}` };
  assert.equal((await send("instagram", raw, {})).status, 401);
  assert.equal((await send("instagram", raw, { "x-hub-signature-256": `sha256=${hmac("sha256", "another-apps-secret", raw)}` })).status, 401);
  // What Instagram does not describe in a shape this studio knows (story insights, postbacks) is skipped, not refused.
  assert.deepEqual((await send("instagram", raw, signed)).body, { received: 8, stored: 7, duplicates: 0, unmatched: 1 });
  assert.deepEqual((await send("instagram", raw, signed)).body, { received: 8, stored: 0, duplicates: 7, unmatched: 1 });

  const events = await activity("?platform=instagram");
  assert.deepEqual(events.map((event) => event.type).sort(), ["comment.created", "comment.created", "like.created", "mention.created", "message.read", "message.received", "message.sent"]);
  const find = (externalId: string) => events.find((event) => event.externalId === externalId);
  const comment = find("17865799348089039");
  assert.deepEqual([comment.source, comment.actor, comment.subject, comment.text, comment.occurredAt], ["instagram", { id: "232323232", name: "maria", url: null }, { id: "17865799348089039", url: null, parentId: "17918195224117851" }, "This is an example.", new Date(1520383571_000).toISOString()]);
  assert.equal(find("17900000000000001").actor.name, "nikos");
  const message = find("mid-1");
  assert.deepEqual([message.type, message.text, message.actor.id, message.occurredAt], ["message.received", "Do you ship to Greece?", "igsid-1", new Date(1569262485349).toISOString()]);
  assert.equal(find("mid-2").type, "message.sent");
  const like = events.find((event) => event.type === "like.created");
  assert.deepEqual([like.subject.id, like.data], ["mid-2", { on: "message", emoji: "❤️" }]);

  // The generic format still works at the same address, next to Instagram's own.
  assert.deepEqual((await deliver("instagram", { events: [{ id: "g1", type: "story.created", externalAccountId: INSTAGRAM_ID }] })).body, { received: 1, stored: 1, duplicates: 0, unmatched: 0 });
  assert.deepEqual((await activity("?type=story.created")).map((event) => event.source), ["webhook"]);
});

test("WhatsApp's own format: messages, reactions and delivery receipts belong to the business phone number", async () => {
  const { call, own, send, activity } = engine(NATIVE);
  const PHONE = "106540352242922";
  await own("whatsapp", PHONE);
  const check = (token: string) => call(`/v1/socials/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=998877`);
  assert.equal((await check("wa-verify-token")).text, "998877");
  assert.equal((await check("ig-verify-token")).status, 404, "another platform's verify token is not accepted");

  const metadata = { display_phone_number: "15550783881", phone_number_id: PHONE };
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "102290129340398",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata,
              contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
              messages: [
                { from: "16505551234", id: "wamid.text", timestamp: "1749416383", type: "text", text: { body: "Does it come in another color?" } },
                { from: "16505551234", id: "wamid.image", timestamp: "1749416390", type: "image", image: { id: "media-1", mime_type: "image/jpeg", caption: "Like this one" } },
                { from: "16505551234", id: "wamid.reaction", timestamp: "1749416400", type: "reaction", reaction: { message_id: "wamid.ours", emoji: "👍" } },
                { from: "16505551234", id: "wamid.system", timestamp: "1749416401", type: "system", system: { body: "The customer changed their number" } },
              ],
            },
          },
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata,
              statuses: [
                { id: "wamid.ours", status: "delivered", timestamp: "1749416410", recipient_id: "16505551234" },
                { id: "wamid.ours", status: "read", timestamp: "1749416420", recipient_id: "16505551234" },
                { id: "wamid.lost", status: "failed", timestamp: "1749416430", recipient_id: "16505551234", errors: [{ code: 131026, title: "Message undeliverable" }] },
              ],
            },
          },
          { field: "account_update", value: { event: "VERIFIED_ACCOUNT" } },
        ],
      },
    ],
  });
  assert.equal((await send("whatsapp", raw, { "x-hub-signature-256": `sha256=${hmac("sha256", "ig-app-secret", raw)}` })).status, 401, "Instagram's app secret does not sign for WhatsApp");
  assert.deepEqual((await send("whatsapp", raw, { "x-hub-signature-256": `sha256=${hmac("sha256", "wa-app-secret", raw)}` })).body, { received: 6, stored: 6, duplicates: 0, unmatched: 0 });

  const events = await activity("?platform=whatsapp");
  assert.deepEqual(events.map((event) => event.type).sort(), ["like.created", "message.delivered", "message.failed", "message.read", "message.received", "message.received"]);
  const text = events.find((event) => event.externalId === "wamid.text");
  assert.deepEqual([text.actor, text.text, text.occurredAt], [{ id: "16505551234", name: "Sheena Nelson", url: null }, "Does it come in another color?", new Date(1749416383_000).toISOString()]);
  const image = events.find((event) => event.externalId === "wamid.image");
  assert.deepEqual([image.text, image.data], ["Like this one", { type: "image" }]);
  assert.equal(events.find((event) => event.type === "message.failed").data.errors[0].code, 131026);
});

test("TikTok's own format: signed with the client secret; a published video and a withdrawn authorization are acted on once", async () => {
  const { call, own, send, activity, store } = engine(NATIVE);
  const OPEN_ID = "act.example12345Example12345Example";
  const account = await own("tiktok", OPEN_ID);
  const state = async () => (await store.select("provider_connections", { id: account.id }))[0].state;
  const event = (name: string, content: unknown, user: Record<string, string> = { user_openid: OPEN_ID }) => JSON.stringify({ client_key: "bwo2m45353a6k85", event: name, create_time: 1615338610, ...user, content: JSON.stringify(content) });
  // The header from TikTok's documentation: a timestamp and the HMAC of "<timestamp>.<body>".
  const sign = (raw: string, secret = "tiktok-client-secret") => ({ "tiktok-signature": `t=1633174587,s=${hmac("sha256", secret, `1633174587.${raw}`)}` });

  const published = event("video.publish.completed", { share_id: "video.6974245311675353080.VDCxrcMJ" });
  assert.equal((await send("tiktok", published, sign(published, "someone-elses-secret"))).status, 401);
  assert.equal((await send("tiktok", published, { "tiktok-signature": `t=1633174588,s=${hmac("sha256", "tiktok-client-secret", `1633174587.${published}`)}` })).status, 401, "the timestamp is part of what is signed");
  assert.deepEqual((await send("tiktok", published, sign(published))).body, { received: 1, stored: 1, duplicates: 0, unmatched: 0 });
  const failed = event("video.upload.failed", { share_id: "video.2.x" });
  assert.deepEqual((await send("tiktok", failed, sign(failed))).body, { received: 1, stored: 1, duplicates: 0, unmatched: 0 });
  // An event about no account (a data export) is acknowledged and nothing is stored. TikTok makes no address check.
  const portability = event("portability.download.ready", { request_id: 123 }, {});
  assert.deepEqual((await send("tiktok", portability, sign(portability))).body, { received: 0, stored: 0, duplicates: 0, unmatched: 0 });
  assert.equal((await call("/v1/socials/tiktok/webhook")).status, 404);

  const events = await activity("?platform=tiktok");
  assert.deepEqual(events.map((entry) => [entry.type, entry.subject.id, entry.occurredAt]).sort(), [
    ["post.created", "video.6974245311675353080.VDCxrcMJ", new Date(1615338610_000).toISOString()],
    ["post.failed", "video.2.x", new Date(1615338610_000).toISOString()],
  ]);

  // The person removed the app in TikTok: the account stops being usable. After they connect again, TikTok
  // retrying that old delivery changes nothing.
  const removed = event("authorization.removed", { reason: 1 });
  assert.deepEqual((await send("tiktok", removed, sign(removed))).body, { received: 1, stored: 1, duplicates: 0, unmatched: 0 });
  assert.equal(await state(), "expired");
  await store.update("provider_connections", { id: account.id }, { state: "connected" });
  assert.deepEqual((await send("tiktok", removed, sign(removed))).body, { received: 1, stored: 0, duplicates: 1, unmatched: 0 });
  assert.equal(await state(), "connected");
});

test("YouTube: the engine subscribes connected channels at Google's hub under its own per-channel address, confirms only those, and reads signed upload notices", async () => {
  const { call, connect, send, activity, remote, hub, advance } = engine({ ...NATIVE, CRON_SECRET: "cron-secret" });
  const CHANNEL = "UCabc123_-x";
  const topic = (channel: string) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel}`;
  remote.state.channels = remote.state.channels.map((channel) => (channel.service === "youtube" ? { ...channel, serviceId: CHANNEL, isLocked: false } : channel));
  // The address registered for a channel names it, with a token only this engine can make (HMAC of the channel ID).
  const callback = (channel: string, token = hmac("sha256", HUB_SECRET, `youtube-callback.${channel}`)) => `/v1/socials/youtube/webhook?channel=${channel}&token=${token}`;
  // Connecting asks the hub right away: the address to deliver to, the channel's feed, and the secret that will sign deliveries.
  await connect();
  assert.deepEqual(hub.map((request) => Object.fromEntries(request)), [{ "hub.callback": `${BASE}${callback(CHANNEL)}`, "hub.mode": "subscribe", "hub.topic": topic(CHANNEL), "hub.verify": "async", "hub.secret": HUB_SECRET, "hub.lease_seconds": "864000" }]);
  // The scheduler keeps it alive: nothing to do while it is fresh, asked again once it is two days old.
  const tick = async () => (await call("/v1/cron/tick", { headers: { authorization: "Bearer cron-secret" } })).body.webhooks;
  assert.deepEqual(await tick(), { renewed: 0, failed: 0 });
  advance(49 * 60);
  assert.deepEqual([await tick(), hub.length], [{ renewed: 1, failed: 0 }, 2]);
  assert.equal(hub[1].get("hub.callback"), `${BASE}${callback(CHANNEL)}`, "a renewal registers the same address");

  // The hub checks the address before delivering, keeping its query string. Anyone can make it ask, so only the
  // address registered for that channel is confirmed, and only to subscribe a connected channel or unsubscribe one
  // that is not connected.
  const confirm = (mode: string, channel: string, address = callback(channel)) => call(`${address}&hub.mode=${mode}&hub.topic=${encodeURIComponent(topic(channel))}&hub.challenge=7342891&hub.lease_seconds=864000`);
  const confirmed = await confirm("subscribe", CHANNEL);
  assert.deepEqual([confirmed.status, confirmed.text], [200, "7342891"]);
  assert.equal((await confirm("subscribe", "UCsomeoneElse")).status, 404);
  assert.equal((await confirm("unsubscribe", CHANNEL)).status, 404);
  assert.equal((await confirm("unsubscribe", "UCsomeoneElse")).status, 200);
  // Someone else subscribing this engine's bare address (to replace the secret with theirs), an address registered
  // for another channel, or a guessed token is refused, even for the connected channel.
  assert.equal((await call(`/v1/socials/youtube/webhook?hub.mode=subscribe&hub.topic=${encodeURIComponent(topic(CHANNEL))}&hub.challenge=7342891`)).status, 404);
  assert.equal((await confirm("subscribe", CHANNEL, callback("UCsomeoneElse"))).status, 404);
  assert.equal((await confirm("subscribe", CHANNEL, callback(CHANNEL, "0".repeat(64)))).status, 404);
  assert.equal((await confirm("unsubscribe", "UCsomeoneElse", "/v1/socials/youtube/webhook?channel=UCsomeoneElse")).status, 404);

  // The notification from Google's guide, for this channel.
  const atom = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
  <link rel="hub" href="https://pubsubhubbub.appspot.com"/>
  <link rel="self" href="${topic(CHANNEL)}"/>
  <title>YouTube video feed</title>
  <updated>2015-04-01T19:05:24.552394234+00:00</updated>
  <entry>
    <id>yt:video:dQw4w9WgXcQ</id>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <yt:channelId>${CHANNEL}</yt:channelId>
    <title>Launch day &amp; what comes next</title>
    <link rel="alternate" href="http://www.youtube.com/watch?v=dQw4w9WgXcQ"/>
    <author>
     <name>Faceful</name>
     <uri>http://www.youtube.com/channel/${CHANNEL}</uri>
    </author>
    <published>2015-03-06T21:40:57+00:00</published>
    <updated>2015-03-09T19:05:24.552394234+00:00</updated>
  </entry>
</feed>`;
  const signed = { "content-type": "application/atom+xml", "x-hub-signature": `sha1=${hmac("sha1", HUB_SECRET, atom)}` };
  const deliver = (headers: Record<string, string>, address = callback(CHANNEL)) => call(address, { method: "POST", raw: atom, headers });
  assert.equal((await deliver({ "x-hub-signature": `sha1=${hmac("sha1", "not-the-hub-secret", atom)}` })).status, 401);
  // A correctly signed delivery is still refused at an address the engine did not register.
  assert.equal((await send("youtube", atom, signed)).status, 401);
  assert.equal((await deliver(signed, callback(CHANNEL, "0".repeat(64)))).status, 401);
  assert.deepEqual((await deliver(signed)).body, { received: 1, stored: 1, duplicates: 0, unmatched: 0 });
  // An edited title arrives as the same video again.
  assert.deepEqual((await deliver(signed)).body, { received: 1, stored: 0, duplicates: 1, unmatched: 0 });
  assert.deepEqual((await activity("?platform=youtube")).map((event) => [event.type, event.source, event.text, event.subject.url, event.occurredAt]), [
    ["post.created", "youtube", "Launch day & what comes next", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "2015-03-06T21:40:57.000Z"],
  ]);
});

test("LinkedIn's own format: the challenge is answered only for LinkedIn's kind of code, and page activity is read from the signed batch", async () => {
  const { call, own, send, activity } = engine(NATIVE);
  const PAGE = "urn:li:organization:12345";
  await own("linkedin", PAGE);
  const code = "890e4665-4dfe-4ab1-b689-ed553bceeed0";
  const answer = await call(`/v1/socials/linkedin/webhook?challengeCode=${code}`);
  assert.deepEqual([answer.status, answer.body], [200, { challengeCode: code, challengeResponse: hmac("sha256", "linkedin-client-secret", code) }]);
  // The challenge signs what it is given with the client secret. Asked to sign a delivery's string-to-sign, it refuses,
  // so it cannot be used to forge a delivery.
  const forged = JSON.stringify({ type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS", notifications: [] });
  assert.equal((await call(`/v1/socials/linkedin/webhook?challengeCode=${encodeURIComponent(`hmacsha256=${forged}`)}`)).status, 404);

  const notification = (id: number, action: string, extra: Record<string, unknown> = {}) => ({ lastModifiedAt: 1535741251282, notificationId: id, sourcePost: "urn:li:activity:29292929292992929293", action, organizationalEntity: PAGE, subscriber: "urn:li:person:abcdedf", ...extra });
  const comment = notification(4406005, "COMMENT", {
    generatedActivity: "urn:li:comment:(activity:63434434348, 12345)",
    decoratedGeneratedActivity: { comment: { entity: "urn:li:comment:(urn:li:activity:63434434348, 12345)", owner: "urn:li:person:523424", object: "urn:li:activity:56459853495", text: "Great launch!" } },
  });
  const raw = JSON.stringify({
    type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS",
    notifications: [
      notification(4406004, "SHARE", { generatedActivity: "urn:li:share:6343443434841538048", decoratedGeneratedActivity: { share: { entity: "urn:li:share:6343443434841538048", owner: "urn:li:organization:523424", text: "This is a some share text", landingPageUrl: "www.linkedin.com", mediaCategory: "IMAGE" } } }),
      comment,
      notification(4406006, "LIKE"),
      notification(4406007, "COMMENT_EDIT", { generatedActivity: "urn:li:comment:(activity:63434434348, 12345)" }),
      notification(4406008, "SHARE", { generatedActivity: "urn:li:share:7343443434841538048", organizationalEntity: "urn:li:organization:67890" }),
    ],
  });
  // LinkedIn signs "hmacsha256=" followed by the body, and sends only the hex digest.
  const sign = (body: string) => ({ "x-li-signature": hmac("sha256", "linkedin-client-secret", `hmacsha256=${body}`) });
  assert.equal((await send("linkedin", raw, { "x-li-signature": hmac("sha256", "linkedin-client-secret", raw) })).status, 401);
  assert.deepEqual((await send("linkedin", raw, sign(raw))).body, { received: 4, stored: 3, duplicates: 0, unmatched: 1 });
  // A second page admin who subscribed receives the same notification: still one event.
  const again = JSON.stringify({ type: "ORGANIZATION_SOCIAL_ACTION_NOTIFICATIONS", notifications: [{ ...comment, subscriber: "urn:li:person:another-admin" }] });
  assert.deepEqual((await send("linkedin", again, sign(again))).body, { received: 1, stored: 0, duplicates: 1, unmatched: 0 });

  const events = await activity("?platform=linkedin");
  assert.deepEqual(events.map((event) => event.type).sort(), ["comment.created", "like.created", "share.created"]);
  const stored = events.find((event) => event.type === "comment.created");
  assert.deepEqual([stored.actor.id, stored.text, stored.subject, stored.occurredAt], ["urn:li:person:523424", "Great launch!", { id: "urn:li:comment:(activity:63434434348, 12345)", url: null, parentId: "urn:li:activity:29292929292992929293" }, new Date(1535741251282).toISOString()]);
});

test("connecting Instagram directly: the person is sent to Instagram, and only they can complete the sign-in they started", async () => {
  // Without this deployment's own Instagram app, the direct connection is simply not offered.
  assert.equal((await engine().call("/v1/socials/providers/instagram/connect", { as: "user:u1", method: "POST" })).status, 503);
  const { call, signIn, store, meta, advance } = engine(LOGIN);
  const agent = await call("/v1/socials/providers/instagram/connect", { as: "user:u1:claude-code", method: "POST" });
  assert.deepEqual([agent.status, agent.body.error.code], [403, "approval_required"]);

  const started = await signIn("code-1");
  const authorize = new URL(started.authorizeUrl);
  assert.equal(`${authorize.origin}${authorize.pathname}`, "https://www.instagram.com/oauth/authorize");
  assert.deepEqual(
    [authorize.searchParams.get("client_id"), authorize.searchParams.get("redirect_uri"), authorize.searchParams.get("response_type"), authorize.searchParams.get("scope")],
    ["990602627938098", `${BASE}/v1/socials/providers/instagram/callback`, "code", "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_comments,instagram_business_manage_messages"],
  );

  // Instagram sends the browser back to the engine, which has no session to trust there: it only passes the person
  // on to the studio's connect page, with the code in the part of the address that servers never see.
  const back = await call(`/v1/socials/providers/instagram/callback?code=code-1&state=${encodeURIComponent(started.state)}`);
  assert.deepEqual([back.status, back.location], [302, `${BASE}/studio/connect/instagram#${new URLSearchParams({ grant: "code-1", ticket: started.state })}`]);
  assert.equal((await call("/v1/socials/providers/instagram/callback?error=access_denied&error_reason=user_denied")).location, `${BASE}/studio/connect/instagram#problem=declined`);
  assert.equal((await call("/v1/socials/providers/buffer/callback?code=x&state=y")).status, 404);
  assert.equal(meta.state.requests.length, 0, "nothing is exchanged until the signed-in person completes it");

  // A link to someone else's sign-in does nothing: another person, a tampered ticket and a stale one are all refused,
  // and the one-time code is not spent on them.
  const complete = (as: string, state: string) => call("/v1/socials/providers/instagram/complete", { as, method: "POST", body: { code: "code-1", state } });
  for (const refused of [await complete("user:u2", started.state), await complete("user:u1", `${started.state}x`), await complete("user:u1", started.state.replace(/^./, "A"))]) assert.deepEqual([refused.status, refused.body.error.code], [403, "forbidden"]);
  const stale = await signIn("code-1");
  advance(16);
  assert.equal((await stale.finish()).status, 403);
  assert.deepEqual([meta.state.requests.length, (await store.select("provider_connections", {})).length], [0, 0]);

  const fresh = await signIn("code-1");
  const connected = await fresh.finish();
  assert.equal(connected.status, 200, connected.text);
  const [account] = connected.body.accounts;
  assert.deepEqual([account.platform, account.provider, account.displayName, account.profileUrl, account.state, typeof account.webhookSubscribedAt], ["instagram", "instagram", "@faceful", "https://www.instagram.com/faceful/", "connected", "string"]);
  // The 1-hour token was traded for the 60-day one, the account was read, and its activity was asked for.
  assert.deepEqual(meta.state.requests.map((request) => `${request.method} ${request.path}`), ["POST api.instagram.com/oauth/access_token", "GET graph.instagram.com/access_token", "GET graph.instagram.com/me", "POST graph.instagram.com/me/subscribed_apps"]);
  assert.deepEqual(meta.state.subscribed, ["comments,live_comments,messages,message_reactions,messaging_seen"]);
  const [row] = await store.select("provider_connections", {});
  // The account is stored under the ID Instagram's webhooks name, so its comments and messages find it.
  assert.equal(row.external_account_id, INSTAGRAM_ID);
  assert.ok(!connected.text.includes("long-token") && !JSON.stringify(row).includes("long-token"), "the token is never returned or stored in the clear");
  assert.ok((await store.select("audit_events", {})).some((event) => event.action === "Connected Instagram account @faceful"));

  // A code works once. Signing in again with the same account renews it in place.
  const replay = await fresh.finish();
  assert.deepEqual([replay.status, /already used/.test(replay.body.error.message)], [400, true]);
  assert.equal((await (await signIn("code-2")).finish()).status, 200);
  assert.equal((await store.select("provider_connections", {})).length, 1);

  const catalog = (await call("/v1/socials", { as: "user:u1" })).body;
  assert.deepEqual(catalog.providers.find((provider: any) => provider.id === "instagram"), { id: "instagram", label: "Instagram", platforms: ["instagram"], connect: "sign_in", available: true, connected: true });
  assert.equal((await call("/v1/socials/providers/instagram/sync", { as: "user:u1", method: "POST" })).status, 422);
});

test("a Reel posted directly: Instagram prepares the video first, and it is published exactly once", async () => {
  const { deps, call, signIn, due, meta, activity } = engine(LOGIN);
  const account = (await (await signIn("code-1")).finish()).body.accounts[0];
  Object.assign(instagramTiming, { pollMs: 0, polls: 3 });
  const publishes = () => meta.state.requests.filter((request) => request.path.endsWith("/me/media_publish")).length;

  // Ready within the wait: prepared, published and confirmed in one run.
  meta.state.processing = 1;
  const quick = await due(account.id);
  assert.deepEqual(await processDuePublishJobs(deps), { processed: 1, submitted: 1, failed: 0, retried: 0, unknown: 0, verified: 0, swept: 0 });
  const [container] = [...meta.state.containers.values()];
  const { video_url: videoUrl, ...settings } = container.input;
  assert.deepEqual(settings, { media_type: "REELS", caption: "Hello from Faceful", share_to_feed: true, is_ai_generated: true });
  assert.match(videoUrl, /^https:\/\/media\.test\//);
  const posted = await quick();
  assert.deepEqual([posted.state, posted.provider_post_id, posted.published_url], ["verified_published", container.media, `https://www.instagram.com/reel/${container.media}/`]);

  // Still being prepared when the wait runs out: nothing is claimed, and a later check publishes it. (The run that sent
  // it already checks once more, so the video here stays in preparation for five checks.)
  meta.state.processing = 5;
  const slow = await due(account.id);
  assert.deepEqual(await processDuePublishJobs(deps), { processed: 1, submitted: 1, failed: 0, retried: 0, unknown: 0, verified: 0, swept: 0 });
  assert.deepEqual([(await slow()).state, /^container:\d+$/.test((await slow()).provider_post_id)], ["submitted", true]);
  assert.deepEqual(await verifySubmittedPublishJobs(deps), { checked: 1, verified: 0, failed: 0 });
  // Asking now publishes it. Two checks at once (the scheduler and an open project) do not both ask: one holds the post.
  const published = publishes();
  const together = await Promise.all([verifySubmittedPublishJobs(deps), verifySubmittedPublishJobs(deps)]);
  assert.deepEqual(together.map((outcome) => [outcome.checked, outcome.verified]).sort(), [[0, 0], [1, 1]]);
  assert.equal(publishes() - published, 1);
  const later = await slow();
  assert.deepEqual([later.state, /^\d+$/.test(later.provider_post_id), later.published_url], ["verified_published", true, `https://www.instagram.com/reel/${later.provider_post_id}/`]);
  assert.deepEqual((await activity("?type=post.created")).map((event) => [event.source, event.externalId]), [["instagram", later.provider_post_id]]);

  // The publish goes through but its answer is lost. It is not sent again: the prepared video itself says it was
  // published, and that settles it (here in the same run, whose check follows the send).
  meta.state.processing = 0;
  meta.state.publishAnswer = "lost";
  const before = publishes();
  const unclear = await due(account.id);
  assert.deepEqual(await processDuePublishJobs(deps), { processed: 1, submitted: 1, failed: 0, retried: 0, unknown: 0, verified: 1, swept: 0 });
  assert.deepEqual([(await unclear()).state, /^container:\d+$/.test((await unclear()).provider_post_id), publishes() - before], ["verified_published", true, 1]);
  meta.state.publishAnswer = "normal";

  // Instagram has no private posts, so one approved as private is refused before any video is sent.
  const containers = meta.state.containers.size;
  const hidden = await due(account.id, { visibility: "private" });
  await processDuePublishJobs(deps);
  assert.deepEqual([(await hidden()).state, /only post publicly/.test((await hidden()).error), meta.state.containers.size], ["failed", true, containers]);

  // The person removed the app in Instagram: the post fails with what to do about it.
  meta.state.revoked = true;
  const refused = await due(account.id);
  await processDuePublishJobs(deps);
  assert.deepEqual([(await refused()).state, /Connect the account again/.test((await refused()).error)], ["failed", true]);
  assert.equal((await call("/v1/socials/instagram", { as: "user:u1" })).body.accounts[0].state, "connected", "only the scheduler's own check marks an account expired");
});

test("the scheduler keeps the 60-day sign-in alive, and marks the account expired once Instagram refuses it", async () => {
  const { call, signIn, store, meta, advance } = engine({ ...LOGIN, CRON_SECRET: "cron-secret" });
  await (await signIn("code-1")).finish();
  const tick = async () => (await call("/v1/cron/tick", { headers: { authorization: "Bearer cron-secret" } })).body.credentials;
  const refreshes = () => meta.state.requests.filter((request) => request.path.endsWith("/refresh_access_token")).length;
  const saved = async () => (await store.select("provider_connections", {}))[0];
  const first = (await saved()).credentials_ciphertext;

  // Plenty of time left: nothing is asked. With under 30 days left, the token is renewed and stored again.
  assert.deepEqual([await tick(), refreshes()], [{ refreshed: 0, expired: 0, failed: 0 }, 0]);
  advance(31 * 24 * 60);
  assert.deepEqual([await tick(), refreshes()], [{ refreshed: 1, expired: 0, failed: 0 }, 1]);
  assert.notEqual((await saved()).credentials_ciphertext, first);
  assert.deepEqual([await tick(), refreshes()], [{ refreshed: 0, expired: 0, failed: 0 }, 1]);

  // Access withdrawn at Instagram: the account is marked expired, and the studio asks for it to be connected again.
  meta.state.revoked = true;
  advance(31 * 24 * 60);
  assert.deepEqual(await tick(), { refreshed: 0, expired: 1, failed: 0 });
  assert.equal((await saved()).state, "expired");
  assert.deepEqual(await tick(), { refreshed: 0, expired: 0, failed: 0 });
});

test("Settings in the studio: the browser's own client reads and changes accounts through the real routes", async () => {
  const { deps, signIn, own } = engine({ ...NATIVE, ...LOGIN });
  // The browser's fetch, answered by the engine. Whatever the studio's client cannot read fails here.
  const browserFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    return (await handleEngineRequest(deps, new Request(url, init), url.pathname))!;
  }) as typeof globalThis.fetch;
  try {
    const api = createSocialsApi(BASE, async () => "user:u1");
    const empty = await api.catalog();
    assert.deepEqual([empty.canManage, empty.webhooks, empty.platforms.flatMap((platform) => platform.accounts)], [true, { generic: true }, []]);
    assert.deepEqual(empty.platforms.map((platform) => [platform.label, platform.kind]), [["TikTok", "social"], ["Instagram", "social"], ["LinkedIn", "social"], ["YouTube", "social"], ["WhatsApp", "messaging"]]);
    assert.deepEqual(empty.providers.map((provider) => [provider.label, provider.connect, provider.available, provider.connected]), [["Buffer", "credentials", true, false], ["Instagram", "sign_in", true, false]]);
    // An agent acting for the same person sees the accounts but is not offered the buttons.
    assert.equal((await createSocialsApi(BASE, async () => "user:u1:claude-code").catalog()).canManage, false);

    // Buffer with its key, then a refresh; Instagram by signing in; a YouTube channel connected with Google elsewhere.
    const buffer = await api.connectWithCredentials("buffer", { apiKey: BUFFER_KEY });
    assert.deepEqual(buffer.accounts.map((account) => [account.platform, account.state]), [["instagram", "connected"], ["linkedin", "connected"], ["youtube", "unavailable"]]);
    assert.equal((await api.sync("buffer")).accounts.length, 3);
    assert.match((await api.start("instagram")).authorizeUrl, /^https:\/\/www\.instagram\.com\/oauth\/authorize\?/);
    const { state } = await signIn("code-1");
    assert.deepEqual((await api.complete("instagram", "code-1", state)).accounts.map((account) => account.displayName), ["@faceful"]);
    const channel = await own("youtube", "UCconnectedWithGoogle");

    const catalog = await api.catalog();
    const rows = catalog.platforms.flatMap((platform) => platform.accounts.map((account) => `${platform.label} ${account.displayName}: ${accountSource(account, catalog.providers)}${managedHere(account, catalog.providers) ? "" : " (managed in Schedule)"}`));
    assert.deepEqual(rows, [
      "Instagram Faceful on instagram: through Buffer",
      "Instagram @faceful: connected directly",
      "LinkedIn linkedin-handle: through Buffer",
      "YouTube Faceful on youtube: through Buffer",
      "YouTube youtube account: connected with Google (managed in Schedule)",
    ]);
    assert.deepEqual(catalog.providers.map((provider) => provider.connected), [true, true]);

    // What each address accepts, as the Webhooks sub tab words it.
    const instagram = catalog.platforms.find((platform) => platform.id === "instagram")!;
    assert.deepEqual([instagram.webhookUrl, webhookAcceptance(instagram, catalog.webhooks.generic)], [`${BASE}/v1/socials/instagram/webhook`, "Accepts Instagram’s own deliveries and Faceful’s signed format."]);
    assert.deepEqual([webhookAcceptance({ label: "TikTok", nativeWebhook: false }, true), webhookAcceptance({ label: "TikTok", nativeWebhook: false }, false)], ["Accepts Faceful’s signed format only.", "Not accepting deliveries yet."]);

    // Removing. The engine's refusal reaches the page as its own sentence; a channel connected with Google is not removable here.
    const direct = catalog.platforms.find((platform) => platform.id === "instagram")!.accounts.find((account) => account.provider === "instagram")!;
    assert.deepEqual(await api.removeAccount(direct.id), { cancelledPosts: 0 });
    await assert.rejects(api.removeAccount(channel.id), (failure) => failure instanceof ApiError && failure.code === "not_found" && failure.message === "This account was not found in your workspace.");
    assert.deepEqual(await api.disconnect("buffer"), { cancelledPosts: 0 });
    assert.deepEqual((await api.catalog()).platforms.flatMap((platform) => platform.accounts.map((account) => account.provider)), ["direct"]);
    await assert.rejects(createSocialsApi(BASE, async () => null).catalog(), (failure) => failure instanceof ApiError && failure.code === "unauthenticated");
  } finally {
    globalThis.fetch = browserFetch;
  }

  // The sub tab comes from the address; anything unknown opens the first one.
  assert.deepEqual([settingsTabFrom("?view=settings&tab=webhooks"), settingsTabFrom("?view=settings"), settingsTabFrom("?tab=nonsense")], ["webhooks", "accounts", "accounts"]);
  assert.deepEqual([cancelledNote(0), cancelledNote(1), cancelledNote(3)], ["", " 1 unsent post was cancelled.", " 3 unsent posts were cancelled."]);
});
