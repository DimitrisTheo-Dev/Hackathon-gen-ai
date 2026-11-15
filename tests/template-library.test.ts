import { test } from "node:test";
import assert from "node:assert/strict";
import { libraryTemplateSchema } from "../packages/contracts/src/index";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MemoryStore } from "../packages/engine/src/store-memory";

/** Real engine + in-memory store. Tokens "user:<id>" stand in for verified Supabase sessions. */
function engine() {
  const deps: HttpDeps = {
    store: new MemoryStore(),
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: "https://faceful.test" }),
    now: () => new Date("2026-11-15T10:00:00.000Z"),
    verifyAccessToken: async (token) => {
      const [kind, id] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: null };
    },
    fetch: async () => new Response("{}", { status: 500 }),
    planner: null,
  };
  const call = async (path: string, init: RequestInit = {}) => (await handleEngineRequest(deps, new Request(`https://faceful.test${path}`, init), path))!;
  return { deps, call };
}

function row(id: string, position: number, published: boolean, family: "face" | "no_face" = "no_face") {
  const base = `templates/${id}/v1`;
  return {
    id, version: 1, family, name: `Template ${id}`, summary: "What it is.", use_for: "What it is for.", position, published,
    language: "el", languages: ["el", "en"], aspect_ratio: "9:16", fps: 25, duration_min: 15, duration_max: 35,
    sample_topic: "Αντηλιακό τον χειμώνα", sample_seconds: "31.32", voice: "No voice, music only", fonts: ["Inter"],
    inputs: [{ key: "say", label: "The message" }], script: [{ id: "q1", text: "Γιατρέ, να βάζω αντηλιακό;" }],
    spec: { template: id }, video_path: `${base}/sample.mp4`, poster_path: `${base}/poster.jpg`,
    stills: [{ beat: "q1", path: `${base}/stills/01-q1.jpg` }], variants: [{ language: "en", path: `${base}/en.mp4` }], qa: {},
  };
}

test("template library: signed-in people get the published templates in order, with signed media links", async () => {
  const { deps, call } = engine();
  const store = deps.store as MemoryStore;
  await store.insert("templates", row("chat-qa", 9, true));
  await store.insert("templates", row("talking-tip", 0, true, "face"));
  await store.insert("templates", row("draft-only", 5, false));
  for (const path of ["templates/chat-qa/v1/sample.mp4", "templates/chat-qa/v1/poster.jpg", "templates/chat-qa/v1/stills/01-q1.jpg", "templates/talking-tip/v1/sample.mp4"])
    await store.media.put(path, new Uint8Array([1]), path.endsWith(".mp4") ? "video/mp4" : "image/jpeg");

  assert.equal((await call("/v1/studio/templates/library")).status, 401, "the library is not public");

  const response = await call("/v1/studio/templates/library", { headers: { Authorization: "Bearer user:u1" } });
  assert.equal(response.status, 200);
  const list = (await response.json()) as unknown[];
  assert.equal(list.length, 2, "unpublished rows are not listed");
  const [first, second] = list.map((entry) => libraryTemplateSchema.parse(entry));
  assert.deepEqual([first.id, second.id], ["talking-tip", "chat-qa"], "ordered by position");
  assert.equal(second.family, "no_face");
  assert.deepEqual(second.durationRange, [15, 35]);
  assert.equal(second.sampleSeconds, 31.32);
  assert.match(second.videoUrl ?? "", /^https:\/\/media\.test\/templates\/chat-qa\/v1\/sample\.mp4\?ttl=3600$/);
  assert.ok(second.posterUrl && second.stills[0].url);
  assert.equal(second.variants[0].url, null, "a file missing from storage is null, never a dead link");
  assert.equal(first.posterUrl, null);
  assert.equal(second.expiresAt, "2026-11-15T10:30:00.000Z", "links are promised for half their lifetime");
  assert.ok(list.every((entry) => !Object.hasOwn(entry as object, "spec")), "the full render spec stays server-side");
});

test("template library: an empty table is an empty list", async () => {
  const { call } = engine();
  const response = await call("/v1/studio/templates/library", { headers: { Authorization: "Bearer user:u1" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), []);
});
