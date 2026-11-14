# Stripe sandbox on production — 14 November 2026

Environment: https://faceful.vercel.app (production deployment of `d830fad`), Stripe **sandbox** account `acct_1UbjdQ…` (test mode; `livemode: false` on every object). No real charge was made. Card data was entered only on Stripe's hosted page.

Configuration created through the Stripe API with the sandbox key: product "Faceful Creator (demo plan)", recurring Price €19.00/month (lookup key `faceful_demo_monthly`; the amount is a placeholder chosen for the demo and can be changed in Stripe), webhook endpoint `https://faceful.vercel.app/v1/stripe/webhook` (9 event types, API version `2026-10-28.endive`, snapshot payloads), and a default Customer Portal configuration.

## Controlled run (Playwright driving Stripe-hosted Checkout, signed in as the smoke account's owner)

| Step | Observed |
| --- | --- |
| `GET /v1/studio/billing` before | `status: free`, 1 credit, no customer |
| `create_checkout` | 200, URL on `checkout.stripe.com`; billing became `checkout_pending`, **credits unchanged (1)** |
| Hosted page | "Faceful sandbox · Sandbox · Subscribe to Faceful Creator (demo plan) · €19.00 per month" (`stripe-checkout-page.png`) |
| Paid with test card 4242 4242 4242 4242 | redirected to `/studio/?view=billing&checkout=success` |
| After Stripe's signed webhooks | `status: active`, `planKey: demo`, **credits 31 (+30)**, period end 2026-12-14 |
| Events the engine recorded | `checkout.session.completed → checkout_completed:subscription_active`, `customer.subscription.created → subscription_active`, `invoice.paid → invoice_paid_granted_30:subscription_active` |
| Second checkout while subscribed | 422 `unsupported` — pointed to Manage billing (no double subscription) |
| Checkout naming a Price ID instead of a plan key | 400 `validation_error` |
| A different workspace | still `free`, 3 credits, no customer; `create_portal` refused |
| `create_portal` | 200, URL on `billing.stripe.com`; page "Faceful sandbox Billing" shows the plan (`stripe-customer-portal.png`) |

One earlier `checkout.session.expired` event (from a diagnostic session created outside the app) was correctly recorded as `ignored_unknown_customer`.

## A failure found and fixed on the way

The first production `create_checkout` returned `provider_unavailable`: this Stripe account has **Managed Payments** enabled by default, which requires a product tax code. Sessions now pass `managed_payments.enabled=false` (plain Checkout with this account as seller). Verified against the real sandbox before redeploying.

## Not exercised here

Declined cards (4000 0000 0000 0002), cancelling in the Customer Portal and the resulting `customer.subscription.updated/deleted` events on production, and out-of-order/replayed deliveries on production. These are covered by the 18 unit tests (real Stripe signature verification, faked network) and by the manual checklist in `STRIPE_SANDBOX_SETUP.md`.

## Edge cases on production — 15 November 2026, early morning

| Check | Observed |
| --- | --- |
| Declined test card (4000 0000 0000 0002) on a free workspace | Stripe kept the person on its page with a decline message (`stripe-declined.png`). Faceful: still 3 credits, status `checkout_pending` (a display hint only; it clears when the session expires). Nothing granted. |
| Cancel in the hosted Customer Portal | Stripe showed "Cancels Dec 14 · Faceful Creator (demo plan) €19" (`stripe-portal-cancel-confirm.png`, `stripe-portal-cancelled.png`). The signed webhook arrived and was processed, but **Faceful did not show the scheduled cancellation**: this API version records it as `cancel_at` (the period end) with `cancel_at_period_end: false`, and the engine read only the flag. Bug found; fix in progress, to be re-verified on production. |
