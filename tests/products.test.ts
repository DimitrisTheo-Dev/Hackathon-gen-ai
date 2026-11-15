import { test } from "node:test";
import assert from "node:assert/strict";
import { contextSchema, productSchema, timeAtScriptIndex, type CompositionDocument } from "../packages/contracts/src/index";
import { directorTurn } from "../packages/engine/src/director";
import type { Planner } from "../packages/engine/src/llm";
import { startCampaign } from "../packages/engine/src/studio";
import { engine, key, sha256 } from "./reel-support";

/**
 * Brand kit products on the real engine over the in-memory store and bucket. "user:<id>" stands in for a verified
 * session; `fct_…` workspace tokens are real. Signed links to the bucket are served by the fake fetch below, the way
 * R2 answers a presigned GET.
 */
function harness() {
  const env = engine();
  env.deps.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname !== "files.test") return new Response("{}", { status: 500 });
    const object = env.files.objects.get(decodeURIComponent(url.pathname.slice(1)));
    return object ? new Response(new Uint8Array(object.bytes), { headers: { "content-type": object.contentType } }) : new Response("missing", { status: 404 });
  };
  const send = async (path: string, as: string, body?: unknown) => {
    const response = await env.call(path, as, body);
    return { status: response.status, body: (await response.json()) as any };
  };
  const op = (name: string, as: string, body: unknown) => send(`/v1/studio/operations/${name}`, as, body);
  const ok = async (name: string, as: string, body: unknown) => {
    const response = await op(name, as, body);
    assert.equal(response.status, 200, `${name}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const context = async (as = "user:u1") => contextSchema.parse((await send("/v1/studio/context", as)).body);
  /** Uploads a product photo through its one-file link, the way the browser does. */
  const photo = async (as = "user:u1", bytes = new TextEncoder().encode(`photo-${crypto.randomUUID()}`), type = "image/png") => {
    const ticket = await ok("product_image_upload_url", as, { type, size: bytes.byteLength, sha256: sha256(bytes) });
    await env.files.put(ticket.key, bytes, type);
    return ticket.key as string;
  };
  return { env, send, op, ok, context, photo };
}

test("products: create, list on the context, edit and delete; a replayed key creates nothing new", async () => {
  const { env, op, ok, context } = harness();
  assert.deepEqual((await context()).products, []);
  const operationKey = key();
  const input = { name: "VitaBoost", description: "Vitamin C capsules.", domain: "health", facts: ["Each capsule contains 1000 mg of vitamin C."], operationKey };
  const created = productSchema.parse(await ok("create_product", "user:u1", input));
  assert.equal(created.name, "VitaBoost");
  assert.equal(created.domain, "health");
  assert.deepEqual(created.facts, ["Each capsule contains 1000 mg of vitamin C."]);
  assert.equal(created.hasImage, false);
  assert.equal(created.imageUrl, null);
  assert.equal(created.position, 0);
  assert.equal((await ok("create_product", "user:u1", input)).id, created.id, "the same key replays the first result");
  assert.equal((await op("create_product", "user:u1", { ...input, name: "Other" })).body.error.code, "idempotency_conflict");

  const second = await ok("create_product", "user:u1", { name: "Calm Tea", operationKey: key() });
  assert.equal(second.domain, "general", "domain defaults to general");
  assert.equal(second.position, 1);
  assert.deepEqual((await context()).products.map((product) => product.name), ["VitaBoost", "Calm Tea"]);

  const edited = await ok("update_product", "user:u1", { productId: created.id, facts: ["Each capsule contains 1000 mg of vitamin C.", "Made in Greece."] });
  assert.deepEqual(edited.facts, ["Each capsule contains 1000 mg of vitamin C.", "Made in Greece."]);
  assert.equal(edited.name, "VitaBoost", "fields not sent stay as they were");
  const duplicate = await op("update_product", "user:u1", { productId: created.id, facts: ["Same fact", "same fact"] });
  assert.equal(duplicate.status, 400);
  assert.match(duplicate.body.error.message, /Each fact must be different/);

  assert.deepEqual(await ok("delete_product", "user:u1", { productId: second.id }), { deleted: true });
  assert.deepEqual((await context()).products.map((product) => product.id), [created.id]);
  assert.equal((await op("delete_product", "user:u1", { productId: second.id })).status, 404);
  const audit = await env.deps.store.select("audit_events", {});
  for (const action of ["Added a product to the brand kit", "Edited a product", "Deleted a product from the brand kit"]) assert.ok(audit.some((event) => event.action === action), action);
});

test("products follow the brand kit's permission: editors and agents with content:edit; readers cannot write", async () => {
  const { env, op, ok, context, photo } = harness();
  const owner = await env.as("user:u1");
  const writer = await env.agentToken(owner, ["campaign:read", "content:edit"]);
  const reader = await env.agentToken(owner, ["campaign:read"]);
  const made = await ok("create_product", writer, { name: "Agent product", facts: ["Ships in 2 days."], operationKey: key() });
  const refused = await op("create_product", reader, { name: "Nope", operationKey: key() });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "forbidden");
  assert.equal((await op("product_image_upload_url", reader, { type: "image/png", size: 10, sha256: "a".repeat(64) })).status, 403);
  // People in the studio get a photo link; agents see that a photo exists, never the link.
  await ok("update_product", "user:u1", { productId: made.id, imageKey: await photo() });
  const forPerson = (await context("user:u1")).products[0];
  assert.equal(forPerson.hasImage, true);
  assert.match(forPerson.imageUrl ?? "", new RegExp(`^https://files\\.test/orgs/${owner.org.id}/products/[0-9a-f-]{36}\\.png\\?ttl=900$`));
  const forAgent = (await context(reader)).products[0];
  assert.equal(forAgent.hasImage, true);
  assert.equal(forAgent.imageUrl, null);
});

test("products are isolated per workspace", async () => {
  const { op, ok, context } = harness();
  const mine = await ok("create_product", "user:u1", { name: "Mine", operationKey: key() });
  assert.deepEqual((await context("user:u2")).products, []);
  assert.equal((await op("update_product", "user:u2", { productId: mine.id, name: "Taken" })).status, 404);
  assert.equal((await op("delete_product", "user:u2", { productId: mine.id })).status, 404);
  assert.equal((await op("update_product", "user:u1", { productId: "not-a-uuid", name: "x" })).status, 404);
  assert.equal((await context("user:u1")).products[0].name, "Mine", "the owner's product is unchanged");
});

test("product photos: only this workspace's uploaded keys are accepted; replaced and removed photos are deleted", async () => {
  const { env, op, ok, photo } = harness();
  const u1 = await env.as("user:u1");
  const u2 = await env.as("user:u2");
  const theirs = await photo("user:u2");
  assert.ok(theirs.startsWith(`orgs/${u2.org.id}/products/`));
  const foreign = await op("create_product", "user:u1", { name: "Stolen", imageKey: theirs, operationKey: key() });
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error.message, /does not belong to this workspace/);
  const outside = await op("create_product", "user:u1", { name: "Outside", imageKey: `orgs/${u1.org.id}/personas/x/${crypto.randomUUID()}.png`, operationKey: key() });
  assert.equal(outside.status, 400);
  const notUploaded = await op("create_product", "user:u1", { name: "Pending", imageKey: `orgs/${u1.org.id}/products/${crypto.randomUUID()}.png`, operationKey: key() });
  assert.equal(notUploaded.status, 400);
  assert.match(notUploaded.body.error.message, /did not finish uploading/);
  const badType = await op("product_image_upload_url", "user:u1", { type: "image/svg+xml", size: 10, sha256: "a".repeat(64) });
  assert.equal(badType.status, 400);

  const first = await photo();
  const product = await ok("create_product", "user:u1", { name: "Tea", imageKey: first, operationKey: key() });
  assert.equal(product.hasImage, true);
  const reused = await op("create_product", "user:u1", { name: "Copy", imageKey: first, operationKey: key() });
  assert.equal(reused.status, 400);
  assert.match(reused.body.error.message, /already used by another product/);

  const second = await photo();
  await ok("update_product", "user:u1", { productId: product.id, imageKey: second });
  assert.equal(env.files.objects.has(first), false, "the replaced photo is deleted");
  assert.equal(env.files.objects.has(second), true);
  const cleared = await ok("update_product", "user:u1", { productId: product.id, imageKey: null });
  assert.equal(cleared.hasImage, false);
  assert.equal(env.files.objects.has(second), false, "a removed photo is deleted");

  const third = await photo();
  const withPhoto = await ok("create_product", "user:u1", { name: "Biscuits", imageKey: third, operationKey: key() });
  await ok("delete_product", "user:u1", { productId: withPhoto.id });
  assert.equal(env.files.objects.has(third), false, "deleting a product deletes its photo");
});

const SCRIPT = "Mornings set the tone for the whole day. Start with a glass of water and a short walk outside. Then pour a cup of Calm Tea and take a quiet minute for yourself.";

async function project(env: ReturnType<typeof harness>["env"]) {
  const ctx = await env.as("user:u1");
  const campaign = await startCampaign(env.deps, ctx, {
    operationKey: key(),
    title: "Slow mornings",
    companyContext: { name: "Calm Co", description: "A tea brand.", audience: "Busy people", tone: "Warm", sourceText: "", sourceUrl: null, missingInformation: "" },
    items: [{ title: "Morning ritual", script: SCRIPT }],
  });
  return { ctx, campaign, item: campaign.items[0] };
}

test("place_product puts the photo where the script names the product, copies it into the project, and adds a closing card", async () => {
  const h = harness();
  const { ok, op, send, photo, env } = h;
  const { campaign, item } = await project(env);
  const product = await ok("create_product", "user:u1", { name: "Calm Tea", description: "Chamomile blend.", facts: ["Caffeine free."], imageKey: await photo(), operationKey: key() });
  const before = (await send(`/v1/studio/items/${item.id}/composition`, "user:u1")).body as CompositionDocument;
  assert.equal(before.revision, 0);
  const expected = timeAtScriptIndex(SCRIPT, before.composition, SCRIPT.indexOf("Calm Tea"));
  assert.ok(expected > 0);

  const placed = await ok("place_product", "user:u1", { itemId: item.id, productId: product.id, expectedCompositionRevision: 0, layout: "split", operationKey: key() });
  assert.equal(placed.itemId, item.id);
  assert.equal(placed.compositionRevision, 1);
  assert.equal(placed.matchedMention, true);
  assert.equal(placed.placedAt, Math.min(expected, before.composition.durationSeconds - 3));

  const after = (await send(`/v1/studio/items/${item.id}/composition`, "user:u1")).body as CompositionDocument;
  assert.equal(after.revision, 1);
  const clip = after.composition.video.find((entry) => entry.source.kind === "file" && entry.source.fileId === placed.fileId)!;
  assert.ok(clip, "the photo is on the timeline");
  assert.equal(clip.layer, 1);
  assert.equal(clip.media, "image");
  assert.equal(clip.layout, "split");
  assert.equal(clip.start, placed.placedAt);
  assert.equal(Math.round((clip.end - clip.start) * 100) / 100, 3);
  const card = after.composition.cards.find((entry) => entry.kind === "cta")!;
  assert.equal(card.imageFileId, placed.fileId);
  assert.equal(card.end, after.composition.durationSeconds);
  assert.ok(after.files[placed.fileId], "the copied photo resolves to a link");

  const files = (await send(`/v1/studio/campaigns/${campaign.id}/files`, "user:u1")).body as Array<{ id: string; kind: string; meta: Record<string, unknown>; itemId: string }>;
  const copy = files.find((file) => file.id === placed.fileId)!;
  assert.equal(copy.kind, "image");
  assert.equal(copy.itemId, item.id);
  assert.deepEqual(copy.meta, { productId: product.id, source: "brand_kit" });

  // Another placement based on the old timeline is a conflict; the saved timeline is untouched.
  const stale = await op("place_product", "user:u1", { itemId: item.id, productId: product.id, expectedCompositionRevision: 0, operationKey: key() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "revision_conflict");
  assert.equal((await send(`/v1/studio/items/${item.id}/composition`, "user:u1")).body.revision, 1);

  // Placing the same product again reuses the project's copy and does not add a second closing card.
  const again = await ok("place_product", "user:u1", { itemId: item.id, productId: product.id, expectedCompositionRevision: 1, at: 1, seconds: 2, operationKey: key() });
  assert.equal(again.fileId, placed.fileId);
  assert.equal(again.placedAt, 1);
  assert.equal(again.matchedMention, false);
  const last = (await send(`/v1/studio/items/${item.id}/composition`, "user:u1")).body as CompositionDocument;
  assert.equal(last.composition.cards.filter((entry) => entry.kind === "cta").length, 1);
  assert.equal(last.composition.video.filter((entry) => entry.layer === 1).length, 2);
});

test("place_product falls back to one third in, clamps inside the timeline, and refuses products without a photo or from elsewhere", async () => {
  const { ok, op, send, photo, env } = harness();
  const { item } = await project(env);
  const unnamed = await ok("create_product", "user:u1", { name: "Honey Jar", imageKey: await photo(), operationKey: key() });
  const doc = (await send(`/v1/studio/items/${item.id}/composition`, "user:u1")).body as CompositionDocument;
  const duration = doc.composition.durationSeconds;
  const third = await ok("place_product", "user:u1", { itemId: item.id, productId: unnamed.id, expectedCompositionRevision: 0, endCard: false, operationKey: key() });
  assert.equal(third.matchedMention, false);
  assert.equal(third.placedAt, Math.round((duration / 3) * 100) / 100);
  const late = await ok("place_product", "user:u1", { itemId: item.id, productId: unnamed.id, expectedCompositionRevision: 1, at: 999, seconds: 4, endCard: false, operationKey: key() });
  assert.equal(late.placedAt, Math.round((duration - 4) * 100) / 100, "a time past the end is clamped so the photo ends with the video");

  const bare = await ok("create_product", "user:u1", { name: "No photo", operationKey: key() });
  const noPhoto = await op("place_product", "user:u1", { itemId: item.id, productId: bare.id, expectedCompositionRevision: 2, operationKey: key() });
  assert.equal(noPhoto.status, 400);
  assert.match(noPhoto.body.error.message, /Add a photo/);
  const elsewhere = await ok("create_product", "user:u2", { name: "Theirs", operationKey: key() });
  assert.equal((await op("place_product", "user:u1", { itemId: item.id, productId: elsewhere.id, expectedCompositionRevision: 2, operationKey: key() })).status, 404);
  assert.equal((await op("place_product", "user:u2", { itemId: item.id, productId: elsewhere.id, expectedCompositionRevision: 0, operationKey: key() })).status, 404);
});

test("the Director writes from the products: they reach the planner as data, with the rule that claims restate approved facts", async () => {
  const { env, ok } = harness();
  const ctx = await env.as("user:u1");
  await ok("create_product", "user:u1", { name: "VitaBoost", description: "Vitamin C capsules.", domain: "health", facts: ["Each capsule contains 1000 mg of vitamin C."], operationKey: key() });
  let seen = { system: "", user: "" };
  const planner: Planner = {
    plan: async (input) => {
      seen = input;
      return { intent: "answer", reply: "Noted.", project: null, edits: [], renderItemIds: [], find: null, wantsCheckout: false };
    },
  };
  await directorTurn(env.deps, ctx, { campaignId: null, itemId: null, scope: "project", instruction: "Write a 15-second script about VitaBoost.", operationKey: key() }, planner);
  const workspace = JSON.parse(seen.user.match(/<workspace>([\s\S]*?)<\/workspace>/)![1]);
  assert.deepEqual(workspace.products, [{ name: "VitaBoost", description: "Vitamin C capsules.", domain: "health", approvedFacts: ["Each capsule contains 1000 mg of vitamin C."] }]);
  assert.match(seen.system, /A script may say only what a product's approved facts say about it/);
  assert.match(seen.system, /no cure, treatment or guaranteed-return promises and carry no diagnosis/);
});

test("a product named in the opening words starts after the opening title card, not under it", async () => {
  const { placement } = await import("../packages/engine/src/products");
  const { draftComposition } = await import("../packages/contracts/src/composition");
  const script = "BeWell Omega is here. One capsule a day, with food, for a steady week.";
  const composition = draftComposition({ title: "Omega", script, brandColor: "#2a2a27", captionPosition: "center", mediaDurationSeconds: 12 });
  const title = composition.cards.find((card) => card.kind === "title");
  assert.ok(title && title.start === 0, "the draft timeline opens on a title card");
  const placed = placement(script, composition, { id: "p1", name: "BeWell Omega" }, null, 3);
  assert.equal(placed.matchedMention, true);
  assert.equal(placed.start, title.end);
  // An explicit time is respected as given.
  assert.equal(placement(script, composition, { id: "p1", name: "BeWell Omega" }, 0.5, 3).start, 0.5);
});

test("a product photo link counts against the workspace's file storage quota", async () => {
  const MB = 1024 * 1024;
  const env = engine({ STORAGE_QUOTA_BYTES: String(MB) }); // the smallest quota the config accepts
  const ask = async (size: number) => {
    const response = await env.call("/v1/studio/operations/product_image_upload_url", "user:u1", { type: "image/png", size, sha256: sha256(crypto.randomUUID()) });
    return { status: response.status, body: (await response.json()) as any };
  };
  assert.equal((await ask(MB)).status, 200);
  const over = await ask(MB + 1);
  assert.deepEqual([over.status, over.body.error.code], [429, "quota_exceeded"]);
  assert.match(over.body.error.message, /file storage/);
});
