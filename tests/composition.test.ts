import { test } from "node:test";
import assert from "node:assert/strict";
import { captionsFromScript, compositionDocumentSchema, compositionSchema, draftComposition, type Composition } from "../packages/contracts/src/index";
import { authenticate, hashToken, newAgentToken, resolveContext, type Ctx } from "../packages/engine/src/access";
import { getComposition, saveComposition } from "../packages/engine/src/composition";
import { loadConfig } from "../packages/engine/src/config";
import { EngineError } from "../packages/engine/src/errors";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MemoryStore } from "../packages/engine/src/store-memory";
import { getCampaign, startCampaign } from "../packages/engine/src/studio";

/** Real engine + in-memory store. Tokens "user:<id>" stand in for verified Supabase sessions. */
function engine() {
  const deps: HttpDeps = {
    store: new MemoryStore(),
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: "https://faceful.test" }),
    now: () => new Date("2026-11-14T10:00:00.000Z"),
    verifyAccessToken: async (token) => {
      const [kind, id] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: null };
    },
    fetch: async () => new Response("{}", { status: 500 }),
    planner: null,
  };
  const as = async (token: string, org: string | null = null): Promise<Ctx> => resolveContext(deps, await authenticate(deps, `Bearer ${token}`), org, crypto.randomUUID());
  const call = async (path: string, token: string | null, body?: unknown) =>
    (await handleEngineRequest(
      deps,
      new Request(`https://faceful.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      path,
    ))!;
  return { deps, as, call };
}
const SCRIPT = "Your first scan is at week six. You will hear the heartbeat. Bring your questions, and bring someone you trust.";
async function seed(env: ReturnType<typeof engine>, user = "user:u1") {
  const ctx = await env.as(user);
  const campaign = await startCampaign(env.deps, ctx, {
    operationKey: crypto.randomUUID(),
    title: "Pregnancy week by week",
    companyContext: { name: "Clinic", description: "A fertility clinic.", audience: "Patients", tone: "Calm", sourceText: "", sourceUrl: null, missingInformation: "" },
    items: [{ title: "Your first scan", script: SCRIPT }],
  });
  return { ctx, campaign, item: campaign.items[0] };
}
const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof EngineError && error.code === code);
const save = (contentId: string, expectedRevision: number, composition: Composition, operationKey: string = crypto.randomUUID()) => ({ contentId, expectedRevision, composition, operationKey });

test("captions are split at sentence ends and spread across the requested time", () => {
  const cues = captionsFromScript("One two three four five. Six seven!", 1, 8);
  assert.deepEqual(cues.map((cue) => cue.text), ["One two three four", "five.", "Six seven!"]);
  assert.equal(cues[0].start, 1);
  assert.equal(cues.at(-1)!.end, 8);
  for (const [index, cue] of cues.entries()) {
    assert.ok(cue.end > cue.start);
    if (index) assert.equal(cue.start, cues[index - 1].end, "pages follow each other without gaps");
  }
  assert.deepEqual(captionsFromScript("   ", 0, 5), []);
});

test("a first draft fits the rendered clip when there is one, and the script when there is not", () => {
  const unrendered = draftComposition({ title: "Hello", script: SCRIPT, brandColor: "#123456", captionPosition: "bottom", mediaDurationSeconds: null });
  assert.equal(unrendered.durationSeconds, Math.ceil(SCRIPT.split(" ").length / 2.5 + 1.5));
  assert.equal(unrendered.cards[0].title, "Hello");
  assert.equal(unrendered.style.accent, "#123456");
  assert.equal(unrendered.presenter.source, "item_media");
  const rendered = draftComposition({ title: "Hello", script: SCRIPT, brandColor: "#123456", captionPosition: "center", mediaDurationSeconds: 31.4 });
  assert.equal(rendered.durationSeconds, 31.4);
  assert.equal(rendered.captions.at(-1)!.end, 31.4);
  assert.ok(compositionSchema.safeParse(rendered).success);
});

test("the contract rejects clips that end before they start or after the video, http media and duplicate ids", () => {
  const base = draftComposition({ title: "Hello", script: SCRIPT, brandColor: "#123456", captionPosition: "bottom", mediaDurationSeconds: 20 });
  const bad = (patch: Partial<Composition>) => compositionSchema.safeParse({ ...base, ...patch }).success;
  assert.equal(bad({ captions: [{ id: "a", start: 3, end: 2, text: "Backwards" }] }), false);
  assert.equal(bad({ captions: [{ id: "a", start: 3, end: 25, text: "Too long" }] }), false);
  assert.equal(bad({ captions: [{ id: "a", start: 1, end: 2, text: "One" }, { id: "a", start: 2, end: 3, text: "Two" }] }), false);
  assert.equal(bad({ broll: [{ id: "b", start: 0, end: 2, media: "video", url: "http://cdn.example.com/a.mp4", layout: "split", trimStart: 0 }] }), false);
  assert.equal(bad({ broll: [{ id: "b", start: 0, end: 2, media: "video", url: "https://user:pw@cdn.example.com/a.mp4", layout: "split", trimStart: 0 }] }), false);
  assert.equal(bad({ presenter: { source: "url", url: null, trimStart: 0, volume: 1 } }), false);
  assert.equal(bad({ broll: [{ id: "b", start: 0, end: 2, media: "video", url: "https://cdn.example.com/a.mp4", layout: "split", trimStart: 0 }] }), true);
});

test("reading a composition before any save returns a first draft from the item, without writing anything", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const document = await getComposition(env.deps, ctx, item.id);
  assert.equal(document.revision, 0);
  assert.equal(document.updatedAt, null);
  assert.equal(document.itemRevision, item.revision);
  assert.equal(document.presenterMedia, null, "nothing is rendered yet");
  assert.equal(document.composition.cards[0].title, "Your first scan");
  assert.equal(document.composition.captions.map((cue) => cue.text).join(" "), SCRIPT);
  assert.equal((await env.deps.store.select("video_compositions", {})).length, 0);
});

test("saving uses compare-and-swap revisions, replays by operation key, audits, and leaves the item revision alone", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const draft = (await getComposition(env.deps, ctx, item.id)).composition;
  const edited: Composition = { ...draft, captions: draft.captions.map((cue, index) => (index === 0 ? { ...cue, text: "Week six: your first scan." } : cue)) };
  const first = save(item.id, 0, edited);
  const saved = await saveComposition(env.deps, ctx, first);
  assert.equal(saved.revision, 1);
  assert.equal(saved.composition.captions[0].text, "Week six: your first scan.");
  assert.deepEqual(await saveComposition(env.deps, ctx, first), saved, "the same key replays the recorded result");
  await rejects(saveComposition(env.deps, ctx, { ...first, composition: draft }), "idempotency_conflict");
  await rejects(saveComposition(env.deps, ctx, save(item.id, 0, draft)), "revision_conflict");
  const second = await saveComposition(env.deps, ctx, save(item.id, 1, { ...edited, music: { url: "https://cdn.example.com/bed.mp3", volume: 0.2 } }));
  assert.equal(second.revision, 2);
  assert.equal((await getComposition(env.deps, ctx, item.id)).composition.music?.volume, 0.2);
  assert.equal((await env.deps.store.select("video_compositions", {})).length, 1, "one row per item");
  const campaign = await getCampaign(env.deps, ctx, item.campaignId);
  assert.equal(campaign.items[0].revision, item.revision, "the composition never invalidates the item or its render");
  assert.ok(campaign.activity.some((event) => event.action === "Saved the video edit" && event.revision === 2));
});

test("a rendered presenter clip is resolved to a fresh signed URL and sets the draft length", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const path = `${ctx.org.id}/${item.id}/1.mp4`;
  await env.deps.store.media.put(path, new Uint8Array([1, 2, 3]), "video/mp4");
  const assetId = crypto.randomUUID();
  await env.deps.store.insert("media_assets", { id: assetId, org_id: ctx.org.id, item_id: item.id, revision: 1, storage_path: path, sha256: "abc", duration_seconds: 24, has_audio: true, created_at: env.deps.now().toISOString() });
  await env.deps.store.update("content_items", { id: item.id }, { media_asset_id: assetId, render_revision: 1, status: "ready" });
  const document = await getComposition(env.deps, ctx, item.id);
  assert.match(document.presenterMedia?.url ?? "", /^https:\/\/media\.test\//);
  assert.equal(document.presenterMedia?.durationSeconds, 24);
  assert.equal(document.composition.durationSeconds, 24);
});

test("workspace, role and token boundaries apply to reading and saving compositions", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const draft = (await getComposition(env.deps, ctx, item.id)).composition;
  // Another account's workspace cannot see or write this item.
  const stranger = await env.as("user:u2");
  await rejects(getComposition(env.deps, stranger, item.id), "not_found");
  await rejects(saveComposition(env.deps, stranger, save(item.id, 0, draft)), "not_found");
  // A reviewer in the same workspace may read but not edit.
  await env.deps.store.insert("memberships", { org_id: ctx.org.id, user_id: "u3", role: "reviewer", created_at: env.deps.now().toISOString() });
  const reviewer = await env.as("user:u3", ctx.org.id);
  assert.equal((await getComposition(env.deps, reviewer, item.id)).revision, 0);
  await rejects(saveComposition(env.deps, reviewer, save(item.id, 0, draft)), "forbidden");
  // A workspace token needs content:edit to save.
  const token = async (scopes: string[]) => {
    const value = newAgentToken();
    await env.deps.store.insert("agent_connections", { id: crypto.randomUUID(), org_id: ctx.org.id, display_name: "Codex", token_sha256: hashToken(value), scopes, expires_at: "2026-12-01T00:00:00.000Z", last_seen_at: null, revoked_at: null, created_by: "u1", created_at: env.deps.now().toISOString() });
    return value;
  };
  const reader = await env.as(await token(["campaign:read"]));
  await rejects(saveComposition(env.deps, reader, save(item.id, 0, draft)), "forbidden");
  const editor = await env.as(await token(["campaign:read", "content:edit"]));
  assert.equal((await saveComposition(env.deps, editor, save(item.id, 0, draft))).revision, 1);
  assert.equal((await env.deps.store.select("video_compositions", {}))[0].updated_by.startsWith("agent:"), true);
});

test("HTTP routes: sign-in is required, results follow the contract, and invalid edits are a 400", async () => {
  const env = engine();
  const { item } = await seed(env);
  const path = `/v1/studio/items/${item.id}/composition`;
  assert.equal((await env.call(path, null)).status, 401);
  assert.equal((await env.call("/v1/studio/operations/save_composition", null, {})).status, 401);
  const read = await env.call(path, "user:u1");
  assert.equal(read.status, 200);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  const document = compositionDocumentSchema.parse(await read.json());
  const backwards = { ...document.composition, cards: [{ ...document.composition.cards[0], start: 2, end: 1 }] };
  const invalid = await env.call("/v1/studio/operations/save_composition", "user:u1", save(item.id, 0, backwards));
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error.message, /cards\.0\.end: must be after the start/);
  const saved = await env.call("/v1/studio/operations/save_composition", "user:u1", save(item.id, 0, document.composition));
  assert.equal(saved.status, 200);
  assert.equal(compositionDocumentSchema.parse(await saved.json()).revision, 1);
  const stale = await env.call("/v1/studio/operations/save_composition", "user:u1", save(item.id, 0, document.composition));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "revision_conflict");
  assert.equal((await env.call(`/v1/studio/items/${crypto.randomUUID()}/composition`, "user:u1")).status, 404);
  assert.equal((await env.call(path, "user:u2")).status, 404, "another workspace's item is not found");
});
