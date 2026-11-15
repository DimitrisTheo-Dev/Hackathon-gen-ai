import { z } from "zod";
import type { EngineDeps } from "./access.js";
import { EngineError } from "./errors.js";

/**
 * Checkout and portal shapes shared by billing.ts (the boundary) and billing-stripe.ts (the Stripe side).
 * They live here so the Stripe side never imports billing.ts, which re-exports it: no import cycle.
 */
export const checkoutInputSchema = z.object({ priceKey: z.string().min(1).max(40), confirmationGranted: z.literal(true), operationKey: z.uuid() }).strict();
export const checkoutResultSchema = z.object({ checkoutUrl: z.url({ protocol: /^https$/ }), sessionId: z.string(), status: z.literal("created") });
export type CheckoutResult = z.infer<typeof checkoutResultSchema>;
export const portalResultSchema = z.object({ portalUrl: z.url({ protocol: /^https$/ }) });
export type PortalResult = z.infer<typeof portalResultSchema>;

export function stripeNotConfigured(deps: EngineDeps): EngineError {
  return new EngineError("unsupported", `STRIPE_NOT_CONFIGURED: ${deps.config.stripeProblem ?? "Stripe sandbox is not configured."} Drafting and your existing credits are unaffected.`);
}
