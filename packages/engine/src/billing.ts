import { z } from "zod";
import { requireScope, type Ctx, type EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";
import { selectOne } from "./store.js";
import { creditBalance, parse } from "./studio.js";

/**
 * Billing boundary. Entitlement and credits are derived only from verified Stripe events and the
 * append-only credit ledger — never from a redirect, a success page or a client-supplied flag.
 * Sandbox only: live keys and live-mode objects are rejected (see config.ts and STRIPE_SANDBOX_SETUP.md).
 */
export const billingStatusSchema = z.object({
  organizationId: z.string(),
  /** "sandbox": Stripe test mode is configured. "not_configured": keys are missing; free features keep working. */
  mode: z.enum(["sandbox", "not_configured"]),
  configurationProblem: z.string().nullable(),
  status: z.enum(["not_configured", "free", "checkout_pending", "trialing", "active", "past_due", "cancelled", "incomplete", "unpaid", "paused"]),
  planKey: z.string().nullable(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  creditBalance: z.number().int(),
  renderCreditCost: z.number().int().positive(),
  rendersRemaining: z.number().int().nonnegative(),
  plans: z.array(z.object({ key: z.string(), creditsPerPeriod: z.number().int().positive() })),
  canManage: z.boolean(),
  canCheckout: z.boolean(),
  hasCustomer: z.boolean(),
});
export type BillingStatus = z.infer<typeof billingStatusSchema>;
export const checkoutInputSchema = z.object({ priceKey: z.string().min(1).max(40), confirmationGranted: z.literal(true), operationKey: z.uuid() }).strict();
export const checkoutResultSchema = z.object({ checkoutUrl: z.url({ protocol: /^https$/ }), sessionId: z.string(), status: z.literal("created") });
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;
export const portalResultSchema = z.object({ portalUrl: z.url({ protocol: /^https$/ }) });
export type PortalResult = z.infer<typeof portalResultSchema>;

export function stripeNotConfigured(deps: EngineDeps): EngineError {
  return new EngineError("unsupported", `STRIPE_NOT_CONFIGURED: ${deps.config.stripeProblem ?? "Stripe sandbox is not configured."} Drafting and your existing credits are unaffected.`);
}

export async function getBillingStatus(deps: EngineDeps, ctx: Ctx): Promise<BillingStatus> {
  requireScope(ctx, "billing:read");
  const [state, customer, balance] = await Promise.all([
    selectOne(deps.store, "billing_state", { org_id: ctx.org.id }),
    selectOne(deps.store, "billing_customers", { org_id: ctx.org.id }),
    creditBalance(deps, ctx.org.id),
  ]);
  const configured = deps.config.stripe !== null;
  return parse(billingStatusSchema, {
    organizationId: ctx.org.id,
    mode: configured ? "sandbox" : "not_configured",
    configurationProblem: configured ? null : deps.config.stripeProblem,
    status: state?.status ?? "free",
    planKey: state?.plan_key ?? null,
    currentPeriodEnd: state?.current_period_end ? new Date(state.current_period_end).toISOString() : null,
    cancelAtPeriodEnd: state?.cancel_at_period_end ?? false,
    creditBalance: balance,
    renderCreditCost: deps.config.renderCreditCost,
    rendersRemaining: Math.max(0, Math.floor(balance / deps.config.renderCreditCost)),
    plans: configured ? Object.entries(deps.config.stripe!.creditsPerPeriod).map(([key, creditsPerPeriod]) => ({ key, creditsPerPeriod })) : [],
    canManage: configured && ctx.scopes.has("billing:manage"),
    canCheckout: configured && (ctx.scopes.has("billing:manage") || ctx.scopes.has("billing:checkout")),
    hasCustomer: Boolean(customer),
  });
}

/* The three functions below are implemented in billing-stripe.ts and re-exported here. */
export { createCheckout, createPortal, handleStripeWebhook } from "./billing-stripe.js";
