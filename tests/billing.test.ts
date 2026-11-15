import { test } from "node:test";
import assert from "node:assert/strict";
import Stripe from "stripe";
import { authenticate, hashToken, resolveContext, type Ctx, type EngineDeps, type Scope } from "../packages/engine/src/access";
import { getBillingStatus } from "../packages/engine/src/billing";
import {
  __setStripeGatewayForTests,
  constructStripeEvent,
  createCheckout,
  createPortal,
  handleStripeWebhook,
  type GatewaySubscription,
  type StripeGateway,
} from "../packages/engine/src/billing-stripe";
import { loadConfig } from "../packages/engine/src/config";
import { handleEngineRequest, type HttpDeps } from "../packages/engine/src/http";
import { EngineError } from "../packages/engine/src/errors";
import { MemoryStore } from "../packages/engine/src/store-memory";

/**
 * Server-side billing logic only. Stripe's network API is replaced by a fake gateway; webhook
 * signatures are produced and verified with Stripe's real signing code. No Stripe account is contacted,
 * so these tests prove our handling — not a live Checkout. See STRIPE_SANDBOX_SETUP.md for the manual run.
 */
const WEBHOOK_SECRET = "whsec_unit_test_only";
const PRICE = "price_unit_demo";
const sandboxEnv = {
  SUPABASE_URL: "https://project.supabase.test",
  APP_BASE_URL: "https://studio.example.test",
  STRIPE_SECRET_KEY: "sk_test_unit_only",
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_ID_DEMO: PRICE,
  STRIPE_DEMO_PLAN_CREDITS: "30",
};
const USERS: Record<string, { sub: string; email: string }> = {
  alice: { sub: "11111111-1111-4111-8111-111111111111", email: "alice@example.test" },
  bob: { sub: "22222222-2222-4222-8222-222222222222", email: "bob@example.test" },
};

function fakeGateway() {
  const calls = { customers: 0, sessions: 0, portals: 0, retrieves: 0 };
  const byKey = new Map<string, unknown>();
  const subscriptions = new Map<string, GatewaySubscription>();
  const options = { livemodeSession: false, failRetrieve: false };
  const once = <T>(key: string, make: () => T): T => {
    // Mirrors Stripe: the same idempotency key returns the first result instead of creating again.
    if (!byKey.has(key)) byKey.set(key, make());
    return byKey.get(key) as T;
  };
  const gateway: StripeGateway = {
    createCustomer: async (_input, key) => once(`customer:${key}`, () => ({ id: `cus_unit_${++calls.customers}`, livemode: false })),
    createCheckoutSession: async (_input, key) =>
      once(`session:${key}`, () => {
        const id = `cs_test_unit_${++calls.sessions}`;
        return { id, url: `https://checkout.stripe.com/c/pay/${id}`, livemode: options.livemodeSession };
      }),
    createPortalSession: async () => ({ url: `https://billing.stripe.com/p/session/unit_${++calls.portals}` }),
    constructEvent: constructStripeEvent,
    retrieveSubscription: async (id) => {
      calls.retrieves++;
      if (options.failRetrieve) throw new EngineError("provider_unavailable", "Stripe could not be reached.");
      return subscriptions.get(id) ?? null;
    },
  };
  return { gateway, calls, subscriptions, options };
}

function setup(env: Record<string, string> = sandboxEnv) {
  const store = new MemoryStore();
  const clock = { now: new Date("2026-11-14T18:00:00.000Z") };
  const deps: EngineDeps = {
    store,
    config: loadConfig(env),
    now: () => new Date(clock.now),
    verifyAccessToken: async (token) => {
      const user = USERS[token];
      if (!user) throw new Error("invalid token");
      return { ...user, clientId: null };
    },
    fetch: async () => {
      throw new Error("no network in unit tests");
    },
  };
  const fake = fakeGateway();
  __setStripeGatewayForTests(fake.gateway);
  const ctxFor = async (user: string, orgId: string | null = null): Promise<Ctx> => resolveContext(deps, await authenticate(deps, `Bearer ${user}`), orgId, "test-correlation");
  const balance = async (orgId: string) => (await store.select("credit_ledger", { org_id: orgId })).reduce((sum, row) => sum + row.delta, 0);
  const state = async (orgId: string) => (await store.select("billing_state", { org_id: orgId }))[0];
  return { deps, store, clock, ctxFor, balance, state, ...fake };
}

let eventCounter = 0;
function signedEvent(type: string, object: Record<string, unknown>, extra: { id?: string; created?: number; livemode?: boolean; secret?: string } = {}) {
  const payload = JSON.stringify({
    id: extra.id ?? `evt_unit_${++eventCounter}`,
    object: "event",
    type,
    created: extra.created ?? Math.floor(Date.now() / 1000),
    livemode: extra.livemode ?? false,
    data: { object },
  });
  return { payload, signature: Stripe.webhooks.generateTestHeaderString({ payload, secret: extra.secret ?? WEBHOOK_SECRET }) };
}
const checkoutInput = (operationKey = crypto.randomUUID(), priceKey = "demo") => ({ priceKey, confirmationGranted: true as const, operationKey });
const rejects = (promise: Promise<unknown>, code: string, message?: RegExp) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${error}`);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    return true;
  });
const subscription = (id: string, customerId: string, status: string, overrides: Partial<GatewaySubscription> = {}): GatewaySubscription => ({
  id,
  livemode: false,
  customerId,
  status,
  priceId: PRICE,
  currentPeriodEnd: 1_800_000_000,
  cancelAtPeriodEnd: false,
  ...overrides,
});

/** Runs checkout for alice and returns everything needed to deliver events for her customer. */
async function subscribed(t: ReturnType<typeof setup>) {
  const ctx = await t.ctxFor("alice");
  const checkout = await createCheckout(t.deps, ctx, checkoutInput());
  const customerId = (await t.store.select("billing_customers", { org_id: ctx.org.id }))[0].stripe_customer_id as string;
  return { ctx, checkout, customerId, orgId: ctx.org.id as string };
}
const deliver = (t: ReturnType<typeof setup>, type: string, object: Record<string, unknown>, extra: Parameters<typeof signedEvent>[2] = {}) => {
  const { payload, signature } = signedEvent(type, object, extra);
  return handleStripeWebhook(t.deps, payload, signature);
};

test("sandbox config: live keys, live mode and malformed values are refused", () => {
  assert.ok(loadConfig(sandboxEnv).stripe);
  for (const key of ["sk_live_anything", "rk_live_anything", "pk_test_wrong_kind", ""]) {
    const config = loadConfig({ ...sandboxEnv, STRIPE_SECRET_KEY: key });
    assert.equal(config.stripe, null, `key ${key || "(empty)"} must not enable billing`);
    assert.ok(config.stripeProblem);
  }
  assert.ok(loadConfig({ ...sandboxEnv, STRIPE_SECRET_KEY: "rk_test_restricted" }).stripe, "restricted sandbox keys are accepted");
  assert.equal(loadConfig({ ...sandboxEnv, STRIPE_MODE: "live" }).stripe, null);
  assert.equal(loadConfig({ ...sandboxEnv, STRIPE_WEBHOOK_SECRET: "not-a-signing-secret" }).stripe, null);
  assert.equal(loadConfig({ ...sandboxEnv, STRIPE_PRICE_ID_DEMO: "prod_not_a_price" }).stripe, null);
  // The problem text is shown to owners, so it must never echo a key.
  assert.ok(!loadConfig({ ...sandboxEnv, STRIPE_SECRET_KEY: "sk_live_anything" }).stripeProblem!.includes("sk_live_anything"));
});

test("not configured: free features keep working and billing reports STRIPE_NOT_CONFIGURED", async () => {
  const t = setup({ SUPABASE_URL: sandboxEnv.SUPABASE_URL, APP_BASE_URL: sandboxEnv.APP_BASE_URL });
  const ctx = await t.ctxFor("alice");
  const status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.mode, "not_configured");
  assert.equal(status.status, "free");
  assert.equal(status.creditBalance, 3, "starter credits are still usable");
  assert.equal(status.canCheckout, false);
  await rejects(createCheckout(t.deps, ctx, checkoutInput()), "unsupported", /^STRIPE_NOT_CONFIGURED/);
  await rejects(createPortal(t.deps, ctx, {}), "unsupported", /^STRIPE_NOT_CONFIGURED/);
  const { payload, signature } = signedEvent("invoice.paid", { id: "in_x" });
  assert.deepEqual(await handleStripeWebhook(t.deps, payload, signature), { status: 503, body: { error: "stripe_not_configured" } });
  assert.equal(t.calls.customers + t.calls.sessions, 0);
});

test("checkout: one customer per workspace, hosted URL, safe return URLs, nothing granted by the redirect", async () => {
  const t = setup();
  const seen: Array<Record<string, string>> = [];
  const inner = t.gateway.createCheckoutSession;
  t.gateway.createCheckoutSession = async (input, key) => {
    seen.push(input);
    return inner(input, key);
  };
  const ctx = await t.ctxFor("alice");
  const first = await createCheckout(t.deps, ctx, checkoutInput());
  assert.equal(first.status, "created");
  assert.match(first.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  // The server picks the configured Price and builds same-origin return URLs itself.
  assert.equal(seen[0].priceId, PRICE);
  assert.equal(seen[0].successUrl, "https://studio.example.test/studio/?view=billing&checkout=success");
  assert.equal(seen[0].cancelUrl, "https://studio.example.test/studio/?view=billing&checkout=cancelled");
  assert.equal(seen[0].orgId, ctx.org.id);
  const customers = await t.store.select("billing_customers", { org_id: ctx.org.id });
  assert.equal(customers.length, 1);
  assert.equal(customers[0].livemode, false);

  // Returning from Checkout is not payment: no webhook has arrived, so nothing is entitled or credited.
  const status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.status, "checkout_pending");
  assert.equal(status.planKey, null);
  assert.equal(status.creditBalance, 3);

  // A second request while the first session is open reuses it: two tabs cannot create two subscriptions.
  const again = await createCheckout(t.deps, ctx, checkoutInput());
  assert.equal(again.sessionId, first.sessionId);
  assert.equal(t.calls.sessions, 1);

  // After that session expires, a new one is created for the SAME customer.
  assert.equal((await deliver(t, "checkout.session.expired", { id: first.sessionId, mode: "subscription", customer: customers[0].stripe_customer_id })).status, 200);
  assert.equal((await t.state(ctx.org.id)).status, "free");
  const later = await createCheckout(t.deps, ctx, checkoutInput());
  assert.notEqual(later.sessionId, first.sessionId);
  assert.equal(t.calls.customers, 1, "the Stripe customer is created once and reused");
  assert.equal((await t.store.select("billing_customers", {})).length, 1);
});

test("checkout: same operation key replays; a different request on that key is an idempotency conflict", async () => {
  const t = setup();
  // A second allowlisted plan, so a genuinely different valid request can reuse the key.
  t.deps.config.stripe!.prices.pro = "price_unit_pro";
  t.deps.config.stripe!.creditsPerPeriod.pro = 100;
  const ctx = await t.ctxFor("alice");
  const key = crypto.randomUUID();
  const first = await createCheckout(t.deps, ctx, checkoutInput(key));
  assert.deepEqual(await createCheckout(t.deps, ctx, checkoutInput(key)), first);
  assert.equal(t.calls.sessions, 1);
  assert.equal((await t.store.select("checkout_sessions", { org_id: ctx.org.id })).length, 1);
  await rejects(createCheckout(t.deps, ctx, checkoutInput(key, "pro")), "idempotency_conflict");
  assert.equal(t.calls.sessions, 1);
});

test("checkout: without a configured https APP_BASE_URL no session is created", async () => {
  for (const base of ["", "http://studio.example.test", "not a url"]) {
    const t = setup({ ...sandboxEnv, APP_BASE_URL: base });
    await rejects(createCheckout(t.deps, await t.ctxFor("alice"), checkoutInput()), "provider_unavailable", /APP_BASE_URL/);
    assert.equal(t.calls.customers + t.calls.sessions, 0);
  }
});

test("checkout: only allowlisted price keys; client price IDs, amounts and missing confirmation are refused", async () => {
  const t = setup();
  const ctx = await t.ctxFor("alice");
  for (const priceKey of [PRICE, "enterprise", "__proto__", "constructor"]) await rejects(createCheckout(t.deps, ctx, checkoutInput(crypto.randomUUID(), priceKey)), "validation_error");
  await rejects(createCheckout(t.deps, ctx, { ...checkoutInput(), amount: 1 }), "validation_error");
  await rejects(createCheckout(t.deps, ctx, { ...checkoutInput(), priceId: "price_attacker" }), "validation_error");
  await rejects(createCheckout(t.deps, ctx, { ...checkoutInput(), confirmationGranted: false }), "validation_error");
  await rejects(createCheckout(t.deps, ctx, { ...checkoutInput(), successUrl: "https://evil.example" }), "validation_error");
  assert.equal(t.calls.customers + t.calls.sessions, 0, "no Stripe call was made for any rejected request");
});

test("checkout: a live-mode object from Stripe is refused and never recorded", async () => {
  const t = setup();
  t.options.livemodeSession = true;
  const ctx = await t.ctxFor("alice");
  await rejects(createCheckout(t.deps, ctx, checkoutInput()), "unsupported", /sandbox only/);
  assert.equal((await t.store.select("checkout_sessions", {})).length, 0);
  assert.equal((await t.state(ctx.org.id)).status, "free");
});

test("permissions: editors, reviewers, outsiders and under-scoped agents cannot start checkout or open the portal", async () => {
  const t = setup();
  const alice = await t.ctxFor("alice");
  await t.ctxFor("bob"); // provisions bob's own workspace
  // Bob is not a member of Alice's workspace: it does not exist for him.
  await rejects(t.ctxFor("bob", alice.org.id), "not_found");
  for (const role of ["editor", "reviewer"]) {
    await t.store.remove("memberships", { org_id: alice.org.id, user_id: USERS.bob.sub });
    await t.store.insert("memberships", { org_id: alice.org.id, user_id: USERS.bob.sub, role, created_at: new Date().toISOString() });
    const member = await t.ctxFor("bob", alice.org.id);
    assert.equal(member.role, role);
    await rejects(createCheckout(t.deps, member, checkoutInput()), "forbidden");
    await rejects(createPortal(t.deps, member, {}), "forbidden");
    assert.equal((await getBillingStatus(t.deps, member)).canCheckout, false);
  }
  // Agent token without billing:checkout — denied; with it — may only create a hosted link, never the portal.
  const agent = async (scopes: Scope[]) => {
    const token = `fct_${crypto.randomUUID()}${crypto.randomUUID()}`;
    await t.store.insert("agent_connections", { id: crypto.randomUUID(), org_id: alice.org.id, display_name: "Test agent", token_sha256: hashToken(token), scopes, expires_at: "2027-01-01T00:00:00.000Z", last_seen_at: null, revoked_at: null, created_by: USERS.alice.sub, created_at: new Date().toISOString() });
    return resolveContext(t.deps, await authenticate(t.deps, `Bearer ${token}`), null, "test-correlation");
  };
  await rejects(createCheckout(t.deps, await agent(["campaign:read", "billing:read"]), checkoutInput()), "forbidden");
  assert.equal(t.calls.customers + t.calls.sessions, 0);
  const allowed = await agent(["campaign:read", "billing:checkout"]);
  const link = await createCheckout(t.deps, allowed, checkoutInput());
  assert.match(link.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  await rejects(createPortal(t.deps, allowed, {}), "approval_required");
  // A token cannot be pointed at another workspace.
  const bob = await t.ctxFor("bob");
  assert.notEqual(bob.org.id, alice.org.id);
  assert.equal((await t.store.select("billing_customers", { org_id: bob.org.id })).length, 0);
});

test("tenancy: each workspace gets its own customer; one workspace's events never touch another", async () => {
  const t = setup();
  const alice = await subscribed(t);
  const bob = await t.ctxFor("bob");
  await createCheckout(t.deps, bob, checkoutInput());
  const bobCustomer = (await t.store.select("billing_customers", { org_id: bob.org.id }))[0].stripe_customer_id;
  assert.notEqual(bobCustomer, alice.customerId);
  // Bob's portal opens Bob's customer only.
  const portalCustomers: string[] = [];
  t.gateway.createPortalSession = async (input) => {
    portalCustomers.push(input.customerId);
    return { url: "https://billing.stripe.com/p/session/unit" };
  };
  await createPortal(t.deps, bob, { customerId: alice.customerId });
  assert.deepEqual(portalCustomers, [bobCustomer]);
  // A paid invoice for Alice's customer credits Alice alone.
  t.subscriptions.set("sub_alice", subscription("sub_alice", alice.customerId, "active"));
  const result = await deliver(t, "invoice.paid", { id: "in_alice_1", customer: alice.customerId, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_alice" } } });
  assert.equal(result.status, 200);
  assert.equal(await t.balance(alice.orgId), 33);
  assert.equal(await t.balance(bob.org.id), 3);
  assert.equal((await t.state(bob.org.id)).status, "checkout_pending");
  // An event claiming Alice's subscription for Bob's customer is ignored: the customer mapping decides tenancy, not the payload.
  const forged = await deliver(t, "customer.subscription.updated", { id: "sub_alice", customer: bobCustomer, metadata: { faceful_org_id: bob.org.id } });
  assert.match(String(forged.body.outcome), /customer_mismatch/);
  assert.equal((await t.state(bob.org.id)).status, "checkout_pending");
});

test("portal: needs an existing billing account and returns only a Stripe-hosted URL", async () => {
  const t = setup();
  const ctx = await t.ctxFor("alice");
  await rejects(createPortal(t.deps, ctx, {}), "validation_error", /no billing account/);
  await createCheckout(t.deps, ctx, checkoutInput());
  const seen: string[] = [];
  const inner = t.gateway.createPortalSession;
  t.gateway.createPortalSession = async (input) => {
    seen.push(input.returnUrl);
    return inner(input);
  };
  const portal = await createPortal(t.deps, ctx, { returnUrl: "https://evil.example" });
  assert.match(portal.portalUrl, /^https:\/\/billing\.stripe\.com\//);
  assert.deepEqual(seen, ["https://studio.example.test/studio/?view=billing"]);
});

test("webhook: missing, wrong-secret, tampered and live-mode deliveries are rejected before any processing", async () => {
  const t = setup();
  const { customerId, orgId } = await subscribed(t);
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active"));
  const invoice = { id: "in_1", customer: customerId, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_1" } } };
  const good = signedEvent("invoice.paid", invoice);
  assert.deepEqual(await handleStripeWebhook(t.deps, good.payload, null), { status: 400, body: { error: "missing_signature" } });
  assert.equal((await handleStripeWebhook(t.deps, good.payload, "t=1,v1=deadbeef")).status, 400);
  const wrongSecret = signedEvent("invoice.paid", invoice, { secret: "whsec_someone_else" });
  assert.deepEqual(await handleStripeWebhook(t.deps, wrongSecret.payload, wrongSecret.signature), { status: 400, body: { error: "invalid_signature" } });
  // The signature covers the exact bytes: a re-serialised or edited body fails.
  assert.equal((await handleStripeWebhook(t.deps, good.payload.replace("in_1", "in_2"), good.signature)).status, 400);
  assert.equal((await handleStripeWebhook(t.deps, JSON.stringify(JSON.parse(good.payload), null, 2), good.signature)).status, 400);
  // A stale signature (outside Stripe's tolerance window) is a replay.
  const old = JSON.stringify({ id: "evt_old", object: "event", type: "invoice.paid", created: 1, livemode: false, data: { object: invoice } });
  const stale = Stripe.webhooks.generateTestHeaderString({ payload: old, secret: WEBHOOK_SECRET, timestamp: Math.floor(Date.now() / 1000) - 3600 });
  assert.equal((await handleStripeWebhook(t.deps, old, stale)).status, 400);
  // Correctly signed but live mode: refused in this sandbox-only build.
  const live = signedEvent("invoice.paid", invoice, { livemode: true });
  assert.deepEqual(await handleStripeWebhook(t.deps, live.payload, live.signature), { status: 400, body: { error: "livemode_rejected" } });
  assert.equal(await t.balance(orgId), 3, "no rejected delivery granted anything");
  assert.equal((await t.store.select("stripe_events", {})).length, 0, "rejected deliveries are not recorded as events");
  assert.equal(t.calls.retrieves, 0);
});

test("webhook over HTTP: the bounded read keeps the exact bytes, and a body over 1 MB is refused before it is buffered", async () => {
  const t = setup();
  const http: HttpDeps = { ...t.deps, planner: null };
  const post = (body: BodyInit, signature: string) =>
    handleEngineRequest(http, new Request("https://faceful.test/v1/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature }, body, duplex: "half" } as RequestInit), "/v1/stripe/webhook") as Promise<Response>;
  // Multi-byte text survives the bounded read byte for byte, so the signature over it still verifies.
  const event = signedEvent("invoice.paid", { id: "in_stranger", customer: "cus_not_ours", description: "Συνδρομή — ελληνικά ✓", parent: { subscription_details: { subscription: "sub_x" } } });
  const genuine = await post(event.payload, event.signature);
  assert.deepEqual([genuine.status, await genuine.json()], [200, { received: true, outcome: "ignored_unknown_customer" }]);
  // Larger than the 256 KB studio limit but within Stripe's bound: read and judged on its signature.
  assert.equal((await post(" ".repeat(300 * 1024), "t=1,v1=bad")).status, 400);
  assert.equal((await post("x".repeat(1024 * 1024 + 1), "t=1,v1=bad")).status, 413);
  // Without a Content-Length (chunked), reading stops at the limit instead of buffering the whole body.
  const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < 64) controller.enqueue(chunk);
      else controller.close();
    },
  });
  assert.equal((await post(stream, "t=1,v1=bad")).status, 413);
  assert.ok(sent < 64, "reading stopped at the limit");
  assert.equal((await t.store.select("stripe_events", {})).length, 1, "only the genuine delivery was recorded");
});

test("webhook: entitlement arrives from Stripe even if the user never returns; credits are granted exactly once", async () => {
  const t = setup();
  const { checkout, customerId, orgId, ctx } = await subscribed(t);
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active", { currentPeriodEnd: 1_800_000_000 }));
  // The browser tab is closed here. Only Stripe's server-to-server events follow.
  const completed = await deliver(t, "checkout.session.completed", { id: checkout.sessionId, mode: "subscription", customer: customerId, subscription: "sub_1", payment_status: "paid" });
  assert.equal(completed.status, 200);
  let status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.status, "active");
  assert.equal(status.planKey, "demo");
  assert.equal(status.currentPeriodEnd, new Date(1_800_000_000 * 1000).toISOString());
  assert.equal(status.creditBalance, 3, "completing checkout alone grants no credits; the paid invoice does");
  assert.equal((await t.store.select("checkout_sessions", { stripe_session_id: checkout.sessionId }))[0].state, "completed");

  const invoice = { id: "in_first", customer: customerId, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_1" } } };
  const paid = signedEvent("invoice.paid", invoice, { id: "evt_paid_1" });
  const first = await handleStripeWebhook(t.deps, paid.payload, paid.signature);
  assert.match(String(first.body.outcome), /^invoice_paid_granted_30/);
  assert.equal(await t.balance(orgId), 33);

  // Replay of the very same event (Stripe retry, or an attacker replaying a captured delivery).
  assert.deepEqual(await handleStripeWebhook(t.deps, paid.payload, paid.signature), { status: 200, body: { received: true, duplicate: true } });
  // A DIFFERENT event describing the same invoice (e.g. a second endpoint, or invoice.paid re-sent with a new id).
  const second = await deliver(t, "invoice.paid", invoice, { id: "evt_paid_2" });
  assert.match(String(second.body.outcome), /^invoice_paid_already_granted/);
  assert.equal(await t.balance(orgId), 33, "one grant per invoice, whatever the number of events");
  assert.equal((await t.store.select("credit_ledger", { org_id: orgId, reason: "subscription_grant" })).length, 1);

  // The next billing period is a new invoice and a new grant; a proration invoice is not.
  await deliver(t, "invoice.paid", { ...invoice, id: "in_second", billing_reason: "subscription_cycle" });
  assert.equal(await t.balance(orgId), 63);
  await deliver(t, "invoice.paid", { ...invoice, id: "in_proration", billing_reason: "subscription_update" });
  assert.equal(await t.balance(orgId), 63);
  status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.rendersRemaining, 63);
  // A subscribed workspace is sent to the portal instead of being allowed to subscribe twice.
  await rejects(createCheckout(t.deps, ctx, checkoutInput()), "unsupported", /already has a subscription/);
});

test("webhook: an invoice for an unknown customer or a non-allowlisted price grants nothing", async () => {
  const t = setup();
  const { customerId, orgId } = await subscribed(t);
  const unknown = await deliver(t, "invoice.paid", { id: "in_stranger", customer: "cus_not_ours", parent: { subscription_details: { subscription: "sub_x" } } });
  assert.deepEqual(unknown, { status: 200, body: { received: true, outcome: "ignored_unknown_customer" } });
  t.subscriptions.set("sub_other", subscription("sub_other", customerId, "active", { priceId: "price_something_else" }));
  const other = await deliver(t, "invoice.paid", { id: "in_other", customer: customerId, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_other" } } });
  assert.match(String(other.body.outcome), /no_grant_unknown_price/);
  // The subscription does not exist at Stripe at all.
  const ghost = await deliver(t, "invoice.paid", { id: "in_ghost", customer: customerId, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_ghost" } } });
  assert.match(String(ghost.body.outcome), /no_grant/);
  assert.equal(await t.balance(orgId), 3);
});

test("webhook: out-of-order and delayed subscription events converge on Stripe's current state", async () => {
  const t = setup();
  const { customerId, orgId } = await subscribed(t);
  const now = Math.floor(Date.now() / 1000);
  // Stripe's truth is "active". The newer event is delivered first…
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active"));
  await deliver(t, "customer.subscription.updated", { id: "sub_1", customer: customerId, status: "active" }, { created: now });
  assert.equal((await t.state(orgId)).status, "active");
  // …then an OLDER event whose snapshot still says "incomplete" arrives late. The snapshot is not trusted.
  const late = await deliver(t, "customer.subscription.created", { id: "sub_1", customer: customerId, status: "incomplete" }, { created: now - 120 });
  assert.equal(late.status, 200);
  const state = await t.state(orgId);
  assert.equal(state.status, "active");
  assert.equal(state.last_event_created, now, "the high-water mark never moves backwards");
  // A failed renewal: Stripe now says past_due, and that is what is recorded.
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "past_due"));
  await deliver(t, "invoice.payment_failed", { id: "in_failed", customer: customerId, parent: { subscription_details: { subscription: "sub_1" } } }, { created: now + 10 });
  assert.equal((await t.state(orgId)).status, "past_due");
  assert.equal(await t.balance(orgId), 3, "a failed payment grants nothing");
  // An unknown future Stripe status changes nothing rather than being guessed.
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "some_new_status"));
  const unknown = await deliver(t, "customer.subscription.updated", { id: "sub_1", customer: customerId }, { created: now + 20 });
  assert.equal(unknown.body.outcome, "ignored_unknown_status");
  assert.equal((await t.state(orgId)).status, "past_due");
});

test("webhook: portal changes and cancellation are reflected; a stale deletion cannot end a newer subscription", async () => {
  const t = setup();
  const { customerId, orgId, ctx } = await subscribed(t);
  const now = Math.floor(Date.now() / 1000);
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active"));
  await deliver(t, "customer.subscription.created", { id: "sub_1", customer: customerId }, { created: now });
  // Customer chooses "cancel at period end" in the portal.
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active", { cancelAtPeriodEnd: true }));
  await deliver(t, "customer.subscription.updated", { id: "sub_1", customer: customerId }, { created: now + 5 });
  let status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.status, "active");
  assert.equal(status.cancelAtPeriodEnd, true);
  // The period ends and Stripe deletes the subscription.
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "canceled"));
  await deliver(t, "customer.subscription.deleted", { id: "sub_1", customer: customerId }, { created: now + 10 });
  status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.status, "cancelled");
  assert.equal(status.cancelAtPeriodEnd, false);
  // They subscribe again; a late deletion event for the OLD subscription must not cancel the new one.
  await createCheckout(t.deps, ctx, checkoutInput());
  t.subscriptions.set("sub_2", subscription("sub_2", customerId, "active"));
  await deliver(t, "customer.subscription.created", { id: "sub_2", customer: customerId }, { created: now + 20 });
  assert.equal((await t.state(orgId)).stripe_subscription_id, "sub_2");
  const stale = await deliver(t, "customer.subscription.deleted", { id: "sub_1", customer: customerId }, { created: now + 11 });
  assert.equal(stale.body.outcome, "ignored_superseded_subscription");
  assert.equal((await t.state(orgId)).status, "active");
  // A subscription Stripe no longer knows: only its own deletion event may end the tracked one.
  t.subscriptions.delete("sub_2");
  await deliver(t, "customer.subscription.updated", { id: "sub_2", customer: customerId }, { created: now + 30 });
  assert.equal((await t.state(orgId)).status, "active");
  await deliver(t, "customer.subscription.deleted", { id: "sub_2", customer: customerId }, { created: now + 31 });
  assert.equal((await t.state(orgId)).status, "cancelled");
});

test("webhook: a portal cancellation recorded as cancel_at (newer API versions) is shown as ending, with the real end date", async () => {
  const t = setup();
  const { customerId, orgId, ctx } = await subscribed(t);
  const now = Math.floor(Date.now() / 1000);
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active"));
  await deliver(t, "customer.subscription.created", { id: "sub_1", customer: customerId }, { created: now });
  assert.equal((await getBillingStatus(t.deps, ctx)).cancelAtPeriodEnd, false);
  // What production returned after a Customer Portal cancellation on API 2026-10-28.endive: the legacy flag is false,
  // and `cancel_at` holds the period end (2026-12-14T...Z).
  const cancelAt = 1_797_269_994;
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active", { cancelAtPeriodEnd: false, cancelAt, currentPeriodEnd: cancelAt }));
  const updated = await deliver(t, "customer.subscription.updated", { id: "sub_1", customer: customerId, cancel_at_period_end: false, cancel_at: cancelAt }, { created: now + 5 });
  assert.equal(updated.body.outcome, "subscription_active", "still active until Stripe actually ends it");
  let status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.status, "active");
  assert.equal(status.cancelAtPeriodEnd, true, "a scheduled cancel_at counts as cancelling");
  assert.equal(status.currentPeriodEnd, new Date(cancelAt * 1000).toISOString());
  // A cancellation scheduled for a date other than the period end: the plan ends at cancel_at, not the period end.
  const earlier = cancelAt - 7 * 24 * 3600;
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active", { cancelAt: earlier, currentPeriodEnd: cancelAt }));
  await deliver(t, "customer.subscription.updated", { id: "sub_1", customer: customerId }, { created: now + 6 });
  assert.equal((await getBillingStatus(t.deps, ctx)).currentPeriodEnd, new Date(earlier * 1000).toISOString());
  // The person resumes the plan in the portal: Stripe clears cancel_at, and so do we.
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active", { cancelAt: null, currentPeriodEnd: cancelAt }));
  await deliver(t, "customer.subscription.updated", { id: "sub_1", customer: customerId }, { created: now + 10 });
  status = await getBillingStatus(t.deps, ctx);
  assert.equal(status.cancelAtPeriodEnd, false);
  assert.equal(status.currentPeriodEnd, new Date(cancelAt * 1000).toISOString());
  assert.equal((await t.state(orgId)).status, "active");
});

test("webhook: delayed-payment checkout stays pending until Stripe confirms, and a failed one returns to free", async () => {
  const t = setup();
  const { checkout, customerId, orgId } = await subscribed(t);
  t.subscriptions.set("sub_async", subscription("sub_async", customerId, "incomplete"));
  const waiting = await deliver(t, "checkout.session.completed", { id: checkout.sessionId, mode: "subscription", customer: customerId, subscription: "sub_async", payment_status: "unpaid" });
  assert.match(String(waiting.body.outcome), /^checkout_awaiting_payment/);
  assert.equal((await t.state(orgId)).status, "incomplete");
  assert.equal((await t.store.select("checkout_sessions", { stripe_session_id: checkout.sessionId }))[0].state, "pending");
  t.subscriptions.set("sub_async", subscription("sub_async", customerId, "incomplete_expired"));
  await deliver(t, "checkout.session.async_payment_failed", { id: checkout.sessionId, mode: "subscription", customer: customerId, subscription: "sub_async", payment_status: "unpaid" });
  const state = await t.state(orgId);
  assert.equal(state.status, "free");
  assert.equal(state.stripe_subscription_id, null);
  assert.equal((await t.store.select("checkout_sessions", { stripe_session_id: checkout.sessionId }))[0].state, "failed");
  assert.equal(await t.balance(orgId), 3);
});

test("webhook: unrelated events are acknowledged and ignored; thin-format and malformed deliveries are refused clearly", async () => {
  const t = setup();
  const { orgId } = await subscribed(t);
  const other = await deliver(t, "payment_intent.succeeded", { id: "pi_1", customer: "cus_whoever" });
  assert.deepEqual(other, { status: 200, body: { received: true, outcome: "ignored_event_type" } });
  // A destination created with the "thin" payload format: genuinely signed, but not a snapshot event.
  const thin = JSON.stringify({ id: "evt_thin_1", object: "v2.core.event", type: "v1.billing.meter.no_meter_found", created: "2026-11-14T18:00:00.000Z", livemode: false });
  const sign = (payload: string) => Stripe.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  assert.deepEqual(await handleStripeWebhook(t.deps, thin, sign(thin)), { status: 400, body: { error: "unsupported_event_format" } });
  // The signature is still checked first: an unsigned thin payload is just an invalid signature.
  assert.deepEqual(await handleStripeWebhook(t.deps, thin, "t=1,v1=deadbeef"), { status: 400, body: { error: "invalid_signature" } });
  const noId = JSON.stringify({ object: "event", type: "invoice.paid", created: 1, livemode: false, data: { object: {} } });
  assert.deepEqual(await handleStripeWebhook(t.deps, noId, sign(noId)), { status: 400, body: { error: "malformed_event" } });
  assert.equal(await t.balance(orgId), 3);
  assert.equal((await t.state(orgId)).status, "checkout_pending");
  assert.equal((await t.store.select("stripe_events", {})).length, 1, "only the well-formed event was recorded");
});

test("webhook: a processing failure returns 500 and Stripe's retry completes without double-applying", async () => {
  const t = setup();
  const { customerId, orgId } = await subscribed(t);
  t.subscriptions.set("sub_1", subscription("sub_1", customerId, "active"));
  const paid = signedEvent("invoice.paid", { id: "in_retry", customer: customerId, billing_reason: "subscription_create", parent: { subscription_details: { subscription: "sub_1" } } }, { id: "evt_retry" });
  t.options.failRetrieve = true; // Stripe's API is unreachable while handling the event
  assert.deepEqual(await handleStripeWebhook(t.deps, paid.payload, paid.signature), { status: 500, body: { error: "processing_failed" } });
  assert.equal(await t.balance(orgId), 3);
  assert.equal((await t.store.select("stripe_events", { event_id: "evt_retry" }))[0].processed_at, null, "left unprocessed so the retry is not treated as a duplicate");
  t.options.failRetrieve = false;
  const retry = await handleStripeWebhook(t.deps, paid.payload, paid.signature);
  assert.equal(retry.status, 200);
  assert.equal(await t.balance(orgId), 33);
  assert.equal((await handleStripeWebhook(t.deps, paid.payload, paid.signature)).body.duplicate, true);
  assert.equal(await t.balance(orgId), 33);
});

test.after(() => __setStripeGatewayForTests(null));
