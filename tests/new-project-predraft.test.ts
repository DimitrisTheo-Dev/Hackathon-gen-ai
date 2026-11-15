import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { DraftScriptInput, DraftScriptResult } from "../packages/contracts/src/index";
import { emptyDraft, scriptKeyOf, type Draft } from "../apps/web/src/create/model";
import { copyKey, copyRequest, firstDraftRequest, placeDraft, ScriptCache, writeAhead } from "../apps/web/src/create/predraft";

const draft = (extra: Partial<Draft> = {}): Draft => ({
  ...emptyDraft("#2A2A27", "Three signs you should book an eye check this year."),
  language: "en",
  face: { kind: "persona", personaId: "persona-1", lookId: null },
  ...extra,
});
const written = (text: string, title = "Eye check"): DraftScriptResult => ({ mode: "ai", title, beats: [{ id: "beat-1", label: "Hook", text }], reply: "Drafted." });
/** A model that answers only when the test says so. */
function slowWriter() {
  const calls: Array<{ input: DraftScriptInput; resolve: (result: DraftScriptResult) => void; reject: (reason: Error) => void }> = [];
  const write = (input: DraftScriptInput) => new Promise<DraftScriptResult>((resolve, reject) => calls.push({ input, resolve, reject }));
  return { calls, write };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the script key follows what changes the words: settings, layout and who speaks, not which AI presenter", () => {
  const base = draft();
  const key = scriptKeyOf(base);
  assert.equal(scriptKeyOf(draft({ face: { kind: "avatar", avatarId: "stock-1" } })), key, "a stock avatar reads the same script as a persona");
  assert.equal(scriptKeyOf(draft({ brief: `${base.brief}  ` })), key, "spaces around the description change nothing");
  const self = scriptKeyOf(draft({ making: "camera" }));
  assert.notEqual(self, key, "reading it yourself is written for easy breathing");
  assert.equal(scriptKeyOf(draft({ making: "voice" })), self, "camera and voice-only are both read by the person");
  for (const change of [{ face: { kind: "none" } as const }, { platform: "tiktok" as const }, { templateId: "hosted-list" }, { seconds: 15 as const }, { language: "el" }, { brief: "Something else entirely here." }])
    assert.notEqual(scriptKeyOf(draft(change)), key, JSON.stringify(change));
});

test("the cache writes each set of inputs once, keeps no failure and lets the oldest go when full", async () => {
  const model = slowWriter();
  const cache = new ScriptCache(model.write, 2);
  const first = cache.get("a", () => firstDraftRequest(draft()));
  const joined = cache.get("a", () => firstDraftRequest(draft()));
  assert.equal(model.calls.length, 1, "a second ask joins the one being written");
  assert.equal(cache.ready("a"), null, "nothing is ready while it is being written");
  assert.ok(model.calls[0].input.operationKey);
  model.calls[0].resolve(written("Blurry screens at night?"));
  assert.deepEqual(await first, await joined);
  assert.equal(cache.ready("a")?.beats[0].text, "Blurry screens at night?");

  const failing = cache.get("b", () => firstDraftRequest(draft()));
  model.calls[1].reject(new Error("provider down"));
  await assert.rejects(failing, /provider down/);
  assert.equal(cache.ready("b"), null);
  void cache.get("b", () => firstDraftRequest(draft()));
  assert.equal(model.calls.length, 3, "after a failure, asking again tries again");

  void cache.get("c", () => firstDraftRequest(draft()));
  assert.equal(cache.ready("a"), null, "with room for two, the least recently asked for is let go");
});

test("a draft for choices that changed is kept, never handed over, and comes back at once if the choice does", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const model = slowWriter();
    const cache = new ScriptCache(model.write);
    const handed: string[] = [];
    const onReady = (key: string) => handed.push(key);
    const job = (key: string) => ({ key, request: () => firstDraftRequest(draft()) });

    const stopA = writeAhead(cache, [job("presenter")], 350, onReady);
    mock.timers.tick(350);
    assert.equal(model.calls.length, 1);
    // The person switches to recording themself while the first draft is still being written.
    stopA();
    const stopB = writeAhead(cache, [job("self")], 350, onReady);
    model.calls[0].resolve(written("For an AI presenter"));
    await settle();
    assert.deepEqual(handed, [], "the stale draft never reaches the page");
    assert.equal(cache.ready("presenter")?.beats[0].text, "For an AI presenter", "but it is kept");

    mock.timers.tick(350);
    model.calls[1].resolve(written("For you to read"));
    await settle();
    assert.deepEqual(handed, ["self"]);

    stopB();
    writeAhead(cache, [job("presenter")], 350, onReady);
    assert.deepEqual(handed, ["self", "presenter"], "switching back hands over the kept draft at once");
    mock.timers.tick(350);
    assert.equal(model.calls.length, 2, "and asks the model for nothing more");
  } finally {
    mock.timers.reset();
  }
});

test("clicking through choices asks only for the one the person settles on; a failure waits for the script step", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const model = slowWriter();
    const cache = new ScriptCache(model.write);
    const handed: string[] = [];
    for (const key of ["layout-1", "layout-2"]) {
      const stop = writeAhead(cache, [{ key, request: () => firstDraftRequest(draft()) }], 350, (done) => handed.push(done));
      mock.timers.tick(120);
      stop();
    }
    writeAhead(cache, [{ key: "layout-3", request: () => firstDraftRequest(draft()) }], 350, (done) => handed.push(done));
    mock.timers.tick(350);
    assert.equal(model.calls.length, 1);
    model.calls[0].reject(new Error("quota"));
    await settle();
    assert.deepEqual(handed, [], "a failed draft is dropped quietly here");
    void cache.get("layout-3", () => firstDraftRequest(draft()));
    assert.equal(model.calls.length, 2, "the script step drafts again, with its loading state");
  } finally {
    mock.timers.reset();
  }
});

test("a finished draft never replaces lines the person edited, and a typed title stays", () => {
  const result = written("A new hook", "New title");
  const edited = draft({ beats: [{ id: "beat-1", label: "Hook", text: "My own words" }], edited: true, scriptKey: "old" });
  assert.deepEqual(placeDraft(edited, "new", result, null), {});
  const inPlace = draft({ beats: result.beats, scriptKey: "new", title: "New title" });
  assert.deepEqual(placeDraft(inPlace, "new", result, null), {}, "already in place: nothing to change");

  const fresh = placeDraft(draft(), "new", result, null);
  assert.deepEqual(fresh, { beats: result.beats, title: "New title", scriptKey: "new", edited: false });
  const earlier = draft({ beats: [{ id: "beat-1", label: "Hook", text: "Older hook" }], scriptKey: "old", title: "Old title" });
  assert.equal(placeDraft(earlier, "new", result, "Old title").title, "New title", "a title that came with the earlier draft follows the new one");
  assert.equal(placeDraft({ ...earlier, title: "Typed by me" }, "new", result, "Old title").title, "Typed by me");
});

test("first drafts are written for the planned layout and who speaks; copies are kept for exactly their lines", () => {
  const request = firstDraftRequest(draft({ platform: "youtube", making: "voice" }), "hosted-list");
  assert.equal(request.templateId, "hosted-list");
  assert.equal(request.presenter, "voice");
  assert.equal(request.platform, "youtube");
  assert.equal(request.beats, null);
  assert.equal(firstDraftRequest(draft({ face: { kind: "none" } })).presenter, "none");

  const lines = [{ id: "beat-1", label: "Hook", text: "Blurry screens at night?" }];
  const base = draft();
  const copy = copyRequest(base, "el", lines);
  assert.equal(copy.language, "el");
  assert.deepEqual(copy.beats, lines);
  assert.match(copy.instruction ?? "", /Greek \(el\)/);
  assert.equal(copyKey(base, "el", lines), copyKey(base, "el", [...lines]));
  assert.notEqual(copyKey(base, "el", lines), copyKey(base, "el", [{ ...lines[0], text: "Headaches after reading?" }]), "an edited line is translated again");
  assert.notEqual(copyKey(base, "el", lines), copyKey(base, "de", lines));
});
