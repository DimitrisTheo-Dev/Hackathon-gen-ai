import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GEMINI_MODEL, loadConfig } from "../packages/engine/src/config";
import { EngineError } from "../packages/engine/src/errors";
import { createPlanner, type PlannerOutput } from "../packages/engine/src/llm";

/** The director's Gemini path, with Google's API replaced by a recorded fetch. */
const KEY = "gemini-key-placeholder";
const plan: PlannerOutput = { intent: "answer", reply: "Hello.", project: null, edits: [], renderItemIds: [], find: null, wantsCheckout: false };
const io = { system: "You are the director.", user: "<request>hi</request>" };

function gemini(respond: () => Response | Promise<Response>) {
  const calls: Request[] = [];
  const planner = createPlanner({ provider: "gemini", apiKey: KEY, model: DEFAULT_GEMINI_MODEL }, async (input, init) => {
    calls.push(new Request(input, init));
    return respond();
  });
  return { planner, calls };
}
const answer = (parts: Array<{ text: string; thought?: boolean }>, finishReason = "STOP") => Response.json({ candidates: [{ finishReason, content: { role: "model", parts } }] });
const rejects = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof EngineError && error.code === code && (!message || message.test(error.message)));

test("a Gemini key alone selects Gemini; with an Anthropic key too, DIRECTOR_PROVIDER decides", () => {
  assert.deepEqual(loadConfig({ GEMINI_API_KEY: "  key  " }).llm, { provider: "gemini", apiKey: "key", model: DEFAULT_GEMINI_MODEL });
  assert.equal(loadConfig({ GEMINI_API_KEY: "key", DIRECTOR_MODEL: "gemini-3.8-flash" }).llm?.model, "gemini-3.8-flash");
  assert.equal(loadConfig({ GEMINI_API_KEY: "key", ANTHROPIC_API_KEY: "a" }).llm?.provider, "anthropic");
  assert.equal(loadConfig({ GEMINI_API_KEY: "key", ANTHROPIC_API_KEY: "a", DIRECTOR_PROVIDER: "gemini" }).llm?.provider, "gemini");
  assert.equal(loadConfig({ GEMINI_API_KEY: "   " }).llm, null);
  // The model name becomes part of the request path, so anything but a plain model name falls back to the default.
  assert.equal(loadConfig({ GEMINI_API_KEY: "key", DIRECTOR_MODEL: "../files?alt=media" }).llm?.model, DEFAULT_GEMINI_MODEL);
});

test("Gemini planner sends the key in a header, asks for the plan schema, and returns only the validated answer", async () => {
  const { planner, calls } = gemini(() => answer([{ text: "Thinking about the brief…", thought: true }, { text: JSON.stringify(plan) }]));
  assert.deepEqual(await planner.plan(io), plan);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(url.search, "", "the key never travels in the URL");
  assert.equal(calls[0].headers.get("x-goog-api-key"), KEY);
  const body = await calls[0].json();
  assert.equal(body.systemInstruction.parts[0].text, io.system);
  assert.deepEqual(body.contents, [{ role: "user", parts: [{ text: io.user }] }]);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseJsonSchema.$schema, undefined);
  assert.deepEqual([...body.generationConfig.responseJsonSchema.required].sort(), Object.keys(plan).sort());
});

test("Gemini failures change nothing and say why in plain words", async () => {
  await rejects(gemini(() => Response.json({ error: { status: "RESOURCE_EXHAUSTED" } }, { status: 429 })).planner.plan(io), "quota_exceeded");
  await rejects(gemini(() => Response.json({ error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, { status: 400 })).planner.plan(io), "provider_unavailable", /credentials/);
  await rejects(gemini(() => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 })).planner.plan(io), "provider_unavailable", /credentials/);
  await rejects(gemini(() => Response.json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })).planner.plan(io), "unsupported");
  await rejects(gemini(() => answer([], "SAFETY")).planner.plan(io), "unsupported");
  await rejects(gemini(() => answer([{ text: '{"intent":' }], "MAX_TOKENS")).planner.plan(io), "provider_unavailable", /too long/);
  await rejects(gemini(() => answer([{ text: "Here is your plan!" }])).planner.plan(io), "provider_unavailable", /unreadable/);
  await rejects(gemini(() => answer([{ text: JSON.stringify({ ...plan, intent: "publish" }) }])).planner.plan(io), "provider_unavailable", /invalid/);
  await rejects(gemini(() => Promise.reject(new TypeError("fetch failed"))).planner.plan(io), "provider_unavailable", /reached/);
});

test("a Gemini server error is retried once, then reported", async () => {
  let attempt = 0;
  const recovered = gemini(() => (++attempt === 1 ? new Response("", { status: 503 }) : answer([{ text: JSON.stringify(plan) }])));
  assert.deepEqual(await recovered.planner.plan(io), plan);
  assert.equal(recovered.calls.length, 2);
  const down = gemini(() => new Response("", { status: 500 }));
  await rejects(down.planner.plan(io), "provider_unavailable", /could not prepare/);
  assert.equal(down.calls.length, 2);
});
