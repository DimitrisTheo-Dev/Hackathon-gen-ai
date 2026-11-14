import { test } from "node:test";
import assert from "node:assert/strict";
import { draftComposition, type Composition } from "@castroom/contracts";
import { createFixtureClient } from "../apps/web/src/data/fixture";
import * as model from "../apps/web/src/video/model";

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
  composition = model.addCard(composition, "cta", 5);
  composition = model.addCard(composition, "lower_third", 1);
  const ids = [...composition.captions, ...composition.cards].map((clip) => clip.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(composition.cards.map((card) => card.kind), ["title", "lower_third", "cta"], "cards stay in time order");
  composition = model.addBroll(composition, 2, "https://cdn.example.com/scan.mp4", "video");
  assert.equal(composition.broll[0].layout, "split");
  assert.deepEqual(model.issues(composition), []);
});

test("typing a time never reorders rows until the field is left", () => {
  const composition = base();
  const first = composition.captions[0];
  const typed = model.updateClip(composition, "captions", first.id, { start: 19, end: 19.5 });
  assert.equal(typed.captions[0].id, first.id, "still first while editing");
  const left = model.sortTrack(typed, "captions");
  assert.equal(left.captions.at(-1)!.id, first.id);
});

test("shortening the video drops clips that would start after the end and trims the rest", () => {
  const composition = { ...base(), cards: [{ id: "late", start: 15, end: 18, kind: "cta" as const, title: "Book", subtitle: "" }, { id: "early", start: 0, end: 12, kind: "title" as const, title: "Hi", subtitle: "" }] };
  const short = model.setDuration(composition, 10);
  assert.equal(short.durationSeconds, 10);
  assert.deepEqual(short.cards.map((card) => [card.id, card.end]), [["early", 10]]);
  assert.ok(short.captions.every((cue) => cue.end <= 10));
  assert.deepEqual(model.issues(short), []);
  assert.equal(model.setDuration(composition, 999).durationSeconds, 180);
});

test("problems are worded for people and point at the row", () => {
  const composition = model.updateClip(model.updateClip(base(), "captions", "cap-1", { end: 0 }), "captions", "cap-2", { text: "" });
  const problems = model.issues(composition);
  assert.deepEqual(problems.map((problem) => [problem.track, problem.index]).sort(), [["captions", 0], ["captions", 1]]);
  assert.ok(problems.some((problem) => problem.message === "Caption 1: end must be after the start"));
  assert.ok(problems.some((problem) => problem.message === "Caption 2: text is empty"));
  const link = model.issues({ ...base(), broll: [{ id: "b", start: 0, end: 2, media: "image", url: "http://example.com/a.jpg", layout: "full", trimStart: 0 }] });
  assert.equal(link[0].message, "B-roll clip 1: link must be an https link");
});

test("captions rebuild from the script over the span they already cover", () => {
  const composition = { ...base(), captions: [{ id: "x", start: 2, end: 3, text: "Old" }, { id: "y", start: 9, end: 12, text: "Old" }] };
  const rebuilt = model.captionsFromItemScript(composition, "One two three. Four five six seven eight.");
  assert.equal(rebuilt.captions[0].start, 2);
  assert.equal(rebuilt.captions.at(-1)!.end, 12);
  assert.equal(rebuilt.captions.map((cue) => cue.text).join(" "), "One two three. Four five six seven eight.");
});

test("the development transport saves compositions locally with the same revision rules as the engine", async () => {
  const storage = new MemoryStorage();
  const client = createFixtureClient(storage);
  const draft = await client.getComposition("fixture-video-1");
  assert.equal(draft.revision, 0);
  assert.equal(draft.composition.cards[0].title, "Find your next moment");
  const input = { contentId: "fixture-video-1", expectedRevision: 0, composition: model.addCard(draft.composition, "cta", 4), operationKey: crypto.randomUUID() };
  const saved = await client.saveComposition(input);
  assert.equal(saved.revision, 1);
  assert.deepEqual(await client.saveComposition(input), saved, "a replayed key returns the recorded result");
  await assert.rejects(client.saveComposition({ ...input, operationKey: crypto.randomUUID() }), (error: unknown) => (error as { code?: string }).code === "revision_conflict");
  const reopened = await createFixtureClient(storage).getComposition("fixture-video-1");
  assert.equal(reopened.revision, 1, "saved in this browser's storage");
  assert.equal(reopened.composition.cards.length, 2);
  assert.ok((await createFixtureClient(storage).getCampaign("fixture-bewell-week")).activity.some((event) => event.action === "Saved the video edit"));
});

test("fixture state saved before compositions existed still loads", async () => {
  const storage = new MemoryStorage();
  const client = createFixtureClient(storage);
  await client.getContext();
  const raw = JSON.parse(storage.getItem("castroom-development-v1")!);
  delete raw.compositions;
  storage.setItem("castroom-development-v1", JSON.stringify(raw));
  assert.equal((await createFixtureClient(storage).getComposition("fixture-video-2")).revision, 0);
});
