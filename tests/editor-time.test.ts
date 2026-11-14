import { test } from "node:test";
import assert from "node:assert/strict";
import { exactInstant, localInput } from "../apps/web/src/lib/time";
import {
  affectsVideo,
  contentPatch,
  agentHandoff,
} from "../apps/web/src/views/editor/model";
import { createFixtureClient } from "../apps/web/src/data/fixture";

test("Athens input round-trips exact UTC and rejects both daylight-saving ambiguities", () => {
  assert.equal(
    exactInstant("2026-11-16T09:00", "Europe/Athens"),
    "2026-11-16T07:00:00Z",
  );
  assert.equal(
    localInput("2026-11-16T07:00:00Z", "Europe/Athens"),
    "2026-11-16T09:00",
  );
  assert.throws(() => exactInstant("2026-03-29T03:30", "Europe/Athens"));
  assert.throws(() => exactInstant("2026-10-25T03:30", "Europe/Athens"));
});

test("editor patches exclude workflow evidence and distinguish caption from video changes", async () => {
  const client = createFixtureClient();
  const [campaign] = await client.listCampaigns();
  const item = campaign.items[0];
  const changed = structuredClone(item);
  changed.status = "ready";
  changed.revision = 999;
  changed.targets[0].state = "published";
  changed.variants[0].caption = "An edited caption";
  const patch = contentPatch(item, changed);
  assert.deepEqual(Object.keys(patch), ["variants"]);
  assert.equal(affectsVideo(patch), false);
  changed.script = "New spoken words";
  assert.equal(affectsVideo(contentPatch(item, changed)), true);
  const handoff = agentHandoff(
    item,
    await client.getContext(),
    [],
    "Plan the campaign",
    false,
  );
  assert.ok(!handoff.includes(item.script));
  assert.ok(handoff.includes(item.id));
  assert.ok(handoff.includes("expectedRevision"));
});
