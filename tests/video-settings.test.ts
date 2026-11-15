import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyDraft, isLength, MAX_SECONDS } from "../apps/web/src/create/model";
import { ASPECTS, lengthLabel, lengthWords, withSettings } from "../apps/web/src/create/settings";
import { withPreferences } from "../apps/web/src/director/model";

test("a custom length is any whole number of seconds a video can be made at, up to three minutes", () => {
  assert.equal(MAX_SECONDS, 180);
  for (const ok of [5, 15, 75, 150, 180]) assert.equal(isLength(ok), true, String(ok));
  for (const bad of [4, 181, 600, 30.5, "30", null, undefined]) assert.equal(isLength(bad), false, String(bad));
  assert.deepEqual([30, 90, 119, 120, 150, 180].map(lengthLabel), ["30s", "90s", "119s", "2 min", "2:30", "3 min"]);
  assert.deepEqual([45, 120, 150].map(lengthWords), ["45 seconds", "2 minutes", "2 minutes 30 seconds"]);
  assert.equal(withPreferences("A walkthrough of our app", { seconds: 150 }), "A walkthrough of our app — 2 minutes 30 seconds");
});

test("settings picked on home apply to a New project draft and stay valid", () => {
  const draft = emptyDraft("#123456", "A launch video");
  const set = withSettings(draft, { seconds: 150, platform: "tiktok", language: "el", copies: ["el", "es", "es", "fr", "de"] }, "tpl-quick-tip");
  assert.equal(set.seconds, 150);
  assert.equal(set.platform, "tiktok");
  assert.equal(set.language, "el");
  assert.deepEqual(set.copies, ["es", "fr"], "no copy in the main language, no repeats, at most two");
  assert.equal(set.templateId, "tpl-quick-tip");
  assert.equal(set.brief, "A launch video");
  const kept = withSettings({ ...draft, seconds: 60, platform: "youtube" }, { seconds: 600 });
  assert.equal(kept.seconds, 60, "a length that cannot be made keeps the draft's own");
  assert.equal(kept.platform, "youtube", "settings not picked keep the draft's own");
  assert.equal(withSettings({ ...draft, platform: "youtube" }, { platform: null }).platform, null, "“Any” is a real pick");
});

test("only vertical can be made today; the other frame shapes are listed, not offered", () => {
  assert.deepEqual(ASPECTS.filter((aspect) => aspect.available).map((aspect) => aspect.ratio), ["9:16"]);
  assert.deepEqual(ASPECTS.map((aspect) => `${aspect.label} ${aspect.ratio}`), ["Vertical 9:16", "Portrait 4:5", "Square 1:1", "Horizontal 16:9"]);
});
