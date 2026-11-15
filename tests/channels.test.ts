import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate, hashToken, newAgentToken, resolveContext, type Ctx } from "../packages/engine/src/access";
import { connectChannel, disconnectChannel, getChannelStatus, openSecret, sealSecret } from "../packages/engine/src/channels";
import { loadConfig } from "../packages/engine/src/config";
import { EngineError } from "../packages/engine/src/errors";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { renderContent, workerClaim, workerComplete, workerUploadUrl } from "../packages/engine/src/render";
import { approveSchedule, commitSchedule, prepareSchedule, processDuePublishJobs, sweepPublishJobs, verifySubmittedPublishJobs } from "../packages/engine/src/schedule";
import { isGoogleUploadUrl } from "../packages/engine/src/providers/youtube";
import { MemoryStore } from "../packages/engine/src/store-memory";
import { getCampaign, getContext, reviseContent, startCampaign } from "../packages/engine/src/studio";

/**
 * Real engine code on the in-memory store. Every Google call goes through `deps.fetch`, which here is a
 * scripted stand-in for Google's OAuth and YouTube endpoints — no request leaves the process.
 */
const CLIENT_ID = "1234567890-faceful.apps.googleusercontent.com";
const KEY = Buffer.alloc(32, 7).toString("base64");
const UPLOAD = "https://www.googleapis.com/auth/youtube.upload";
const env = {
  SUPABASE_URL: "https://project.supabase.co",
  APP_BASE_URL: "https://faceful.test",
  RENDER_WORKER_TOKEN: "w".repeat(40),
  RENDER_AVATARS: JSON.stringify([{ id: "minas_kontis", name: "Minas", languages: ["en", "el"] }]),
  GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: "client-secret-for-tests",
  CONNECTIONS_ENCRYPTION_KEY: KEY,
};

function google() {
  const state = {
    /** access token → what tokeninfo says about it */
    access: new Map<string, { aud: string; scope: string }>([["access-token-from-google-consent", { aud: CLIENT_ID, scope: `${UPLOAD} https://www.googleapis.com/auth/youtube.readonly` }]]),
    /** refresh token → the access token Google would mint (or an OAuth error code) */
    refresh: new Map<string, { access: string; scope: string } | { error: string }>([["refresh-token-from-google-consent", { access: "minted-access-1", scope: UPLOAD }]]),
    /** access token → channel that uploads go to (null: account has no channel; "disabled": API not enabled) */
    channels: new Map<string, { id: string; title: string } | null | "disabled">([["minted-access-1", { id: "UC_channel_1", title: "BeWell Official" }]]),
    video: { uploadStatus: "uploaded", privacyStatus: "private" } as Record<string, string>,
    sessionStatus: 200,
    /** Overrides the upload session URL Google hands back (to prove a foreign host is never sent the video). */
    sessionLocation: null as string | null,
    putBehaviour: "ok" as "ok" | "network_then_unknown" | "interrupted",
    sessions: [] as Array<{ metadata: any; headers: Record<string, string>; token: string }>,
    puts: 0,
    revoked: [] as string[],
    calls: [] as string[],
  };
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([key, value]) => [key.toLowerCase(), value]));
    const bearer = headers.authorization?.replace(/^Bearer /, "") ?? "";
    state.calls.push(`${method} ${url.split("?")[0]}`);
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
      assert.equal(url.includes("?"), false, "tokens are never placed in a URL");
      const info = state.access.get(new URLSearchParams(String(init.body)).get("access_token") ?? "");
      return info ? json({ aud: info.aud, azp: info.aud, scope: info.scope, expires_in: "3500" }) : json({ error: "invalid_token", error_description: "Invalid Value" }, 400);
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(String(init.body));
      assert.equal(form.get("client_id"), CLIENT_ID);
      const grant = state.refresh.get(form.get("refresh_token") ?? "");
      if (!grant) return json({ error: "invalid_grant", error_description: "Bad Request" }, 400);
      return "error" in grant ? json({ error: grant.error }, 400) : json({ access_token: grant.access, scope: grant.scope, expires_in: 3599, token_type: "Bearer" });
    }
    if (url === "https://oauth2.googleapis.com/revoke") {
      state.revoked.push(new URLSearchParams(String(init.body)).get("token") ?? "");
      return json({});
    }
    if (url.startsWith("https://www.googleapis.com/youtube/v3/channels")) {
      const channel = state.channels.get(bearer);
      if (channel === "disabled") return json({ error: { code: 403, status: "PERMISSION_DENIED", errors: [{ reason: "accessNotConfigured" }] } }, 403);
      if (channel === undefined) return json({ error: { code: 401, status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] } }, 401);
      return json(channel ? { items: [{ id: channel.id, snippet: { title: channel.title } }] } : { items: [] });
    }
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos") && method === "POST") {
      if (state.sessionStatus !== 200) return json({ error: { code: state.sessionStatus, errors: [{ reason: "backendError" }] } }, state.sessionStatus);
      state.sessions.push({ metadata: JSON.parse(String(init.body)), headers, token: bearer });
      // The shape Google returns: the session lives on the same upload host, identified by upload_id.
      return new Response(null, { status: 200, headers: { Location: state.sessionLocation ?? `https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=unit-session-${state.sessions.length}` } });
    }
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=") && method === "PUT") {
      const probe = headers["content-range"]?.startsWith("bytes */");
      if (!probe) {
        state.puts++;
        if (state.putBehaviour !== "ok") throw new TypeError("socket hang up");
        return json({ id: `video_${state.puts}`, status: { uploadStatus: "uploaded" } }, 201);
      }
      if (state.putBehaviour === "interrupted") return new Response(null, { status: 308 });
      throw new TypeError("socket hang up");
    }
    if (url.startsWith("https://www.googleapis.com/youtube/v3/videos")) return json({ items: [{ status: state.video }] });
    if (url.startsWith("https://media.test/")) return new Response(new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), { status: 200, headers: { "Content-Type": "video/mp4" } });
    throw new Error(`Unexpected request in test: ${method} ${url}`);
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

function engine(overrides: Record<string, string | undefined> = {}) {
  let clock = Date.parse("2026-11-14T10:00:00.000Z");
  const fake = google();
  const deps: HttpDeps = {
    store: new MemoryStore(),
    config: loadConfig({ ...env, ...overrides }),
    now: () => new Date(clock),
    verifyAccessToken: async (token) => {
      const [kind, id] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: null };
    },
    fetch: fake.fetch,
    planner: null,
  };
  const as = async (token: string, org: string | null = null): Promise<Ctx> => resolveContext(deps, await authenticate(deps, `Bearer ${token}`), org, crypto.randomUUID());
  return { deps, as, google: fake.state, advance: (minutes: number) => (clock += minutes * 60_000) };
}
const key = () => crypto.randomUUID();
const tokens = () => ({ platform: "youtube" as const, accessToken: "access-token-from-google-consent", refreshToken: "refresh-token-from-google-consent", operationKey: key() });
const rejects = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof EngineError && error.code === code && (!message || message.test(error.message)));

/** A project with one rendered, verified video and a connected channel, scheduled publicly for Monday 09:00 Athens. */
async function readyToPublish(kit = engine(), visibility: "public" | "unlisted" = "public") {
  const { deps, as } = kit;
  const ctx = await as("user:owner");
  const campaign = await startCampaign(deps, ctx, { operationKey: key(), title: "Launch week", companyContext: { name: "BeWell", description: "A festival companion app.", audience: "", tone: "", sourceText: "", sourceUrl: null, missingInformation: "" }, items: [{ title: "Hello from BeWell", script: "Welcome to BeWell." }] });
  let item = await reviseContent(deps, ctx, { contentId: campaign.items[0].id, expectedRevision: 1, operationKey: key(), patch: { avatarId: "minas_kontis" } });
  await renderContent(deps, ctx, { campaignId: campaign.id, itemIds: [item.id], expectedRevisions: { [item.id]: item.revision }, operationKey: key() });
  const { job } = await workerClaim(deps, { workerId: "w1" });
  const upload = await workerUploadUrl(deps, job!.id, { mime: "video/mp4" });
  await deps.store.media.put(upload.path, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]), "video/mp4");
  await workerComplete(deps, job!.id, { durationSeconds: 15, hasAudio: true });
  const { connection } = await connectChannel(deps, ctx, tokens());
  item = await reviseContent(deps, ctx, {
    contentId: item.id,
    expectedRevision: item.revision,
    operationKey: key(),
    patch: {
      targets: [{ platform: "youtube", accountId: connection.id, scheduledAt: "2026-11-16T07:00:00.000Z", timezone: "Europe/Athens" }],
      variants: item.variants.map((variant) => (variant.platform === "youtube" ? { ...variant, caption: "A day, planned your way.", visibility, accountId: connection.id } : variant)),
    },
  });
  const project = await getCampaign(deps, ctx, campaign.id);
  const manifest = await prepareSchedule(deps, ctx, { campaignId: campaign.id, expectedRevision: project.revision, operationKey: key() });
  return { ...kit, ctx, campaign, item, connection, manifest };
}
const target = async (kit: Awaited<ReturnType<typeof readyToPublish>>) => (await getCampaign(kit.deps, kit.ctx, kit.campaign.id)).items[0].targets[0];

test("without Google settings, channels are reported as not set up and nothing can be connected", async () => {
  const { deps, as, google } = engine({ GOOGLE_OAUTH_CLIENT_ID: undefined, GOOGLE_OAUTH_CLIENT_SECRET: undefined, CONNECTIONS_ENCRYPTION_KEY: undefined });
  const ctx = await as("user:owner");
  const status = await getChannelStatus(deps, ctx);
  assert.deepEqual(status.platforms.map((p) => [p.platform, p.availability]), [["youtube", "not_configured"], ["instagram", "unavailable"], ["tiktok", "unavailable"]]);
  assert.match(status.platforms[0].reason ?? "", /has not been set up/);
  assert.match(status.platforms[1].reason ?? "", /app review; not available yet/);
  assert.equal(status.canManage, false);
  assert.equal((await getContext(deps, ctx)).capabilities.canConnectChannels, false);
  await rejects(connectChannel(deps, ctx, tokens()), "unsupported", /has not been set up/);
  assert.equal(google.calls.length, 0, "Google is never contacted when the deployment is not configured");
  assert.match(loadConfig({ ...env, CONNECTIONS_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }).youtubeProblem ?? "", /32 random bytes/);
  assert.match(loadConfig({ ...env, GOOGLE_OAUTH_CLIENT_SECRET: "" }).youtubeProblem ?? "", /GOOGLE_OAUTH_CLIENT_SECRET/);
  assert.ok(loadConfig(env).youtube);
});

test("credentials are sealed with AES-256-GCM: round trip, fresh IV, tamper and wrong key are refused", () => {
  const keyBytes = new Uint8Array(Buffer.alloc(32, 7));
  const sealed = sealSecret(keyBytes, "1//refresh-token-value");
  assert.match(sealed, /^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(sealed.includes("refresh-token-value"), false);
  assert.equal(openSecret(keyBytes, sealed), "1//refresh-token-value");
  assert.notEqual(sealSecret(keyBytes, "1//refresh-token-value"), sealed, "a new IV every time");
  const parts = sealed.split(".");
  assert.throws(() => openSecret(keyBytes, [parts[0], parts[1], parts[2], Buffer.from("tampered").toString("base64url")].join(".")));
  assert.throws(() => openSecret(new Uint8Array(Buffer.alloc(32, 8)), sealed));
  assert.throws(() => openSecret(keyBytes, sealed.replace(/^v1/, "v2")));
});

test("connecting stores a verified channel and an encrypted grant; the token never appears in rows, results or audit", async () => {
  const { deps, as, google } = engine();
  const ctx = await as("user:owner");
  assert.equal((await getContext(deps, ctx)).capabilities.canConnectChannels, true);
  const input = tokens();
  const { connection } = await connectChannel(deps, ctx, input);
  assert.deepEqual([connection.platform, connection.displayName, connection.state], ["youtube", "BeWell Official", "connected"]);
  const rows = await deps.store.select("provider_connections", {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].external_account_id, "UC_channel_1");
  assert.equal(openSecret(deps.config.youtube!.encryptionKey, rows[0].credentials_ciphertext), "refresh-token-from-google-consent");
  const everything = JSON.stringify([...(deps.store as MemoryStore).tables.entries()]) + JSON.stringify(connection);
  assert.equal(everything.includes("refresh-token-from-google-consent"), false, "the grant is stored only in sealed form");
  assert.equal(everything.includes("access-token-from-google-consent"), false);
  assert.equal(everything.includes("minted-access-1"), false);
  assert.deepEqual(google.calls, ["POST https://oauth2.googleapis.com/tokeninfo", "POST https://oauth2.googleapis.com/token", "GET https://www.googleapis.com/youtube/v3/channels"]);
  // Same operation key replays; nothing is re-validated or duplicated.
  assert.deepEqual((await connectChannel(deps, ctx, input)).connection, connection);
  assert.equal(google.calls.length, 3);
  const context = await getContext(deps, ctx);
  assert.deepEqual(context.channels.find((channel) => channel.platform === "youtube"), { id: connection.id, platform: "youtube", displayName: "BeWell Official", state: "connected" });
  assert.equal((await getChannelStatus(deps, ctx)).connections.length, 1);
});

test("a token minted for another app, or without upload permission, is refused before anything is stored", async () => {
  const { deps, as, google } = engine();
  const ctx = await as("user:owner");
  google.access.set("token-for-another-application", { aud: "999-other.apps.googleusercontent.com", scope: UPLOAD });
  await rejects(connectChannel(deps, ctx, { ...tokens(), accessToken: "token-for-another-application" }), "forbidden", /different application/);
  google.access.set("token-without-upload-scope", { aud: CLIENT_ID, scope: "openid email" });
  await rejects(connectChannel(deps, ctx, { ...tokens(), accessToken: "token-without-upload-scope" }), "validation_error", /permission to upload/);
  await rejects(connectChannel(deps, ctx, { ...tokens(), accessToken: "token-google-does-not-recognise" }), "validation_error", /did not recognise/);
  // A refresh token that was not issued to this OAuth client cannot be exchanged, so it is never kept.
  await rejects(connectChannel(deps, ctx, { ...tokens(), refreshToken: "refresh-token-from-somewhere-else" }), "validation_error", /lasting access/);
  assert.equal((await deps.store.select("provider_connections", {})).length, 0);
});

test("an account without a channel and a Google project without the YouTube API are reported precisely", async () => {
  const { deps, as, google } = engine();
  const ctx = await as("user:owner");
  google.channels.set("minted-access-1", null);
  await rejects(connectChannel(deps, ctx, tokens()), "validation_error", /has no YouTube channel/);
  google.channels.set("minted-access-1", "disabled");
  await rejects(connectChannel(deps, ctx, tokens()), "unsupported", /YouTube Data API is not enabled for this Google project/);
  assert.equal((await deps.store.select("provider_connections", {})).length, 0);
});

test("reconnecting the same channel updates its one row and restores an expired connection", async () => {
  const { deps, as, google } = engine();
  const ctx = await as("user:owner");
  const first = (await connectChannel(deps, ctx, tokens())).connection;
  await deps.store.update("provider_connections", { id: first.id }, { state: "expired" });
  google.refresh.set("a-newer-refresh-token", { access: "minted-access-2", scope: UPLOAD });
  google.channels.set("minted-access-2", { id: "UC_channel_1", title: "BeWell (renamed)" });
  const second = (await connectChannel(deps, ctx, { ...tokens(), refreshToken: "a-newer-refresh-token" })).connection;
  assert.equal(second.id, first.id);
  assert.deepEqual([second.displayName, second.state], ["BeWell (renamed)", "connected"]);
  const rows = await deps.store.select("provider_connections", {});
  assert.equal(rows.length, 1);
  assert.equal(openSecret(deps.config.youtube!.encryptionKey, rows[0].credentials_ciphertext), "a-newer-refresh-token");
});

test("only a signed-in owner or admin can connect or disconnect; agents and editors cannot", async () => {
  const { deps, as } = engine();
  const owner = await as("user:owner");
  const { connection } = await connectChannel(deps, owner, tokens());
  const agentToken = newAgentToken();
  await deps.store.insert("agent_connections", { id: crypto.randomUUID(), org_id: owner.org.id, display_name: "Codex", token_sha256: hashToken(agentToken), scopes: ["campaign:read", "content:edit", "schedule:prepare"], expires_at: "2026-12-01T00:00:00.000Z", last_seen_at: null, revoked_at: null, created_by: "owner", created_at: deps.now().toISOString() });
  const agent = await as(agentToken);
  await rejects(connectChannel(deps, agent, tokens()), "approval_required");
  await rejects(disconnectChannel(deps, agent, { connectionId: connection.id, operationKey: key() }), "approval_required");
  assert.equal((await getContext(deps, agent)).capabilities.canConnectChannels, false);
  assert.equal((await getChannelStatus(deps, agent)).canManage, false);
  await as("user:editor");
  await deps.store.insert("memberships", { org_id: owner.org.id, user_id: "editor", role: "editor", created_at: deps.now().toISOString() });
  const editor = await as("user:editor", owner.org.id);
  assert.equal(editor.role, "editor");
  await rejects(connectChannel(deps, editor, tokens()), "forbidden");
  await rejects(disconnectChannel(deps, editor, { connectionId: connection.id, operationKey: key() }), "forbidden");
  assert.equal((await getContext(deps, editor)).capabilities.canConnectChannels, false);
  // Through HTTP the agent gets the same refusal, as a contract error.
  const response = (await handleEngineRequest(deps, new Request("https://faceful.test/v1/studio/operations/connect_channel", { method: "POST", headers: { Authorization: `Bearer ${agentToken}` }, body: JSON.stringify(tokens()) }), "/v1/studio/operations/connect_channel"))!;
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, "approval_required");
  const listed = (await handleEngineRequest(deps, new Request("https://faceful.test/v1/studio/channels", { headers: { Authorization: "Bearer user:owner" } }), "/v1/studio/channels"))!;
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).connections[0].displayName, "BeWell Official");
});

test("channels are isolated per workspace", async () => {
  const { deps, as } = engine();
  const alice = await as("user:alice");
  const bob = await as("user:bob");
  const { connection } = await connectChannel(deps, alice, tokens());
  assert.equal((await getChannelStatus(deps, bob)).connections.length, 0);
  assert.equal((await getContext(deps, bob)).channels.some((channel) => channel.id === connection.id), false);
  await rejects(disconnectChannel(deps, bob, { connectionId: connection.id, operationKey: key() }), "not_found");
  const campaign = await startCampaign(deps, bob, { operationKey: key(), title: "Bob", companyContext: { name: "B", description: "B.", audience: "", tone: "", sourceText: "", sourceUrl: null, missingInformation: "" }, items: [{ title: "Hi", script: "Hi." }] });
  await rejects(
    reviseContent(deps, bob, { contentId: campaign.items[0].id, expectedRevision: 1, operationKey: key(), patch: { targets: [{ platform: "youtube", accountId: connection.id, scheduledAt: "2026-11-16T07:00:00.000Z", timezone: "Europe/Athens" }] } }),
    "validation_error",
  );
  assert.equal((await deps.store.select("provider_connections", {})).length, 1);
});

test("approve → commit uploads the approved video once, private with publishAt, labelled as synthetic media", async () => {
  const kit = await readyToPublish();
  const { deps, ctx, manifest, google, item, connection } = kit;
  assert.deepEqual(manifest.blockers, []);
  assert.equal(manifest.entries.length, 1);
  assert.deepEqual([manifest.entries[0].platform, manifest.entries[0].accountId, manifest.entries[0].scheduledAt], ["youtube", connection.id, "2026-11-16T07:00:00.000Z"]);
  assert.equal(google.sessions.length, 0, "preparing a schedule sends nothing");
  await rejects(commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() }), "approval_required");
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.equal(google.sessions.length, 0, "approval alone sends nothing");
  const commit = { manifestId: manifest.id, hash: manifest.hash, operationKey: key() };
  const committed = await commitSchedule(deps, ctx, commit);
  assert.equal(committed.jobIds.length, 1);
  assert.equal(google.sessions.length, 1);
  assert.equal(google.puts, 1);
  const { metadata, headers, token } = google.sessions[0];
  assert.equal(token, "minted-access-1", "the upload uses an access token minted from the stored grant");
  assert.deepEqual(metadata.status, { privacyStatus: "private", publishAt: "2026-11-16T07:00:00.000Z", selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
  assert.deepEqual(metadata.snippet, { title: item.title, description: "A day, planned your way.", categoryId: "22" });
  assert.equal(headers["x-upload-content-type"], "video/mp4");
  assert.equal(headers["x-upload-content-length"], "8");
  // Uploaded and scheduled at YouTube is "accepted" — never "published" — and carries no published link.
  const accepted = await target(kit);
  assert.deepEqual([accepted.state, accepted.providerId, accepted.publishedUrl, accepted.publishedAt], ["accepted", "video_1", null, null]);
  // The same commit again, a fresh commit of the same manifest, and the scheduler all leave it at one upload.
  await commitSchedule(deps, ctx, commit);
  await commitSchedule(deps, ctx, { ...commit, operationKey: key() });
  await processDuePublishJobs(deps);
  assert.equal(google.sessions.length, 1);
  assert.equal(google.puts, 1);
  assert.equal((await deps.store.select("publish_jobs", {})).length, 1);
});

test("the video is only ever sent to a Google upload host, whatever upload session URL comes back", async () => {
  assert.equal(isGoogleUploadUrl("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=x"), true);
  for (const foreign of ["https://evil.example/upload", "http://www.googleapis.com/upload", "https://googleapis.com.evil.example/u", "https://user:pw@www.googleapis.com/u", "not a url"])
    assert.equal(isGoogleUploadUrl(foreign), false, foreign);
  const kit = await readyToPublish();
  const { deps, ctx, manifest, google } = kit;
  google.sessionLocation = "https://collector.evil.example/session/1";
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.equal(google.sessions.length, 1, "the session was opened with Google");
  assert.equal(google.puts, 0, "no bytes were sent to the foreign host");
  assert.ok(!google.calls.some((call) => call.includes("evil.example")), "the foreign host was never contacted");
  const job = (await deps.store.select("publish_jobs", {}))[0];
  assert.notEqual(job.state, "submitted", "nothing is reported as uploaded");
});

test("unlisted posts upload with that privacy and no release time, and are never called published", async () => {
  const kit = await readyToPublish(engine(), "unlisted");
  const { deps, ctx, manifest, google } = kit;
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.deepEqual(google.sessions[0].metadata.status, { privacyStatus: "unlisted", selfDeclaredMadeForKids: false, containsSyntheticMedia: true });
  google.video = { uploadStatus: "processed", privacyStatus: "unlisted" };
  kit.advance(5);
  assert.equal((await verifySubmittedPublishJobs(deps)).verified, 0);
  assert.equal((await target(kit)).state, "accepted");
});

test("only YouTube reporting processed + public makes a post published", async () => {
  const kit = await readyToPublish();
  const { deps, ctx, manifest, google, campaign } = kit;
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  // Before the release time: private is expected, nothing to report.
  google.video = { uploadStatus: "processed", privacyStatus: "private", publishAt: "2026-11-16T07:00:00.000Z" };
  kit.advance(2);
  assert.deepEqual(await verifySubmittedPublishJobs(deps), { checked: 1, verified: 0, failed: 0 });
  let state = await target(kit);
  assert.deepEqual([state.state, state.error, state.publishedUrl], ["accepted", null, null]);
  // The release time passes and YouTube still says private (the unaudited-API-project restriction): say so, do not claim success.
  kit.advance(60 * 24 * 2);
  assert.equal((await verifySubmittedPublishJobs(deps)).verified, 0);
  state = await target(kit);
  assert.equal(state.state, "accepted");
  assert.match(state.error ?? "", /still lists this video as private.*API audit/);
  assert.equal(state.publishedUrl, null);
  // Reading the project re-checks at most once a minute per post.
  const before = google.calls.length;
  const read = () => handleEngineRequest(deps, new Request(`https://faceful.test/v1/studio/campaigns/${campaign.id}`, { headers: { Authorization: "Bearer user:owner" } }), `/v1/studio/campaigns/${campaign.id}`);
  await read();
  await read();
  assert.equal(google.calls.length, before, "no provider call inside the throttle window");
  // YouTube finally reports it public: now, and only now, it is published.
  google.video = { uploadStatus: "processed", privacyStatus: "public" };
  kit.advance(2);
  await read();
  state = await target(kit);
  assert.deepEqual([state.state, state.publishedUrl, state.error], ["published", "https://youtu.be/video_1", null]);
  assert.equal(state.publishedAt, "2026-11-16T07:00:00.000Z");
  // A video YouTube rejected is a failure, not a quiet success.
  const other = await readyToPublish();
  await approveSchedule(other.deps, other.ctx, { manifestId: other.manifest.id, hash: other.manifest.hash, operationKey: key() });
  await commitSchedule(other.deps, other.ctx, { manifestId: other.manifest.id, hash: other.manifest.hash, operationKey: key() });
  other.google.video = { uploadStatus: "rejected", privacyStatus: "private", rejectionReason: "duplicate" };
  other.advance(2);
  assert.equal((await verifySubmittedPublishJobs(other.deps)).failed, 1);
  const rejected = await target(other);
  assert.equal(rejected.state, "failed");
  assert.match(rejected.error ?? "", /rejected \(duplicate\)/);
});

test("a revoked grant fails the post without uploading and marks the channel as needing reconnection", async () => {
  const kit = await readyToPublish();
  const { deps, ctx, manifest, google, connection, campaign } = kit;
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  google.refresh.set("refresh-token-from-google-consent", { error: "invalid_grant" });
  await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.equal(google.sessions.length, 0);
  const failed = await target(kit);
  assert.deepEqual([failed.state, failed.error], ["failed", "Reconnect YouTube; the approved post was not sent."]);
  assert.equal((await getChannelStatus(deps, ctx)).connections.find((entry) => entry.id === connection.id)?.state, "expired");
  // With the channel expired, a new schedule cannot be approved until it is reconnected.
  const project = await getCampaign(deps, ctx, campaign.id);
  const next = await prepareSchedule(deps, ctx, { campaignId: campaign.id, expectedRevision: project.revision, operationKey: key() });
  assert.ok(next.blockers.some((blocker) => /Reconnect YouTube/.test(blocker.message)));
});

test("a transient refusal is retried later; editing the item or disconnecting the channel cancels the unsent post", async () => {
  const kit = await readyToPublish();
  const { deps, ctx, manifest, google, item, connection } = kit;
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  google.sessionStatus = 503;
  await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.equal(google.puts, 0);
  let job = (await deps.store.select("publish_jobs", {}))[0];
  assert.deepEqual([job.state, job.attempt], ["scheduled", 1]);
  assert.ok(job.next_attempt_at);
  google.sessionStatus = 200;
  await processDuePublishJobs(deps);
  assert.equal(google.puts, 0, "the retry waits for its backoff");
  // An edit after approval: the approved version is gone, so the waiting post is cancelled and never sent.
  await reviseContent(deps, ctx, { contentId: item.id, expectedRevision: item.revision, operationKey: key(), patch: { title: "A different title" } });
  job = (await deps.store.select("publish_jobs", {}))[0];
  assert.equal(job.state, "cancelled");
  kit.advance(120);
  await processDuePublishJobs(deps);
  assert.equal(google.puts, 0);

  // Disconnect: unsent posts are cancelled, Google access is revoked, our copy of the grant is gone.
  const second = await readyToPublish();
  await approveSchedule(second.deps, second.ctx, { manifestId: second.manifest.id, hash: second.manifest.hash, operationKey: key() });
  second.google.sessionStatus = 503;
  await commitSchedule(second.deps, second.ctx, { manifestId: second.manifest.id, hash: second.manifest.hash, operationKey: key() });
  const result = await disconnectChannel(second.deps, second.ctx, { connectionId: second.connection.id, operationKey: key() });
  assert.deepEqual(result, { disconnected: true, cancelledPosts: 1, revokedAtGoogle: true });
  assert.deepEqual(second.google.revoked, ["refresh-token-from-google-consent"]);
  assert.equal((await second.deps.store.select("provider_connections", {})).length, 0);
  assert.equal((await second.deps.store.select("publish_jobs", {}))[0].state, "cancelled");
  second.google.sessionStatus = 200;
  second.advance(120);
  await processDuePublishJobs(second.deps);
  assert.equal(second.google.puts, 0);
  assert.equal((await getContext(second.deps, second.ctx)).channels.find((channel) => channel.platform === "youtube")?.state, "unavailable");
  assert.equal(connection.id.length > 0, true);
});

test("an upload whose result is unknown is never re-sent; it fails visibly after the timeout", async () => {
  const kit = await readyToPublish();
  const { deps, ctx, manifest, google } = kit;
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  google.putBehaviour = "network_then_unknown";
  await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.equal(google.puts, 1);
  assert.equal((await deps.store.select("publish_jobs", {}))[0].state, "processing");
  google.putBehaviour = "ok";
  await processDuePublishJobs(deps);
  await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.equal(google.puts, 1, "no second upload while the first one's outcome is unknown");
  assert.equal(await sweepPublishJobs(deps), 0);
  kit.advance(16);
  assert.equal(await sweepPublishJobs(deps), 1);
  const failed = await target(kit);
  assert.deepEqual([failed.state, failed.error], ["failed", "Outcome unknown — check the channel before retrying."]);
  await processDuePublishJobs(deps);
  assert.equal(google.puts, 1);

  // When YouTube confirms the session received nothing complete, that is a definite miss and may be retried.
  const other = await readyToPublish();
  await approveSchedule(other.deps, other.ctx, { manifestId: other.manifest.id, hash: other.manifest.hash, operationKey: key() });
  other.google.putBehaviour = "interrupted";
  await commitSchedule(other.deps, other.ctx, { manifestId: other.manifest.id, hash: other.manifest.hash, operationKey: key() });
  assert.equal((await other.deps.store.select("publish_jobs", {}))[0].state, "scheduled");
  other.google.putBehaviour = "ok";
  other.advance(2);
  await processDuePublishJobs(other.deps);
  assert.equal((await target(other)).state, "accepted");
  assert.equal(other.google.puts, 2);
});

test("Instagram and TikTok stay blocked with a specific reason; YouTube needs a chosen, connected channel", async () => {
  const { deps, as } = engine();
  const ctx = await as("user:owner");
  const campaign = await startCampaign(deps, ctx, { operationKey: key(), title: "Mixed", companyContext: { name: "B", description: "B.", audience: "", tone: "", sourceText: "", sourceUrl: null, missingInformation: "" }, items: [{ title: "Hi", script: "Hi." }] });
  await reviseContent(deps, ctx, { contentId: campaign.items[0].id, expectedRevision: 1, operationKey: key(), patch: { targets: ["instagram", "tiktok", "youtube"].map((platform) => ({ platform: platform as "instagram", accountId: null, scheduledAt: "2026-11-16T07:00:00.000Z", timezone: "Europe/Athens" })) } });
  const manifest = await prepareSchedule(deps, ctx, { campaignId: campaign.id, expectedRevision: 2, operationKey: key() });
  const messages = manifest.blockers.map((blocker) => blocker.message);
  assert.equal(messages.filter((message) => message === "Instagram and TikTok publishing need each platform’s app review; not available yet.").length, 2);
  assert.ok(messages.some((message) => /Connect a YouTube channel and choose it/.test(message)));
  assert.equal(manifest.entries.length, 0);
  await rejects(approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() }), "approval_required");
});

test("an account connected through Buffer is its own row: the YouTube connection never touches it, and it is a destination once socials are switched on", async () => {
  const kit = await readyToPublish(engine({ SOCIALS_CREDENTIAL_KEY: "ab".repeat(32) }));
  const { deps, ctx } = kit;
  const now = deps.now().toISOString();
  const viaBuffer = (platform: string, externalAccountId: string) =>
    deps.store.insert("provider_connections", { id: crypto.randomUUID(), org_id: ctx.org.id, platform, provider: "buffer", external_account_id: externalAccountId, provider_account_id: `ch_${platform}`, profile_url: null, display_name: `${platform} via Buffer`, state: "connected", scopes: [], credentials_ciphertext: "v1.sealed-for-buffer", created_by: null, created_at: now, updated_at: now });
  // The same YouTube channel, also reached through Buffer, plus accounts the studio does and does not schedule to.
  const sameChannel = await viaBuffer("youtube", "UC_channel_1");
  const instagram = await viaBuffer("instagram", "17841400000000000");
  await viaBuffer("linkedin", "urn:li:organization:1");

  // Reconnecting the channel in the studio updates its own row only.
  await connectChannel(deps, ctx, tokens());
  const [buffered] = await deps.store.select("provider_connections", { id: sameChannel.id });
  assert.deepEqual([buffered.credentials_ciphertext, buffered.display_name], ["v1.sealed-for-buffer", "youtube via Buffer"]);
  // The channel panel lists the channels it manages; the studio lists every account it can schedule to.
  assert.deepEqual((await getChannelStatus(deps, ctx)).connections.map((connection) => connection.id), [kit.connection.id]);
  assert.deepEqual((await getContext(deps, ctx)).channels.map((channel) => channel.id).sort(), [kit.connection.id, sameChannel.id, instagram.id, "unavailable-tiktok"].sort());

  // Instagram on the Buffer account can be approved; TikTok without an account asks for one.
  const targets = (platforms: string[]) => platforms.map((platform) => ({ platform: platform as "instagram", accountId: platform === "instagram" ? instagram.id : null, scheduledAt: "2026-11-16T07:00:00.000Z", timezone: "Europe/Athens" }));
  let item = await reviseContent(deps, ctx, { contentId: kit.item.id, expectedRevision: kit.item.revision, operationKey: key(), patch: { targets: targets(["instagram", "tiktok"]) } });
  const prepare = async (on = deps) => prepareSchedule(on, ctx, { campaignId: kit.campaign.id, expectedRevision: (await getCampaign(deps, ctx, kit.campaign.id)).revision, operationKey: key() });
  const mixed = await prepare();
  assert.deepEqual(mixed.entries.map((entry) => [entry.platform, entry.accountId]), [["instagram", instagram.id]]);
  assert.deepEqual(mixed.blockers.map((blocker) => blocker.message), ["Connect a TikTok channel and choose it for this item before scheduling there."]);
  // Without SOCIALS_CREDENTIAL_KEY the Buffer account cannot post, and nothing changes from before.
  const off = await prepare({ ...deps, config: { ...deps.config, socials: { ...deps.config.socials, credentialKey: null } } });
  assert.deepEqual([off.entries.length, off.blockers.filter((blocker) => blocker.message === "Instagram and TikTok publishing need each platform’s app review; not available yet.").length], [0, 2]);

  // Buffer does not hold a post until its time, so committing leaves it to the scheduler at the approved time.
  item = await reviseContent(deps, ctx, { contentId: item.id, expectedRevision: item.revision, operationKey: key(), patch: { targets: targets(["instagram"]) } });
  const manifest = await prepare();
  await approveSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  const committed = await commitSchedule(deps, ctx, { manifestId: manifest.id, hash: manifest.hash, operationKey: key() });
  assert.deepEqual((await deps.store.select("publish_jobs", { id: committed.jobIds[0] })).map((job) => [job.platform, job.account_id, job.state]), [["instagram", instagram.id, "scheduled"]]);
});
