import { test } from "node:test";
import assert from "node:assert/strict";
import { captionsFromScript, captionsFromWords, compositionDocumentSchema, compositionSchema, draftComposition, referencedFileIds, type Composition } from "../packages/contracts/src/index";
import { getComposition, saveComposition } from "../packages/engine/src/composition";
import { archiveFile, saveTextFile } from "../packages/engine/src/files";
import { getCampaign } from "../packages/engine/src/studio";
import { SCRIPT, engine, key, rejects, seed } from "./reel-support";

const save = (contentId: string, expectedRevision: number, composition: Composition, operationKey: string = key()) => ({ contentId, expectedRevision, composition, operationKey });
const NO = { kind: "cut" as const, duration: 0 };

test("captions are split at sentence ends and spread across the requested time", () => {
  const cues = captionsFromScript("One two three four five. Six seven!", 1, 8);
  assert.deepEqual(cues.map((cue) => cue.text), ["One two three four", "five.", "Six seven!"]);
  assert.equal(cues[0].start, 1);
  assert.equal(cues.at(-1)!.end, 8);
  for (const [index, cue] of cues.entries()) if (index) assert.equal(cue.start, cues[index - 1].end, "pages follow each other without gaps");
  assert.deepEqual(captionsFromScript("   ", 0, 5), []);
});

test("captions from real word timings break at pauses and hold until the next page", () => {
  const cues = captionsFromWords([
    { t: "Πέντε", start: 0.08, end: 0.36 },
    { t: "βήματα,", start: 0.44, end: 0.84 },
    { t: "που", start: 1.08, end: 1.2 },
    { t: "ξέρει.", start: 2.36, end: 2.72 },
    { t: "Για", start: 3.6, end: 3.8 },
  ]);
  assert.deepEqual(cues.map((cue) => cue.text), ["Πέντε βήματα, που", "ξέρει.", "Για"]);
  assert.equal(cues[0].end, 1.2, "a pause over 0.6 s ends the page at its last word");
  assert.equal(cues[1].end, 2.72);
});

test("a first draft puts the rendered presenter on the main layer and labels it as an AI avatar", () => {
  const draft = draftComposition({ title: "Hello", script: SCRIPT, brandColor: "#123456", captionPosition: "bottom", mediaDurationSeconds: 31.4 });
  assert.equal(draft.version, 2);
  assert.equal(draft.durationSeconds, 31.4);
  assert.deepEqual(draft.video.map((clip) => [clip.layer, clip.source.kind, clip.start, clip.end]), [[0, "item_media", 0, 31.4]]);
  assert.equal(draft.captions.at(-1)!.end, 31.4);
  assert.equal(draft.labels.aiAvatar, true);
  assert.equal(draft.cards[0].title, "Hello");
  const unrendered = draftComposition({ title: "Hello", script: SCRIPT, brandColor: "#123456", captionPosition: "bottom", mediaDurationSeconds: null });
  assert.equal(unrendered.durationSeconds, Math.ceil(SCRIPT.split(" ").length / 2.5 + 1.5));
});

test("the contract rejects clips outside the video, duplicate ids, http media and backwards words", () => {
  const base = draftComposition({ title: "Hello", script: SCRIPT, brandColor: "#123456", captionPosition: "bottom", mediaDurationSeconds: 20 });
  const ok = (patch: Partial<Composition>) => compositionSchema.safeParse({ ...base, ...patch }).success;
  const clip = { id: "b", start: 0, end: 2, media: "video" as const, in: 0, layer: 1 as const, layout: "split" as const, volume: 0, syncOffsetFrames: 0, transitionIn: NO, transitionOut: NO };
  assert.equal(ok({ captions: [{ id: "a", start: 3, end: 2, text: "Backwards" }] }), false);
  assert.equal(ok({ captions: [{ id: "a", start: 3, end: 25, text: "Too long" }] }), false);
  assert.equal(ok({ video: [...base.video, { ...clip, id: "presenter", source: { kind: "url", url: "https://cdn.example.com/a.mp4" } }] }), false);
  assert.equal(ok({ video: [{ ...clip, source: { kind: "url", url: "http://cdn.example.com/a.mp4" } }] }), false);
  assert.equal(ok({ transcript: { language: "el", sourceFileId: null, words: [{ t: "a", start: 2, end: 1 }] } }), false);
  assert.equal(ok({ video: [...base.video, { ...clip, source: { kind: "url", url: "https://cdn.example.com/a.mp4" } }] }), true);
});

test("reading before any save returns a first draft without writing anything", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const document = await getComposition(env.deps, ctx, item.id);
  assert.equal(document.revision, 0);
  assert.equal(document.itemMedia, null, "nothing is rendered yet");
  assert.deepEqual(document.files, {});
  assert.equal(document.composition.captions.map((cue) => cue.text).join(" "), SCRIPT);
  assert.equal((await env.deps.store.select("video_compositions", {})).length, 0);
});

test("saving uses compare-and-swap revisions, replays by key, audits, and leaves the item revision alone", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const draft = (await getComposition(env.deps, ctx, item.id)).composition;
  const edited: Composition = { ...draft, labels: { aiAvatar: true, disclaimer: "Educational content, not medical advice." } };
  const first = save(item.id, 0, edited);
  const saved = await saveComposition(env.deps, ctx, first);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await saveComposition(env.deps, ctx, first), saved, "the same key replays the recorded result");
  await rejects(saveComposition(env.deps, ctx, { ...first, composition: draft }), "idempotency_conflict");
  await rejects(saveComposition(env.deps, ctx, save(item.id, 0, draft)), "revision_conflict");
  assert.equal((await saveComposition(env.deps, ctx, save(item.id, 1, draft))).revision, 2);
  const campaign = await getCampaign(env.deps, ctx, item.campaignId);
  assert.equal(campaign.items[0].revision, item.revision, "the timeline never invalidates the item or its render");
  assert.ok(campaign.activity.some((event) => event.action === "Saved the video edit" && event.revision === 2));
});

test("timelines may only use ready draft files of the same project, and reads resolve them to links", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const other = await seed(env, "user:u2");
  const words = [{ t: "Your", start: 0.4, end: 0.7 }];
  const transcript = await saveTextFile(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "transcript", name: "Words", mime: "application/json", text: JSON.stringify(words), operationKey: key() });
  const foreign = await saveTextFile(env.deps, other.ctx, { campaignId: other.campaign.id, kind: "transcript", name: "Words", mime: "application/json", text: "[]", operationKey: key() });
  const draft = (await getComposition(env.deps, ctx, item.id)).composition;
  const withTranscript: Composition = { ...draft, transcript: { language: "en", words, sourceFileId: transcript.id } };
  assert.deepEqual(referencedFileIds(withTranscript), [transcript.id]);
  await rejects(saveComposition(env.deps, ctx, save(item.id, 0, { ...withTranscript, transcript: { ...withTranscript.transcript!, sourceFileId: foreign.id } })), "validation_error");
  const saved = await saveComposition(env.deps, ctx, save(item.id, 0, withTranscript));
  assert.match(saved.files[transcript.id].url, /^https:\/\/files\.test\//);
  assert.equal(saved.files[transcript.id].mime, "application/json");
  await archiveFile(env.deps, ctx, { fileId: transcript.id, operationKey: key() });
  assert.deepEqual((await getComposition(env.deps, ctx, item.id)).files, {}, "an archived file is no longer resolved");
  await rejects(saveComposition(env.deps, ctx, save(item.id, 1, withTranscript)), "validation_error");
});

test("a rendered presenter clip is resolved to a fresh signed URL and sets the draft length", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const path = `${ctx.org.id}/${item.id}/1.mp4`;
  await env.deps.store.media.put(path, new Uint8Array([1, 2, 3]), "video/mp4");
  const assetId = crypto.randomUUID();
  await env.deps.store.insert("media_assets", { id: assetId, org_id: ctx.org.id, item_id: item.id, revision: 1, storage_path: path, mime: "video/mp4", sha256: "abc", duration_seconds: 24, has_audio: true, created_at: env.deps.now().toISOString() });
  await env.deps.store.update("content_items", { id: item.id }, { media_asset_id: assetId, render_revision: 1, status: "ready" });
  const document = await getComposition(env.deps, ctx, item.id);
  assert.match(document.itemMedia?.url ?? "", /^https:\/\/media\.test\//);
  assert.equal(document.itemMedia?.durationSeconds, 24);
  assert.equal(document.composition.durationSeconds, 24);
});

test("workspace, role and token boundaries apply to reading and saving timelines", async () => {
  const env = engine();
  const { ctx, item } = await seed(env);
  const draft = (await getComposition(env.deps, ctx, item.id)).composition;
  const stranger = await env.as("user:u2");
  await rejects(getComposition(env.deps, stranger, item.id), "not_found");
  await rejects(saveComposition(env.deps, stranger, save(item.id, 0, draft)), "not_found");
  await env.deps.store.insert("memberships", { org_id: ctx.org.id, user_id: "u3", role: "reviewer", created_at: env.deps.now().toISOString() });
  const reviewer = await env.as("user:u3", ctx.org.id);
  assert.equal((await getComposition(env.deps, reviewer, item.id)).revision, 0);
  await rejects(saveComposition(env.deps, reviewer, save(item.id, 0, draft)), "forbidden");
  const reader = await env.as(await env.agentToken(ctx, ["campaign:read"]));
  await rejects(saveComposition(env.deps, reader, save(item.id, 0, draft)), "forbidden");
  const editor = await env.as(await env.agentToken(ctx, ["campaign:read", "content:edit"]));
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
  assert.equal((await env.call("/v1/studio/operations/save_composition", "user:u1", save(item.id, 0, document.composition))).status, 200);
  const stale = await env.call("/v1/studio/operations/save_composition", "user:u1", save(item.id, 0, document.composition));
  assert.equal(stale.status, 409);
  assert.equal((await env.call(`/v1/studio/items/${crypto.randomUUID()}/composition`, "user:u1")).status, 404);
  assert.equal((await env.call(path, "user:u2")).status, 404, "another workspace's item is not found");
});
