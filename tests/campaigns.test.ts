import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MAX_AI_TURNS, matchKeyword, withLink } from "../packages/engine/src/socials-campaigns";
import { MemoryStore } from "../packages/engine/src/store-memory";

/**
 * Comment-to-DM campaigns on the real engine: an in-memory store, Instagram connected with Unified login (the Meta app
 * "Castroom" has no other setup), and stand-ins for graph.facebook.com and Gemini answering in their documented shapes.
 */
const BASE = "https://faceful.test";
const IG = "17841449748019054";
const META_APP = "1644316440822858";
const CONFIG_ID = "2727787837624152";
const APP_SECRET = "meta-app-secret-value";
const WEBHOOK_SECRET = "w".repeat(40);
const LINK = "https://giatrosonline.gr/guide";
const UNIFIED = {
  SOCIALS_CREDENTIAL_KEY: "cd".repeat(32),
  SOCIALS_WEBHOOK_SECRET: WEBHOOK_SECRET,
  INSTAGRAM_APP_ID: META_APP,
  INSTAGRAM_APP_SECRET: APP_SECRET,
  INSTAGRAM_WEBHOOK_VERIFY_TOKEN: "verify-token-1",
  INSTAGRAM_LOGIN_CONFIG_ID: CONFIG_ID,
  GEMINI_API_KEY: "gemini-test-key",
  CRON_SECRET: "cron-secret-value",
};

function meta() {
  const state = {
    requests: [] as Array<{ method: string; host: string; path: string; token: string | null; body: any }>,
    /** Each private reply tells who it went to; a person's messages then come from that ID. */
    recipients: 0,
    gemini: [] as any[],
    geminiAnswer: "The guide is here again: https://giatrosonline.gr/guide",
    refuseMessages: false,
  };
  const fetch = (async (url: unknown, init?: RequestInit) => {
    const target = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
    const path = target.pathname.replace(/^\/v27\.0/, "");
    state.requests.push({ method, host: target.host, path, token, body });
    if (target.host === "generativelanguage.googleapis.com") {
      assert.equal(new Headers(init?.headers).get("x-goog-api-key"), "gemini-test-key");
      state.gemini.push(body);
      return Response.json({ candidates: [{ content: { parts: [{ text: state.geminiAnswer }] }, finishReason: "STOP" }] });
    }
    assert.equal(target.host, "graph.facebook.com", `unexpected host ${target.host}`);
    if (path === "/oauth/access_token") {
      const query = target.searchParams;
      assert.deepEqual([query.get("client_id"), query.get("client_secret"), query.get("redirect_uri")], [META_APP, APP_SECRET, `${BASE}/v1/socials/providers/instagram/callback`]);
      return query.get("code") === "fb-code" ? Response.json({ access_token: "suat-token-1", token_type: "bearer" }) : Response.json({ error: { message: "Invalid verification code", code: 100 } }, { status: 400 });
    }
    if (token !== "suat-token-1") return Response.json({ error: { message: "Invalid OAuth access token", code: 190 } }, { status: 400 });
    if (path === "/me/assigned_instagram_accounts") return Response.json({ data: [{ id: IG, username: "giatrosonline.gr" }], paging: { cursors: {} } });
    if (path === "/me") return Response.json({ client_business_id: "1286745215763987", id: "122000000" });
    if (path === `/${IG}/subscribed_apps` && method === "POST") return Response.json({ success: true });
    if (path === `/${IG}/messages` && method === "POST") {
      if (state.refuseMessages) return Response.json({ error: { message: "This message is sent outside of allowed window.", code: 10, error_subcode: 2534022 } }, { status: 400 });
      const recipient = body.recipient.comment_id ? `IGSID-${++state.recipients}` : body.recipient.id;
      return Response.json({ recipient_id: recipient, message_id: `mid-${state.requests.length}` });
    }
    const reply = path.match(/^\/([\w-]+)\/replies$/);
    if (reply && method === "POST") return Response.json({ id: `reply-to-${reply[1]}` });
    throw new Error(`unexpected request: ${method} ${target.host}${path}`);
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

function engine(env: Record<string, string> = UNIFIED) {
  let clock = Date.parse("2026-11-15T10:00:00.000Z");
  const remote = meta();
  const store = new MemoryStore();
  store.clock = () => new Date(clock);
  const deps: HttpDeps = {
    store,
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: BASE, ...env }),
    now: () => new Date(clock),
    verifyAccessToken: async (token) => {
      const [kind, id] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: null };
    },
    fetch: remote.fetch,
    planner: null,
  };
  const call = async (path: string, init: { as?: string; method?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.as) headers.authorization = `Bearer ${init.as}`;
    const method = init.method ?? "GET";
    const body = init.raw ?? (method === "GET" || method === "DELETE" ? undefined : JSON.stringify(init.body ?? {}));
    const response = await handleEngineRequest(deps, new Request(`${BASE}${path}`, { method, headers, body }), path.split("?")[0]);
    const text = await response!.text();
    return { status: response!.status, text, body: (text.startsWith("{") ? JSON.parse(text) : null) as any };
  };
  /** Connects @giatrosonline.gr the way a person does: start in the studio, allow access at Facebook, come back with the code. */
  const connect = async () => {
    const started = await call("/v1/socials/providers/instagram/connect", { as: "user:u1", method: "POST" });
    assert.equal(started.status, 200, started.text);
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    const done = await call("/v1/socials/providers/instagram/complete", { as: "user:u1", method: "POST", body: { code: "fb-code", state } });
    assert.equal(done.status, 200, done.text);
    return { authorizeUrl: new URL(started.body.authorizeUrl), account: done.body.accounts[0] };
  };
  /** One delivery in Instagram's own format, signed with the Meta app's secret as Meta signs it. */
  const instagram = (entry: Record<string, unknown>) => {
    const raw = JSON.stringify({ object: "instagram", entry: [{ id: IG, time: Math.floor(clock / 1000), ...entry }] });
    return call("/v1/socials/instagram/webhook", { method: "POST", raw, headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}` } });
  };
  let n = 0;
  const comment = (text: string, from = { id: "commenter-1", username: "maria" }) => instagram({ changes: [{ field: "comments", value: { from, media: { id: "media-1", media_product_type: "REELS" }, id: `comment-${++n}`, text } }] });
  const message = (text: string, sender = "IGSID-1") => instagram({ messaging: [{ sender: { id: sender }, recipient: { id: IG }, timestamp: clock, message: { mid: `in-${++n}`, text } }] });
  const sent = (filter: (request: { path: string; body: any }) => boolean = () => true) => remote.state.requests.filter((request) => request.host === "graph.facebook.com" && request.method === "POST" && /\/(messages|replies)$/.test(request.path) && filter(request));
  return { deps, store, remote, call, connect, instagram, comment, message, sent, advance: (minutes: number) => (clock += minutes * 60_000) };
}

const campaign = (accountId: string, extra: Record<string, unknown> = {}) => ({
  accountId,
  name: "Free guide",
  enabled: true,
  keywords: ["guide", "οδηγός"],
  openingMessage: "Here is the guide you asked for: {link}",
  linkUrl: LINK,
  publicReply: "Sent you a DM 📩",
  aiEnabled: true,
  aiInstructions: "Help people book a home visit. Mention the guide when it helps.",
  followUps: [{ delayMinutes: 60, text: "Did the guide help? Book here: {link}" }],
  ...extra,
});

test("keywords match whole words and phrases, without regard to case or accents", () => {
  assert.equal(matchKeyword(["guide"], "Guide please!"), "guide");
  assert.equal(matchKeyword(["guide"], "the guidelines"), null);
  assert.equal(matchKeyword(["οδηγός"], "ΟΔΗΓΟΣ!!"), "οδηγός");
  assert.equal(matchKeyword(["free guide"], "Can I have the free   guide?"), "free guide");
  assert.equal(matchKeyword(["free guide"], "free, then a guide"), null);
  assert.equal(matchKeyword(["guide"], null), null);
  assert.equal(withLink("Here: {link}", LINK), `Here: ${LINK}`);
  assert.equal(withLink("Here it is", LINK), `Here it is\n\n${LINK}`);
  assert.equal(withLink("Here it is {link}", null), "Here it is");
  assert.equal(withLink("Last call", LINK, false), "Last call");
});

test("Instagram with Unified login: the person allows access through Facebook's dialog, and the account is reached by its own ID", async () => {
  const { connect, remote } = engine();
  const { authorizeUrl, account } = await connect();
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, "https://www.facebook.com/dialog/oauth");
  assert.deepEqual([authorizeUrl.searchParams.get("client_id"), authorizeUrl.searchParams.get("config_id"), authorizeUrl.searchParams.get("redirect_uri"), authorizeUrl.searchParams.get("response_type")], [META_APP, CONFIG_ID, `${BASE}/v1/socials/providers/instagram/callback`, "code"]);
  assert.deepEqual([account.displayName, account.state, account.provider], ["@giatrosonline.gr", "connected", "instagram"]);
  // Activity was asked for on the account's own ID, with the system user's token, on graph.facebook.com.
  assert.ok(remote.state.requests.some((request) => request.path === `/${IG}/subscribed_apps` && request.token === "suat-token-1"));
  assert.ok(account.webhookSubscribedAt);
});

test("a campaign is an owner's to make, only for an Instagram account that can send messages, and its link must be https", async () => {
  const { call, connect } = engine();
  const { account } = await connect();
  assert.equal((await call("/v1/socials/campaigns")).status, 401);
  const empty = await call("/v1/socials/campaigns", { as: "user:u1" });
  assert.equal(empty.status, 200, empty.text);
  assert.deepEqual([empty.body.campaigns, empty.body.ai, empty.body.webhook, empty.body.canManage], [[], true, { url: `${BASE}/v1/socials/instagram/webhook`, instagram: true, signedTests: true }, true]);
  assert.deepEqual(empty.body.accounts.map((entry: any) => [entry.displayName, entry.canMessage, entry.activity]), [["@giatrosonline.gr", true, true]]);

  assert.equal((await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(crypto.randomUUID()) })).status, 404);
  const insecure = await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id, { linkUrl: "http://example.com" }) });
  assert.equal(insecure.status, 400, insecure.text);
  const tooLate = await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id, { followUps: [{ delayMinutes: 24 * 60, text: "Late" }] }) });
  assert.equal(tooLate.status, 400, "a follow-up must fit in Instagram's 24 hours");

  const created = await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id) });
  assert.equal(created.status, 201, created.text);
  assert.deepEqual([created.body.campaign.name, created.body.campaign.enabled, created.body.campaign.keywords, created.body.campaign.people], ["Free guide", true, ["guide", "οδηγός"], 0]);
  const off = await call(`/v1/socials/campaigns/${created.body.campaign.id}`, { as: "user:u1", method: "PATCH", body: { enabled: false, publicReply: "" } });
  assert.equal(off.status, 200, off.text);
  assert.deepEqual([off.body.campaign.enabled, off.body.campaign.publicReply], [false, null]);
  // Another person, with no workspace role here, sees nothing of it.
  assert.deepEqual((await call("/v1/socials/campaigns", { as: "user:u2" })).body.campaigns, []);
  assert.equal((await call(`/v1/socials/campaigns/${created.body.campaign.id}`, { as: "user:u2", method: "DELETE" })).status, 404);
  assert.equal((await call(`/v1/socials/campaigns/${created.body.campaign.id}`, { as: "user:u1", method: "DELETE" })).status, 200);
  assert.deepEqual((await call("/v1/socials/campaigns", { as: "user:u1" })).body.campaigns, []);
});

test("a comment with the keyword is answered once, privately and publicly; other comments and the account's own are left alone", async () => {
  const { call, connect, comment, sent, instagram } = engine();
  const { account } = await connect();
  const { campaign: made } = (await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id) })).body;

  assert.equal((await comment("Lovely video")).status, 200);
  assert.equal((await comment("guide", { id: IG, username: "giatrosonline.gr" })).status, 200);
  assert.equal(sent().length, 0);

  const delivered = await comment("Guide please!");
  assert.equal(delivered.status, 200, delivered.text);
  const [opening, publicReply] = sent();
  assert.equal(opening.path, `/${IG}/messages`);
  assert.deepEqual(opening.body, { recipient: { comment_id: "comment-3" }, message: { text: `Here is the guide you asked for: ${LINK}` } });
  assert.deepEqual([publicReply.path, publicReply.body], ["/comment-3/replies", { message: "Sent you a DM 📩" }]);

  // The same delivery again (Meta retries), and the same person commenting again: nobody is messaged twice.
  await comment("GUIDE");
  assert.equal(sent().length, 2);
  const conversations = await call(`/v1/socials/campaigns/${made.id}/conversations`, { as: "user:u1" });
  assert.equal(conversations.status, 200, conversations.text);
  const [conversation] = conversations.body.conversations;
  assert.deepEqual([conversation.contactName, conversation.state], ["maria", "awaiting_reply"]);
  assert.deepEqual(conversation.messages.map((message: any) => [message.direction, message.kind, message.status]), [["in", "comment", "received"], ["out", "opening", "sent"], ["out", "public_reply", "sent"], ["in", "comment", "received"]]);
  assert.equal((await call("/v1/socials/campaigns", { as: "user:u1" })).body.campaigns[0].people, 1);

  // A campaign switched off listens to nothing.
  await call(`/v1/socials/campaigns/${made.id}`, { as: "user:u1", method: "PATCH", body: { enabled: false } });
  await comment("guide", { id: "commenter-2", username: "nikos" });
  assert.equal(sent().length, 2);
  // An unsigned delivery is refused before anything happens.
  const raw = JSON.stringify({ object: "instagram", entry: [] });
  assert.equal((await call("/v1/socials/instagram/webhook", { method: "POST", raw, headers: { "x-hub-signature-256": "sha256=00" } })).status, 401);
  void instagram;
});

test("when the person writes back, Gemini answers with the conversation so far, and follow-ups go out inside Instagram's 24 hours", async () => {
  const { call, connect, comment, message, sent, remote, advance } = engine();
  const { account } = await connect();
  const { campaign: made } = (await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id, { publicReply: null, followUps: [{ delayMinutes: 60, text: "Did the guide help? Book here: {link}" }, { delayMinutes: 23 * 60, text: "Last call" }] }) })).body;
  await comment("guide");
  // Messages come from the ID the private reply named (IGSID-1), not the one on the comment.
  const replied = await message("Thanks! Can a doctor come to Petroupoli?", "IGSID-1");
  assert.equal(replied.status, 200, replied.text);
  const answer = sent((request) => request.body?.recipient?.id === "IGSID-1");
  assert.equal(answer.length, 1);
  assert.equal(answer[0].body.message.text, remote.state.geminiAnswer);
  const [asked] = remote.state.gemini;
  assert.match(asked.systemInstruction.parts[0].text, /Help people book a home visit/);
  assert.match(asked.systemInstruction.parts[0].text, /giatrosonline\.gr\/guide/);
  assert.deepEqual(asked.contents.map((content: any) => content.role), ["user", "model", "user"]);
  assert.match(asked.contents[2].parts[0].text, /Petroupoli/);

  const read = async () => (await call(`/v1/socials/campaigns/${made.id}/conversations`, { as: "user:u1" })).body.conversations[0];
  let conversation = await read();
  assert.deepEqual([conversation.state, conversation.aiTurns], ["open", 1]);
  assert.deepEqual(conversation.messages.filter((m: any) => m.kind === "follow_up").map((m: any) => [m.status, m.text]), [["scheduled", `Did the guide help? Book here: ${LINK}`], ["scheduled", "Last call"]]);

  // An hour later the scheduler sends the first follow-up.
  advance(61);
  const tick = await call("/v1/cron/tick", { method: "POST", headers: { authorization: "Bearer cron-secret-value" } });
  assert.equal(tick.status, 200, tick.text);
  assert.deepEqual(tick.body.messages, { sent: 1, skipped: 0, failed: 0 });
  assert.equal(sent((request) => request.body?.message?.text === `Did the guide help? Book here: ${LINK}`).length, 1);
  // The second is due 23 hours after their reply; a day and more later Instagram would refuse it, so it is skipped.
  advance(25 * 60);
  assert.deepEqual((await call("/v1/cron/tick", { method: "POST", headers: { authorization: "Bearer cron-secret-value" } })).body.messages, { sent: 0, skipped: 1, failed: 0 });
  conversation = await read();
  assert.deepEqual(conversation.messages.filter((m: any) => m.kind === "follow_up").map((m: any) => m.status), ["sent", "skipped"]);
});

test("STOP ends the conversation: nothing scheduled goes out and nothing more is answered", async () => {
  const { call, connect, comment, message, sent, remote, advance } = engine();
  const { account } = await connect();
  const { campaign: made } = (await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id, { publicReply: null }) })).body;
  await comment("οδηγός");
  await message("yes");
  await message("Stop");
  await message("hello again?");
  advance(120);
  await call("/v1/cron/tick", { method: "POST", headers: { authorization: "Bearer cron-secret-value" } });
  const [conversation] = (await call(`/v1/socials/campaigns/${made.id}/conversations`, { as: "user:u1" })).body.conversations;
  assert.equal(conversation.state, "stopped");
  assert.deepEqual(conversation.messages.filter((m: any) => m.direction === "out").map((m: any) => [m.kind, m.status]), [["opening", "sent"], ["ai", "sent"], ["notice", "sent"], ["follow_up", "cancelled"]]);
  // One AI answer (to "yes"), none after STOP.
  assert.equal(remote.state.gemini.length, 1);
  assert.equal(sent((request) => request.body?.message?.text === "Did the guide help? Book here: https://giatrosonline.gr/guide").length, 0);
});

test("AI answers stop at the per-conversation limit, and a refusal from Instagram is recorded once, not retried", async () => {
  const { call, connect, comment, message, sent, remote } = engine();
  const { account } = await connect();
  const { campaign: made } = (await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id, { publicReply: null, followUps: [] }) })).body;
  await comment("guide");
  for (let index = 0; index < MAX_AI_TURNS + 2; index++) await message(`question ${index}`);
  assert.equal(remote.state.gemini.length, MAX_AI_TURNS);

  remote.state.refuseMessages = true;
  const before = sent().length;
  await comment("guide", { id: "commenter-2", username: "nikos" });
  assert.equal(sent().length, before + 1, "one attempt, no retry");
  const nikos = (await call(`/v1/socials/campaigns/${made.id}/conversations`, { as: "user:u1" })).body.conversations.find((entry: any) => entry.contactName === "nikos");
  const opening = nikos.messages.find((m: any) => m.kind === "opening");
  assert.deepEqual([opening.status, opening.error], ["failed", "Instagram only lets an account message someone within 24 hours of their last message."]);
});

test("Try it: a test comment and reply go through the signed webhook address, the AI answers for real, and nothing is sent to Instagram", async () => {
  const { call, connect, sent, remote } = engine();
  const { account } = await connect();
  // A test works before the campaign is switched on.
  const { campaign: made } = (await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id, { enabled: false }) })).body;
  const path = `/v1/socials/campaigns/${made.id}/test`;
  assert.equal((await call(path, { as: "user:u1", method: "POST", body: { kind: "reply", text: "hi" } })).status, 400, "a reply needs a comment first");
  const missed = await call(path, { as: "user:u1", method: "POST", body: { kind: "comment", text: "nice video" } });
  assert.deepEqual([missed.status, missed.body.via, missed.body.conversation], [200, "webhook", null]);

  const commented = await call(path, { as: "user:u1", method: "POST", body: { kind: "comment", text: "GUIDE pls" } });
  assert.equal(commented.status, 200, commented.text);
  assert.equal(commented.body.via, "webhook");
  assert.deepEqual(commented.body.conversation.messages.map((m: any) => [m.kind, m.status]), [["comment", "received"], ["opening", "simulated"], ["public_reply", "simulated"]]);
  const replied = await call(path, { as: "user:u1", method: "POST", body: { kind: "reply", text: "Do you come to Kifisia?" } });
  assert.deepEqual(replied.body.conversation.messages.slice(3).map((m: any) => [m.kind, m.status]), [["message", "received"], ["ai", "simulated"], ["follow_up", "scheduled"]]);
  // A follow-up sits where it will go out: after the AI's answer, an hour from now.
  assert.equal(replied.body.conversation.messages.find((m: any) => m.kind === "ai").text, remote.state.geminiAnswer);
  assert.equal(sent().length, 0, "a test sends nothing to Instagram");
  // Tests are not counted as people reached, and do not show among real conversations.
  assert.equal((await call("/v1/socials/campaigns", { as: "user:u1" })).body.campaigns[0].people, 0);
  assert.deepEqual((await call(`/v1/socials/campaigns/${made.id}/conversations`, { as: "user:u1" })).body.conversations, []);
  // The test went through the activity log like any delivery, marked as a test.
  const events = (await call("/v1/socials/events", { as: "user:u1" })).body.events;
  assert.deepEqual(events.filter((event: any) => event.source === "test").map((event: any) => event.type).sort(), ["comment.created", "comment.created", "message.received"]);

  const reset = await call(path, { as: "user:u1", method: "POST", body: { kind: "reset" } });
  assert.deepEqual([reset.body.via, reset.body.conversation], [null, null]);
});

test("without Gemini or the webhook secret, campaigns still message people and tests still run, saying what is missing", async () => {
  const { GEMINI_API_KEY: _gemini, SOCIALS_WEBHOOK_SECRET: _secret, ...rest } = UNIFIED;
  const { call, connect } = engine(rest);
  const { account } = await connect();
  const listed = await call("/v1/socials/campaigns", { as: "user:u1" });
  assert.deepEqual([listed.body.ai, listed.body.webhook.signedTests], [false, false]);
  const { campaign: made } = (await call("/v1/socials/campaigns", { as: "user:u1", method: "POST", body: campaign(account.id) })).body;
  const path = `/v1/socials/campaigns/${made.id}/test`;
  assert.equal((await call(path, { as: "user:u1", method: "POST", body: { kind: "comment", text: "guide" } })).body.via, "direct");
  const replied = await call(path, { as: "user:u1", method: "POST", body: { kind: "reply", text: "thanks" } });
  const ai = replied.body.conversation.messages.find((m: any) => m.kind === "ai");
  assert.deepEqual([ai.kind, ai.status, ai.error], ["ai", "skipped", "AI answers need GEMINI_API_KEY on this deployment."]);
});
