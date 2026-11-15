import { test } from "node:test";
import assert from "node:assert/strict";
import { uploadTicketSchema } from "../packages/contracts/src/index";
import { archiveFile, completeUpload, listFiles, requestUpload, saveTextFile } from "../packages/engine/src/files";
import { loadConfig } from "../packages/engine/src/config";
import { presignUrl, R2FileStore } from "../packages/engine/src/r2";
import { EngineError } from "../packages/engine/src/errors";
import { engine, key, rejects, seed, sha256 } from "./reel-support";

test("the R2 signer reproduces AWS's published SigV4 presigned URL", () => {
  const url = presignUrl({ method: "GET", host: "examplebucket.s3.amazonaws.com", path: "/test.txt", region: "us-east-1", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", now: new Date("2013-05-24T00:00:00Z"), expiresSeconds: 86400 });
  assert.match(url, /X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

test("R2 upload links are bound to one object, its type, its SHA-256 and its size", async () => {
  const store = new R2FileStore({ accountId: "0".repeat(32), accessKeyId: "AK", secretAccessKey: "SK", bucket: "faceful-media" }, () => new Date("2026-11-14T10:00:00Z"), fetch);
  const digest = sha256("hello");
  const { url, headers } = await store.uploadUrl(`orgs/o/projects/p/files/${digest}.txt`, { sha256Hex: digest, contentType: "text/plain", bytes: 5, expiresSeconds: 900 });
  const parsed = new URL(url);
  assert.equal(parsed.host, `${"0".repeat(32)}.r2.cloudflarestorage.com`);
  assert.equal(parsed.pathname, `/faceful-media/orgs/o/projects/p/files/${digest}.txt`);
  assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host;x-amz-checksum-sha256");
  assert.equal(parsed.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(headers["x-amz-checksum-sha256"], Buffer.from(digest, "hex").toString("base64"));
  // The size is signed but not handed to the client: fetch refuses a script-set Content-Length and sends the real one.
  assert.deepEqual(Object.keys(headers).sort(), ["content-type", "x-amz-checksum-sha256"]);
  // The signature commits to exactly that length: re-signing with it reproduces the link, any other length does not.
  const resign = (length: string) => presignUrl({ method: "PUT", host: parsed.host, path: parsed.pathname, region: "auto", accessKeyId: "AK", secretAccessKey: "SK", now: new Date("2026-11-14T10:00:00Z"), expiresSeconds: 900, headers: { ...headers, "content-length": length } });
  assert.equal(resign("5"), url);
  assert.notEqual(new URL(resign("6")).searchParams.get("X-Amz-Signature"), parsed.searchParams.get("X-Amz-Signature"));
  await assert.rejects(store.uploadUrl("../escape", { sha256Hex: digest, contentType: "text/plain", bytes: 5, expiresSeconds: 60 }));
  await assert.rejects(store.uploadUrl(`orgs/o/projects/p/files/${digest}.txt`, { sha256Hex: digest, contentType: "text/plain", bytes: 1.5, expiresSeconds: 60 }));
});

test("server-side writes to R2 sign the length of the body they send", async () => {
  const sent: Array<{ url: URL; headers: Record<string, string>; size: number }> = [];
  const store = new R2FileStore({ accountId: "0".repeat(32), accessKeyId: "AK", secretAccessKey: "SK", bucket: "faceful-media" }, () => new Date("2026-11-14T10:00:00Z"), (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: new URL(String(input)), headers: init?.headers as Record<string, string>, size: (init?.body as Blob).size });
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  await store.put("orgs/o/manifest.json", new TextEncoder().encode('{"ok":true}'), "application/json");
  assert.equal(sent[0].url.searchParams.get("X-Amz-SignedHeaders"), "content-length;content-type;host;x-amz-checksum-sha256");
  assert.equal(sent[0].size, 11);
  assert.equal(sent[0].headers["content-length"], undefined, "fetch sets the length from the body");
});

test("R2 settings are read from FACEFUL_R2_* and refused when the account id is malformed", () => {
  const ok = loadConfig({ FACEFUL_R2_ACCOUNT_ID: "a".repeat(32), FACEFUL_R2_ACCESS_KEY_ID: "id", FACEFUL_R2_SECRET_ACCESS_KEY: "secret" });
  assert.deepEqual(ok.r2, { accountId: "a".repeat(32), accessKeyId: "id", secretAccessKey: "secret", bucket: "faceful-media" });
  assert.equal(loadConfig({ FACEFUL_R2_ACCOUNT_ID: "nope", FACEFUL_R2_ACCESS_KEY_ID: "id", FACEFUL_R2_SECRET_ACCESS_KEY: "secret" }).r2, null);
  assert.equal(loadConfig({}).r2, null);
});

test("uploads: request, PUT, complete; identical bytes are stored once; versions count per name", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const request = { campaignId: campaign.id, itemId: item.id, kind: "voice" as const, name: "Voice take", mime: "audio/mpeg", bytes: bytes.byteLength, sha256: sha256(bytes), durationSeconds: 57.5, meta: { provider: "cartesia", speed: 1.05 } };
  const ticket = uploadTicketSchema.parse(await requestUpload(env.deps, ctx, { ...request, operationKey: key() }));
  assert.equal(ticket.file.state, "pending");
  assert.equal(ticket.file.url, null);
  assert.equal(ticket.upload?.method, "PUT");
  assert.match(ticket.upload!.url, new RegExp(`orgs/${ctx.org.id}/projects/${campaign.id}/files/${request.sha256}\\.mp3$`));
  await rejects(completeUpload(env.deps, ctx, { fileId: ticket.file.id, operationKey: key() }), "validation_error");
  // The client PUTs the bytes (R2 checks the SHA-256 header); then completes.
  await env.files.put(`orgs/${ctx.org.id}/projects/${campaign.id}/files/${request.sha256}.mp3`, bytes, "audio/mpeg");
  const ready = await completeUpload(env.deps, ctx, { fileId: ticket.file.id, operationKey: key() });
  assert.equal(ready.state, "ready");
  assert.match(ready.url ?? "", /^https:\/\/files\.test\//);
  assert.deepEqual(ready.meta, { provider: "cartesia", speed: 1.05 });
  const again = await requestUpload(env.deps, ctx, { ...request, operationKey: key() });
  assert.equal(again.upload, null, "identical bytes are not uploaded twice");
  assert.equal(again.file.state, "ready");
  assert.equal(again.file.version, 2);
  assert.ok((await listFiles(env.deps, ctx, campaign.id)).every((file) => file.campaignId === campaign.id));
  const campaignAfter = (await env.call(`/v1/studio/campaigns/${campaign.id}`, "user:u1"));
  assert.ok(((await campaignAfter.json()).activity as Array<{ action: string }>).some((event) => event.action === "Added draft file Voice take"));
});

test("uploads refuse unsafe types, oversize files, wrong sizes and other projects' items", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const base = { campaignId: campaign.id, itemId: item.id, kind: "image" as const, name: "Icon", bytes: 10, sha256: sha256("x"), operationKey: key() };
  await rejects(requestUpload(env.deps, ctx, { ...base, mime: "image/svg+xml", operationKey: key() }), "validation_error");
  await rejects(requestUpload(env.deps, ctx, { ...base, kind: "voice", mime: "text/html", operationKey: key() }), "validation_error");
  await rejects(requestUpload(env.deps, ctx, { ...base, mime: "image/png", bytes: 26 * 1024 * 1024, operationKey: key() }), "validation_error");
  const other = await seed(env, "user:u2");
  await rejects(requestUpload(env.deps, ctx, { ...base, mime: "image/png", campaignId: other.campaign.id, operationKey: key() }), "not_found");
  await rejects(requestUpload(env.deps, ctx, { ...base, mime: "image/png", itemId: other.item.id, operationKey: key() }), "not_found");
  const ticket = await requestUpload(env.deps, ctx, { ...base, mime: "image/png", operationKey: key() });
  await env.files.put(`orgs/${ctx.org.id}/projects/${campaign.id}/files/${base.sha256}.png`, new Uint8Array(9), "image/png");
  await rejects(completeUpload(env.deps, ctx, { fileId: ticket.file.id, operationKey: key() }), "validation_error");
});

test("upload links stop at the workspace's storage quota; archiving gives room back; server-side writes are not limited", async () => {
  const MB = 1024 * 1024;
  const env = engine({ STORAGE_QUOTA_BYTES: String(3 * MB) });
  const { ctx, campaign, item } = await seed(env);
  const ask = (bytes: number) => requestUpload(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "video", name: "Clip", mime: "video/mp4", bytes, sha256: sha256(crypto.randomUUID()), operationKey: key() });
  const first = await ask(2 * MB);
  // Pending files count: their bytes may already be on their way.
  await assert.rejects(ask(MB + 1), (error: unknown) => error instanceof EngineError && error.code === "quota_exceeded" && /used 2 MB of its 3 MB of file storage/.test(error.message));
  await ask(MB);
  await rejects(ask(1), "quota_exceeded");
  // The quota is per workspace: another workspace is unaffected.
  const other = await seed(env, "user:u2");
  await requestUpload(env.deps, other.ctx, { campaignId: other.campaign.id, itemId: other.item.id, kind: "video", name: "Clip", mime: "video/mp4", bytes: 2 * MB, sha256: sha256("other"), operationKey: key() });
  await archiveFile(env.deps, ctx, { fileId: first.file.id, operationKey: key() });
  assert.equal((await ask(2 * MB)).file.state, "pending");
  // Text drafts are written by the engine itself, not through a link, so a full workspace can still save a script.
  assert.equal((await saveTextFile(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "script", name: "Script", mime: "text/plain", text: "Hello", operationKey: key() })).state, "ready");
});

test("a workspace has at most 20 uploads in progress; an expired link stops counting", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const ask = () => requestUpload(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "image", name: "Still", mime: "image/png", bytes: 10, sha256: sha256(crypto.randomUUID()), operationKey: key() });
  for (let i = 0; i < 20; i++) await ask();
  await rejects(ask(), "quota_exceeded");
  // Links last 15 minutes; after that the pending file can no longer receive bytes through them.
  env.advance(16);
  assert.equal((await ask()).file.state, "pending");
});

test("text drafts are written by the engine; JSON must parse; archived files leave the list", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const words = JSON.stringify([{ t: "Your", start: 0.1, end: 0.3 }]);
  const transcript = await saveTextFile(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "transcript", name: "Words", mime: "application/json", text: words, operationKey: key() });
  assert.equal(transcript.state, "ready");
  assert.equal(transcript.sha256, sha256(words));
  assert.equal(new TextDecoder().decode(env.files.objects.get(`orgs/${ctx.org.id}/projects/${campaign.id}/files/${transcript.sha256}.json`)!.bytes), words);
  await rejects(saveTextFile(env.deps, ctx, { campaignId: campaign.id, kind: "facts", name: "Facts", mime: "application/json", text: "{nope", operationKey: key() }), "validation_error");
  const facts = await saveTextFile(env.deps, ctx, { campaignId: campaign.id, kind: "facts", name: "Facts", mime: "text/markdown", text: "- Heartbeat around week 6 (source: WHO)", operationKey: key() });
  assert.equal(facts.itemId, null, "project-level drafts need no item");
  await archiveFile(env.deps, ctx, { fileId: facts.id, operationKey: key() });
  assert.deepEqual((await listFiles(env.deps, ctx, campaign.id)).map((file) => file.name), ["Words"]);
});

test("draft-file routes: sign-in, scopes and tenancy", async () => {
  const env = engine();
  const { ctx, campaign } = await seed(env);
  const body = { campaignId: campaign.id, kind: "script", name: "Script", mime: "text/markdown", text: "Hello", operationKey: key() };
  assert.equal((await env.call(`/v1/studio/campaigns/${campaign.id}/files`, null)).status, 401);
  assert.equal((await env.call("/v1/studio/operations/save_text_file", null, body)).status, 401);
  assert.equal((await env.call(`/v1/studio/campaigns/${campaign.id}/files`, "user:u2")).status, 404);
  assert.equal((await env.call("/v1/studio/operations/save_text_file", "user:u2", body)).status, 404);
  const reader = await env.agentToken(ctx, ["campaign:read"]);
  assert.equal((await env.call("/v1/studio/operations/save_text_file", reader, body)).status, 403);
  const agent = await env.agentToken(ctx, ["campaign:read", "content:edit"]);
  const saved = await env.call("/v1/studio/operations/save_text_file", agent, body);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).createdBy, "Claude Code on the VPS (agent)");
  const list = await env.call(`/v1/studio/campaigns/${campaign.id}/files`, "user:u1");
  assert.equal(list.status, 200);
  assert.equal((await list.json()).length, 1);
});

test("without R2 settings, file routes say storage is not connected", async () => {
  const env = engine();
  delete (env.deps as { files?: unknown }).files;
  const { ctx, campaign } = await seed(env);
  await assert.rejects(saveTextFile(env.deps, ctx, { campaignId: campaign.id, kind: "script", name: "Script", mime: "text/plain", text: "Hi", operationKey: key() }), /isn’t connected/);
});
