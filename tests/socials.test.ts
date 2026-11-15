import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { processDuePublishJobs, verifySubmittedPublishJobs } from "../packages/engine/src/schedule";
import { signSocialWebhook, webhookAdapters } from "../packages/engine/src/socials-events";
import { MemoryStore } from "../packages/engine/src/store-memory";

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

function engine(env: Record<string, string> = switchedOn) {
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  const remote = buffer();
  const store = new MemoryStore();
  /** What the engine asked Google's hub for (YouTube). Everything else goes to the Buffer stand-in. */
  const hub: URLSearchParams[] = [];
  const fetch = (async (url: unknown, init?: RequestInit) => {
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
    return { status: response!.status, text, body: (text.startsWith("{") ? JSON.parse(text) : null) as any };
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
  return { deps, store, remote, hub, call, connect, deliver, own, send, activity, advance: (minutes: number) => (clock += minutes * 60_000) };
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
  assert.deepEqual([instagram.kind, instagram.providers, instagram.webhookUrl], ["social", ["buffer"], `${BASE}/v1/socials/instagram/webhook`]);
  assert.deepEqual(catalog.body.providers, [{ id: "buffer", label: "Buffer", platforms: ["tiktok", "instagram", "linkedin", "youtube"], available: false, connected: false }]);

  assert.equal((await call("/v1/socials/linkedin", { as: "user:u1" })).body.label, "LinkedIn");
  assert.equal((await call("/v1/socials/myspace", { as: "user:u1" })).status, 404);

  const refused = await call("/v1/socials/providers/buffer/connect", { as: "user:u1", method: "POST", body: { apiKey: BUFFER_KEY } });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.error.code, "provider_unavailable");
  const off = (await call("/v1/health")).body;
  assert.deepEqual([off.publishing.adapters, off.socials], [[], { connections: false, webhooks: false, nativeWebhooks: [] }]);
  const on = (await engine().call("/v1/health")).body;
  assert.deepEqual([on.publishing.adapters, on.socials], [["buffer"], { connections: true, webhooks: true, nativeWebhooks: [] }]);
  // Each platform's own format is switched on by that platform's credentials, and shows on its entry.
  const native = engine(NATIVE);
  assert.deepEqual((await native.call("/v1/health")).body.socials.nativeWebhooks, ["instagram", "whatsapp", "tiktok", "linkedin", "youtube"]);
  assert.deepEqual([instagram.nativeWebhook, (await native.call("/v1/socials/instagram", { as: "user:u1" })).body.nativeWebhook], [false, true]);
});

test("connecting Buffer is an owner's act; it keeps the accounts this studio uses and never the key in the clear", async () => {
  const { call, connect, store, remote } = engine();
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

  // Removing: one account, then the provider. Someone else's account ID is simply not found.
  const [first] = await connect();
  assert.equal((await call(`/v1/socials/accounts/${first.id}`, { as: "user:u2", method: "DELETE" })).status, 404);
  assert.deepEqual((await call(`/v1/socials/accounts/${first.id}`, { as: "user:u1", method: "DELETE" })).body, { removed: true });
  assert.deepEqual((await call("/v1/socials/providers/buffer", { as: "user:u1", method: "DELETE" })).body, { removed: 2 });
  assert.equal((await store.select("provider_connections", {})).length, 0);
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

test("YouTube: the engine subscribes connected channels at Google's hub, confirms only those, and reads signed upload notices", async () => {
  const { call, connect, send, activity, remote, hub, advance } = engine({ ...NATIVE, CRON_SECRET: "cron-secret" });
  const CHANNEL = "UCabc123_-x";
  const topic = (channel: string) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channel}`;
  remote.state.channels = remote.state.channels.map((channel) => (channel.service === "youtube" ? { ...channel, serviceId: CHANNEL, isLocked: false } : channel));
  // Connecting asks the hub right away: the address to deliver to, the channel's feed, and the secret that will sign deliveries.
  await connect();
  assert.deepEqual(hub.map((request) => Object.fromEntries(request)), [{ "hub.callback": `${BASE}/v1/socials/youtube/webhook`, "hub.mode": "subscribe", "hub.topic": topic(CHANNEL), "hub.verify": "async", "hub.secret": HUB_SECRET, "hub.lease_seconds": "864000" }]);
  // The scheduler keeps it alive: nothing to do while it is fresh, asked again once it is two days old.
  const tick = async () => (await call("/v1/cron/tick", { headers: { authorization: "Bearer cron-secret" } })).body.webhooks;
  assert.deepEqual(await tick(), { renewed: 0, failed: 0 });
  advance(49 * 60);
  assert.deepEqual([await tick(), hub.length], [{ renewed: 1, failed: 0 }, 2]);

  // The hub checks the address before delivering. Anyone can make it ask, so only what matches the connected
  // accounts is confirmed: subscribing a connected channel, unsubscribing one that is not connected.
  const confirm = (mode: string, channel: string) => call(`/v1/socials/youtube/webhook?hub.mode=${mode}&hub.topic=${encodeURIComponent(topic(channel))}&hub.challenge=7342891&hub.lease_seconds=864000`);
  const confirmed = await confirm("subscribe", CHANNEL);
  assert.deepEqual([confirmed.status, confirmed.text], [200, "7342891"]);
  assert.equal((await confirm("subscribe", "UCsomeoneElse")).status, 404);
  assert.equal((await confirm("unsubscribe", CHANNEL)).status, 404);
  assert.equal((await confirm("unsubscribe", "UCsomeoneElse")).status, 200);

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
  assert.equal((await send("youtube", atom, { "x-hub-signature": `sha1=${hmac("sha1", "not-the-hub-secret", atom)}` })).status, 401);
  assert.deepEqual((await send("youtube", atom, signed)).body, { received: 1, stored: 1, duplicates: 0, unmatched: 0 });
  // An edited title arrives as the same video again.
  assert.deepEqual((await send("youtube", atom, signed)).body, { received: 1, stored: 0, duplicates: 1, unmatched: 0 });
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
