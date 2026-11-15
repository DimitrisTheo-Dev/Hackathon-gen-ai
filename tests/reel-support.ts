import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { authenticate, hashToken, newAgentToken, resolveContext, type Ctx } from "../packages/engine/src/access";
import { loadConfig } from "../packages/engine/src/config";
import { EngineError } from "../packages/engine/src/errors";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { MemoryFileStore } from "../packages/engine/src/r2";
import { MemoryStore } from "../packages/engine/src/store-memory";
import { startCampaign } from "../packages/engine/src/studio";

/** Shared harness for the reel tests: real engine, in-memory store and file store, "user:<id>" sessions. */
export const WORKER_TOKEN = "r".repeat(40);
export const SCRIPT = "Your first scan is at week six. You will hear the heartbeat. Bring your questions, and bring someone you trust.";

export function engine(env: Record<string, string> = {}) {
  let clock = Date.parse("2026-11-14T10:00:00.000Z");
  const files = new MemoryFileStore();
  const deps: HttpDeps = {
    store: new MemoryStore(),
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: "https://faceful.test", REEL_WORKER_TOKEN: WORKER_TOKEN, ...env }),
    now: () => new Date(clock),
    verifyAccessToken: async (token) => {
      const [kind, id] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: null };
    },
    fetch: async () => new Response("{}", { status: 500 }),
    planner: null,
    files,
  };
  const as = async (token: string, org: string | null = null): Promise<Ctx> => resolveContext(deps, await authenticate(deps, `Bearer ${token}`), org, crypto.randomUUID());
  const call = async (path: string, token: string | null, body?: unknown) =>
    (await handleEngineRequest(
      deps,
      new Request(`https://faceful.test${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      path,
    ))!;
  const agentToken = async (ctx: Ctx, scopes: string[]) => {
    const value = newAgentToken();
    await deps.store.insert("agent_connections", { id: crypto.randomUUID(), org_id: ctx.org.id, display_name: "Claude Code on the VPS", token_sha256: hashToken(value), scopes, expires_at: "2026-12-01T00:00:00.000Z", last_seen_at: null, revoked_at: null, created_by: "u1", created_at: deps.now().toISOString() });
    return value;
  };
  return { deps, files, as, call, agentToken, advance: (minutes: number) => (clock += minutes * 60_000) };
}

export async function seed(env: ReturnType<typeof engine>, user = "user:u1") {
  const ctx = await env.as(user);
  const campaign = await startCampaign(env.deps, ctx, {
    operationKey: crypto.randomUUID(),
    title: "Pregnancy week by week",
    companyContext: { name: "Clinic", description: "A fertility clinic.", audience: "Patients", tone: "Calm", sourceText: "", sourceUrl: null, missingInformation: "" },
    items: [{ title: "Your first scan", script: SCRIPT }],
  });
  return { ctx, campaign, item: campaign.items[0] };
}

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const rejects = (promise: Promise<unknown>, code: string) => assert.rejects(promise, (error: unknown) => error instanceof EngineError && error.code === code);
export const key = () => crypto.randomUUID();
