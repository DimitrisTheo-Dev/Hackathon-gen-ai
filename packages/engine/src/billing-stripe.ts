import Stripe from "stripe";
import { audit, idempotent, requireHuman, type Ctx, type EngineDeps } from "./access.js";
import { checkoutInputSchema, checkoutResultSchema, portalResultSchema, stripeNotConfigured, type CheckoutResult, type PortalResult } from "./billing.js";
import type { StripeConfig } from "./config.js";
import { EngineError, StoreConflict } from "./errors.js";
import { selectOne, type Filter, type Row } from "./store.js";
import { parse } from "./studio.js";

/**
 * Stripe SANDBOX integration: hosted Checkout, hosted Customer Portal and signed webhooks.
 *
 * Rules this module enforces:
 *   • Sandbox only. config.ts rejects live keys; every Stripe object that reports `livemode: true`
 *     is refused here as well, so a mis-set environment cannot create or apply live billing.
 *   • The server chooses the Price from an allowlist. Clients send a price *key*, never an ID or amount.
 *   • Entitlement and credits change only inside the webhook handler, after signature verification,
 *     from Stripe's authoritative objects. A redirect back from Checkout changes nothing.
 *   • Card data never touches this service: payment happens on Stripe-hosted pages.
 */

/* ───────────────────────── gateway: the only code that talks to Stripe ───────────────────────── */

export interface GatewayCustomer {
  id: string;
  livemode: boolean;
}
export interface GatewayCheckoutSession {
  id: string;
  url: string | null;
  livemode: boolean;
}
export interface GatewaySubscription {
  id: string;
  livemode: boolean;
  customerId: string;
  /** Stripe's own status string, unmodified. */
  status: string;
  priceId: string | null;
  /** Unix seconds. On current API versions the period lives on the subscription items. */
  currentPeriodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}
export interface GatewayEvent {
  id: string;
  type: string;
  /** Unix seconds, as stamped by Stripe. */
  created: number;
  livemode: boolean;
  /** `data.object` exactly as sent. Read defensively; it is a snapshot, not the current truth. */
  object: Record<string, unknown>;
}
export interface StripeGateway {
  createCustomer(input: { orgId: string; name: string; email: string | null }, idempotencyKey: string): Promise<GatewayCustomer>;
  createCheckoutSession(
    input: { customerId: string; priceId: string; priceKey: string; orgId: string; checkoutId: string; successUrl: string; cancelUrl: string },
    idempotencyKey: string,
  ): Promise<GatewayCheckoutSession>;
  createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  /** Verifies the `Stripe-Signature` header against the raw body. Throws `StripeSignatureError` on any mismatch. */
  constructEvent(rawBody: string, signature: string, webhookSecret: string): Promise<GatewayEvent>;
  /** The subscription as Stripe holds it right now, or null when it does not exist. */
  retrieveSubscription(subscriptionId: string): Promise<GatewaySubscription | null>;
}
export class StripeSignatureError extends Error {
  constructor() {
    super("Stripe signature verification failed");
    this.name = "StripeSignatureError";
  }
}
/** The delivery is genuinely from Stripe, but not a snapshot event this handler can read (for example a thin event). */
export class StripeUnsupportedEventError extends Error {
  constructor() {
    super("Unsupported Stripe event format");
    this.name = "StripeUnsupportedEventError";
  }
}

/** Signature check with Stripe's own verifier. Needs no API key, so tests exercise the real thing. */
export async function constructStripeEvent(rawBody: string, signature: string, webhookSecret: string): Promise<GatewayEvent> {
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret);
  } catch (error) {
    // The SDK checks the signature first. Any other failure means a signed payload in a format it will not
    // parse as a snapshot event — in practice, a destination created with the "thin" payload format.
    if (error instanceof Stripe.errors.StripeSignatureVerificationError) throw new StripeSignatureError();
    throw new StripeUnsupportedEventError();
  }
  // Verified, but still read defensively: nothing below assumes a field exists.
  const loose = event as unknown as { id?: unknown; type?: unknown; created?: unknown; livemode?: unknown; data?: { object?: unknown } };
  const object = loose.data?.object;
  return {
    id: String(loose.id ?? ""),
    type: typeof loose.type === "string" ? loose.type : "unknown",
    created: typeof loose.created === "number" ? loose.created : 0,
    livemode: loose.livemode === true,
    object: object && typeof object === "object" ? (object as Record<string, unknown>) : {},
  };
}

function ref(value: unknown): string | null {
  // Stripe references are an ID string, or an expanded object carrying `id`.
  if (typeof value === "string" && value) return value;
  if (value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
  return null;
}

/** Turns SDK failures into safe studio errors. Stripe's message text can name IDs, so it is never forwarded. */
async function stripeCall<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const kind = error instanceof Stripe.errors.StripeError ? error.type : "unknown";
    console.error(JSON.stringify({ level: "error", event: "stripe_api_error", operation, kind, code: error instanceof Stripe.errors.StripeError ? (error.code ?? null) : null }));
    if (error instanceof Stripe.errors.StripeAuthenticationError || error instanceof Stripe.errors.StripePermissionError)
      throw new EngineError("provider_unavailable", "Stripe rejected this deployment’s sandbox key or it lacks a needed permission. Nothing was charged.");
    if (error instanceof Stripe.errors.StripeRateLimitError) throw new EngineError("quota_exceeded", "Stripe is rate limiting this workspace. Nothing was charged; try again shortly.", { retryAfterSeconds: 10 });
    if (error instanceof Stripe.errors.StripeInvalidRequestError)
      throw new EngineError("provider_unavailable", "Stripe did not accept this billing request. Check that the configured demo Price belongs to the same sandbox as the key. Nothing was charged.");
    throw new EngineError("provider_unavailable", "Stripe could not be reached. Nothing was charged; try again.");
  }
}

export function createStripeGateway(secretKey: string): StripeGateway {
  // The SDK's pinned API version is used on purpose, so request and response shapes match its types.
  const stripe = new Stripe(secretKey, { maxNetworkRetries: 2, timeout: 20_000, appInfo: { name: "Faceful studio", version: "0.1.0" } });
  return {
    async createCustomer(input, idempotencyKey) {
      const customer = await stripeCall("customers.create", () =>
        stripe.customers.create({ name: input.name, ...(input.email ? { email: input.email } : {}), metadata: { faceful_org_id: input.orgId } }, { idempotencyKey }),
      );
      return { id: customer.id, livemode: customer.livemode };
    },
    async createCheckoutSession(input, idempotencyKey) {
      const metadata = { faceful_org_id: input.orgId, faceful_checkout_id: input.checkoutId, faceful_price_key: input.priceKey };
      const session = await stripeCall("checkout.sessions.create", () =>
        stripe.checkout.sessions.create(
          {
            mode: "subscription",
            customer: input.customerId,
            // Plain Checkout, with this account as the seller. Accounts with Managed Payments on by default would
            // otherwise require a product tax code and change who the merchant of record is.
            managed_payments: { enabled: false },
            // No payment_method_types: Stripe selects eligible methods from the sandbox Dashboard settings.
            line_items: [{ price: input.priceId, quantity: 1 }],
            success_url: input.successUrl,
            cancel_url: input.cancelUrl,
            client_reference_id: input.orgId,
            metadata,
            subscription_data: { metadata: { faceful_org_id: input.orgId, faceful_price_key: input.priceKey } },
          },
          { idempotencyKey },
        ),
      );
      return { id: session.id, url: session.url, livemode: session.livemode };
    },
    async createPortalSession(input) {
      const session = await stripeCall("billingPortal.sessions.create", () => stripe.billingPortal.sessions.create({ customer: input.customerId, return_url: input.returnUrl }));
      return { url: session.url };
    },
    constructEvent: constructStripeEvent,
    async retrieveSubscription(subscriptionId) {
      let subscription: Stripe.Subscription;
      try {
        subscription = await stripe.subscriptions.retrieve(subscriptionId);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeInvalidRequestError && error.code === "resource_missing") return null;
        return stripeCall("subscriptions.retrieve", () => Promise.reject(error));
      }
      const items = subscription.items?.data ?? [];
      const periodEnds = items.map((item) => item.current_period_end).filter((value): value is number => typeof value === "number");
      return {
        id: subscription.id,
        livemode: subscription.livemode,
        customerId: ref(subscription.customer) ?? "",
        status: subscription.status,
        priceId: items[0]?.price?.id ?? null,
        currentPeriodEnd: periodEnds.length ? Math.max(...periodEnds) : null,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      };
    },
  };
}

let testGateway: StripeGateway | null = null;
const gateways = new Map<string, StripeGateway>();
/** Test seam only. Production always builds the gateway from the configured sandbox key. */
export function __setStripeGatewayForTests(gateway: StripeGateway | null) {
  testGateway = gateway;
}
function gatewayFor(config: StripeConfig): StripeGateway {
  if (testGateway) return testGateway;
  let gateway = gateways.get(config.secretKey);
  if (!gateway) gateways.set(config.secretKey, (gateway = createStripeGateway(config.secretKey)));
  return gateway;
}

/* ───────────────────────── shared helpers ───────────────────────── */

const LIVE_REFUSED = "Stripe returned a live-mode object. This build is sandbox only, so the request was stopped and nothing was recorded.";
/** A subscription in any of these states already exists at Stripe; a second Checkout would double-bill. */
const HAS_SUBSCRIPTION = ["trialing", "active", "past_due", "unpaid", "paused"];
const CHECKOUT_REUSE_MS = 23 * 3600_000; // Checkout Sessions expire after 24 hours by default

function returnBase(deps: EngineDeps): string {
  // Return URLs are built only from server configuration — never from request input — so they cannot become an open redirect.
  let url: URL;
  try {
    url = new URL(deps.config.appBaseUrl);
  } catch {
    throw new EngineError("provider_unavailable", "APP_BASE_URL is not set on this deployment, so Stripe cannot be given a safe return address.");
  }
  const local = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new EngineError("provider_unavailable", "APP_BASE_URL must be an https address.");
  return url.origin;
}

function log(event: string, fields: Record<string, unknown>) {
  // IDs, types and outcomes only. No payloads, emails, keys or signatures.
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}

async function upsertBillingState(deps: EngineDeps, orgId: string, patch: Row, onlyIfStatus?: string[]): Promise<boolean> {
  const now = deps.now().toISOString();
  const filter: Filter = onlyIfStatus ? { org_id: orgId, status: { in: onlyIfStatus } } : { org_id: orgId };
  if ((await deps.store.update("billing_state", filter, { ...patch, updated_at: now })).length) return true;
  if (await selectOne(deps.store, "billing_state", { org_id: orgId })) return false; // exists, but not in an allowed status
  const fresh = { org_id: orgId, status: "free", plan_key: null, stripe_subscription_id: null, stripe_price_id: null, current_period_end: null, cancel_at_period_end: false, last_event_created: 0, updated_at: now };
  if (onlyIfStatus && !onlyIfStatus.includes("free")) return false;
  try {
    await deps.store.insert("billing_state", { ...fresh, ...patch, updated_at: now });
    return true;
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
    return (await deps.store.update("billing_state", filter, { ...patch, updated_at: now })).length > 0;
  }
}

/** One Stripe Customer per billable organization, created at most once even under concurrent requests. */
async function ensureCustomer(deps: EngineDeps, ctx: Ctx, gateway: StripeGateway): Promise<string> {
  const existing = await selectOne(deps.store, "billing_customers", { org_id: ctx.org.id });
  if (existing) return existing.stripe_customer_id as string;
  const email = ctx.principal.kind === "human" ? ctx.principal.email : null;
  // The Stripe idempotency key is derived from the org, so racing requests receive the same Customer.
  const customer = await gateway.createCustomer({ orgId: ctx.org.id, name: String(ctx.org.name).slice(0, 120), email }, `faceful-customer-${ctx.org.id}`);
  if (customer.livemode) throw new EngineError("unsupported", LIVE_REFUSED);
  try {
    await deps.store.insert("billing_customers", { org_id: ctx.org.id, stripe_customer_id: customer.id, livemode: false, created_at: deps.now().toISOString() });
  } catch (error) {
    if (!(error instanceof StoreConflict)) throw error;
    const winner = await selectOne(deps.store, "billing_customers", { org_id: ctx.org.id });
    if (!winner) throw new EngineError("unknown_outcome", "The billing account could not be linked to this workspace. Nothing was charged; try again.");
    return winner.stripe_customer_id as string;
  }
  return customer.id;
}

/* ───────────────────────── hosted Checkout ───────────────────────── */

export async function createCheckout(deps: EngineDeps, ctx: Ctx, raw: unknown): Promise<CheckoutResult> {
  // Permission first: an unentitled caller learns nothing about configuration or billing state.
  if (!ctx.scopes.has("billing:manage") && !ctx.scopes.has("billing:checkout"))
    throw new EngineError("forbidden", "Only a workspace owner or admin (or an agent they granted billing:checkout) can start checkout for this workspace.");
  const stripe = deps.config.stripe;
  if (!stripe) throw stripeNotConfigured(deps);
  const input = parse(checkoutInputSchema, raw);
  // The client names a plan; the server maps it to a configured sandbox Price. IDs and amounts are never accepted.
  const priceId = Object.hasOwn(stripe.prices, input.priceKey) ? stripe.prices[input.priceKey] : null;
  if (!priceId) throw new EngineError("validation_error", "That plan is not available. Choose a plan listed in Billing.");
  const base = returnBase(deps);
  const gateway = gatewayFor(stripe);
  return idempotent(deps, ctx, "create_checkout", input.operationKey, input, async () => {
    const state = await selectOne(deps.store, "billing_state", { org_id: ctx.org.id });
    if (state && HAS_SUBSCRIPTION.includes(state.status))
      throw new EngineError("unsupported", "This workspace already has a subscription. Open “Manage billing” to change or cancel it instead of subscribing twice.", { reviewUrl: "/studio/?view=billing" });
    // An open session for the same plan is reused, so two tabs or two agents cannot create two subscriptions.
    const open = (await deps.store.select("checkout_sessions", { org_id: ctx.org.id, state: "pending", price_key: input.priceKey }, { order: ["created_at", "desc"], limit: 1 }))[0];
    if (open?.url && deps.now().getTime() - new Date(open.created_at).getTime() < CHECKOUT_REUSE_MS)
      return parse(checkoutResultSchema, { checkoutUrl: open.url, sessionId: open.stripe_session_id, status: "created" });

    const customerId = await ensureCustomer(deps, ctx, gateway);
    const checkoutId = crypto.randomUUID();
    const session = await gateway.createCheckoutSession(
      {
        customerId,
        priceId,
        priceKey: input.priceKey,
        orgId: ctx.org.id,
        checkoutId,
        successUrl: `${base}/studio/?view=billing&checkout=success`,
        cancelUrl: `${base}/studio/?view=billing&checkout=cancelled`,
      },
      `faceful-checkout-${ctx.org.id}-${input.operationKey}`,
    );
    if (session.livemode) throw new EngineError("unsupported", LIVE_REFUSED);
    if (!session.url) throw new EngineError("provider_unavailable", "Stripe created the checkout but returned no page address. Nothing was charged; try again.");
    const now = deps.now().toISOString();
    try {
      await deps.store.insert("checkout_sessions", {
        id: checkoutId,
        org_id: ctx.org.id,
        stripe_session_id: session.id,
        price_key: input.priceKey,
        state: "pending",
        url: session.url,
        created_by: ctx.actorId,
        idempotency_key: input.operationKey,
        created_at: now,
        updated_at: now,
      });
    } catch (error) {
      // The same Stripe session was already recorded by a concurrent attempt with this key.
      if (!(error instanceof StoreConflict)) throw error;
    }
    // "Pending" is a display hint only. It never grants anything and never overwrites a real subscription state.
    await upsertBillingState(deps, ctx.org.id, { status: "checkout_pending" }, ["free", "cancelled"]);
    await audit(deps, ctx, { action: "Opened Stripe sandbox checkout", objectId: checkoutId, outcome: `Plan “${input.priceKey}” · awaiting Stripe confirmation · nothing granted yet` });
    log("stripe_checkout_created", { orgId: ctx.org.id, checkoutId, sessionId: session.id, priceKey: input.priceKey, correlationId: ctx.correlationId });
    return parse(checkoutResultSchema, { checkoutUrl: session.url, sessionId: session.id, status: "created" });
  });
}

/* ───────────────────────── hosted Customer Portal ───────────────────────── */

export async function createPortal(deps: EngineDeps, ctx: Ctx, _raw: unknown): Promise<PortalResult> {
  // Managing or cancelling a subscription is a person's decision; agents can only read status or hand over a checkout link.
  requireHuman(ctx, "Managing billing");
  if (!ctx.scopes.has("billing:manage")) throw new EngineError("forbidden", "Only a workspace owner or admin can manage billing for this workspace.");
  const stripe = deps.config.stripe;
  if (!stripe) throw stripeNotConfigured(deps);
  const base = returnBase(deps);
  // The customer is looked up by the authenticated organization only; no customer ID is ever accepted from the request.
  const customer = await selectOne(deps.store, "billing_customers", { org_id: ctx.org.id });
  if (!customer) throw new EngineError("validation_error", "This workspace has no billing account yet. Start a subscription first; then you can manage it here.");
  const session = await gatewayFor(stripe).createPortalSession({ customerId: customer.stripe_customer_id, returnUrl: `${base}/studio/?view=billing` });
  await audit(deps, ctx, { action: "Opened the Stripe customer portal", objectId: ctx.org.id, outcome: "Hosted by Stripe" });
  return parse(portalResultSchema, { portalUrl: session.url });
}

/* ───────────────────────── webhooks ───────────────────────── */

/** Stripe subscription status → billing_state.status. Unknown values change nothing rather than being guessed. */
const STATUS: Record<string, string> = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "unpaid",
  paused: "paused",
  incomplete: "incomplete",
  canceled: "cancelled",
  // The first payment never succeeded and Stripe closed the attempt: the workspace never had a subscription.
  incomplete_expired: "free",
};
const LIVE_SUBSCRIPTION = ["trialing", "active", "past_due", "unpaid", "paused"];

async function orgForCustomer(deps: EngineDeps, customerId: string | null): Promise<string | null> {
  if (!customerId) return null;
  // The mapping written at checkout time is the only authority for "which workspace is this customer".
  // Metadata on Stripe objects is never trusted for tenancy.
  return ((await selectOne(deps.store, "billing_customers", { stripe_customer_id: customerId }))?.org_id as string | undefined) ?? null;
}

/**
 * Writes Stripe's CURRENT view of a subscription. Because the state is re-read from Stripe rather than
 * taken from the event snapshot, delayed, duplicated or out-of-order events all converge on the truth.
 */
interface SyncResult {
  outcome: string;
  /** Stripe's current subscription when it exists and belongs to this workspace's customer; otherwise null. */
  subscription: GatewaySubscription | null;
}
async function syncSubscription(deps: EngineDeps, config: StripeConfig, gateway: StripeGateway, orgId: string, subscriptionId: string, event: GatewayEvent): Promise<SyncResult> {
  const [current, state, customer] = await Promise.all([
    gateway.retrieveSubscription(subscriptionId),
    selectOne(deps.store, "billing_state", { org_id: orgId }),
    selectOne(deps.store, "billing_customers", { org_id: orgId }),
  ]);
  // Diagnostic high-water mark only (it never moves backwards). Correctness comes from re-reading Stripe.
  const lastEvent = Math.max(Number(state?.last_event_created ?? 0), event.created);
  if (!current) {
    // Gone at Stripe. Only a deletion event for the very subscription we track ends it. Event timestamps are
    // not used to decide this: Stripe does not guarantee delivery order, and `created` has one-second resolution.
    if (event.type !== "customer.subscription.deleted" || state?.stripe_subscription_id !== subscriptionId)
      return { outcome: "subscription_not_found", subscription: null };
    await upsertBillingState(deps, orgId, { status: "cancelled", cancel_at_period_end: false, last_event_created: lastEvent });
    return { outcome: "subscription_cancelled", subscription: null };
  }
  if (current.livemode) return { outcome: "ignored_livemode_subscription", subscription: null };
  if (!customer || current.customerId !== customer.stripe_customer_id) return { outcome: "ignored_customer_mismatch", subscription: null };
  const status = STATUS[current.status];
  if (!status) return { outcome: "ignored_unknown_status", subscription: current };
  // A dead subscription must not overwrite a different one that is still running for this workspace.
  const tracked = state?.stripe_subscription_id as string | null | undefined;
  if (tracked && tracked !== current.id && LIVE_SUBSCRIPTION.includes(String(state?.status)) && !LIVE_SUBSCRIPTION.includes(status))
    return { outcome: "ignored_superseded_subscription", subscription: current };
  if (status === "free" && tracked && tracked !== current.id) return { outcome: "ignored_superseded_subscription", subscription: current };
  const planKey = Object.entries(config.prices).find(([, priceId]) => priceId === current.priceId)?.[0] ?? null;
  const ended = status === "free";
  await upsertBillingState(deps, orgId, {
    status,
    plan_key: ended ? null : planKey,
    stripe_subscription_id: ended ? null : current.id,
    stripe_price_id: ended ? null : current.priceId,
    current_period_end: !ended && current.currentPeriodEnd ? new Date(current.currentPeriodEnd * 1000).toISOString() : null,
    cancel_at_period_end: !ended && current.cancelAtPeriodEnd,
    last_event_created: lastEvent,
  });
  return { outcome: `subscription_${status}`, subscription: current };
}

async function settleCheckout(deps: EngineDeps, sessionId: string, state: "completed" | "expired" | "failed") {
  // Only a pending record moves; a completed checkout is never downgraded by a late "expired".
  return deps.store.update("checkout_sessions", { stripe_session_id: sessionId, state: "pending" }, { state, url: null, updated_at: deps.now().toISOString() });
}

async function releasePending(deps: EngineDeps, orgId: string) {
  // Leave "checkout pending" only when no other checkout is still open for this workspace.
  const stillOpen = await deps.store.select("checkout_sessions", { org_id: orgId, state: "pending" }, { limit: 1 });
  if (!stillOpen.length) await upsertBillingState(deps, orgId, { status: "free" }, ["checkout_pending"]);
}

async function processEvent(deps: EngineDeps, config: StripeConfig, gateway: StripeGateway, event: GatewayEvent): Promise<string> {
  const object = event.object;
  const customerId = ref(object.customer);

  if (event.type.startsWith("checkout.session.")) {
    const sessionId = typeof object.id === "string" ? object.id : null;
    if (!sessionId) return "ignored_malformed";
    // Subscription mode only: this service never creates one-off payment or setup sessions.
    if (object.mode !== "subscription") return "ignored_other_mode";
    const record = await selectOne(deps.store, "checkout_sessions", { stripe_session_id: sessionId });
    const orgId = await orgForCustomer(deps, customerId);
    if (!orgId) return "ignored_unknown_customer";
    if (record && record.org_id !== orgId) return "ignored_customer_mismatch";
    const subscriptionId = ref(object.subscription);
    if (event.type === "checkout.session.expired") {
      await settleCheckout(deps, sessionId, "expired");
      await releasePending(deps, orgId);
      return "checkout_expired";
    }
    if (event.type === "checkout.session.async_payment_failed") {
      await settleCheckout(deps, sessionId, "failed");
      if (subscriptionId) await syncSubscription(deps, config, gateway, orgId, subscriptionId, event);
      await releasePending(deps, orgId);
      return "checkout_payment_failed";
    }
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      // "completed" with a delayed payment method is not paid yet; the async events report the real outcome.
      const settled = object.payment_status === "paid" || object.payment_status === "no_payment_required";
      if (settled) await settleCheckout(deps, sessionId, "completed");
      // Access is derived from the subscription itself, re-read from Stripe — not from this redirect-adjacent event.
      const outcome = subscriptionId ? (await syncSubscription(deps, config, gateway, orgId, subscriptionId, event)).outcome : "no_subscription";
      return `checkout_${settled ? "completed" : "awaiting_payment"}:${outcome}`;
    }
    return "ignored_event_type";
  }

  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    const invoiceId = typeof object.id === "string" ? object.id : null;
    if (!invoiceId) return "ignored_malformed";
    const orgId = await orgForCustomer(deps, customerId);
    if (!orgId) return "ignored_unknown_customer";
    const parent = object.parent as { subscription_details?: { subscription?: unknown } | null } | null | undefined;
    // Older API versions put the subscription directly on the invoice.
    const subscriptionId = ref(parent?.subscription_details?.subscription) ?? ref(object.subscription);
    if (!subscriptionId) return "ignored_not_a_subscription_invoice";
    const { outcome, subscription } = await syncSubscription(deps, config, gateway, orgId, subscriptionId, event);
    if (event.type === "invoice.payment_failed") return `invoice_payment_failed:${outcome}`;
    // Credits are granted for a paid subscription period only — not for proration or manual invoices.
    const reason = typeof object.billing_reason === "string" ? object.billing_reason : null;
    if (reason && !["subscription_create", "subscription_cycle"].includes(reason)) return `invoice_paid_no_grant:${outcome}`;
    // No grant unless Stripe confirms the subscription exists and belongs to this workspace's customer.
    if (!subscription) return `invoice_paid_no_grant:${outcome}`;
    const planKey = Object.entries(config.prices).find(([, priceId]) => priceId === subscription?.priceId)?.[0] ?? null;
    const credits = planKey ? config.creditsPerPeriod[planKey] : undefined;
    if (!planKey || !credits) return `invoice_paid_no_grant_unknown_price:${outcome}`;
    try {
      // One ledger row per Stripe invoice. The unique (org, ref) key makes the grant exactly-once across
      // replays of this event AND across different events that describe the same invoice.
      await deps.store.insert("credit_ledger", { id: crypto.randomUUID(), org_id: orgId, delta: credits, reason: "subscription_grant", ref: `invoice:${invoiceId}`, created_at: deps.now().toISOString() });
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
      return `invoice_paid_already_granted:${outcome}`;
    }
    await deps.store.insert("audit_events", {
      id: crypto.randomUUID(),
      org_id: orgId,
      project_id: null,
      actor: "Stripe (sandbox)",
      actor_kind: "system",
      action: "Subscription period paid",
      object_id: invoiceId,
      revision: null,
      outcome: `${credits} render credits added · plan “${planKey}”`,
      correlation_id: event.id,
      at: deps.now().toISOString(),
    });
    return `invoice_paid_granted_${credits}:${outcome}`;
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const subscriptionId = typeof object.id === "string" ? object.id : null;
    if (!subscriptionId) return "ignored_malformed";
    const orgId = await orgForCustomer(deps, customerId);
    if (!orgId) return "ignored_unknown_customer";
    return (await syncSubscription(deps, config, gateway, orgId, subscriptionId, event)).outcome;
  }
  return "ignored_event_type";
}

/** `rawBody` must be the exact bytes Stripe signed. Returns the HTTP status and JSON body to send. */
export async function handleStripeWebhook(deps: EngineDeps, rawBody: string, signature: string | null): Promise<{ status: number; body: Record<string, unknown> }> {
  const config = deps.config.stripe;
  if (!config) return { status: 503, body: { error: "stripe_not_configured" } };
  if (!signature) return { status: 400, body: { error: "missing_signature" } };
  const gateway = gatewayFor(config);
  let event: GatewayEvent;
  try {
    event = await gateway.constructEvent(rawBody, signature, config.webhookSecret);
  } catch (error) {
    if (error instanceof StripeUnsupportedEventError) {
      // A failed delivery is visible in Workbench, which is how the operator learns the destination is misconfigured.
      log("stripe_webhook", { outcome: "rejected_unsupported_format" });
      return { status: 400, body: { error: "unsupported_event_format" } };
    }
    // Unsigned, re-serialised, replayed-too-late or wrong-secret payloads all end here, unprocessed.
    log("stripe_webhook", { outcome: "rejected_invalid_signature" });
    return { status: 400, body: { error: "invalid_signature" } };
  }
  if (event.livemode) {
    log("stripe_webhook", { eventId: event.id, type: event.type, outcome: "rejected_livemode" });
    return { status: 400, body: { error: "livemode_rejected" } };
  }
  if (!event.id) return { status: 400, body: { error: "malformed_event" } };
  // Deduplicate on Stripe's event ID. A finished event is acknowledged and skipped.
  const seen = await selectOne(deps.store, "stripe_events", { event_id: event.id });
  if (seen?.processed_at) return { status: 200, body: { received: true, duplicate: true } };
  if (!seen) {
    try {
      await deps.store.insert("stripe_events", { event_id: event.id, type: event.type, created: event.created, outcome: "received", received_at: deps.now().toISOString(), processed_at: null });
    } catch (error) {
      if (!(error instanceof StoreConflict)) throw error;
      // A concurrent delivery got here first. If it already finished, we are done; otherwise carry on —
      // every write below is itself idempotent, so two workers on one event cannot double-apply it.
      if ((await selectOne(deps.store, "stripe_events", { event_id: event.id }))?.processed_at) return { status: 200, body: { received: true, duplicate: true } };
    }
  }
  try {
    const outcome = await processEvent(deps, config, gateway, event);
    await deps.store.update("stripe_events", { event_id: event.id }, { outcome: outcome.slice(0, 200), processed_at: deps.now().toISOString() });
    log("stripe_webhook", { eventId: event.id, type: event.type, outcome });
    return { status: 200, body: { received: true, outcome } };
  } catch (error) {
    // Not marked processed, so Stripe's automatic retry runs the (idempotent) handler again.
    await deps.store.update("stripe_events", { event_id: event.id }, { outcome: "error" }).catch(() => undefined);
    console.error(JSON.stringify({ level: "error", event: "stripe_webhook", eventId: event.id, type: event.type, outcome: "error", name: error instanceof Error ? error.name : "unknown" }));
    return { status: 500, body: { error: "processing_failed" } };
  }
}
