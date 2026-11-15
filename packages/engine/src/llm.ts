import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { LlmConfig } from "./config.js";
import { EngineError } from "./errors.js";

/**
 * The planner turns a request into a typed proposal. It has no tools and no credentials: it cannot
 * render, charge, approve or publish. Everything it returns is validated and authorized by the engine.
 */
const platform = z.enum(["instagram", "tiktok", "youtube"]);
const slot = z.object({ platform, localDateTime: z.string().describe("Local wall-clock time in the workspace timezone, formatted YYYY-MM-DDTHH:mm") });
export const plannerOutputSchema = z.object({
  intent: z
    .enum(["create", "edit", "schedule", "render", "find", "billing", "review_schedule", "answer"])
    .describe("create: new project with drafts. edit: change existing items. schedule: propose posting times for existing items. render: start video rendering for existing items. find: locate/open/play existing content. billing: credits, plan or upgrade. review_schedule: open the exact schedule for human approval. answer: anything else, including clarifying questions."),
  reply: z.string().describe("One to three sentences to the person, in their language. Describe what you drafted or propose. Never claim that anything was rendered, scheduled, paid for or published."),
  project: z
    .object({
      title: z.string(),
      brandName: z.string(),
      brandDescription: z.string().describe("Only what the person or the workspace context supplied. Do not invent facts."),
      audience: z.string(),
      tone: z.string(),
      language: z.string().describe("Language code of the scripts, e.g. en or el"),
      items: z.array(
        z.object({
          title: z.string(),
          script: z.string().describe("Exactly what the presenter says. About 2.5 words per second of requested duration."),
          caption: z.string(),
          avatarId: z.string().nullable().describe("An id from the authorized presenters list, or null"),
          schedule: z.array(slot),
        }),
      ),
    })
    .nullable()
    .describe("Required for intent=create, otherwise null. One to three items."),
  edits: z.array(
    z.object({
      itemId: z.string(),
      title: z.string().nullable(),
      script: z.string().nullable().describe("The complete new script, or null to leave it unchanged"),
      avatarId: z.string().nullable(),
      language: z.string().nullable(),
      captions: z.array(z.object({ platform, caption: z.string() })),
      burnedInCaptions: z.boolean().nullable(),
      schedule: z.array(slot).nullable().describe("The complete list of requested posting times for this item, or null to leave them unchanged"),
    }),
  ),
  renderItemIds: z.array(z.string()),
  find: z.object({ campaignId: z.string().nullable(), itemId: z.string().nullable(), play: z.boolean() }).nullable(),
  wantsCheckout: z.boolean().describe("True only when the person explicitly asks to upgrade, subscribe, buy credits or open checkout."),
});
export type PlannerOutput = z.infer<typeof plannerOutputSchema>;

export interface Planner {
  plan(input: { system: string; user: string }): Promise<PlannerOutput>;
}

/** Parses the model's final text as a plan. Anything that is not exactly a valid plan changes nothing. */
function readPlan(text: string): PlannerOutput {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EngineError("provider_unavailable", "The creative model returned an unreadable plan. Nothing was changed; try again.");
  }
  const parsed = plannerOutputSchema.safeParse(json);
  if (!parsed.success) throw new EngineError("provider_unavailable", "The creative model returned an invalid plan. Nothing was changed; try again.");
  return parsed.data;
}

const declined = () => new EngineError("unsupported", "The creative model declined this request. Rephrase it, or edit the script yourself in Details.");
const tooLong = () => new EngineError("provider_unavailable", "The plan was too long to finish. Ask for fewer items at once.");

const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";
/** The plan's JSON Schema in the subset Gemini accepts (`anyOf`, `["string","null"]`, `enum`, `description`). */
function geminiResponseSchema() {
  const { $schema: _dialect, ...schema } = z.toJSONSchema(plannerOutputSchema);
  return schema;
}
/** Why Gemini stopped. Anything other than these two means the content was withheld. */
const GEMINI_FINISHED = new Set(["STOP", "MAX_TOKENS"]);
interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}

/**
 * Gemini through Google's own `generateContent` API. The key travels in a header, never in the URL, and the
 * response is constrained to the same plan schema the Anthropic path uses, then validated again here.
 */
function createGeminiPlanner(config: LlmConfig, fetchImpl: typeof fetch): Planner {
  const url = `${GEMINI_API_URL}/models/${encodeURIComponent(config.model)}:generateContent`;
  const responseJsonSchema = geminiResponseSchema();
  return {
    async plan({ system, user }) {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          maxOutputTokens: 16000,
          responseMimeType: "application/json",
          responseJsonSchema,
          // Interactive planning: keep latency down.
          thinkingConfig: { thinkingLevel: "low" },
        },
      });
      let response: Response | undefined;
      // One retry on a server error, as the Anthropic client does.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey ?? "" }, body, signal: AbortSignal.timeout(90_000) });
        } catch {
          throw new EngineError("provider_unavailable", "The creative model could not be reached. Nothing was changed.");
        }
        if (response.status < 500) break;
      }
      if (!response!.ok) {
        const status = response!.status;
        const error = ((await response!.json().catch(() => null)) as { error?: { status?: string; details?: Array<{ reason?: string }> } } | null)?.error;
        const reasons = (error?.details ?? []).map((detail) => detail.reason);
        if (status === 429) throw new EngineError("quota_exceeded", "The creative model is busy. Nothing was changed; try again in a moment.", { retryAfterSeconds: 20 });
        if (status === 401 || status === 403 || reasons.includes("API_KEY_INVALID"))
          throw new EngineError("provider_unavailable", "The creative model rejected this deployment’s credentials. Nothing was changed.");
        console.error(JSON.stringify({ level: "error", event: "planner_error", provider: "gemini", status, reason: error?.status ?? null }));
        throw new EngineError("provider_unavailable", "The creative model could not prepare a plan. Nothing was changed; try again.");
      }
      const data = (await response!.json().catch(() => null)) as GeminiResponse | null;
      if (data?.promptFeedback?.blockReason) throw declined();
      const candidate = data?.candidates?.[0];
      if (candidate?.finishReason === "MAX_TOKENS") throw tooLong();
      if (candidate?.finishReason && !GEMINI_FINISHED.has(candidate.finishReason)) throw declined();
      // Thought summaries, if any, are not part of the answer.
      const text = (candidate?.content?.parts ?? []).flatMap((part) => (typeof part.text === "string" && !part.thought ? [part.text] : [])).join("");
      return readPlan(text);
    },
  };
}

export function createPlanner(config: LlmConfig, fetchImpl: typeof fetch = globalThis.fetch): Planner {
  if (config.provider === "gemini") return createGeminiPlanner(config, fetchImpl);
  const firstParty = config.provider === "anthropic";
  async function client() {
    if (firstParty) return new Anthropic({ apiKey: config.apiKey, timeout: 90_000, maxRetries: 1 });
    // The gateway exposes the same Messages API. Its credential is a gateway key or, on Vercel, the deployment's
    // short-lived OIDC token — read per request because it rotates.
    const token = config.apiKey ?? (await (await import("@vercel/functions/oidc")).getVercelOidcToken());
    return new Anthropic({ baseURL: "https://ai-gateway.vercel.sh", apiKey: null, authToken: token, timeout: 90_000, maxRetries: 1 });
  }
  return {
    async plan({ system, user }) {
      const request = {
        model: config.model,
        max_tokens: 16000,
        system,
        messages: [{ role: "user" as const, content: user }],
        // Interactive planning: keep latency down.
        output_config: { effort: "low" as const, format: zodOutputFormat(plannerOutputSchema) },
      };
      let response;
      try {
        const anthropic = await client();
        response = firstParty
          ? // A policy decline is retried server-side on a fallback model instead of failing the turn.
            await anthropic.beta.messages.create({ ...request, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })
          : await anthropic.messages.create(request);
      } catch (error) {
        if (error instanceof Anthropic.RateLimitError) throw new EngineError("quota_exceeded", "The creative model is busy. Nothing was changed; try again in a moment.", { retryAfterSeconds: 20 });
        if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError)
          throw new EngineError(
            "provider_unavailable",
            firstParty
              ? "The creative model rejected this deployment’s credentials. Nothing was changed."
              : "The AI gateway did not accept this deployment’s request (its account may need a payment method or access to this model). Nothing was changed.",
          );
        if (error instanceof Anthropic.APIError) {
          console.error(JSON.stringify({ level: "error", event: "planner_error", status: error.status ?? null }));
          throw new EngineError("provider_unavailable", "The creative model could not prepare a plan. Nothing was changed; try again.");
        }
        throw new EngineError("provider_unavailable", "The creative model could not be reached. Nothing was changed.");
      }
      if (response.stop_reason === "refusal") throw declined();
      if (response.stop_reason === "max_tokens") throw tooLong();
      return readPlan(response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""));
    },
  };
}
