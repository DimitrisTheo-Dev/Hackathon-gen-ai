import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { beatsFromText, draftScriptResultSchema, scriptFromBeats, TAKE_PART_BYTES } from "../packages/contracts/src/index";
import type { Planner } from "../packages/engine/src/llm";
import { draftScript } from "../packages/engine/src/script";
import { abortTake, completeTake, startTake, takePartUrl } from "../packages/engine/src/takes";
import { listFiles } from "../packages/engine/src/files";
import { R2FileStore } from "../packages/engine/src/r2";
import { previewComposition, savedComposition, stepsFor, STILL_PRESENTER, timedWords } from "../apps/web/src/create/model";
import { engine, seed } from "./reel-support";

const brief = "Three signs you should book an eye check this year. Blurry screens at night. Headaches after reading. End with: book online in two minutes.";
const draftInput = (extra: Record<string, unknown> = {}) => ({ brief, language: "en", seconds: 30, presenter: "camera", operationKey: crypto.randomUUID(), ...extra });

test("without a model, the script step splits the person's own words into lines and writes nothing new", async () => {
  const env = engine();
  const { ctx } = await seed(env);
  const result = await draftScript(env.deps, ctx, draftInput(), null);
  assert.equal(result.mode, "basic");
  assert.equal(scriptFromBeats(result.beats).replace(/\s+/g, " "), brief);
  // A rewrite request without a model keeps the script exactly as it was.
  const again = await draftScript(env.deps, ctx, draftInput({ beats: result.beats, instruction: "Make it shorter" }), null);
  assert.deepEqual(again.beats, result.beats);
  assert.match(again.reply, /isn’t connected/);
});

test("with a model, a first draft comes back as beats and a one-line rewrite changes only that line", async () => {
  const env = engine();
  const { ctx } = await seed(env);
  const prompts: string[] = [];
  const planner: Planner = {
    plan: async () => {
      throw new Error("not used");
    },
    generate: async <T>(schema: z.ZodType<T>, input: { system: string; user: string }) => {
      prompts.push(input.user);
      return schema.parse({
        title: "Book your eye check",
        beats: [
          { label: "Hook", text: "Your eyes are asking for a check." },
          { label: "Signs", text: "Blurry screens at night. Headaches after reading." },
          { label: "Call to action", text: "Book online in two minutes." },
        ],
        reply: "I drafted three beats.",
      });
    },
  };
  const first = await draftScript(env.deps, ctx, draftInput(), planner);
  assert.equal(first.mode, "ai");
  assert.deepEqual(first.beats.map((beat) => beat.id), ["beat-1", "beat-2", "beat-3"]);
  assert.match(prompts[0], /"targetWords":75/);
  assert.match(prompts[0], /"presenter":"camera"/);
  const edited = first.beats.map((beat, index) => (index === 0 ? { ...beat, text: "My own hook, word for word." } : beat));
  const rewrite = await draftScript(env.deps, ctx, draftInput({ beats: edited, instruction: "Shorter", beatId: "beat-2" }), planner);
  assert.equal(rewrite.beats[0].text, "My own hook, word for word.");
  assert.equal(rewrite.beats[2].text, edited[2].text);
  assert.equal(rewrite.beats.length, 3);
  assert.ok(draftScriptResultSchema.safeParse(rewrite).success);
});

test("a recorded take streams in parts and becomes a ready voice file of the project", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const started = await startTake(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "voice", mime: "audio/webm", name: "Voice take", operationKey: crypto.randomUUID() });
  assert.equal(started.partBytes, TAKE_PART_BYTES);
  const parts = [new Uint8Array(TAKE_PART_BYTES).fill(1), new Uint8Array(1234).fill(2)];
  const sent = [];
  for (const [index, bytes] of parts.entries()) {
    const link = await takePartUrl(env.deps, ctx, { fileId: started.fileId, partNumber: index + 1, bytes: bytes.byteLength });
    const url = new URL(link.url);
    assert.equal(url.searchParams.get("partNumber"), String(index + 1));
    sent.push({ partNumber: index + 1, etag: env.files.putPart(url.searchParams.get("uploadId")!, index + 1, bytes) });
  }
  const total = TAKE_PART_BYTES + 1234;
  // A part missing from the list is refused before anything is joined.
  await assert.rejects(completeTake(env.deps, ctx, { fileId: started.fileId, parts: [sent[1]], bytes: total, sha256: "a".repeat(64), operationKey: crypto.randomUUID() }), /missing a part/);
  // The declared size must match what storage holds.
  await assert.rejects(completeTake(env.deps, ctx, { fileId: started.fileId, parts: sent, bytes: total + 1, sha256: "a".repeat(64), operationKey: crypto.randomUUID() }), /size/);
  const again = await startTake(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "voice", mime: "audio/webm", name: "Voice take", operationKey: crypto.randomUUID() });
  for (const [index, bytes] of parts.entries()) {
    const link = await takePartUrl(env.deps, ctx, { fileId: again.fileId, partNumber: index + 1, bytes: bytes.byteLength });
    env.files.putPart(new URL(link.url).searchParams.get("uploadId")!, index + 1, bytes);
  }
  const file = await completeTake(env.deps, ctx, { fileId: again.fileId, parts: sent, bytes: total, sha256: "b".repeat(64), durationSeconds: 12.5, operationKey: crypto.randomUUID() });
  assert.equal(file.state, "ready");
  assert.equal(file.kind, "voice");
  assert.equal(file.bytes, total);
  assert.equal(file.durationSeconds, 12.5);
  assert.equal(file.meta.sha256, "computed by the browser");
  assert.ok(!("upload_id" in file.meta));
  await assert.rejects(takePartUrl(env.deps, ctx, { fileId: again.fileId, partNumber: 3, bytes: 10 }), /already finished/);
  const listed = await listFiles(env.deps, ctx, campaign.id);
  assert.ok(listed.some((entry) => entry.id === again.fileId && entry.state === "ready"));
});

test("a cancelled take is dropped from storage and archived, and a camera take must be video", async () => {
  const env = engine();
  const { ctx, campaign, item } = await seed(env);
  const started = await startTake(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "avatar_clip", mime: "video/webm", name: "Camera take", operationKey: crypto.randomUUID() });
  assert.equal(env.files.uploads.size, 1);
  await abortTake(env.deps, ctx, { fileId: started.fileId });
  assert.equal(env.files.uploads.size, 0);
  assert.ok(!(await listFiles(env.deps, ctx, campaign.id)).some((entry) => entry.id === started.fileId));
  await assert.rejects(startTake(env.deps, ctx, { campaignId: campaign.id, itemId: item.id, kind: "avatar_clip", mime: "audio/webm", name: "Camera take", operationKey: crypto.randomUUID() }));
});

test("R2 part links sign the part's size, its number and the upload, and nothing else", async () => {
  const store = new R2FileStore({ accountId: "0".repeat(32), accessKeyId: "AK", secretAccessKey: "SK", bucket: "faceful-media" }, () => new Date("2026-11-14T10:00:00Z"), fetch);
  const { url, headers } = await store.partUrl("orgs/o/projects/p/takes/t.weba", "UPLOAD-1", { partNumber: 2, bytes: TAKE_PART_BYTES, expiresSeconds: 900 });
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("partNumber"), "2");
  assert.equal(parsed.searchParams.get("uploadId"), "UPLOAD-1");
  assert.equal(parsed.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
  assert.deepEqual(headers, {});
  assert.ok(TAKE_PART_BYTES >= 5 * 1024 * 1024, "R2 needs parts of at least 5 MiB");
});

test("the rough preview keeps AI labels for AI presenters only and never saves preview-only pictures", () => {
  const beats = beatsFromText(brief);
  const take = { fileId: "take-1", kind: "avatar_clip" as const, mime: "video/webm", durationSeconds: 9, words: null, localUrl: "blob:x" };
  const camera = previewComposition({ title: "Eyes", beats, accent: "#F6C404", presenter: { mode: "camera", personaId: null, avatarId: null }, language: "en", take, stills: { presenter: false, style: true } });
  assert.equal(camera.labels.aiAvatar, false);
  assert.equal(camera.durationSeconds, 9);
  assert.deepEqual(camera.video[0].source, { kind: "file", fileId: "take-1" });
  const persona = previewComposition({ title: "Eyes", beats, accent: "#F6C404", presenter: { mode: "persona", personaId: "p1", avatarId: null }, language: "en", take: null, stills: { presenter: true, style: false } });
  assert.equal(persona.labels.aiAvatar, true);
  assert.deepEqual(persona.video[0].source, { kind: "file", fileId: STILL_PRESENTER });
  assert.equal(savedComposition(persona).video.length, 0);
  assert.equal(savedComposition(camera).video.length, 1);
  assert.deepEqual(stepsFor({ mode: "voice", personaId: null, avatarId: null }), ["describe", "look", "make", "script", "record", "preview"]);
  assert.deepEqual(stepsFor({ mode: "none", personaId: null, avatarId: null }), ["describe", "look", "make", "script", "preview"]);
});

test("word timings from the teleprompter are ordered, inside the take and fill the gaps evenly", () => {
  const words = timedWords("one two three four five six", [1, undefined, undefined, 4], 8);
  assert.equal(words.length, 6);
  for (let index = 1; index < words.length; index++) assert.ok(words[index].start >= words[index - 1].end - 1e-9 && words[index].end > words[index].start);
  assert.ok(words.at(-1)!.end <= 8);
  assert.ok(Math.abs(words[0].end - 0.65) < 0.01);
  assert.ok(words[1].end < words[2].end && words[2].end < words[3].end);
});
