import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_GEMINI_MODEL } from "../packages/engine/src/config";
import { EngineError } from "../packages/engine/src/errors";
import { createReviewModel, type ModelClaim, type ReviewModelInput } from "../packages/engine/src/review-model";

/** The review's claims pass on a deployment whose director writes with Gemini, with Google's API replaced by a recorded fetch. */
const KEY = "gemini-key-placeholder";
const input: ReviewModelInput = {
  domain: "health",
  language: "en",
  sentences: ["BeWell Omega contains 1000 mg of omega-3 per capsule."],
  products: [{ id: "p1", name: "BeWell Omega", description: "", domain: "health", approvedFacts: ["BeWell Omega contains 1000 mg of omega-3 per capsule."] }],
  sources: [],
  brandRules: [],
};
const claim: ModelClaim = {
  quote: "BeWell Omega contains 1000 mg of omega-3 per capsule.",
  kind: "number",
  status: "supported",
  severity: "info",
  source: { type: "product_fact", id: "p1", quote: "BeWell Omega contains 1000 mg of omega-3 per capsule." },
  note: "Matches an approved product fact.",
  suggestion: null,
};
function gemini(respond: () => Response | Promise<Response>) {
  const calls: Request[] = [];
  const model = createReviewModel({ provider: "gemini", apiKey: KEY, model: DEFAULT_GEMINI_MODEL }, async (url, init) => {
    calls.push(new Request(url, init));
    return respond();
  });
  return { model, calls };
}
const answer = (parts: Array<{ text: string; thought?: boolean }>, finishReason = "STOP") => Response.json({ candidates: [{ finishReason, content: { role: "model", parts } }] });
const rejects = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => error instanceof EngineError && error.code === code && (!message || message.test(error.message)));

test("a Gemini deployment reviews claims through Gemini: key in a header, review schema, validated answer", async () => {
  const { model, calls } = gemini(() => answer([{ text: "Checking the facts…", thought: true }, { text: JSON.stringify({ claims: [claim] }) }]));
  assert.deepEqual(await model.claims(input), [claim]);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(url.search, "", "the key never travels in the URL");
  assert.equal(calls[0].headers.get("x-goog-api-key"), KEY);
  const body = await calls[0].json();
  assert.match(body.systemInstruction.parts[0].text, /never use outside knowledge/i);
  assert.match(body.contents[0].parts[0].text, /<script_sentences>/);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.equal(body.generationConfig.responseJsonSchema.$schema, undefined);
  assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["claims"]);
});

test("Gemini review failures are reported in words that complete “The AI check was unavailable: …”", async () => {
  await rejects(gemini(() => Response.json({ error: { status: "RESOURCE_EXHAUSTED" } }, { status: 429 })).model.claims(input), "quota_exceeded");
  await rejects(gemini(() => Response.json({ error: { status: "PERMISSION_DENIED" } }, { status: 403 })).model.claims(input), "provider_unavailable", /credentials/);
  await rejects(gemini(() => Response.json({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" } })).model.claims(input), "unsupported");
  await rejects(gemini(() => answer([{ text: '{"claims":' }], "MAX_TOKENS")).model.claims(input), "provider_unavailable", /too long/);
  await rejects(gemini(() => answer([{ text: "All good!" }])).model.claims(input), "provider_unavailable", /unreadable/);
  await rejects(gemini(() => answer([{ text: JSON.stringify({ claims: [{ ...claim, status: "verified" }] }) }])).model.claims(input), "provider_unavailable", /wrong shape/);
  await rejects(gemini(() => Promise.reject(new TypeError("fetch failed"))).model.claims(input), "provider_unavailable", /reached/);
  let attempt = 0;
  const recovered = gemini(() => (++attempt === 1 ? new Response("", { status: 503 }) : answer([{ text: JSON.stringify({ claims: [] }) }])));
  assert.deepEqual(await recovered.model.claims(input), []);
  assert.equal(recovered.calls.length, 2);
});
