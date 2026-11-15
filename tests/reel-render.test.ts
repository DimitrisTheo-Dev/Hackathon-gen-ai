import { test } from "node:test";
import assert from "node:assert/strict";
import { getComposition, saveComposition } from "../packages/engine/src/composition";
import { listFiles } from "../packages/engine/src/files";
import { cancelRender, listRenders, queueRender } from "../packages/engine/src/reel-render";
import { WORKER_TOKEN, engine, key, rejects, seed, sha256 } from "./reel-support";

async function savedReel(env: ReturnType<typeof engine>) {
  const seeded = await seed(env);
  const draft = (await getComposition(env.deps, seeded.ctx, seeded.item.id)).composition;
  const saved = await saveComposition(env.deps, seeded.ctx, { contentId: seeded.item.id, expectedRevision: 0, composition: draft, operationKey: key() });
  return { ...seeded, saved };
}
const worker = (env: ReturnType<typeof engine>, path: string, body: unknown, token = WORKER_TOKEN) => env.call(`/v1/worker/reel${path}`, token, body);

test("renders need a saved, current timeline and the render:write scope", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  await rejects(queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: 1, operationKey: key() }), "validation_error");
  const draft = (await getComposition(env.deps, ctx, item.id)).composition;
  await saveComposition(env.deps, ctx, { contentId: item.id, expectedRevision: 0, composition: draft, operationKey: key() });
  await saveComposition(env.deps, ctx, { contentId: item.id, expectedRevision: 1, composition: draft, operationKey: key() });
  await rejects(queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: 1, operationKey: key() }), "revision_conflict");
  await env.deps.store.insert("memberships", { org_id: ctx.org.id, user_id: "u3", role: "reviewer", created_at: env.deps.now().toISOString() });
  await rejects(queueRender(env.deps, await env.as("user:u3", ctx.org.id), { contentId: item.id, expectedRevision: 2, operationKey: key() }), "forbidden");
  const agent = await env.as(await env.agentToken(ctx, ["campaign:read", "content:edit", "render:write"]));
  const queued = await queueRender(env.deps, agent, { contentId: item.id, expectedRevision: 2, operationKey: key() });
  assert.equal(queued.state, "queued");
  assert.equal(queued.compositionRevision, 2);
});

test("a worker claims, reports progress, uploads and completes; the MP4 becomes a render draft file", async () => {
  const env = engine();
  const { ctx, campaign, item, saved } = await savedReel(env);
  const render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  assert.equal((await worker(env, "/claim", { workerId: "vps-1" }, "wrong")).status, 401);
  const claim = await (await worker(env, "/claim", { workerId: "vps-1" })).json();
  assert.equal(claim.job.id, render.id);
  assert.equal(claim.job.composition.version, 2);
  assert.equal(claim.job.itemMedia, null);
  assert.deepEqual((await (await worker(env, "/claim", { workerId: "vps-2" })).json()).job, null, "one worker per job");
  assert.equal((await worker(env, `/${render.id}/progress`, { workerId: "vps-2", progress: 0.5 })).status, 404, "another worker cannot report on it");
  assert.equal((await worker(env, `/${render.id}/progress`, { workerId: "vps-1", progress: 0.5 })).status, 200);
  assert.equal((await listRenders(env.deps, ctx, item.id))[0].progress, 0.5);
  const mp4 = new Uint8Array(2048).fill(7);
  const digest = sha256(mp4);
  const upload = await (await worker(env, `/${render.id}/upload-url`, { workerId: "vps-1", sha256: digest, bytes: mp4.byteLength })).json();
  assert.equal(upload.method, "PUT");
  assert.equal((await worker(env, `/${render.id}/complete`, { workerId: "vps-1", sha256: digest, bytes: mp4.byteLength, durationSeconds: 12.4 })).status, 400, "nothing uploaded yet");
  await env.files.put(`orgs/${ctx.org.id}/projects/${campaign.id}/files/${digest}.mp4`, mp4, "video/mp4");
  assert.equal((await worker(env, `/${render.id}/complete`, { workerId: "vps-1", sha256: digest, bytes: mp4.byteLength, durationSeconds: 12.4 })).status, 200);
  const [done] = await listRenders(env.deps, ctx, item.id);
  assert.equal(done.state, "succeeded");
  assert.equal(done.outputFile?.kind, "render");
  assert.equal(done.outputFile?.durationSeconds, 12.4);
  assert.match(done.outputFile?.url ?? "", /^https:\/\/files\.test\//);
  assert.ok((await listFiles(env.deps, ctx, campaign.id)).some((file) => file.kind === "render" && file.createdBy === "Render worker vps-1"));
});

test("a silent worker loses its lease, the job is claimed again, and three silences fail it", async () => {
  const env = engine();
  const { ctx, item, saved } = await savedReel(env);
  const render = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  for (const workerId of ["a", "b", "c"]) {
    const claim = await (await worker(env, "/claim", { workerId })).json();
    assert.equal(claim.job?.id, render.id, `worker ${workerId} gets the job`);
    env.advance(11);
  }
  assert.deepEqual((await (await worker(env, "/claim", { workerId: "d" })).json()).job, null);
  const [failed] = await listRenders(env.deps, ctx, item.id);
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /stopped responding three times/);
});

test("cancelling stops the worker; unclaimed jobs time out with a reason; at most three wait at once", async () => {
  const env = engine();
  const { ctx, item, saved } = await savedReel(env);
  const first = await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  await (await worker(env, "/claim", { workerId: "vps-1" })).json();
  await cancelRender(env.deps, ctx, { renderId: first.id, operationKey: key() });
  const stopped = await worker(env, `/${first.id}/progress`, { workerId: "vps-1", progress: 0.9 });
  assert.equal(stopped.status, 409);
  assert.match((await stopped.json()).error.message, /cancelled/);
  for (let n = 0; n < 3; n++) await queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  await rejects(queueRender(env.deps, ctx, { contentId: item.id, expectedRevision: saved.revision, operationKey: key() }), "quota_exceeded");
  env.advance(61);
  const renders = await listRenders(env.deps, ctx, item.id);
  assert.deepEqual(renders.map((render) => render.state).sort(), ["cancelled", "failed", "failed", "failed"]);
  assert.match(renders.find((render) => render.state === "failed")!.error ?? "", /No render worker picked this up/);
});

test("render routes over HTTP: scopes and tenancy; the worker route needs its own credential", async () => {
  const env = engine();
  const { item, saved } = await savedReel(env);
  assert.equal((await env.call("/v1/studio/operations/queue_reel_render", "user:u2", { contentId: item.id, expectedRevision: saved.revision, operationKey: key() })).status, 404);
  const queued = await env.call("/v1/studio/operations/queue_reel_render", "user:u1", { contentId: item.id, expectedRevision: saved.revision, operationKey: key() });
  assert.equal(queued.status, 200);
  assert.equal((await env.call(`/v1/studio/items/${item.id}/renders`, "user:u1")).status, 200);
  assert.equal((await env.call(`/v1/studio/items/${item.id}/renders`, "user:u2")).status, 404);
  assert.equal((await env.call("/v1/worker/reel/claim", "user:u1", { workerId: "x" })).status, 401, "a member session is not a worker credential");
  const none = engine({ REEL_WORKER_TOKEN: "" });
  assert.equal((await none.call("/v1/worker/reel/claim", WORKER_TOKEN, { workerId: "x" })).status, 401, "no worker can claim when none is configured");
});
