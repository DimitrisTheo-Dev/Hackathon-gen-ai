# Faceful demo readiness

Updated 14 November 2026, evening. Production: <https://faceful.vercel.app> (also served at <https://faceful.dtheo.dev>). What a deployment has configured is always visible at `/v1/health`.

Labels: **VERIFIED LIVE** — exercised on production with real services. **IMPLEMENTED, NOT VERIFIED LIVE** — code and tests exist; the live path has not been run. **BLOCKED** — cannot work until someone supplies something. **DEFERRED** — deliberately not built.

## Feature matrix

| Capability | Status | Evidence / what is missing |
| --- | --- | --- |
| Sign-in (email code via Resend, Google) and first-run workspace provisioning | Email code + provisioning: **VERIFIED LIVE** (provisioning through real sessions). Google button: **IMPLEMENTED, NOT VERIFIED LIVE** (provider enabled, Google accepts the redirect; no person has clicked through) | `docs/demo/evidence/engine/smoke-live-supabase.txt` |
| Domain API on production (`/v1`): projects, drafts, immutable versions, restore, idempotency, tenant isolation, RLS | **VERIFIED LIVE** | 32 live checks; production calls in `evidence/production/` |
| Studio wired to the engine: first-run composer, labelled sample project, billing view | **VERIFIED LIVE** in a real browser on production with a real session (no console errors) | `evidence/production/studio-*.png` |
| Studio: prompt → written drafts → docked chat, edit proposals, versions, templates | **IMPLEMENTED, NOT VERIFIED LIVE** (10 browser tests against the real engine logic with an in-memory store and a stubbed model; on production the prompt correctly answers "AI writing isn’t connected") | `tests/browser/live-engine.spec.ts` |
| AI Creative Director writing drafts from a prompt | **BLOCKED — no model credential.** Runs in honest "basic" mode: finds/opens content, credits, schedule review, exact edits, templates | Add `ANTHROPIC_API_KEY` on Vercel, **or** add a card to the Vercel team's AI Gateway and set `DIRECTOR_PROVIDER=vercel-gateway` (the gateway answered `customer_verification_required`) |
| Remote MCP server (13 tools), scoped workspace tokens | **VERIFIED LIVE** — Claude Code 2.1.325 against production; Codex CLI 0.169.0 and Claude Code against a local engine on the real database | `evidence/production/mcp-and-oauth.md`, `evidence/engine/mcp-client-trials.md` |
| MCP OAuth 2.1 (discovery, dynamic registration, consent page, PKCE, refresh) | **VERIFIED LIVE with a scripted client**; not yet through a host's own OAuth UI | `evidence/production/mcp-and-oauth.md` |
| UI ↔ MCP parity (same projects, same rules) | **VERIFIED LIVE** | Agent-created project and drafts read back through the studio API |
| Stripe sandbox: hosted Checkout, webhook-confirmed plan and credits, Customer Portal, double-subscribe guard, tenant isolation | **VERIFIED LIVE** (test card 4242…, credits 1 → 31 via `invoice.paid`) | `evidence/production/stripe-sandbox.md` |
| Stripe declines, portal cancellation, replay/out-of-order on production | **IMPLEMENTED, NOT VERIFIED LIVE** (18 unit tests with real signature verification) | Manual checklist in `STRIPE_SANDBOX_SETUP.md` |
| Render jobs: admission, credit hold/refund, worker claim, verified upload to private storage, signed playback, timeouts | **VERIFIED LIVE with a non-video test object** (protocol and storage proven; no avatar video involved) | `smoke-live-supabase.txt` |
| A real Humanlike presenter video | **BLOCKED.** Humanlike's documented API starts realtime sessions in a LiveKit room; it has no export. A recorder must turn a session into a file | Needs: Humanlike secret key, LiveKit credentials, a voice provider, and the recorder plugged into `scripts/render-worker.ts` (`RENDER_WORKER_TOKEN`). See `INTEGRATION_CONTRACTS.md` §6–7 |
| Schedule proposal in the user's timezone, exact-manifest review, human-only approval | Proposal and review: **VERIFIED LIVE** (blocked state). Approval: unit-tested; cannot be reached live because nothing is approvable without a rendered video | Athens DST conversion unit-tested |
| YouTube: connect a channel (Google account chooser), upload approved videos with native scheduling | **IMPLEMENTED, NOT VERIFIED LIVE.** Code, 15 tests, and Google error shapes checked; server variables set on production. Needs a person to complete Google consent, the YouTube Data API enabled on the Google project, and a rendered video. Google keeps uploads from unaudited API projects private | `INTEGRATION_CONTRACTS.md` §12 |
| Instagram, TikTok publishing | **BLOCKED** by each platform's app review. Shown as "not available yet" | — |
| Claude Code in the browser (`/claude-login-test/`, Minas): the official CLI on your own server, signed in with your own Claude subscription, streamed to a page | **IMPLEMENTED, NOT VERIFIED LIVE by this workstream.** The page is served on production and its unit tests pass; no runner was reachable to exercise sign-in or a session. It is not yet connected to a Faceful workspace (the runner starts Claude without Faceful's MCP server) | `apps/claude-runner/README.md`. Check Anthropic's terms before offering subscription sign-in to other people; the README scopes it to your own use |
| Installable app (manifest, icons, offline page, service worker) | **IMPLEMENTED, NOT VERIFIED on a phone** | — |
| File uploads, website/brand import, collaborator invitations, unattended publishing grants, template marketplace, realtime push, API rate limiting | **DEFERRED** | — |

## Proof that was actually run

| Check | Result |
| --- | --- |
| Unit and contract tests (`corepack pnpm test`) | 128 passed, 0 failed (last full run, with the YouTube work in the tree) |
| Typecheck, production build incl. API-function and prerender checks | pass |
| Browser tests against the real engine logic (`test:ui:live`) | 10 passed |
| Migration + RLS in a throwaway local Postgres (`scripts/test-engine-rls.mjs`) | pass |
| Live Supabase checks (`corepack pnpm smoke:engine`) | 32/32 |
| Production: health, studio API with a real session, MCP with a token, OAuth, Stripe checkout | see `docs/demo/evidence/production/` |

Mocked vs real: Stripe network calls are faked in unit tests (signature verification is real); Google calls are faked in unit tests; the model is stubbed in tests; the browser suite uses an in-memory store. Everything under "VERIFIED LIVE" used the real services.

## Failures found by testing, and fixed

- Production build failed once: a build-time check assumed billing was unconfigured. The check is now environment-independent.
- First production checkout was rejected: the Stripe account has Managed Payments on by default. Sessions now opt out.
- A 5-second poll would have restarted video playback (new signed URL each read). URLs are now stable per media file.

## What the demo needs from people

| Needed | Who | Unlocks |
| --- | --- | --- |
| A model credential (Anthropic key, or a card on Vercel AI Gateway) | Dimitris | Prompt → written drafts, conversational rewrites, schedule suggestions — the hero flow |
| Humanlike key + LiveKit + voice + recorder | Minas | Real presenter videos, then scheduling and YouTube upload |
| One person clicking "Connect YouTube"; YouTube Data API enabled on the Google project | Dimitris / Minas | A real connected channel |
| A phone | anyone | Checking the installed app and touch behaviour |

## Honest summary

**Working:** accounts and workspaces, the engine and its API, versioned drafting by template or by hand, the agent connection over MCP with tokens and OAuth, credits and Stripe sandbox billing, and the review/approval boundary.
**Needs credentials or external approval:** AI drafting, presenter-video rendering, YouTube (one consent), Instagram/TikTok.
**Known limitations:** five-second polling instead of push; no rate limiting; OAuth tokens are bound to the Supabase project rather than to `/mcp`; faceful.dtheo.dev remains an alias of the same deployment; everything canonical (docs, OAuth consent, emails, Stripe, MCP) uses faceful.vercel.app.
**Next best action:** add the model credential — it turns the first thing a judge types into a real result.
