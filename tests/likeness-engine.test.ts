import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { likenessConsentStatement, likenessUploadTicketSchema } from "../packages/contracts/src/index";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MemoryFileStore, presignUrl, R2FileStore } from "../packages/engine/src/r2";
import { MemoryStore } from "../packages/engine/src/store-memory";

/** The likeness routes on the real engine, with an in-memory store and bucket. "user:<id>" stands in for a verified session. */
const BASE = "https://faceful.test";
const TRANSCRIBE_KEY = "t".repeat(32);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function engine(options: { files?: boolean; env?: Record<string, string> } = {}) {
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  const files = new MemoryFileStore();
  const store = new MemoryStore();
  const deps: HttpDeps = {
    store,
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: BASE, ...options.env }),
    now: () => new Date(clock),
    verifyAccessToken: async (token) => {
      const [kind, id, client] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: client ?? null };
    },
    fetch: async () => new Response("{}", { status: 500 }),
    planner: null,
    ...(options.files === false ? {} : { files }),
  };
  const call = async (path: string, init: { as?: string; method?: string; body?: unknown; org?: string } = {}) => {
    const headers: Record<string, string> = { "user-agent": "TestBrowser/1.0", "x-forwarded-for": "203.0.113.7, 10.0.0.1" };
    if (init.as) headers.authorization = `Bearer ${init.as}`;
    if (init.org) headers["x-faceful-workspace"] = init.org;
    const method = init.method ?? "POST";
    const response = await handleEngineRequest(deps, new Request(`${BASE}${path}`, { method, headers, body: method === "POST" ? JSON.stringify(init.body ?? {}) : undefined }), path);
    return { status: response!.status, body: (await response!.json()) as any };
  };
  /** Uploads one recording the way the browser does: ask for a link, then store bytes with the declared checksum. */
  const upload = async (as: string, type: "video/webm" | "video/mp4" | "video/x-matroska" | "image/jpeg", bytes: Uint8Array, org?: string) => {
    const ticket = await call("/v1/studio/likeness/upload-url", { as, org, body: { type, size: bytes.byteLength, sha256: sha(bytes) } });
    assert.equal(ticket.status, 200, JSON.stringify(ticket.body));
    await files.put(ticket.body.key, bytes, type);
    return ticket.body.key as string;
  };
  /** A complete, passing capture for `name`, uploaded by `as`. */
  const capture = async (as: string, name = "Minas Kontis", org?: string) => {
    const video = (label: string) => new TextEncoder().encode(`${label}-${crypto.randomUUID()}`);
    const stills: Record<string, string> = {};
    for (const pose of ["center", "left", "right", "up", "down"]) stills[pose] = await upload(as, "image/jpeg", video(pose), org);
    return {
      subjectName: name,
      language: "en",
      phrases: ["The quick brown fox.", "Bright morning sunshine.", likenessConsentStatement(name, "en")],
      transcript: "the quick brown fox bright morning sunshine i agree",
      // Chrome labels its H.264 "WebM" recordings as Matroska; they are stored as they come.
      scanVideoKey: await upload(as, "video/x-matroska", video("scan"), org),
      speechVideoKey: await upload(as, "video/mp4", video("speech"), org),
      stills,
      report: { passed: true, checks: [{ id: "poses", label: "Five head angles", passed: true, required: true, value: 5 }, { id: "blink", label: "Blinking", passed: false, required: false, value: 0 }] },
    };
  };
  return { deps, store, files, call, upload, capture, advance: (minutes: number) => (clock += minutes * 60_000) };
}

test("an upload link is for a signed-in person, one file, and their own folder in their own workspace", async () => {
  const { call, store } = engine();
  const input = { type: "video/webm", size: 1234, sha256: "a".repeat(64) };
  assert.equal((await call("/v1/studio/likeness/upload-url", { body: input })).status, 401);
  // An agent acting for the same account cannot record a person's likeness, whatever it was granted.
  const agent = await call("/v1/studio/likeness/upload-url", { as: "user:u1:claude-code", body: input });
  assert.equal(agent.status, 403);
  assert.equal(agent.body.error.code, "approval_required");

  const ticket = await call("/v1/studio/likeness/upload-url", { as: "user:u1", body: input });
  assert.equal(ticket.status, 200);
  const [org] = await store.select("organizations", {});
  assert.match(ticket.body.key, new RegExp(`^orgs/${org.id}/likeness/u1/[0-9a-f-]{36}\\.webm$`));
  // The checksum header is part of the signature: storage refuses any other bytes.
  assert.equal(ticket.body.headers["x-amz-checksum-sha256"], Buffer.from("a".repeat(64), "hex").toString("base64"));
  assert.equal(ticket.body.headers["content-type"], "video/webm");
  assert.equal(ticket.body.expiresAt, "2026-11-15T10:10:00.000Z");

  for (const bad of [{ ...input, type: "video/quicktime" }, { ...input, size: 300 * 1024 * 1024 }, { ...input, sha256: "nope" }, { ...input, type: "image/jpeg", size: 16 * 1024 * 1024 }, { ...input, extra: true }])
    assert.equal((await call("/v1/studio/likeness/upload-url", { as: "user:u1", body: bad })).status, 400, JSON.stringify(bad));
});

test("without R2 settings the capture is told storage is not connected, and health says so without leaking anything", async () => {
  const { call, deps } = engine({ files: false });
  const ticket = await call("/v1/studio/likeness/upload-url", { as: "user:u1", body: { type: "image/jpeg", size: 10, sha256: "b".repeat(64) } });
  assert.equal(ticket.status, 503);
  assert.match(ticket.body.error.message, /storage isn’t connected/);
  const health = await call("/v1/health", { method: "GET" });
  assert.deepEqual(health.body.files, { connected: false });
  assert.deepEqual(health.body.likeness, { liveTranscription: false });
  // FACEFUL_R2_* is read as one unit, and a malformed account id is refused rather than half-used.
  assert.equal(deps.config.r2, null);
  assert.deepEqual(loadConfig({ FACEFUL_R2_ACCOUNT_ID: "a".repeat(32), FACEFUL_R2_ACCESS_KEY_ID: "id", FACEFUL_R2_SECRET_ACCESS_KEY: "secret" }).r2, { accountId: "a".repeat(32), accessKeyId: "id", secretAccessKey: "secret", bucket: "faceful-media" });
  assert.equal(loadConfig({ FACEFUL_R2_ACCOUNT_ID: "nope", FACEFUL_R2_ACCESS_KEY_ID: "id", FACEFUL_R2_SECRET_ACCESS_KEY: "secret" }).r2, null);
});

test("saving a consent stores the proof: the row, a manifest beside the recordings, and an audit entry", async () => {
  // Behind a proxy that sets x-forwarded-for (Vercel's edge), so the forwarded address is the client's.
  const { call, capture, store, files } = engine({ env: { TRUST_PROXY_HEADERS: "true" } });
  const input = await capture("user:u1");
  const saved = await call("/v1/studio/likeness/consents", { as: "user:u1", body: input });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.passed, true);

  const [row] = await store.select("likeness_consents", {});
  assert.equal(row.id, saved.body.id);
  assert.equal(row.user_id, "u1");
  assert.equal(row.statement, "I, Minas Kontis, agree that Faceful may create an avatar of my face and voice.");
  assert.equal(row.scan_video_key, input.scanVideoKey);
  assert.match(row.scan_video_key, /\.mkv$/);
  assert.match(row.speech_video_key, /\.mp4$/);
  assert.deepEqual(Object.keys(row.stills).sort(), ["center", "down", "left", "right", "up"]);
  assert.equal(row.revoked_at, null);
  // Where it was given from is recorded: the first forwarded address only.
  assert.equal(row.ip_address, "203.0.113.7");
  assert.equal(row.user_agent, "TestBrowser/1.0");

  const manifest = JSON.parse(new TextDecoder().decode(files.objects.get(row.manifest_key)!.bytes));
  assert.equal(manifest.id, row.id);
  assert.equal(manifest.email, "u1@example.com");
  assert.equal(manifest.statement, row.statement);
  assert.equal(manifest.files.speech_video, input.speechVideoKey);
  assert.equal(manifest.liveness.passed, true);
  assert.equal(files.objects.size, 8, "two recordings, five stills and the manifest");
  const audit = await store.select("audit_events", { object_id: row.id });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_kind, "human");

  // Where no trusted proxy sets x-forwarded-for, the caller could have chosen it, so no address is recorded.
  const direct = engine();
  assert.equal((await direct.call("/v1/studio/likeness/consents", { as: "user:u1", body: await direct.capture("user:u1") })).status, 200);
  const [untrusted] = await direct.store.select("likeness_consents", {});
  assert.equal(untrusted.ip_address, null);
  assert.equal(untrusted.user_agent, "TestBrowser/1.0");
});

test("a consent cannot be forged: wrong wording, someone else's recordings, missing uploads and failed captures are refused", async () => {
  const { call, capture, store, files } = engine();
  const save = (body: unknown, as = "user:u1") => call("/v1/studio/likeness/consents", { as, body });
  const good = await capture("user:u1");

  // The stored sentence is the engine's, built from the name: a reworded statement is not a consent.
  const reworded = await save({ ...good, phrases: [good.phrases[0], good.phrases[1], "I, Minas Kontis, agree to nothing."] });
  assert.equal(reworded.status, 400);
  assert.match(reworded.body.error.message, /consent statement does not match/);
  assert.equal((await save({ ...good, subjectName: "Someone Else" })).status, 400);

  // Another account's recordings cannot be attached, even with every key known.
  const theirs = await capture("user:u2");
  assert.equal((await save({ ...good, scanVideoKey: theirs.scanVideoKey })).status, 400);
  assert.equal((await save({ ...good, stills: theirs.stills })).status, 400);
  assert.equal((await save({ ...good, speechVideoKey: "../../etc/passwd" })).status, 400);
  // A still cannot stand in for a recording, and the straight-on still is required.
  assert.equal((await save({ ...good, scanVideoKey: good.stills.center })).status, 400);
  assert.equal((await save({ ...good, stills: { left: good.stills.left } })).status, 400);

  // A link that was issued but never used is not a recording.
  const ticket = await call("/v1/studio/likeness/upload-url", { as: "user:u1", body: { type: "video/webm", size: 5, sha256: "c".repeat(64) } });
  const unfinished = await save({ ...good, scanVideoKey: ticket.body.key });
  assert.equal(unfinished.status, 400);
  assert.match(unfinished.body.error.message, /did not finish uploading/);
  assert.equal((await save(good, "user:u1:claude-code")).status, 403, "an agent cannot consent for a person");
  assert.equal((await store.select("likeness_consents", {})).length, 0);

  // A capture that failed a required check is not kept, and neither are its recordings.
  const failed = { ...good, report: { passed: false, checks: [{ id: "phrases", label: "Phrases spoken", passed: false, required: true, value: 0.2 }] } };
  const refused = await save(failed);
  assert.equal(refused.status, 400);
  assert.match(refused.body.error.message, /did not pass its checks/);
  assert.equal(files.objects.has(good.scanVideoKey), false);
  assert.equal(files.objects.has(good.stills.center), false);
  // Claiming "passed" over a failed required check is the same thing.
  const lying = await capture("user:u1");
  assert.equal((await save({ ...lying, report: { passed: true, checks: failed.report.checks } })).status, 400);

  // Declaring a small size and uploading something huge is caught when the consent is saved.
  const big = await capture("user:u1");
  files.objects.set(big.stills.up, { bytes: new Uint8Array(16 * 1024 * 1024), contentType: "image/jpeg" });
  const oversize = await save(big);
  assert.equal(oversize.status, 400);
  assert.match(oversize.body.error.message, /too large/);
  assert.equal(files.objects.has(big.stills.up), false);
  assert.equal((await store.select("likeness_consents", {})).length, 0);
});

test("withdrawing deletes every recording and keeps the row as the record; only the person or an admin may", async () => {
  const { call, capture, store, files } = engine();
  const owner = await call("/v1/studio/context", { as: "user:u1", method: "GET" });
  const org = owner.body.workspace.id as string;
  // u2 and u3 join u1's workspace as editors; u2 records a likeness there.
  for (const user of ["u2", "u3"]) await store.insert("memberships", { org_id: org, user_id: user, role: "editor", created_at: "2026-11-15T09:00:00.000Z" });
  const saved = await call("/v1/studio/likeness/consents", { as: "user:u2", org, body: await capture("user:u2", "Second Person", org) });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const id = saved.body.id as string;
  const path = `/v1/studio/likeness/consents/${id}`;
  assert.equal(files.objects.size, 8);

  assert.equal((await call(path, { method: "DELETE" })).status, 401);
  const colleague = await call(path, { as: "user:u3", org, method: "DELETE" });
  assert.equal(colleague.status, 403);
  assert.equal(colleague.body.error.code, "forbidden");
  // From another workspace the consent does not exist at all.
  assert.equal((await call(path, { as: "user:u9", method: "DELETE" })).status, 404);
  assert.equal((await call("/v1/studio/likeness/consents/not-an-id", { as: "user:u2", org, method: "DELETE" })).status, 404);
  assert.equal((await call(path, { as: "user:u2:claude-code", org, method: "DELETE" })).status, 403);
  assert.equal(files.objects.size, 8, "nothing was deleted by the refused attempts");

  const revoked = await call(path, { as: "user:u2", org, method: "DELETE" });
  assert.deepEqual(revoked.body, { revoked: true });
  assert.equal(files.objects.size, 0, "recordings, stills and manifest are gone");
  const [row] = await store.select("likeness_consents", { id });
  assert.ok(row.revoked_at);
  assert.equal(row.scan_video_key, null);
  assert.equal(row.manifest_key, null);
  assert.deepEqual(row.stills, {});
  assert.equal(row.statement, "I, Second Person, agree that Faceful may create an avatar of my face and voice.", "what was agreed stays on record");
  // Withdrawing twice is harmless, and a workspace owner can withdraw a member's consent.
  assert.deepEqual((await call(path, { as: "user:u2", org, method: "DELETE" })).body, { revoked: true });
  const second = await call("/v1/studio/likeness/consents", { as: "user:u2", org, body: await capture("user:u2", "Second Person", org) });
  assert.deepEqual((await call(`/v1/studio/likeness/consents/${second.body.id}`, { as: "user:u1", method: "DELETE" })).body, { revoked: true });
  assert.equal(files.objects.size, 0);
});

test("a live transcription token is single-purpose, signed the way Humanlike verifies it, and rationed", async () => {
  const off = engine();
  const unavailable = await off.call("/v1/studio/likeness/live-token", { as: "user:u1" });
  assert.equal(unavailable.status, 503);
  assert.match(unavailable.body.error.message, /browser’s own speech recognition/);

  const { call, advance, deps } = engine({ env: { HUMANLIKE_TRANSCRIBE_KEY: TRANSCRIBE_KEY } });
  assert.equal((await call("/v1/studio/likeness/live-token", {})).status, 401);
  assert.equal((await call("/v1/studio/likeness/live-token", { as: "user:u1:claude-code" })).status, 403);
  const issued = await call("/v1/studio/likeness/live-token", { as: "user:u1" });
  assert.equal(issued.status, 200);
  assert.equal(issued.body.url, "wss://api.humanlike.co/transcribe/live");
  // Humanlike's server accepts `${exp}.${nonce}.${sig}` with exp at most 120 s ahead by its own clock.
  const match = (issued.body.token as string).match(/^(\d{10})\.([A-Za-z0-9_-]{8,64})\.([A-Za-z0-9_-]{43})$/);
  assert.ok(match);
  const [, exp, nonce, signature] = match;
  assert.equal(signature, createHmac("sha256", TRANSCRIBE_KEY).update(`transcribe-live.${exp}.${nonce}`).digest("base64url"));
  const ahead = Number(exp) - Math.floor(deps.now().getTime() / 1000);
  assert.ok(ahead > 0 && ahead <= 120 && ahead === issued.body.expiresInSeconds);
  assert.equal(JSON.stringify(issued.body).includes(TRANSCRIBE_KEY), false);
  const again = await call("/v1/studio/likeness/live-token", { as: "user:u1" });
  assert.notEqual(again.body.token, issued.body.token, "every token has its own nonce");

  // Each token opens a paid stream, so a workspace gets 60 an hour (two per capture).
  for (let i = 2; i < 60; i++) assert.equal((await call("/v1/studio/likeness/live-token", { as: "user:u1" })).status, 200);
  const limited = await call("/v1/studio/likeness/live-token", { as: "user:u1" });
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, "quota_exceeded");
  assert.equal((await call("/v1/studio/likeness/live-token", { as: "user:u2" })).status, 200, "another workspace is unaffected");
  advance(61);
  assert.equal((await call("/v1/studio/likeness/live-token", { as: "user:u1" })).status, 200);
});

test("the R2 signer reproduces AWS's published SigV4 presigned URL, and upload links are bound to one object", async () => {
  const url = presignUrl({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", now: new Date("2013-05-24T00:00:00Z"), expiresSeconds: 86400 });
  assert.equal(new URL(url).searchParams.get("X-Amz-Signature"), "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404");

  const requests: Array<{ url: string; method: string; headers?: HeadersInit }> = [];
  const r2 = new R2FileStore({ accountId: "0".repeat(32), accessKeyId: "id", secretAccessKey: "secret", bucket: "faceful-media" }, () => new Date("2026-11-15T10:00:00Z"), (async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", headers: init?.headers });
    return new Response(null, { status: 204, headers: { "content-length": "2036", "content-type": "application/json" } });
  }) as typeof fetch);
  const key = "orgs/o1/likeness/u1/00000000-0000-4000-8000-000000000000.webm";
  const link = await r2.uploadUrl(key, { sha256Hex: "a".repeat(64), contentType: "video/webm", expiresSeconds: 600 });
  const parsed = new URL(link.url);
  assert.equal(parsed.host, `${"0".repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(parsed.pathname, `/faceful-media/${key}`);
  assert.equal(parsed.searchParams.get("X-Amz-Expires"), "600");
  // The type and checksum are signed headers: the same link cannot carry a different file.
  assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "content-type;host;x-amz-checksum-sha256");
  // The browser only accepts a link over https; plain http is for a loopback test server and nothing else.
  const ticket = (uploadUrl: string) => likenessUploadTicketSchema.safeParse({ key, uploadUrl, headers: link.headers, expiresAt: "2026-11-15T10:10:00.000Z" }).success;
  assert.equal(ticket(link.url), true);
  assert.equal(ticket("http://127.0.0.1:4273/__e2e/files/x"), true);
  assert.equal(ticket("http://files.example.com/x"), false);
  assert.equal(ticket("ftp://files.example.com/x"), false);
  // Sizes are asked for unencoded: R2 otherwise gzips JSON and text and omits the length.
  assert.deepEqual(await r2.head(key), { bytes: 2036, contentType: "application/json" });
  assert.deepEqual(requests[0].headers, { "accept-encoding": "identity" });
  await r2.remove(key);
  assert.equal(requests[1].method, "DELETE");
  assert.equal(new URL(requests[1].url).pathname, `/faceful-media/${key}`);
  await assert.rejects(r2.remove("../escape"), /not valid/);
});

test("only the face scan page and the studio (its Personas tab) may use the camera and microphone, and the build files may compile WebAssembly", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>; rewrites: Array<{ source: string; destination: string }>; proxy: { matcher: string[] } };
  const header = (source: string, key: string) => config.headers.find((rule) => rule.source === source)?.headers.find((entry) => entry.key === key)?.value ?? "";
  // The site-wide rule keeps both switched off and skips the paths that carry their own policy.
  const site = config.headers[0];
  assert.equal(site.source, "/((?!face-scan|studio|assets/).*)");
  assert.equal(header(site.source, "Permissions-Policy"), "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()");
  assert.equal(header(site.source, "Content-Security-Policy").includes("wasm-unsafe-eval"), false);
  // The Personas tab records a consent in place, so the studio carries the same policy as the face scan page.
  const recording = ["/face-scan", "/face-scan/", "/studio/", "/studio/:path*"];
  for (const source of recording) {
    assert.equal(header(source, "Permissions-Policy"), "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), browsing-topics=()");
    const policy = header(source, "Content-Security-Policy");
    for (const needed of ["script-src 'self' 'wasm-unsafe-eval'", "worker-src 'self'", "media-src 'self' blob:", "wss://api.humanlike.co", "frame-ancestors 'none'", "object-src 'none'"]) assert.ok(policy.includes(needed), `${source}: ${needed}`);
    // No script from another origin, no inline script and no eval on the page that records a face.
    assert.doesNotMatch(policy, /script-src[^;]*(https:|unsafe-inline|'unsafe-eval'|blob:)/);
    assert.equal(header(source, "X-Frame-Options"), "DENY");
    assert.equal(header(source, "Cache-Control"), "private, no-store");
    assert.equal(header(source, "X-Robots-Tag"), "noindex, nofollow");
    assert.equal(config.rewrites.find((rule) => rule.source === source)?.destination, "/studio/index.html");
  }
  // The landing page and every other page stay under the site-wide rule, without either.
  const siteRule = new RegExp(`^${site.source}$`);
  for (const path of ["/", "/pricing", "/docs/", "/oauth/consent", "/claude-login-test/", "/pitch/", "/dev/studio/"]) assert.match(path, siteRule);
  for (const path of ["/studio", "/studio/", "/studio/index.html", "/face-scan/", "/assets/app.js"]) assert.doesNotMatch(path, siteRule);
  // A worker runs under the headers of its own script, so the build files carry the WebAssembly allowance.
  assert.ok(header("/assets/(.*)", "Content-Security-Policy").includes("script-src 'self' 'wasm-unsafe-eval'"));
  assert.equal(header("/assets/(.*)", "X-Content-Type-Options"), "nosniff");
  // Skipping the site-wide rule must not drop any of its other protections on these paths.
  for (const source of ["/assets/(.*)", ...recording])
    for (const key of ["Strict-Transport-Security", "Cross-Origin-Opener-Policy", "Referrer-Policy", "X-Frame-Options"]) assert.equal(header(source, key), header(site.source, key), `${source}: ${key}`);
  assert.match(config.proxy.matcher[0], /\|face-scan[|)]/);
});
