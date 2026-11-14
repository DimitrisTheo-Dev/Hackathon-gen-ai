import { test } from "node:test";
import assert from "node:assert/strict";
import { draftComposition, type Composition } from "@castroom/contracts";
import { createFixtureClient } from "../apps/web/src/data/fixture";
import { registerFixtureUpload } from "../apps/web/src/data/fixture-uploads";
import * as model from "../apps/web/src/video/model";
import { mp4Duration } from "../apps/web/src/video/upload";

const base = (): Composition =>
  draftComposition({ title: "Week six", script: "Your first scan is at week six. You will hear the heartbeat.", brandColor: "#5F6C66", captionPosition: "bottom", mediaDurationSeconds: 20 });

class MemoryStorage implements Storage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("new clips land at the playhead, stay inside the video and get unique ids", () => {
  let composition = model.addCaption(base(), 19.5);
  const added = composition.captions.find((cue) => cue.text === "New caption")!;
  assert.deepEqual([added.start, added.end], [18, 20], "a clip near the end is pulled back to fit");
  composition = model.addCard(composition, "statement", 5, "file-1");
  composition = model.addVideoClip(composition, { source: { kind: "url", url: "https://cdn.example.com/scan.mp4" }, media: "video", at: 2, length: 3, layer: 1 });
  composition = model.addAudioClip(composition, { source: { kind: "file", fileId: "music-1" }, role: "music", at: 0, length: 999 });
  const ids = [...composition.video, ...composition.audio, ...composition.cards, ...composition.captions].map((clip) => clip.id);
  assert.equal(new Set(ids).size, ids.length);
  const overlay = composition.video.find((clip) => clip.layer === 1)!;
  assert.deepEqual([overlay.layout, overlay.volume, overlay.transitionIn.kind], ["split", 0, "fade"], "overlays start as a muted split screen with a fade");
  const music = composition.audio[0];
  assert.deepEqual([music.start, music.end, music.loop, music.volume], [0, 20, true, 0.18], "music spans the video, loops and sits low");
  assert.equal(composition.cards.find((card) => card.kind === "statement")?.imageFileId, "file-1");
  assert.deepEqual(model.issues(composition), []);
});

test("typing a time never reorders rows until the field is left", () => {
  const composition = base();
  const first = composition.captions[0];
  const typed = model.updateClip(composition, "captions", first.id, { start: 19, end: 19.5 });
  assert.equal(typed.captions[0].id, first.id, "still first while editing");
  assert.equal(model.sortTrack(typed, "captions").captions.at(-1)!.id, first.id);
});

test("shortening the video drops or trims clips on every track and the transcript", () => {
  const composition = { ...base(), transcript: { language: "en", sourceFileId: null, words: [{ t: "a", start: 1, end: 1.2 }, { t: "b", start: 9.8, end: 10.4 }, { t: "c", start: 15, end: 15.3 }] } };
  const short = model.setDuration(composition, 10);
  assert.equal(short.durationSeconds, 10);
  assert.deepEqual(short.video.map((clip) => clip.end), [10]);
  assert.ok(short.captions.every((cue) => cue.end <= 10));
  assert.deepEqual(short.transcript?.words.map((word) => [word.t, word.end]), [["a", 1.2], ["b", 10]]);
  assert.deepEqual(model.issues(short), []);
  assert.equal(model.setDuration(composition, 999).durationSeconds, 180);
});

test("word files from transcription tools parse, and captions rebuild around statement cards", () => {
  const words = model.parseWords(JSON.stringify([{ i: 0, t: "Πέντε", s: 0.08, e: 0.36 }, { text: "βήματα,", start: 0.44, end: 0.84 }, { word: "που", start: 1.08, end: 1.2 }, { t: "bad", s: 2, e: 1 }]));
  assert.deepEqual(words.map((word) => word.t), ["Πέντε", "βήματα,", "που"]);
  assert.deepEqual(model.parseWords(JSON.stringify({ words: [{ t: "a", s: 0, e: 0.1 }] })).length, 1);
  assert.throws(() => model.parseWords("nope"), /not valid JSON/);
  const composition: Composition = { ...base(), cards: [{ id: "st", start: 0.4, end: 0.9, kind: "statement", title: "Five steps", subtitle: "", imageFileId: null }], transcript: { language: "el", sourceFileId: null, words } };
  const rebuilt = model.captionsFromTranscript(composition);
  assert.deepEqual(rebuilt.captions.map((cue) => cue.text), ["Πέντε", "που"], "words under a statement card are not captioned, and the pause splits the page");
  const shifted = model.shiftTranscript(composition, 1.5);
  assert.equal(shifted.transcript?.words[0].start, 1.58);
});

test("problems are worded for people and point at the row", () => {
  const composition = model.updateClip(model.updateClip(base(), "captions", "cap-1", { end: 0 }), "captions", "cap-2", { text: "" });
  const problems = model.issues(composition);
  assert.deepEqual(problems.map((problem) => [problem.track, problem.index]).sort(), [["captions", 0], ["captions", 1]]);
  assert.ok(problems.some((problem) => problem.message === "Caption 1: end must be after the start"));
  assert.ok(problems.some((problem) => problem.message === "Caption 2: text is empty"));
  const link = model.issues({ ...base(), video: [{ ...base().video[0], source: { kind: "url", url: "http://example.com/a.mp4" } }] });
  assert.equal(link[0].message, "Video clip 1: link must be an https link");
});

test("an MP4's duration is read from its mvhd box", () => {
  const box = new Uint8Array(64);
  const view = new DataView(box.buffer);
  box.set([0x6d, 0x76, 0x68, 0x64], 8); // "mvhd"
  view.setUint32(8 + 16, 1000); // timescale
  view.setUint32(8 + 20, 53_600); // duration
  assert.equal(mp4Duration(box.buffer), 53.6);
  assert.equal(mp4Duration(new Uint8Array(64).buffer), null);
});

test("the development transport keeps text drafts, tab-only uploads and timelines with the engine's rules", async () => {
  const storage = new MemoryStorage();
  const client = createFixtureClient(storage);
  const draft = await client.getComposition("fixture-video-1");
  assert.equal(draft.revision, 0);
  assert.equal(draft.composition.cards[0].title, "Find your next moment");
  const script = await client.saveTextFile({ campaignId: "fixture-bewell-week", itemId: "fixture-video-1", kind: "script", name: "Script", mime: "text/markdown", text: "Hello", operationKey: crypto.randomUUID() });
  assert.match(script.url ?? "", /^data:text\/markdown/);
  const ticket = await client.requestUpload({ campaignId: "fixture-bewell-week", itemId: "fixture-video-1", kind: "voice", name: "Voice", mime: "audio/wav", bytes: 4, sha256: "a".repeat(64), operationKey: crypto.randomUUID() });
  await assert.rejects(client.completeUpload({ fileId: ticket.file.id, operationKey: crypto.randomUUID() }), (error: unknown) => (error as { code?: string }).code === "validation_error");
  (globalThis as { URL: typeof URL }).URL.createObjectURL ??= () => "blob:test";
  assert.equal(registerFixtureUpload(ticket.upload!.url, new Blob([new Uint8Array(4)])), true);
  const voice = await client.completeUpload({ fileId: ticket.file.id, operationKey: crypto.randomUUID() });
  assert.equal(voice.state, "ready");
  const withVoice = model.addAudioClip(draft.composition, { source: { kind: "file", fileId: voice.id }, role: "voice", at: 0, length: 4 });
  const saved = await client.saveComposition({ contentId: "fixture-video-1", expectedRevision: 0, composition: withVoice, operationKey: crypto.randomUUID() });
  assert.equal(saved.revision, 1);
  assert.ok(saved.files[voice.id]);
  await assert.rejects(client.saveComposition({ contentId: "fixture-video-1", expectedRevision: 0, composition: withVoice, operationKey: crypto.randomUUID() }), (error: unknown) => (error as { code?: string }).code === "revision_conflict");
  await assert.rejects(client.queueRender({ contentId: "fixture-video-1", expectedRevision: 1, operationKey: crypto.randomUUID() }), /cannot render/);
  const reopened = createFixtureClient(storage);
  assert.equal((await reopened.getComposition("fixture-video-1")).revision, 1, "saved in this browser's storage");
  assert.deepEqual((await reopened.listFiles("fixture-bewell-week")).map((file) => file.name).sort(), ["Script", "Voice"]);
});

test("fixture state saved before draft files existed, or with an old timeline shape, still loads", async () => {
  const storage = new MemoryStorage();
  const client = createFixtureClient(storage);
  await client.getContext();
  const raw = JSON.parse(storage.getItem("castroom-development-v1")!);
  delete raw.files;
  delete raw.fileTexts;
  raw.compositions = { "fixture-video-2": { revision: 3, updatedAt: "2026-11-14T10:00:00.000Z", composition: { version: 1, presenter: {} } } };
  storage.setItem("castroom-development-v1", JSON.stringify(raw));
  const document = await createFixtureClient(storage).getComposition("fixture-video-2");
  assert.equal(document.revision, 3, "the revision is kept so the next save applies");
  assert.equal(document.composition.version, 2);
});
