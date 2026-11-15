import { test } from "node:test";
import assert from "node:assert/strict";
import { basicClaims, contentReviewSchema, REVIEW_BLOCKER_PREFIX, splitSentences, type CompositionDocument, type ContentReview } from "../packages/contracts/src/index";
import type { Ctx } from "../packages/engine/src/access";
import { saveComposition } from "../packages/engine/src/composition";
import { EngineError } from "../packages/engine/src/errors";
import { handleMcpRequest } from "../packages/engine/src/mcp";
import { createProduct, placeProduct, updateProduct } from "../packages/engine/src/products";
import { approveReview, getLatestReview, REVIEWS_NOT_SET_UP, reviewContent, UNAVAILABLE_MESSAGE } from "../packages/engine/src/review";
import type { ModelClaim, ReviewModelInput } from "../packages/engine/src/review-model";
import { prepareSchedule } from "../packages/engine/src/schedule";
import { addSource, getCampaign, reviseContent, startCampaign } from "../packages/engine/src/studio";
import { engine, key, rejects, sha256 } from "./reel-support";

/**
 * Content review on the real engine over the in-memory store and bucket. "user:<id>" stands in for a verified session
 * ("user:<id>:<client>" for an OAuth agent); `fct_…` workspace tokens are real.
 */
const FACT = "Each capsule contains 1000 mg of vitamin C.";
const RISKY = "VitaBoost cures colds with no side effects. Each capsule contains 2000 mg of vitamin C. Doctors recommend it.";
const FIXED = `VitaBoost is a vitamin C supplement. ${FACT} Talk to your doctor before you start.`;
const BAKERY = "Our bakery opens early every morning. Come by for warm bread.";

async function setup(env = engine()) {
  // "user:<id>:<client>" is an OAuth agent acting for that member, as in the MCP and personas tests.
  env.deps.verifyAccessToken = async (token) => {
    const [kind, id, client] = token.split(":");
    if (kind !== "user" || !id) throw new Error("invalid");
    return { sub: id, email: `${id}@example.com`, clientId: client ?? null };
  };
  env.deps.fetch = async (input) => {
    const url = new URL(String(input));
    const object = url.hostname === "files.test" ? env.files.objects.get(decodeURIComponent(url.pathname.slice(1))) : undefined;
    return object ? new Response(new Uint8Array(object.bytes), { headers: { "content-type": object.contentType } }) : new Response("missing", { status: 404 });
  };
  const owner = await env.as("user:u1");
  const product = await createProduct(env.deps, owner, { name: "VitaBoost", description: "Vitamin C capsules.", domain: "health", facts: [FACT], operationKey: key() });
  const campaign = await startCampaign(env.deps, owner, {
    operationKey: key(),
    title: "Winter",
    companyContext: { name: "Vita Co", description: "Supplements.", audience: "Adults", tone: "Calm", sourceText: "", sourceUrl: null, missingInformation: "" },
    items: [
      { title: "Vitamin C", script: RISKY },
      { title: "Bakery", script: BAKERY },
    ],
  });
  const now = env.deps.now().toISOString();
  await env.deps.store.insert("memberships", { org_id: owner.org.id, user_id: "rev", role: "reviewer", created_at: now });
  await env.deps.store.insert("memberships", { org_id: owner.org.id, user_id: "ed", role: "editor", created_at: now });
  const reviewer = await env.as("user:rev", owner.org.id);
  const editor = await env.as("user:ed", owner.org.id);
  const [health, bakery] = campaign.items;
  return { env, owner, reviewer, editor, product, campaign, health, bakery };
}
const post = async (env: ReturnType<typeof engine>, name: string, as: string, body: unknown) => {
  const response = await env.call(`/v1/studio/operations/${name}`, as, body);
  return { status: response.status, body: (await response.json()) as any };
};
const review = async (env: ReturnType<typeof engine>, ctx: Ctx, itemId: string) => contentReviewSchema.parse(await reviewContent(env.deps, ctx, { itemId, operationKey: key() }));
/** The review blockers prepare_schedule reports, by item. */
async function gate(env: ReturnType<typeof engine>, ctx: Ctx, campaignId: string) {
  const campaign = await getCampaign(env.deps, ctx, campaignId);
  const manifest = await prepareSchedule(env.deps, ctx, { campaignId, expectedRevision: campaign.revision, operationKey: key() });
  return manifest.blockers.filter((blocker) => blocker.message.startsWith(REVIEW_BLOCKER_PREFIX));
}

test("a health script with a cure promise, a wrong dose and an endorsement needs changes, and says what it did not check", async () => {
  const { env, health, bakery } = await setup();
  const operationKey = key();
  const response = await post(env, "review_content", "user:u1", { itemId: health.id, operationKey });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const result = contentReviewSchema.parse(response.body);
  assert.equal(result.status, "needs_changes");
  assert.equal(result.domain, "health");
  assert.equal(result.mode, "basic");
  assert.equal(result.itemRevision, 1);
  assert.equal(result.compositionRevision, null);
  assert.deepEqual(result.claims.map((claim) => [claim.status, claim.severity]), [
    ["risky_wording", "blocking"],
    ["contradicted", "blocking"],
    ["risky_wording", "blocking"],
  ]);
  assert.equal(result.claims[1].suggestion, FACT, "the wrong dose is answered with the approved fact");
  assert.deepEqual(result.findings, [], "without a timeline there is nothing to compare the voice or captions with");
  assert.deepEqual(result.checked, { claims: true, timeline: false, transcript: false, renderedVideo: false });
  assert.ok(result.notes.some((note) => /no saved timeline yet.*wait for one/.test(note)));
  assert.ok(result.notes.some((note) => /frames and audio are not inspected/.test(note)));
  assert.ok(result.notes.some((note) => /No AI model checked them/.test(note)));
  assert.doesNotMatch(JSON.stringify(result), /\bverified\b/i, "a review never calls content verified");
  assert.equal(result.approval, null);

  // A retried key replays the same review; the item's latest review is served on its own route.
  assert.equal((await post(env, "review_content", "user:u1", { itemId: health.id, operationKey })).body.id, result.id);
  const latest = await env.call(`/v1/studio/items/${health.id}/review`, "user:u1");
  assert.equal(latest.status, 200);
  assert.equal(((await latest.json()) as ContentReview).id, result.id);
  assert.equal(await (await env.call(`/v1/studio/items/${bakery.id}/review`, "user:u1")).json(), null, "an item never reviewed has no review");
  assert.equal((await env.call(`/v1/studio/items/${health.id}/review`, "user:u2")).status, 404, "another workspace cannot read it");
  assert.ok((await env.deps.store.select("audit_events", { action: "Reviewed the content" })).length === 1);
});

test("approval: a named owner, admin or reviewer, never an agent; a credential for health; a reason for blocking items; a new revision makes it stale; the schedule gate follows", async () => {
  const { env, owner, reviewer, editor, campaign, health, bakery } = await setup();
  assert.deepEqual((await gate(env, owner, campaign.id)).map((blocker) => [blocker.itemId, blocker.message]), [[health.id, `${REVIEW_BLOCKER_PREFIX} this health script needs an approved review. Open Details → Review.`]], "the bakery is not gated");

  const first = await review(env, owner, health.id);
  assert.equal(first.status, "needs_changes");
  const approve = (patch: Record<string, unknown> = {}) => ({ reviewId: first.id, by: "Dr. Eleni Papadopoulou", credential: "MD, general practitioner", note: "", operationKey: key(), ...patch });

  // Agents cannot approve, whether they hold a workspace token or act for a signed-in member.
  const token = await env.agentToken(owner, ["campaign:read", "content:edit", "schedule:prepare"]);
  for (const agent of [token, "user:u1:claude-code"]) {
    const refused = await post(env, "approve_review", agent, approve());
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error.code, "approval_required");
  }
  await rejects(approveReview(env.deps, editor, approve()), "forbidden");
  await rejects(approveReview(env.deps, reviewer, approve({ credential: "" })), "validation_error");
  await assert.rejects(approveReview(env.deps, reviewer, approve({ note: "Fine by me." })), (error: unknown) => error instanceof EngineError && /still has 3 blocking items.*at least 20 characters/.test(error.message));
  const accepted = await approveReview(env.deps, reviewer, approve({ note: "Reviewed with the brand; the claims are being rewritten before launch." }));
  assert.equal(accepted.status, "approved");
  assert.equal(accepted.approval?.by, "Dr. Eleni Papadopoulou");
  assert.equal(accepted.approval?.credential, "MD, general practitioner");
  assert.equal(accepted.approval?.principalId, "rev");
  assert.deepEqual(await gate(env, owner, campaign.id), [], "an approved review of the current revision clears the gate");

  // A new script revision makes the approval stale: the gate returns and the old review can no longer be approved.
  const revised = await reviseContent(env.deps, owner, { contentId: health.id, expectedRevision: health.revision, operationKey: key(), patch: { script: FIXED } });
  assert.match((await gate(env, owner, campaign.id))[0].message, /script changed after its last review/);
  await assert.rejects(approveReview(env.deps, reviewer, approve({ note: "Reviewed with the brand; the claims are being rewritten before launch." })), (error: unknown) => error instanceof EngineError && error.code === "revision_conflict" && error.message === "The script changed after this review. Run a new review.");

  // The fixed script has nothing blocking: it waits for a person, who needs no written reason now.
  const second = await review(env, reviewer, health.id);
  assert.equal(second.itemRevision, revised.revision);
  assert.equal(second.status, "needs_approval");
  assert.deepEqual(second.claims.map((claim) => claim.status), ["supported"]);
  assert.equal((await gate(env, owner, campaign.id)).length, 1, "needs_approval still blocks scheduling");
  await rejects(approveReview(env.deps, owner, { reviewId: first.id, by: "Owner", credential: "MD", operationKey: key() }), "revision_conflict");
  const approved = await approveReview(env.deps, owner, { reviewId: second.id, by: "Dr. Nikos Georgiou", credential: "MD, cardiologist", operationKey: key() });
  assert.equal(approved.status, "approved");
  assert.equal(approved.approval?.note, "");
  assert.deepEqual(await gate(env, owner, campaign.id), []);
  assert.equal((await getLatestReview(env.deps, owner, health.id))?.status, "approved");
  assert.equal((await env.deps.store.select("audit_events", { action: "Approved a content review" })).length, 2);

  // The general item was never gated, reviewed or not.
  assert.equal((await review(env, owner, bakery.id)).status, "passed");
});

test("ai mode: the model's claims are re-checked — quotes must be in the script, support must be quoted exactly — and rule-based blockers it misses stay", async () => {
  const { env, owner, product, campaign, health } = await setup(engine({ ANTHROPIC_API_KEY: "test-key" }));
  const excerpt = "Vitamin C contributes to the normal function of the immune system.";
  const withSource = await addSource(env.deps, owner, { campaignId: campaign.id, title: "EU health claim register", excerpt, operationKey: key() });
  const sourceId = withSource.sources[0].id;
  const script = `VitaBoost cures colds with no side effects. ${FACT} It strengthens your immune system. Every bottle holds 30 capsules.`;
  const item = await reviseContent(env.deps, owner, { contentId: health.id, expectedRevision: health.revision, operationKey: key(), patch: { script } });
  let seen: ReviewModelInput | null = null;
  const claim = (patch: Partial<ModelClaim> & Pick<ModelClaim, "quote">): ModelClaim => ({ kind: "health", status: "supported", severity: "info", source: null, note: "Checked.", suggestion: null, ...patch });
  env.deps.reviewModel = {
    async claims(input) {
      seen = input;
      return [
        claim({ quote: FACT, kind: "number", source: { type: "product_fact", id: product.id, quote: FACT } }),
        claim({ quote: "It strengthens your immune system.", source: { type: "source", id: sourceId, quote: "contributes to the normal function of the immune system" } }),
        // Not in the script word for word: dropped.
        claim({ quote: "VitaBoost cures every cold forever.", status: "risky_wording", severity: "blocking" }),
        // "Supported" by a fact that was never provided: corrected.
        claim({ quote: "Every bottle holds 30 capsules.", kind: "number", source: { type: "product_fact", id: product.id, quote: "30 capsules per bottle" } }),
      ];
    },
  };
  const result = await review(env, owner, item.id);
  assert.equal(result.mode, "ai");
  assert.deepEqual(seen!.sentences, splitSentences(script), "the model reads the script as sentences");
  assert.deepEqual(seen!.sources, [{ id: sourceId, title: "EU health claim register", excerpt }]);
  assert.deepEqual(seen!.products, [{ id: product.id, name: "VitaBoost", description: "Vitamin C capsules.", domain: "health", approvedFacts: [FACT] }]);
  assert.deepEqual(
    result.claims.map((entry) => [entry.id, entry.quote, entry.status, entry.severity]),
    [
      ["c1", "VitaBoost cures colds with no side effects.", "risky_wording", "blocking"],
      ["a1", FACT, "supported", "info"],
      ["a2", "It strengthens your immune system.", "supported", "info"],
      ["a3", "Every bottle holds 30 capsules.", "unsupported", "blocking"],
    ],
    "the rule-based cure flag the model missed is kept; the immune claim is backed by the quoted source",
  );
  assert.deepEqual(result.claims[2].source, { type: "source", id: sourceId, quote: "contributes to the normal function of the immune system" });
  assert.equal(result.claims[3].source, null);
  assert.equal(result.status, "needs_changes");
  assert.ok(result.notes.some((note) => /1 claim from the AI check was left out because its quote was not in the script/.test(note)));
  assert.ok(result.notes.some((note) => /1 claim the AI check called supported did not quote a provided fact or source exactly/.test(note)));
  assert.ok(result.notes.some((note) => /not outside knowledge/.test(note)));

  // A model that calls the cure promise a mere warning cannot lower it.
  env.deps.reviewModel = { claims: async () => [claim({ quote: "cures colds", status: "risky_wording", severity: "warning" })] };
  const stricter = await review(env, owner, item.id);
  assert.equal(stricter.claims.find((entry) => entry.quote === "cures colds")?.severity, "blocking");
});

test("when the model fails, the review falls back to the rules and says why", async () => {
  const { env, owner, health } = await setup(engine({ ANTHROPIC_API_KEY: "test-key" }));
  env.deps.reviewModel = { claims: async () => Promise.reject(new EngineError("provider_unavailable", "the claims model could not be reached")) };
  const result = await review(env, owner, health.id);
  assert.equal(result.mode, "basic");
  assert.deepEqual(result.claims, basicClaims(RISKY, { products: [{ id: (await env.deps.store.select("brand_products", {}))[0].id, name: "VitaBoost", facts: [FACT] }], brandRules: [], domain: "health" }));
  assert.ok(result.notes.includes("The AI claims check was unavailable (the claims model could not be reached), so only the rule-based wording checks ran."));
  env.deps.reviewModel = { claims: async () => Promise.reject(new TypeError("boom")) };
  assert.ok((await review(env, owner, health.id)).notes.some((note) => note.includes("(an unexpected error)")));
  // Without a model configured, the injected one is never asked.
  const plain = await setup();
  let asked = false;
  plain.env.deps.reviewModel = { claims: async () => ((asked = true), []) };
  assert.equal((await review(plain.env, plain.owner, plain.health.id)).mode, "basic");
  assert.equal(asked, false);
});

test("with a saved timeline, the review checks labels, the disclaimer, platform safe zones and whether a named product is shown", async () => {
  const { env, owner, product, health } = await setup();
  const item = await reviseContent(env.deps, owner, { contentId: health.id, expectedRevision: health.revision, operationKey: key(), patch: { script: FIXED, targets: [{ platform: "tiktok", accountId: null, scheduledAt: "2026-12-01T09:00:00.000Z", timezone: "Europe/Athens" }] } });
  const photo = new TextEncoder().encode("vitaboost-photo");
  const ticket = await post(env, "product_image_upload_url", "user:u1", { type: "image/png", size: photo.byteLength, sha256: sha256(photo) });
  await env.files.put(ticket.body.key, photo, "image/png");
  await updateProduct(env.deps, owner, { productId: product.id, imageKey: ticket.body.key });
  const draft = (await (await env.call(`/v1/studio/items/${item.id}/composition`, "user:u1")).json()) as CompositionDocument;
  await saveComposition(env.deps, owner, { contentId: item.id, expectedRevision: 0, composition: { ...draft.composition, labels: { aiAvatar: false, disclaimer: "" } }, operationKey: key() });

  const result = await review(env, owner, item.id);
  assert.equal(result.compositionRevision, 1);
  assert.deepEqual(result.checked, { claims: true, timeline: true, transcript: false, renderedVideo: false });
  assert.deepEqual(result.findings.map((finding) => [finding.code, finding.severity]), [
    ["ai_label_off", "blocking"],
    ["disclaimer_missing", "blocking"],
    ["transcript_missing", "info"],
    ["product_not_shown", "warning"],
    ["captions_under_platform_ui", "warning"],
  ]);
  assert.ok(result.notes.some((note) => /no word timings yet/.test(note)));
  assert.equal(result.status, "needs_changes");

  // Showing the product with place_product, turning the label on and adding a disclaimer clears those findings.
  const placed = await placeProduct(env.deps, owner, { itemId: item.id, productId: product.id, expectedCompositionRevision: 1, operationKey: key() });
  const current = (await (await env.call(`/v1/studio/items/${item.id}/composition`, "user:u1")).json()) as CompositionDocument;
  await saveComposition(env.deps, owner, { contentId: item.id, expectedRevision: placed.compositionRevision, composition: { ...current.composition, labels: { aiAvatar: true, disclaimer: "For information only, not medical advice." }, style: { ...current.composition.style, captionPosition: "center" } }, operationKey: key() });
  const after = await review(env, owner, item.id);
  assert.deepEqual(after.findings.map((finding) => finding.code), ["transcript_missing"]);
  assert.equal(after.status, "needs_approval");
});

test("where reviews are not set up, regulated items are blocked with a clear message and scheduling does not crash", async () => {
  const { env, owner, campaign, health, bakery } = await setup();
  const select = env.deps.store.select.bind(env.deps.store);
  env.deps.store.select = (async (table: string, ...rest: unknown[]) => {
    if (table === "content_reviews") throw new EngineError("provider_unavailable", "The studio database could not complete this request. Nothing was changed; try again.");
    return (select as (...args: unknown[]) => Promise<unknown>)(table, ...rest);
  }) as typeof env.deps.store.select;
  assert.deepEqual((await gate(env, owner, campaign.id)).map((blocker) => [blocker.itemId, blocker.message]), [[health.id, REVIEWS_NOT_SET_UP]]);
  assert.equal(REVIEWS_NOT_SET_UP, "Claims review: reviews are not set up on this deployment yet.");
  const read = await env.call(`/v1/studio/items/${health.id}/review`, "user:u1");
  assert.equal(read.status, 503);
  assert.equal(((await read.json()) as any).error.message, UNAVAILABLE_MESSAGE);

  // Without the products table either, the studio context still opens and the gate still holds by script alone.
  env.deps.store.select = (async (table: string, ...rest: unknown[]) => {
    if (table === "content_reviews" || table === "brand_products") throw new EngineError("provider_unavailable", "The studio database could not complete this request. Nothing was changed; try again.");
    return (select as (...args: unknown[]) => Promise<unknown>)(table, ...rest);
  }) as typeof env.deps.store.select;
  const context = await env.call("/v1/studio/context", "user:u1");
  assert.equal(context.status, 200);
  assert.deepEqual(((await context.json()) as any).products, []);
  assert.deepEqual((await gate(env, owner, campaign.id)).map((blocker) => blocker.itemId), [health.id], "the cure promise alone makes it a health script");
  assert.ok(bakery);
});

test("MCP: agents can list products, run and read reviews, but there is no way for them to approve one", async () => {
  const { env, owner, health } = await setup();
  const token = await env.agentToken(owner, ["campaign:read", "content:edit", "render:write", "schedule:prepare"]);
  const rpc = async (method: string, params: unknown = {}) => {
    const response = (await handleMcpRequest(env.deps, new Request("https://faceful.test/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), "/mcp"))!;
    assert.equal(response.status, 200);
    return ((await response.json()) as { result: any }).result;
  };
  const tools = ((await rpc("tools/list")).tools as Array<{ name: string; description: string; annotations: { readOnlyHint: boolean } }>).filter((tool) => ["list_products", "place_product", "review_content", "get_review"].includes(tool.name));
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["get_review", "list_products", "place_product", "review_content"]);
  assert.deepEqual(tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name).sort(), ["get_review", "list_products"]);
  for (const tool of tools.filter((entry) => entry.name !== "list_products" && entry.name !== "place_product")) assert.match(tool.description, /approv/, `${tool.name} says approval is a person's act`);
  assert.equal((await rpc("tools/list")).tools.some((tool: { name: string }) => tool.name === "approve_review"), false, "no approve_review tool exists");

  const listed = (await rpc("tools/call", { name: "list_products", arguments: {} })).structuredContent;
  assert.deepEqual(listed.products.map((product: { name: string; facts: string[]; hasImage: boolean }) => [product.name, product.facts, product.hasImage]), [["VitaBoost", [FACT], false]]);
  const ran = (await rpc("tools/call", { name: "review_content", arguments: { itemId: health.id } })).structuredContent;
  assert.equal(ran.review.status, "needs_changes");
  assert.match(ran.note, /Revise the script/);
  const read = (await rpc("tools/call", { name: "get_review", arguments: { itemId: health.id } })).structuredContent;
  assert.equal(read.review.id, ran.review.id);
  assert.equal(read.stale, false);
  const refused = await post(env, "approve_review", token, { reviewId: ran.review.id, by: "Claude", credential: "AI", note: "Looks fine to me, nothing to see here.", operationKey: key() });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "approval_required");
  assert.equal((await getLatestReview(env.deps, owner, health.id))?.approval, null);
});
