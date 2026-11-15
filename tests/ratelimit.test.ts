import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate, hashToken, newAgentToken, resolveContext, type Ctx, type Scope } from "../packages/engine/src/access";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { handleMcpRequest } from "../packages/engine/src/mcp";
import { clientNetwork, normalizeNetwork } from "../packages/engine/src/ratelimit";
import { signSocialWebhook } from "../packages/engine/src/socials-events";
import { MemoryStore } from "../packages/engine/src/store-memory";
import type { RateLimitHit } from "../packages/engine/src/store";

/**
 * Rate limiting through the real HTTP and MCP handlers over the in-memory store, whose fixed-window counter mirrors
 * engine_rate_limit_hit (scripts/test-engine-rls.mjs checks the SQL function itself). Tokens "user:<id>" stand in
 * for verified Supabase sessions. The clock starts 30 s into a window, so every window here has 30 s left.
 */
const BASE = "https://faceful.test";
const WORKER = "w".repeat(40);
const AVATARS = JSON.stringify([{ id: "minas_kontis", name: "Minas", languages: ["en", "el"] }]);

function engine(env: Record<string, string> = {}, store: MemoryStore = new MemoryStore()) {
  let clock = Date.parse("2026-11-14T10:00:30.000Z");
  store.clock = () => new Date(clock);
  const deps: HttpDeps = {
    store,
    config: loadConfig({ SUPABASE_URL: "https://project.supabase.co", APP_BASE_URL: BASE, ...env }),
    now: () => new Date(clock),
    verifyAccessToken: async (token) => {
      const [kind, id, client] = token.split(":");
      if (kind !== "user" || !id) throw new Error("invalid");
      return { sub: id, email: `${id}@example.com`, clientId: client ?? null };
    },
    fetch: async () => new Response("{}", { status: 500 }),
    planner: null,
  };
  const call = (path: string, init: RequestInit = {}) => handleEngineRequest(deps, new Request(`${BASE}${path}`, init), path) as Promise<Response>;
  const as = async (token: string): Promise<Ctx> => resolveContext(deps, await authenticate(deps, `Bearer ${token}`), null, crypto.randomUUID());
  const agentToken = async (owner: Ctx, scopes: Scope[] = ["campaign:read"]) => {
    const token = newAgentToken();
    await deps.store.insert("agent_connections", { id: crypto.randomUUID(), org_id: owner.org.id, display_name: "Agent", token_sha256: hashToken(token), scopes, expires_at: "2026-12-14T10:00:00.000Z", last_seen_at: null, revoked_at: null, created_by: (owner.principal as { userId: string }).userId, created_at: deps.now().toISOString() });
    return token;
  };
  return { deps, store, call, as, agentToken, advance: (seconds: number) => (clock += seconds * 1000) };
}
const bearer = (token: string, extra: Record<string, string> = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...extra } });
const post = (token: string, body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra }, body: JSON.stringify(body) });
const from = (ip: string, headers: Record<string, string> = {}) => ({ headers: { "x-forwarded-for": ip, ...headers } });
async function errorOf(response: Response) {
  return ((await response.json()) as { error: { code: string; message: string; retryAfterSeconds: number | null } }).error;
}

test("every authenticated studio request counts per principal; over the limit is 429 with the error contract and headers", async () => {
  const { call } = engine({ RATE_LIMIT_PRINCIPAL_PER_MINUTE: "3" });
  const first = await call("/v1/studio/context", bearer("user:u1"));
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("ratelimit-policy"), '"principal";q=3;w=60');
  assert.equal(first.headers.get("ratelimit"), '"principal";r=2;t=30');
  assert.equal((await call("/v1/studio/campaigns", bearer("user:u1"))).status, 200);
  assert.equal((await call("/v1/studio/billing", bearer("user:u1"))).status, 200);
  const limited = await call("/v1/studio/context", bearer("user:u1"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.equal(limited.headers.get("ratelimit"), '"principal";r=0;t=30');
  assert.ok(limited.headers.get("x-correlation-id"));
  assert.equal(limited.headers.get("cache-control"), "private, no-store");
  const error = await errorOf(limited);
  assert.equal(error.code, "quota_exceeded");
  assert.equal(error.retryAfterSeconds, 30);
  assert.match(error.message, /Try again in 30 seconds/);
});

test("principal buckets are isolated between people, workspace tokens and organizations, and reset with the window", async () => {
  const { call, as, agentToken, advance } = engine({ RATE_LIMIT_PRINCIPAL_PER_MINUTE: "2" });
  const alice = await as("user:alice");
  const bob = await as("user:bob");
  assert.notEqual(alice.org.id, bob.org.id);
  const aliceAgent = await agentToken(alice);
  const bobAgent = await agentToken(bob);
  for (let i = 0; i < 2; i++) assert.equal((await call("/v1/studio/context", bearer("user:alice"))).status, 200);
  assert.equal((await call("/v1/studio/context", bearer("user:alice"))).status, 429, "alice is over her limit");
  assert.equal((await call("/v1/studio/context", bearer("user:bob"))).status, 200, "another person in another organization is unaffected");
  assert.equal((await call("/v1/studio/context", bearer(aliceAgent))).status, 200, "a token alice created has its own bucket");
  assert.equal((await call("/v1/studio/context", bearer(aliceAgent))).status, 200);
  assert.equal((await call("/v1/studio/context", bearer(aliceAgent))).status, 429, "the token is limited on its own");
  assert.equal((await call("/v1/studio/context", bearer(bobAgent))).status, 200, "a token in another organization is unaffected");
  // The same user acting through an OAuth agent client is a separate principal from their studio session.
  assert.equal((await call("/v1/studio/context", bearer("user:alice:claude-code"))).status, 200);
  advance(30);
  assert.equal((await call("/v1/studio/context", bearer("user:alice"))).status, 200, "a new window starts the count again");
});

test("director turns and money-spending operations have stricter buckets on top of the principal bucket", async () => {
  const { call } = engine({ RATE_LIMIT_DIRECTOR_PER_MINUTE: "2", RATE_LIMIT_COSTLY_PER_MINUTE: "2" });
  const turn = () => post("user:u1", { campaignId: null, itemId: null, scope: "project", instruction: "How many credits do I have?", sourceIds: [], history: [], operationKey: crypto.randomUUID() });
  assert.equal((await call("/v1/studio/director/turn", turn())).status, 200);
  const second = await call("/v1/studio/director/turn", turn());
  assert.equal(second.status, 200);
  assert.equal(second.headers.get("ratelimit-policy"), '"principal";q=240;w=60, "director";q=2;w=60');
  assert.equal(second.headers.get("ratelimit"), '"principal";r=238;t=30, "director";r=0;t=30');
  const third = await call("/v1/studio/director/turn", turn());
  assert.equal(third.status, 429);
  assert.match((await errorOf(third)).message, /Creative Director/);
  // render_content, create_checkout and connect_channel share one costly bucket, counted before the body is read.
  assert.equal((await call("/v1/studio/operations/render_content", post("user:u1", {}))).status, 400);
  assert.equal((await call("/v1/studio/operations/create_checkout", post("user:u1", {}))).status, 422, "Stripe is not configured here");
  const costly = await call("/v1/studio/operations/connect_channel", post("user:u1", {}));
  assert.equal(costly.status, 429);
  assert.match(costly.headers.get("ratelimit-policy") ?? "", /"costly";q=2;w=60/);
  // Drafting is not a costly operation.
  const draft = await call("/v1/studio/operations/start_campaign", post("user:u1", { operationKey: crypto.randomUUID(), title: "Launch", companyContext: { name: "BeWell", description: "An app.", audience: "", tone: "", sourceText: "", sourceUrl: null, missingInformation: "" }, items: [{ title: "Hi", script: "Hello." }] }));
  assert.equal(draft.status, 200);
  assert.doesNotMatch(draft.headers.get("ratelimit-policy") ?? "", /costly/);
});

test("requests without a credential are limited per client network, only when the network is known", async () => {
  const { call } = engine({ TRUST_PROXY_HEADERS: "true", RATE_LIMIT_ANONYMOUS_PER_MINUTE: "2" });
  assert.equal((await call("/v1/studio/context", from("203.0.113.7"))).status, 401);
  const second = await call("/v1/studio/context", from("203.0.113.7"));
  assert.equal(second.status, 401);
  assert.equal(second.headers.get("ratelimit-policy"), '"anonymous";q=2;w=60');
  const third = await call("/v1/studio/context", from("203.0.113.7"));
  assert.equal(third.status, 429);
  assert.equal(third.headers.get("retry-after"), "30");
  assert.equal((await errorOf(third)).code, "quota_exceeded");
  assert.equal((await call("/v1/studio/context", from("203.0.113.8"))).status, 401, "another network has its own bucket");
  // Only the left-most x-forwarded-for entry (the client, as Vercel's edge writes it) selects the bucket.
  assert.equal((await call("/v1/studio/context", from("198.51.100.1, 203.0.113.7"))).status, 401);
  // IPv6 clients are grouped by /64, so rotating addresses inside one allocation does not escape the limit.
  assert.equal((await call("/v1/studio/context", from("2001:db8:1:2::1"))).status, 401);
  assert.equal((await call("/v1/studio/context", from("2001:db8:1:2:ffff::9"))).status, 401);
  assert.equal((await call("/v1/studio/context", from("2001:db8:1:2:abcd::5"))).status, 429);
  assert.equal((await call("/v1/studio/context", from("2001:db8:1:3::1"))).status, 401);

  // Without a trusted proxy the client address is unknown: per-network limits are skipped, never shared by everyone.
  const local = engine({ RATE_LIMIT_ANONYMOUS_PER_MINUTE: "1" });
  for (let i = 0; i < 5; i++) {
    const response = await local.call("/v1/studio/context", from("203.0.113.7"));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("ratelimit"), null);
  }
});

test("refused credentials are limited per network, while a valid credential from the same network keeps working", async () => {
  const { call } = engine({ ...{ RENDER_WORKER_TOKEN: WORKER }, TRUST_PROXY_HEADERS: "true", RATE_LIMIT_FAILED_AUTH_PER_MINUTE: "2" });
  const ip = "192.0.2.5";
  assert.equal((await call("/v1/studio/context", bearer("garbage", { "x-forwarded-for": ip }))).status, 401);
  assert.equal((await call("/v1/studio/context", bearer("fct_not-a-real-token", { "x-forwarded-for": ip }))).status, 401);
  const limited = await call("/v1/studio/context", bearer("garbage", { "x-forwarded-for": ip }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("ratelimit-policy"), '"failed_auth";q=2;w=60');
  assert.equal((await call("/v1/worker/render/claim", { method: "POST", headers: { Authorization: "Bearer wrong", "x-forwarded-for": ip }, body: "{}" })).status, 429, "a wrong worker token counts too");
  const valid = await call("/v1/studio/context", bearer("user:u1", { "x-forwarded-for": ip }));
  assert.equal(valid.status, 200, "people behind the same address are never locked out by someone else's failures");
});

test("the Stripe webhook, an authorized scheduler tick and the render worker are exempt; a wrong scheduler secret is not", async () => {
  const env = { TRUST_PROXY_HEADERS: "true", CRON_SECRET: "cron-secret-value", RENDER_WORKER_TOKEN: WORKER, RENDER_AVATARS: AVATARS, RATE_LIMIT_FAILED_AUTH_PER_MINUTE: "1", RATE_LIMIT_ANONYMOUS_PER_MINUTE: "1", RATE_LIMIT_PRINCIPAL_PER_MINUTE: "1" };
  const { call } = engine({ ...env, STRIPE_SECRET_KEY: "sk_test_unit_only", STRIPE_WEBHOOK_SECRET: "whsec_unit_only", STRIPE_PRICE_ID_DEMO: "price_unit" });
  const ip = { "x-forwarded-for": "203.0.113.50" };
  for (let i = 0; i < 4; i++) {
    const webhook = await call("/v1/stripe/webhook", { method: "POST", headers: { ...ip, "stripe-signature": "t=1,v1=bad" }, body: "{}" });
    assert.equal(webhook.status, 400, "an unsigned delivery is refused by signature, never by a rate limit");
    assert.equal(webhook.headers.get("ratelimit"), null);
    const tick = await call("/v1/cron/tick", { headers: { ...ip, Authorization: "Bearer cron-secret-value" } });
    assert.equal(tick.status, 200);
    assert.equal(tick.headers.get("ratelimit"), null);
    const claim = await call("/v1/worker/render/claim", { method: "POST", headers: { ...ip, Authorization: `Bearer ${WORKER}` }, body: JSON.stringify({ workerId: "w1" }) });
    assert.equal(claim.status, 200);
    assert.equal((await call("/v1/health", { headers: ip })).status, 200);
  }
  assert.equal((await call("/v1/cron/tick", { headers: { ...ip, Authorization: "Bearer wrong" } })).status, 401);
  assert.equal((await call("/v1/cron/tick", { headers: { ...ip, Authorization: "Bearer wrong" } })).status, 429);
});

test("social deliveries: a signed one is never limited, a refused signature counts as a failed credential; sign-in returns are anonymous; member routes count like the studio's", async () => {
  const secret = "s".repeat(40);
  const { call, deps } = engine({ TRUST_PROXY_HEADERS: "true", SOCIALS_CREDENTIAL_KEY: "ab".repeat(32), SOCIALS_WEBHOOK_SECRET: secret, RATE_LIMIT_FAILED_AUTH_PER_MINUTE: "1", RATE_LIMIT_ANONYMOUS_PER_MINUTE: "1", RATE_LIMIT_COSTLY_PER_MINUTE: "1" });
  const ip = { "x-forwarded-for": "203.0.113.60" };
  const raw = JSON.stringify({ events: [{ id: "c1", type: "comment.created", externalAccountId: "an-account-nobody-connected" }] });
  for (let i = 0; i < 3; i++) {
    const delivered = await call("/v1/socials/instagram/webhook", { method: "POST", headers: { ...ip, "x-faceful-signature": signSocialWebhook(secret, raw, deps.now()) }, body: raw });
    assert.equal(delivered.status, 200);
    assert.equal(delivered.headers.get("ratelimit"), null);
  }
  const forged = { method: "POST", headers: { ...ip, "x-faceful-signature": "t=1,v1=00" }, body: raw };
  assert.equal((await call("/v1/socials/instagram/webhook", forged)).status, 401);
  const refused = await call("/v1/socials/instagram/webhook", forged);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("ratelimit-policy"), '"failed_auth";q=1;w=60');
  // The check a platform makes when the address is registered carries no credential.
  const other = { headers: { "x-forwarded-for": "203.0.113.61" } };
  assert.equal((await call("/v1/socials/instagram/webhook", other)).status, 404);
  assert.equal((await call("/v1/socials/instagram/webhook", other)).status, 429);
  // Neither does a browser sent back by a platform after signing in there.
  const returning = { headers: { "x-forwarded-for": "203.0.113.62" } };
  assert.equal((await call("/v1/socials/providers/instagram/callback", returning)).status, 404, "not switched on here");
  assert.equal((await call("/v1/socials/providers/instagram/callback", returning)).status, 429);
  // Members count per principal, and connecting a provider (which calls it) also against the costly bucket.
  const connect = () => call("/v1/socials/providers/buffer/connect", post("user:u1", { apiKey: "a-buffer-key-for-tests" }));
  const first = await connect();
  assert.equal(first.status, 503, "the stand-in provider is unreachable");
  assert.match(first.headers.get("ratelimit-policy") ?? "", /"principal";q=240;w=60, "costly";q=1;w=60/);
  assert.equal((await connect()).status, 429);
  assert.equal((await call("/v1/socials/providers/instagram/complete", post("user:u1", { code: "a-code", state: "a-state" }))).status, 429, "finishing a sign-in shares the bucket");
  assert.equal((await call("/v1/socials", bearer("user:u1"))).status, 200, "reading is not a costly request");
});

class UnavailableLimiterStore extends MemoryStore {
  override async consumeRateLimit(): Promise<RateLimitHit> {
    throw new Error("rate limiter unavailable (PGRST202)");
  }
}

test("a broken limiter fails open with a structured log; the failed-auth bucket falls back to a local counter", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (line: unknown) => void logged.push(String(line));
  try {
    const { call } = engine({ TRUST_PROXY_HEADERS: "true", RATE_LIMIT_PRINCIPAL_PER_MINUTE: "1", RATE_LIMIT_DIRECTOR_PER_MINUTE: "1", RATE_LIMIT_FAILED_AUTH_PER_MINUTE: "2" }, new UnavailableLimiterStore());
    for (let i = 0; i < 4; i++) {
      const response = await call("/v1/studio/context", bearer("user:u1", { "x-forwarded-for": "203.0.113.90" }));
      assert.equal(response.status, 200, "the product keeps working while the limiter is down");
      assert.equal(response.headers.get("ratelimit"), null, "no header claims a limit that is not being enforced");
    }
    const open = logged.map((line) => JSON.parse(line)).find((entry) => entry.event === "rate_limit_unavailable" && entry.policy === "principal");
    assert.deepEqual([open?.level, open?.mode], ["error", "fail_open"]);
    assert.equal(logged.filter((line) => line.includes('"policy":"principal"')).length, 1, "the outage is logged once, not on every request");
    assert.equal((await call("/v1/studio/context", bearer("garbage", { "x-forwarded-for": "203.0.113.91" }))).status, 401);
    assert.equal((await call("/v1/studio/context", bearer("garbage", { "x-forwarded-for": "203.0.113.91" }))).status, 401);
    const fallback = await call("/v1/studio/context", bearer("garbage", { "x-forwarded-for": "203.0.113.91" }));
    assert.equal(fallback.status, 429, "refused credentials stay throttled per instance");
    assert.ok(logged.some((line) => line.includes('"policy":"failed_auth"') && line.includes('"mode":"local_fallback"')));
  } finally {
    console.error = original;
  }
});

test("RATE_LIMIT_ENABLED=false turns every bucket off", async () => {
  const { call } = engine({ RATE_LIMIT_ENABLED: "false", RATE_LIMIT_PRINCIPAL_PER_MINUTE: "1", TRUST_PROXY_HEADERS: "true", RATE_LIMIT_ANONYMOUS_PER_MINUTE: "1" });
  for (let i = 0; i < 3; i++) {
    assert.equal((await call("/v1/studio/context", bearer("user:u1"))).status, 200);
    assert.equal((await call("/v1/studio/context", from("203.0.113.7"))).status, 401);
  }
});

/* ───────────────────────── MCP ───────────────────────── */

function mcp(deps: HttpDeps, token: string | null, body: unknown, extra: Record<string, string> = {}) {
  return handleMcpRequest(
    deps,
    new Request(`${BASE}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    "/mcp",
  ) as Promise<Response>;
}
const rpc = (id: number, method: string, params: unknown = {}) => ({ jsonrpc: "2.0", id, method, params });

test("MCP: every JSON-RPC message counts against the principal bucket; over the limit is HTTP 429 with Retry-After", async () => {
  const { deps } = engine({ RATE_LIMIT_PRINCIPAL_PER_MINUTE: "3" });
  const batch = await mcp(deps, "user:u1", [rpc(1, "tools/list"), rpc(2, "tools/list")]);
  assert.equal(batch.status, 200);
  assert.equal(batch.headers.get("ratelimit"), '"principal";r=1;t=30', "a batch of two counts as two");
  assert.match(batch.headers.get("access-control-expose-headers") ?? "", /RateLimit, RateLimit-Policy/);
  assert.equal((await mcp(deps, "user:u1", rpc(3, "tools/list"))).status, 200);
  const limited = await mcp(deps, "user:u1", rpc(4, "tools/list"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "30");
  assert.equal(limited.headers.get("access-control-allow-origin"), "*");
  const body = (await limited.json()) as { error: { code: number; message: string; data: { code: string; retryAfterSeconds: number } } };
  assert.deepEqual(body.error.data, { code: "quota_exceeded", retryAfterSeconds: 30 });
  assert.equal((await mcp(deps, "user:u2", rpc(5, "tools/list"))).status, 200, "another principal is unaffected");
});

test("MCP: start_render and create_checkout_link share the costly bucket and report quota_exceeded as a tool error", async () => {
  const { deps } = engine({ RATE_LIMIT_COSTLY_PER_MINUTE: "1", RENDER_WORKER_TOKEN: WORKER, RENDER_AVATARS: AVATARS });
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await mcp(deps, "user:u1", rpc(1, "tools/call", { name, arguments: args }));
    assert.equal(response.status, 200);
    const result = ((await response.json()) as { result: { isError?: boolean; structuredContent: Record<string, any> } }).result;
    return { response, isError: result.isError === true, data: result.structuredContent };
  };
  const first = await call("start_render", { projectId: "missing", items: [{ itemId: "missing", expectedRevision: 1 }] });
  assert.equal(first.data.code, "not_found", "the first request is counted, then refused by the domain");
  const second = await call("create_checkout_link", { confirmationGranted: true });
  assert.equal(second.isError, true);
  assert.equal(second.data.code, "quota_exceeded");
  assert.equal(second.data.retryAfterSeconds, 30);
  assert.match(second.response.headers.get("ratelimit-policy") ?? "", /"costly";q=1;w=60/);
  const listed = await call("list_projects", {});
  assert.equal(listed.isError, false, "reads are not costly");
});

test("MCP: unauthenticated discovery is limited per network; oversized bodies and large batches are refused", async () => {
  const { deps } = engine({ TRUST_PROXY_HEADERS: "true", RATE_LIMIT_ANONYMOUS_PER_MINUTE: "1" });
  const ip = { "x-forwarded-for": "203.0.113.70" };
  const challenge = await mcp(deps, null, rpc(1, "initialize"), ip);
  assert.equal(challenge.status, 401);
  assert.match(challenge.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  const limited = await mcp(deps, null, rpc(1, "initialize"), ip);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get("retry-after"));
  const huge = await mcp(deps, "user:u1", JSON.stringify(rpc(1, "tools/list", { padding: "x".repeat(300 * 1024) })));
  assert.equal(huge.status, 413);
  const batch = await mcp(deps, "user:u1", Array.from({ length: 11 }, (_, i) => rpc(i, "tools/list")));
  assert.equal(batch.status, 400);
  const broken = await mcp(deps, "user:u1", "{not json");
  assert.equal(broken.status, 400);
  assert.equal(((await broken.json()) as { error: { code: number } }).error.code, -32700);
});

/* ───────────────────────── client network ───────────────────────── */

test("client network: trusted only behind the proxy, left-most forwarded entry, IPv4-mapped and IPv6 /64 normalised", () => {
  const headers = (values: Record<string, string>) => new Headers(values);
  assert.equal(clientNetwork(headers({ "x-forwarded-for": "203.0.113.7" }), false), null);
  assert.equal(clientNetwork(headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" }), true), "203.0.113.7");
  assert.equal(clientNetwork(headers({ "x-real-ip": "198.51.100.4" }), true), "198.51.100.4");
  assert.equal(clientNetwork(headers({ "x-forwarded-for": "not-an-ip" }), true), null);
  assert.equal(clientNetwork(headers({}), true), null);
  assert.equal(normalizeNetwork("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(normalizeNetwork("203.0.113.9:443"), "203.0.113.9");
  assert.equal(normalizeNetwork("[2001:db8::1]:443"), "2001:db8:0:0::/64");
  assert.equal(normalizeNetwork("2001:DB8:0:0:1:2:3:4"), "2001:db8:0:0::/64");
  assert.equal(normalizeNetwork("fe80::1%eth0"), "fe80:0:0:0::/64");
  assert.equal(normalizeNetwork("::1"), "0:0:0:0::/64");
  assert.equal(normalizeNetwork("999.1.1.1"), null);
});

test("memory store counter: atomic per key and window, prunes expired buckets, validates arguments like the SQL function", async () => {
  const store = new MemoryStore();
  let now = Date.parse("2026-11-14T10:00:00.000Z");
  store.clock = () => new Date(now);
  const hits = await Promise.all(Array.from({ length: 10 }, () => store.consumeRateLimit("principal:user:a", 4, 60)));
  assert.equal(hits.filter((hit) => hit.allowed).length, 4, "exactly the limit is admitted under concurrency");
  assert.equal((await store.consumeRateLimit("principal:user:b", 4, 60)).remaining, 3, "keys are independent");
  assert.equal((await store.consumeRateLimit("principal:user:c", 10, 60, 7)).remaining, 3, "a cost counts several requests at once");
  now += 5 * 60_000;
  await store.consumeRateLimit("principal:user:z", 4, 60);
  assert.equal(store.rateLimitBuckets.size, 1, "expired windows are removed by later calls");
  await assert.rejects(store.consumeRateLimit("", 1, 60));
  await assert.rejects(store.consumeRateLimit("k", 0, 60));
  await assert.rejects(store.consumeRateLimit("k", 1, 0));
  await assert.rejects(store.consumeRateLimit("k", 1, 60, 0));
});
