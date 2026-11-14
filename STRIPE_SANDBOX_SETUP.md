# Stripe sandbox setup

Faceful bills through **Stripe-hosted Checkout** and the **Stripe-hosted Customer Portal**, in a Stripe **sandbox** only. This guide covers configuration, the manual test run, and troubleshooting. It contains no secret values; never paste keys into this file, the repository, chat or an agent prompt.

## Status

| Item | State |
| --- | --- |
| Server code (checkout, portal, webhook, credits) | Implemented in `packages/engine/src/billing-stripe.ts` and `billing.ts` |
| Automated tests | 18 tests in `tests/billing.test.ts` pass. They use a fake Stripe gateway and Stripe's real signature code. They do not contact a Stripe account. |
| Real Stripe SDK wiring | Checked once with a deliberately invalid sandbox-format key: all four API calls reached Stripe and failed with the expected safe error. |
| Hosted Checkout, Portal and live webhook delivery | **Not verified.** No sandbox keys have been supplied. Run the manual checklist below when they are. |

Until keys are added, billing reports `STRIPE_NOT_CONFIGURED`. Drafting, existing credits and every other feature keep working.

## How it works

1. An owner or admin asks to upgrade. The server creates a Checkout Session for the one configured demo Price and returns Stripe's page URL. The browser (or an agent's user) opens that page. Card details are entered on Stripe, never in Faceful or in chat.
2. Stripe sends signed events to `POST /v1/stripe/webhook`. The server verifies the signature against the raw body, then re-reads the subscription from Stripe and records its status.
3. Each paid subscription invoice adds render credits once. Rendering spends credits; the check happens on the server for the studio and for MCP alike.

Returning from Checkout changes nothing by itself. A plan and its credits appear only after Stripe's events arrive, so they still arrive if the tab is closed before the redirect.

## Environment variables

Set these on the server only (Vercel project settings, or `.env.local` for local runs). None of them is a `VITE_` variable and none reaches the browser.

| Variable | Required | Value |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Yes | A sandbox key: `rk_test_…` (restricted, preferred) or `sk_test_…`. Keys starting `sk_live_` or `rk_live_` are rejected at startup. |
| `STRIPE_WEBHOOK_SECRET` | Yes | The `whsec_…` signing secret of **this deployment's** webhook endpoint. Local forwarding with the CLI has its own, different secret. |
| `STRIPE_PRICE_ID_DEMO` | Yes | A recurring sandbox Price ID, `price_…`. It is offered as the plan key `demo`. |
| `APP_BASE_URL` | Yes | The site origin, for example `https://faceful.vercel.app`. Checkout and Portal return here. Must be `https` (plain `http` is accepted for `localhost` only). |
| `STRIPE_MODE` | No | Leave unset or set to `sandbox`. Any other value disables billing. |
| `STRIPE_DEMO_PLAN_CREDITS` | No | Render credits added per paid period. Default `30`. |
| `STARTER_RENDER_CREDITS` | No | Free credits for a new workspace. Default `3`. |
| `RENDER_CREDIT_COST` | No | Credits spent per render. Default `1`. |

No publishable key is used. Checkout is opened by URL, so the browser never loads Stripe.js.

If any required value is missing or malformed, billing stays off and the Billing page shows the reason. The reason names the variable, never its value.

## One-time Stripe setup

Do all of this inside one sandbox, so the key, the Price and the webhook endpoint belong to the same environment.

1. **Open a sandbox.** In the Stripe Dashboard, use the account picker to create or open a sandbox.
2. **Create the Price.** Product catalogue → add a product → add a **recurring** price. Copy the Price ID (`price_…`) into `STRIPE_PRICE_ID_DEMO`. The amount is whatever you choose in Stripe; the application never sets or sends an amount.
3. **Create the API key.** Developers → API keys → create a **restricted key** with:
   - Customers: Write
   - Checkout Sessions: Write
   - Customer portal: Write
   - Subscriptions: Read

   Copy it into `STRIPE_SECRET_KEY`. This permission list has not been confirmed against a real sandbox. If a call is refused, the server logs `stripe_api_error` with kind `StripePermissionError`; Workbench → Logs names the missing permission.
4. **Save the Customer Portal settings.** Settings → Billing → Customer portal → review and save, with cancellation enabled. Stripe refuses to create portal sessions in a sandbox until these settings have been saved once.
5. **Register the webhook endpoint.** Workbench → Webhooks → Create an event destination:
   - Events from: **Your account**
   - Payload format: **Snapshot** (the handler reads snapshot events; thin events are refused with `400 unsupported_event_format`)
   - API version: the latest offered. The handler reads the subscription from an invoice in both the current and the older layout.
   - Endpoint URL: `https://<your-domain>/v1/stripe/webhook`
   - Event types:
     - `checkout.session.completed`
     - `checkout.session.async_payment_succeeded`
     - `checkout.session.async_payment_failed`
     - `checkout.session.expired`
     - `invoice.paid`
     - `invoice.payment_failed`
     - `customer.subscription.created`
     - `customer.subscription.updated`
     - `customer.subscription.deleted`

   Reveal the signing secret (`whsec_…`) and copy it into `STRIPE_WEBHOOK_SECRET`.
6. **Deploy** with the variables set, then open Billing in the studio. It should show the demo plan and an Upgrade button.

## Local testing with the Stripe CLI

```sh
# Terminal 1: the engine API on http://127.0.0.1:8787 (reads .env.local)
corepack pnpm dev:api

# Terminal 2: the studio, proxying /v1 to the API
corepack pnpm dev

# Terminal 3: forward sandbox events to the local webhook
stripe login
stripe listen --forward-to 127.0.0.1:8787/v1/stripe/webhook
```

`stripe listen` prints `Ready! Your webhook signing secret is 'whsec_…'`. Put that value in `.env.local` as `STRIPE_WEBHOOK_SECRET`, set `APP_BASE_URL=http://127.0.0.1:5173`, and restart `dev:api`. `.env.local` is git-ignored.

`stripe trigger <event>` creates its own throwaway customer. Faceful has no workspace for that customer, so those events are acknowledged and ignored (`ignored_unknown_customer`). To exercise the real path, go through Checkout from the studio.

## Manual verification checklist

Run this once sandbox keys are in place. Record the outcome of each step in `DEMO_READINESS.md`; do not mark a step passed without doing it.

1. **Same environment.** `GET /v1/health` reports `billing.mode: "sandbox"`. The key, Price and webhook endpoint were all created in the same sandbox.
2. **Successful payment.** In Billing, choose Upgrade. On Stripe's page pay with `4242 4242 4242 4242`, any future expiry such as `12/34`, any three-digit CVC. After returning, Billing shows the plan as active and the credit balance increased by `STRIPE_DEMO_PLAN_CREDITS`.
3. **Closed tab.** Start a second workspace's checkout, pay, and close the tab before the redirect. Reopen the studio: the plan is active and credits were added.
4. **Cancelled checkout.** Start checkout and use the back link. Billing shows no plan and no new credits.
5. **Declined card.** Use `4000 0000 0000 0002` (generic decline) or `4000 0000 0000 9995` (insufficient funds). Stripe shows the decline on its own page; Faceful grants nothing.
6. **Authentication.** Use `4000 0027 6000 3184`, which always requires 3D Secure. Complete the challenge; the result matches step 2.
7. **Replay.** In Workbench → Webhooks → your endpoint → Event deliveries, open the `invoice.paid` event and choose **Resend** (or run `stripe events resend <event_id> --webhook-endpoint=<endpoint_id>`). The delivery returns `200` with `"duplicate": true` and the credit balance does not change.
8. **Customer Portal.** Choose Manage billing. Cancel the subscription in the portal. Billing shows the cancellation (at period end, then cancelled once Stripe ends it).
9. **MCP.** From a connected agent: read billing status, request a checkout link, open it in a browser and pay, then read status again. The agent must hold the `billing:checkout` scope; it never sees or handles card details.
10. **Quota.** With a workspace at zero credits, request a render from the studio and from MCP. Both are refused with `quota_exceeded` and a link to Billing.

To test a failed renewal, subscribe with `4000 0000 0000 0341`. It attaches successfully and fails when charged, which leads to `invoice.payment_failed` and a `past_due` or `incomplete` status.

Use Stripe's test cards only. Stripe's terms prohibit testing with real card details.

## Commands

```sh
# Unit and webhook tests (no Stripe account, no network)
corepack pnpm exec tsx --test tests/billing.test.ts

# Billing status for the signed-in workspace
curl -s "$APP_BASE_URL/v1/studio/billing" -H "Authorization: Bearer $ACCESS_TOKEN"

# Create a hosted checkout link (owner or admin session, or an agent token with billing:checkout)
curl -s -X POST "$APP_BASE_URL/v1/studio/operations/create_checkout" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" \
  -d "{\"priceKey\":\"demo\",\"confirmationGranted\":true,\"operationKey\":\"$(uuidgen | tr A-Z a-z)\"}"

# Create a Customer Portal link (signed-in owner or admin only)
curl -s -X POST "$APP_BASE_URL/v1/studio/operations/create_portal" \
  -H "Authorization: Bearer $ACCESS_TOKEN" -H "Content-Type: application/json" -d '{}'
```

`ACCESS_TOKEN` is a studio session token or a workspace agent token. Keep it in an environment variable; do not put it in a command you share.

## Behaviour reference

| Topic | Behaviour |
| --- | --- |
| Who can pay | Owners and admins. Editors and reviewers cannot. An agent needs the `billing:checkout` scope, which only an owner or admin can grant. |
| Who can open the portal | A signed-in owner or admin. Agents cannot. |
| Customer | One Stripe Customer per workspace, created on first checkout and reused. Stripe receives the workspace name, plus the email of the signed-in person who starts the first checkout. |
| Price | Chosen by the server from the configured allowlist. A request that names a Price ID, an amount or a return URL is rejected. |
| Repeat requests | The same operation key returns the same session. A second request while a session is open reuses that session. A workspace that already has a subscription is sent to the portal. |
| Credits | Added once per paid invoice whose reason is a new subscription or a renewal. Proration and manual invoices add none. Credits already granted stay after cancellation. |
| Status | Taken from Stripe's subscription status: `trialing`, `active`, `past_due`, `unpaid`, `paused`, `incomplete`; `canceled` is shown as cancelled. `incomplete_expired` returns the workspace to free, because no subscription ever started. An unrecognised status changes nothing. |
| Duplicates and ordering | Events are deduplicated by event ID. Subscription state is re-read from Stripe on every event, so late, repeated or out-of-order deliveries converge on the current state. |
| Failures | If handling fails, the endpoint returns `500` and Stripe retries. Sandbox events are retried three times over a few hours. |
| Live mode | Refused at three points: key prefix at startup, any Stripe object or event with `livemode: true`, and a database constraint on stored customers. |

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Billing shows "not configured" | A required variable is missing or malformed. The page names it. Redeploy after fixing. |
| Webhook deliveries fail with `400 invalid_signature` | `STRIPE_WEBHOOK_SECRET` belongs to a different endpoint (for example the CLI's secret on the deployed site), or something altered the request body. Each endpoint has its own secret. |
| Webhook deliveries fail with `400 livemode_rejected` | The endpoint was registered in live mode. Register it in the sandbox. |
| Webhook deliveries return `503` | Stripe variables are not set on that deployment. |
| Webhook deliveries return `404` | The `/v1` route is not deployed or the URL is wrong. `GET /v1/health` should answer on the same origin. |
| Webhook deliveries fail with `400 unsupported_event_format` | The destination was created with the Thin payload format. Recreate it as Snapshot. |
| Deliveries succeed but nothing changes | Check the response body's `outcome`. `ignored_unknown_customer` means the customer was not created by Faceful (for example `stripe trigger`). `ignored_event_type` means the event type is not one of the nine listed above. |
| Paid, but no credits | Look for the `invoice.paid` delivery. `…no_grant_unknown_price` means the subscription's Price is not `STRIPE_PRICE_ID_DEMO`. |
| "Stripe did not accept this billing request" on Upgrade | The Price ID does not exist in the key's sandbox, or is not a recurring price. |
| "Stripe rejected this deployment's sandbox key" | The key was rolled or deleted, or a restricted key lacks a permission. See step 3 above. |
| Manage billing fails | The Customer Portal settings have not been saved in this sandbox, or the workspace has never started a checkout. |
| Plan stays "checkout pending" | Checkout was opened but not completed. It clears when Stripe expires the session (24 hours) or when payment completes. |

Server logs for billing contain event IDs, event types and outcomes only. They never contain keys, signatures, card data or full payloads.

## Deployment checklist

- [ ] `STRIPE_SECRET_KEY` is a sandbox key (`rk_test_…` or `sk_test_…`), stored only in the hosting platform's secret settings.
- [ ] `STRIPE_WEBHOOK_SECRET` is the secret of the endpoint registered for this exact deployment URL.
- [ ] `STRIPE_PRICE_ID_DEMO` is a recurring Price from the same sandbox.
- [ ] `APP_BASE_URL` matches the public origin users see.
- [ ] `STRIPE_MODE` is unset or `sandbox`.
- [ ] The webhook destination uses the Snapshot payload format and lists only the nine event types above.
- [ ] `git grep -nE "(sk|rk)_(test|live)_[A-Za-z0-9]{16,}|whsec_[A-Za-z0-9]{16,}"` finds no real key in the repository.
- [ ] Preview and production deployments do not share a webhook secret.
- [ ] Each team member who had access to the key is known; roll the key when someone leaves.

## Known limits

- Sandbox only. Going live is a separate change: remove the sandbox guards deliberately, use live restricted keys, add Stripe Tax if required, and review terms and pricing. Nothing here enables it by configuration alone.
- One demo subscription plan. There are no top-up packs, metered billing or trials.
- Events are handled inside the webhook request. This is adequate for demo volume; a queue would be needed for heavy traffic.
- Stripe's IP allowlist is not enforced at the endpoint. Signature verification is the control in place.
- Hosted Checkout and Portal pages cannot be automated in tests; they are covered by the manual checklist.
