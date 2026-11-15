import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cleanKey, handle, mintToken, verifyToken, MAX_OBJECT_BYTES } from "../apps/workspace-store/src/index";
import { memoryBucket } from "./support/memory-bucket";

const SECRET = "s".repeat(64);
const call = (env: Parameters<typeof handle>[1], path: string, init: RequestInit & { token?: string } = {}) =>
  handle(new Request(`https://store.test${path}`, { ...init, headers: { ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}), ...(init.headers as Record<string, string> | undefined) } }), env);

test("tokens are per user and can't be forged", async () => {
  const alice = await mintToken(SECRET, "alice");
  assert.match(alice, /^fst1\.alice\.[A-Za-z0-9_-]{43}$/);
  assert.equal(await verifyToken(SECRET, `Bearer ${alice}`), "alice");
  assert.equal(await verifyToken(SECRET, `Bearer ${alice.replace("alice", "bob")}`), null);
  assert.equal(await verifyToken("t".repeat(64), `Bearer ${alice}`), null);
  assert.equal(await verifyToken(SECRET, null), null);
  await assert.rejects(mintToken(SECRET, "Alice!"), /User ids/);
  await assert.rejects(mintToken("short", "alice"), /32/);
});

test("the CLI mints the same token as the Worker", async () => {
  const cli = execFileSync(process.execPath, ["apps/workspace-store/mint-token.mjs", "alice"], { env: { ...process.env, FACEFUL_STORE_SIGNING_KEY: SECRET } }).toString();
  assert.equal(cli, await mintToken(SECRET, "alice"));
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

  const put = await call(env, "/v1/objects/projects/demo/components/hero.json", { method: "PUT", token: alice, body: '{"start":0,"end":3.5}', headers: { "content-type": "application/json", "content-length": "21", "x-store-meta": '{"kind":"component"}' } });
  assert.equal(put.status, 201);
  assert.ok(objects.has("users/alice/projects/demo/components/hero.json"));

  const got = await call(env, "/v1/objects/projects/demo/components/hero.json", { token: alice });
  assert.equal(got.status, 200);
  assert.equal(await got.text(), '{"start":0,"end":3.5}');
  assert.equal(got.headers.get("content-type"), "application/json");

  assert.equal((await call(env, "/v1/objects/projects/demo/components/hero.json", { token: bob })).status, 404);
  const listed = await (await call(env, "/v1/objects?prefix=projects/", { token: alice })).json() as { objects: { key: string; metadata: Record<string, string> }[] };
  assert.deepEqual(listed.objects.map((item) => item.key), ["projects/demo/components/hero.json"]);
  assert.equal(listed.objects[0].metadata.kind, "component");
  assert.deepEqual(((await (await call(env, "/v1/objects", { token: bob })).json()) as { objects: unknown[] }).objects, []);

  assert.equal((await call(env, "/v1/objects/..%2Fbob%2Fx", { token: alice, method: "PUT", body: "x", headers: { "content-length": "1" } })).status, 400);
  assert.equal((await call(env, "/v1/objects?prefix=..%2F", { token: alice })).status, 400);
  assert.equal((await call(env, "/v1/objects/a", { token: alice, method: "PUT", body: "x", headers: { "content-length": String(MAX_OBJECT_BYTES + 1) } })).status, 413);
  assert.equal((await call(env, "/v1/objects/a", { token: alice, method: "PUT", body: "x", headers: { "content-length": "1", "x-store-meta": "[1]" } })).status, 400);

  assert.equal((await call(env, "/v1/objects/projects/demo/components/hero.json", { token: alice, method: "DELETE" })).status, 204);
  assert.equal(objects.size, 0);
});
