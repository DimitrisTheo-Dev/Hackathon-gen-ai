import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { cleanKey, handle, isWritableKey, mintToken, revocationKey, verifyToken, MAX_OBJECT_BYTES } from "../apps/workspace-store/src/index";
import { memoryBucket } from "./support/memory-bucket";

const SECRET = "s".repeat(64);
const call = (env: Parameters<typeof handle>[1], path: string, init: RequestInit & { token?: string } = {}) =>
  handle(new Request(`https://store.test${path}`, { ...init, headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.headers as Record<string, string> | undefined) } }), env);

test("tokens are per user, expire, and can't be forged", async () => {
  const alice = await mintToken(SECRET, "alice");
  assert.match(alice, /^fst2\.1\.alice\.\d+\.\d+\.[A-Za-z0-9_-]{43}$/);
  const claims = await verifyToken(SECRET, `Bearer ${alice}`);
  assert.equal(claims?.uid, "alice");
  assert.equal(claims!.expiresAt - claims!.issuedAt, 12 * 3600, "a machine's token lives 12 hours");
  assert.equal(await verifyToken(SECRET, `Bearer ${alice}`, Date.now() + 12 * 3_600_000 + 1000), null, "expired");
  assert.equal(await verifyToken(SECRET, `Bearer ${alice.replace("alice", "bob")}`), null);
  assert.equal(await verifyToken("t".repeat(64), `Bearer ${alice}`), null);
  assert.equal(await verifyToken(SECRET, null), null);
  const legacy = `fst1.alice.${createHmac("sha256", SECRET).update("fst1:alice").digest("base64url")}`;
  assert.equal(await verifyToken(SECRET, `Bearer ${legacy}`), null, "the old tokens that never expired are refused");
  assert.equal((await verifyToken(`2:${"n".repeat(64)},1:${SECRET}`, `Bearer ${alice}`))?.uid, "alice", "still valid while its key version is kept");
  await assert.rejects(mintToken(SECRET, "Alice!"), /User ids/);
  await assert.rejects(mintToken("short", "alice"), /32/);
  await assert.rejects(mintToken(SECRET, "alice", 91 * 86_400), /90 days/);
});

test("the CLI mints tokens the Worker accepts, for a set time", async () => {
  const mint = (...args: string[]) => execFileSync(process.execPath, ["apps/workspace-store/mint-token.mjs", ...args], { env: { ...process.env, FACEFUL_STORE_SIGNING_KEY: SECRET }, stdio: "pipe" }).toString();
  const cli = await verifyToken(SECRET, `Bearer ${mint("alice")}`);
  assert.deepEqual([cli?.uid, cli!.expiresAt - cli!.issuedAt], ["alice", 30 * 86_400]);
  const short = await verifyToken(SECRET, `Bearer ${mint("alice", "12h")}`);
  assert.ok(short && short.expiresAt - Math.floor(Date.now() / 1000) <= 12 * 3600);
  assert.throws(() => mint("alice", "120d"), /at most 90d/);
});

test("one user's tokens can be revoked: everything issued before the marker is refused", async () => {
  const { bucket, objects } = memoryBucket();
  const env = { BUCKET: bucket, STORE_SIGNING_KEY: SECRET };
  const before = await mintToken(SECRET, "alice", 3600, Date.now() - 5000);
  const bob = await mintToken(SECRET, "bob", 3600, Date.now() - 5000);
  assert.equal((await call(env, "/v1/objects", { token: before })).status, 200);
  await bucket.put(revocationKey("alice"), new TextEncoder().encode("leaked").buffer as ArrayBuffer);
  const refused = await call(env, "/v1/objects", { token: before });
  assert.equal(refused.status, 401);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, "token_revoked");
  assert.equal((await call(env, "/v1/objects", { token: bob })).status, 200, "other users are untouched");
  assert.equal((await call(env, "/v1/objects", { token: await mintToken(SECRET, "alice", 3600, Date.now() + 2000) })).status, 200, "a token minted afterwards works");
  assert.equal((await call(env, `/v1/objects/..%2F..%2F${revocationKey("alice").replace("/", "%2F")}`, { token: before, method: "DELETE" })).status, 401);
  assert.ok(objects.has("revocations/alice"));
});

test("keys can't climb out of the user's folder", () => {
  assert.equal(cleanKey("projects/a/saves/x.tar.gz"), "projects/a/saves/x.tar.gz");
  for (const bad of ["", "/abs", "a/../b", "..", "a//b", "a/./b", "a/b/", "a%2F..%2Fb", "spaces here", "%E0%A4%A"]) assert.equal(cleanKey(bad), null, bad);
  assert.equal(cleanKey("", { prefix: true }), "");
  assert.equal(cleanKey("projects/a/", { prefix: true }), "projects/a/");
  assert.equal(cleanKey("../", { prefix: true }), null);
});

test("each user reads and writes only their own folder", async () => {
  const { bucket, objects } = memoryBucket();
  const env = { BUCKET: bucket, STORE_SIGNING_KEY: SECRET };
  const alice = await mintToken(SECRET, "alice");
  const bob = await mintToken(SECRET, "bob");

  assert.equal((await call(env, "/v1/objects")).status, 401);
  assert.equal((await call(env, "/health")).status, 200);

  const put = await call(env, "/v1/objects/projects/demo/autosave.tar.gz", { method: "PUT", token: alice, body: '{"start":0,"end":3.5}', headers: { "content-type": "application/gzip", "content-length": "21", "x-store-meta": '{"kind":"auto"}' } });
  assert.equal(put.status, 201);
  assert.ok(objects.has("users/alice/projects/demo/autosave.tar.gz"));

  const got = await call(env, "/v1/objects/projects/demo/autosave.tar.gz", { token: alice });
  assert.equal(got.status, 200);
  assert.equal(await got.text(), '{"start":0,"end":3.5}');
  assert.equal(got.headers.get("content-type"), "application/gzip");

  assert.equal((await call(env, "/v1/objects/projects/demo/autosave.tar.gz", { token: bob })).status, 404);
  const listed = await (await call(env, "/v1/objects?prefix=projects/", { token: alice })).json() as { objects: { key: string; metadata: Record<string, string> }[] };
  assert.deepEqual(listed.objects.map((item) => item.key), ["projects/demo/autosave.tar.gz"]);
  assert.equal(listed.objects[0].metadata.kind, "auto");
  assert.deepEqual(((await (await call(env, "/v1/objects", { token: bob })).json()) as { objects: unknown[] }).objects, []);

  assert.equal((await call(env, "/v1/objects/..%2Fbob%2Fx", { token: alice, method: "PUT", body: "x", headers: { "content-length": "1" } })).status, 400);
  assert.equal((await call(env, "/v1/objects?prefix=..%2F", { token: alice })).status, 400);
  assert.equal((await call(env, "/v1/objects/private/claude-home.tar.gz", { token: alice, method: "PUT", body: "x", headers: { "content-length": String(MAX_OBJECT_BYTES + 1) } })).status, 413);
  assert.equal((await call(env, "/v1/objects/private/claude-home.tar.gz", { token: alice, method: "PUT", body: "x", headers: { "content-length": "1", "x-store-meta": "[1]" } })).status, 400);

  assert.equal((await call(env, "/v1/objects/projects/demo/autosave.tar.gz", { token: alice, method: "DELETE" })).status, 204);
  assert.equal(objects.size, 0);
});

const put = (env: Parameters<typeof handle>[1], token: string, key: string, bytes: number) =>
  call(env, `/v1/objects/${key}`, { method: "PUT", token, body: "x".repeat(bytes), headers: { "content-length": String(bytes) } });
const refusal = async (response: Response) => [response.status, ((await response.json()) as { error: { code: string } }).error.code];

test("only the keys a runner writes are accepted", async () => {
  for (const key of ["private/claude-home.tar.gz", "projects/demo/autosave.tar.gz", "projects/3f2c1d7e-aaaa-4bbb-8ccc-000000000001/saves/2026-11-15T10-00-00-000Z.tar.gz"]) assert.ok(isWritableKey(key), key);
  for (const key of ["projects/demo/components/hero.json", "private/other.tar.gz", "projects/demo/autosave.tar.gz.bak", "projects/demo/saves/x.tar.gz", "projects/-x/autosave.tar.gz", "notes.txt", "projects/demo/saves/nested/1.tar.gz"]) assert.ok(!isWritableKey(key), key);
  const { bucket, objects } = memoryBucket();
  const env = { BUCKET: bucket, STORE_SIGNING_KEY: SECRET };
  const alice = await mintToken(SECRET, "alice");
  assert.deepEqual(await refusal(await put(env, alice, "projects/demo/components/hero.json", 5)), [400, "invalid_key"]);
  assert.equal(objects.size, 0);
});

test("each user's folder has a byte quota, a version cap per project and a project cap", async () => {
  const { bucket, objects } = memoryBucket();
  const env = { BUCKET: bucket, STORE_SIGNING_KEY: SECRET, USER_QUOTA_BYTES: "100", MAX_VERSIONS_PER_PROJECT: "2", MAX_PROJECTS_PER_USER: "2" };
  const alice = await mintToken(SECRET, "alice");
  const bob = await mintToken(SECRET, "bob");
  const save = (n: number) => `projects/p1/saves/2026-11-15T10-00-0${n}-000Z.tar.gz`;

  assert.equal((await put(env, alice, "projects/p1/autosave.tar.gz", 60)).status, 201);
  const full = await put(env, alice, "private/claude-home.tar.gz", 50);
  assert.equal(full.status, 507);
  assert.match(((await full.clone().json()) as { error: { message: string } }).error.message, /full: 0\.00 GB of 0\.00 GB/);
  assert.deepEqual(await refusal(full), [507, "quota_exceeded"]);
  assert.equal((await put(env, alice, "projects/p1/autosave.tar.gz", 90)).status, 201, "replacing an object frees its old size");
  assert.equal((await put(env, bob, "projects/p1/autosave.tar.gz", 90)).status, 201, "each user has their own quota");
  assert.equal((await put(env, alice, "projects/p1/autosave.tar.gz", 10)).status, 201);

  assert.equal((await put(env, alice, save(1), 5)).status, 201);
  assert.equal((await put(env, alice, save(2), 5)).status, 201);
  assert.deepEqual(await refusal(await put(env, alice, save(3), 5)), [409, "too_many_versions"]);
  assert.equal((await put(env, alice, save(2), 6)).status, 201, "rewriting a version is not a new one");

  assert.equal((await put(env, alice, "projects/p2/autosave.tar.gz", 5)).status, 201);
  assert.deepEqual(await refusal(await put(env, alice, "projects/p3/autosave.tar.gz", 5)), [409, "too_many_projects"]);
  assert.equal((await put(env, alice, "private/claude-home.tar.gz", 5)).status, 201, "Claude's sign-in is not a project");
  assert.equal([...objects.keys()].filter((key) => key.startsWith("users/alice/")).length, 5);
});

test("the quota counts every page of a large folder", async () => {
  const { bucket } = memoryBucket();
  const env = { BUCKET: bucket, STORE_SIGNING_KEY: SECRET, USER_QUOTA_BYTES: "1600", MAX_VERSIONS_PER_PROJECT: "5000" };
  for (let index = 0; index < 1500; index++) await bucket.put(`users/alice/projects/p/saves/${index}.tar.gz`, new Uint8Array([1]).buffer as ArrayBuffer);
  const alice = await mintToken(SECRET, "alice");
  assert.deepEqual(await refusal(await put(env, alice, "projects/q/autosave.tar.gz", 200)), [507, "quota_exceeded"], "1,500 bytes listed over two pages, plus 200");
  assert.equal((await put(env, alice, "projects/q/autosave.tar.gz", 100)).status, 201);
});
