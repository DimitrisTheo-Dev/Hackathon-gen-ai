# Faceful demo readiness

## Midday update: Sunday 15 November

**The five missing migrations are applied.** `socials`, `reel_production`, `socials_webhook_renewal`, `personas` and `clone_jobs` are now on the hosted database; `supabase migration list` shows all ten local migrations remote. Re-checked on production with a signed-in session: Channels, Personas, Clone a video and the Video tab's timeline, files and renders all answer 200 (they answered 503 before).

**Built but not configured on production** (from `/v1/health`):
- draft file storage (`files.connected: false`)
- the Remotion reel renderer (`reelRendering.connected: false`)
- social connections and webhooks (`socials.connections: false`)
- Humanlike rendering

Publishing adapters on production: YouTube only.

## Morning report: Sunday 15 November, 02:15 Athens

Everything below is merged (PRs #13 and #14) and live on <https://faceful.vercel.app>. Each production item was checked against the live site after deploying.

### Shipped overnight

| What | Where to look |
| --- | --- |
| **Security release:** Postgres-backed rate limits with IETF `RateLimit` headers, 256 KB body cap, MCP batch cap, operation-dispatch fix (`constructor` is now 404), escaped prompt data, HSTS/COOP | `SECURITY.md`; production checks below |
| **Stripe on production:** a declined card grants nothing. The Portal cancellation bug was found, fixed and re-verified: Billing shows "Ends 14 Dec" | `docs/demo/evidence/production/stripe-sandbox.md` |
| **`/pitch`:** the one-minute presenter reveal. Eleni speaks; the camera pulls back to the studio; Director edit → Claude Code over MCP → human approval → end card. Press **F**, then **R** | `docs/demo/pitch-script.md` |
| **Raw demo footage:** 10 clips at 1920×1080 (local only, `demo-footage/`, not in git) plus a cut list | `docs/demo/demo-video-cut-list.md` |
| **Demo workspace on production** ("Quintessential", BeWell brand kit, sample project, one Greek project written by the agent) plus a seed/reset script | `DEMO_RUNBOOK.md` § Before the demo |
| **Safari (WebKit), Firefox and Chromium:** 342 browser tests across the three engines; three real Safari bugs fixed (hero lines shifting when the font loads, focus lost after a dialog, video byte ranges) | `docs/demo/evidence/quality/` |
| **Accessibility:** axe serious/critical findings went from 45 to 0 in all three engines (WCAG 2.2 AA) | `docs/demo/evidence/quality/axe-summary.json` |
| **Performance:** landing Lighthouse 100 on mobile and desktop (local server with brotli, LCP 1.1 s mobile). On production, unthrottled, measured with Playwright: LCP 0.42–0.73 s and CLS ≤ 0.003 on the landing and sign-in. Signed-out studio visits now preload only the sign-in code | `docs/demo/evidence/quality/lighthouse-summary.json` |
| **Agent discovery and docs:** MCP server card at `/.well-known/mcp/server-card.json`; public docs and `llms.txt` state the live rate limits; the OAuth consent page refuses script-bearing callbacks | `INTEGRATION_CONTRACTS.md` §4, §9 |
| **Submission write-up** | `docs/submission/SUBMISSION.md` |

**Tests on the deployed commit (clean checkout, its own install):** typecheck clean · 187 unit tests · browser suites: default 72, landing 20, live 11, onboarding 13, pitch 10 · local Postgres RLS scripts pass. The three-engine matrix (342 passed, 6 skipped with reasons) ran on the commit before the last two small changes, the pitch credit label and signed-out preloads; both of those passed the Chromium suites above.

**Production checks after deploying:**
- Server card served with `Access-Control-Allow-Origin: *`.
- `/pitch`, the landing and studio sign-in open with no console errors in Chromium and WebKit.
- Rate-limit headers are present; HSTS, COOP and CSP are present.
- `operations/constructor` returns 404; an oversized MCP batch is refused.
- Billing reflects the Portal cancellation.

### Needs you, in order

1. **Repository access for judges.** The repo is private. Make it public or add the judges. I did not change its visibility.
2. **The demo video.**
   - Record the voice-over and cut the footage using the cut list, then replace the placeholder link in `SUBMISSION.md`.
   - Blur the demo account's email on Stripe's page in clip 09.
   - Submit by 18:00.
3. **Enable "YouTube Data API v3" on Google Cloud project `741725865286`** (the project that owns the Google sign-in client), then click "Connect YouTube" again. Google consent already works. On 15 Nov both attempts reached the engine and stopped at Google's `accessNotConfigured` when looking up the channel (HTTP 422, "The YouTube Data API is not enabled for this Google project").
4. **Optional: a real presenter clip for the pitch opening** (Minas, Humanlike). Put it at `apps/web/public/pitch/presenter.mp4` with `presenter.json` stating the true credit. Without it the page uses the drawn presenter, labelled "Illustration".
5. **Run the two scans I was not permitted to run:**
   - `corepack pnpm dlx is-agentic faceful.vercel.app --json`
   - `corepack pnpm dlx lighthouse@13.6.0 https://faceful.vercel.app/ --preset=desktop`
6. **Five minutes on a real iPhone and an Android phone:** landing, sign-in, studio, `/pitch`.
7. **Decisions:** the €19 price is a placeholder; whether to connect Minas's runner to Faceful's MCP server (his code was not changed).
9. **After the hackathon:** rotate the secrets pasted in chat (Supabase secret key, Google client secret, Stripe sandbox key) and the other server keys (see "Failures found by testing").

### State to know before presenting

- The demo account holds an **active Stripe sandbox subscription** from recording clip 09, with 33 credits. Upgrade is therefore not offered on that account. To show checkout live, cancel the subscription immediately in the Stripe sandbox Dashboard first, or use a fresh account.
- The sample draft "Find your next moment" is at version 4 after the recordings. `node --env-file=.env.local --import tsx scripts/demo-seed.ts --demo-account --reset` restores the workspace. It does not touch Stripe.
- Feature freeze at 14:00 Athens; fixes only after that.

---

Production: <https://faceful.vercel.app> (also served at <https://faceful.dtheo.dev>). What a deployment has configured is always visible at `/v1/health`.

Labels: **VERIFIED LIVE** — exercised on production with real services. **IMPLEMENTED, NOT VERIFIED LIVE** — code and tests exist; the live path has not been run. **BLOCKED** — cannot work until someone supplies something. **DEFERRED** — deliberately not built.

## Feature matrix

| Capability | Status | Evidence / what is missing |
| --- | --- | --- |
| Sign-in (email code via Resend, Google) and first-run workspace provisioning | Email code + provisioning: **VERIFIED LIVE** (provisioning through real sessions). Google button: **IMPLEMENTED, NOT VERIFIED LIVE** (provider enabled, Google accepts the redirect; no person has clicked through) | `docs/demo/evidence/engine/smoke-live-supabase.txt` |
| Domain API on production (`/v1`): projects, drafts, immutable versions, restore, idempotency, tenant isolation, RLS | **VERIFIED LIVE** | 32 live checks; production calls in `evidence/production/` |
| Studio wired to the engine: first-run composer, labelled sample project, billing view | **VERIFIED LIVE** in a real browser on production with a real session (no console errors) | `evidence/production/studio-*.png` |
| Studio: prompt → written drafts → docked chat, edit proposals, versions, templates | Engine path: **VERIFIED LIVE** (real create and edit turns on production, 15 Nov). The studio UI itself: browser tests against the real engine logic with a stubbed model | `evidence/production/director-gemini.md`, `tests/browser/live-engine.spec.ts` |
| AI Creative Director writing drafts from a prompt | **VERIFIED LIVE** on Gemini (`gemini-4-hydrogen`, `GEMINI_API_KEY` on Vercel). Production: a prompt created 2 drafts in 7.1 s; an edit turn proposed a Greek rewrite in 7.0 s | `evidence/production/director-gemini.md` |
| Remote MCP server (21 tools: 13 for drafting, rendering, schedule and billing, plus 8 for reel production), scoped workspace tokens | **VERIFIED LIVE** — Claude Code 2.1.325 against production; Codex CLI 0.169.0 and Claude Code against a local engine on the real database | `evidence/production/mcp-and-oauth.md`, `evidence/engine/mcp-client-trials.md` |
| MCP OAuth 2.1 (discovery, dynamic registration, consent page, PKCE, refresh) | **VERIFIED LIVE with a scripted client**; not yet through a host's own OAuth UI | `evidence/production/mcp-and-oauth.md` |
| UI ↔ MCP parity (same projects, same rules) | **VERIFIED LIVE**. On 15 Nov, a nine-step Claude Code run against production MCP was followed by the studio showing the same project, credited to the agent, with the same three blockers | `evidence/production/terminal-and-interface-e2e.md` |
| Stripe sandbox: hosted Checkout, webhook-confirmed plan and credits, Customer Portal, double-subscribe guard, tenant isolation | **VERIFIED LIVE** (test card 4242…, credits 1 → 31 via `invoice.paid`) | `evidence/production/stripe-sandbox.md` |
| Stripe declined card and Customer Portal cancellation on production | **VERIFIED LIVE** (15 Nov). The decline granted nothing. The cancellation first exposed a bug (this API version records it as `cancel_at`); it was fixed, redeployed, and production now reports `cancelAtPeriodEnd: true` | `evidence/production/stripe-sandbox.md` § Edge cases |
| Stripe replayed / out-of-order webhooks, `subscription.deleted` at period end | **IMPLEMENTED, NOT VERIFIED LIVE** (unit tests with real signature verification) | Manual checklist in `STRIPE_SANDBOX_SETUP.md` |
| Rate limiting, body limits, security headers | **VERIFIED LIVE** (15 Nov): `RateLimit-Policy`/`RateLimit` headers on authenticated and anonymous requests, HSTS, COOP and CSP present, inherited operation names such as `constructor` refused as `not_found`, oversized MCP batches refused | `SECURITY.md`, `INTEGRATION_CONTRACTS.md` §4 and §9 |
| Render jobs: admission, credit hold/refund, worker claim, verified upload to private storage, signed playback, timeouts | **VERIFIED LIVE with a non-video test object** (protocol and storage proven; no avatar video involved) | `smoke-live-supabase.txt` |
| A real Humanlike presenter video | **BLOCKED.** Humanlike's documented API starts realtime sessions in a LiveKit room; it has no export. A recorder must turn a session into a file | Needs: Humanlike secret key, LiveKit credentials, a voice provider, and the recorder plugged into `scripts/render-worker.ts` (`RENDER_WORKER_TOKEN`). See `INTEGRATION_CONTRACTS.md` §6–7 |
| Schedule proposal in the user's timezone, exact-manifest review, human-only approval | Proposal and review: **VERIFIED LIVE** (blocked state). Approval: unit-tested; cannot be reached live because nothing is approvable without a rendered video | Athens DST conversion unit-tested |
| YouTube: connect a channel (Google account chooser), upload approved videos with native scheduling | **IMPLEMENTED, NOT VERIFIED LIVE.** Code, 15 tests, and Google error shapes checked; server variables set on production. Needs a person to complete Google consent, the YouTube Data API enabled on the Google project, and a rendered video. Google keeps uploads from unaudited API projects private | `INTEGRATION_CONTRACTS.md` §12 |
| Instagram, TikTok publishing | **BLOCKED** by each platform's app review. Shown as "not available yet" | — |
| Claude Code in the browser (`/claude-login-test/`, Minas): the official CLI on your own server, signed in with your own Claude subscription, streamed to a page | **IMPLEMENTED, NOT VERIFIED LIVE by this workstream.** The page is served on production and its unit tests pass; no runner was reachable to exercise sign-in or a session. It is not yet connected to a Faceful workspace (the runner starts Claude without Faceful's MCP server) | `apps/claude-runner/README.md`. Check Anthropic's terms before offering subscription sign-in to other people; the README scopes it to your own use |
| Installable app (manifest, icons, offline page, service worker) | **IMPLEMENTED, NOT VERIFIED on a phone** | — |
| Template library (11 short-form formats, each with a rendered Greek sample) | **VERIFIED LIVE**: `/v1/studio/templates/library` returns 11 templates with signed sample videos, posters and beat stills | Studio → Templates |
| Video tab: Remotion timeline editor, draft files, MP4 render queue (8 MCP tools) | **IMPLEMENTED; reachable on production** (timeline, files and render lists load). Editing was not exercised end to end. Rendering needs a Remotion worker and file uploads need the files store; neither is configured | `docs/agents/reel-production.md`, `workers/reel-render/` |
| Personas (presenters backed by a face-scan consent) and Clone a video | **IMPLEMENTED; reachable on production** (both lists load). Clone jobs wait in a queue until a worker is attached | — |
| Social accounts through Buffer, or Instagram directly; activity webhooks | **IMPLEMENTED, NOT VERIFIED LIVE.** The tables exist; no Buffer or Instagram credentials are configured on production | `INTEGRATION_CONTRACTS.md` §4, §11 |
| Chromium, Safari (WebKit) and Firefox; accessibility (axe, WCAG 2.2 AA) | **VERIFIED** in all three engines on a production-shaped build: 342 browser tests, 0 serious or critical axe findings. Production pages opened without console errors in Chromium and WebKit. Not yet checked on a physical iPhone or Android phone | `docs/demo/evidence/quality/` |
| `/pitch` presenter reveal | **VERIFIED LIVE** (served on production, no console errors in Chromium and WebKit; 10 browser tests). Uses a drawn presenter labelled "Illustration" until a real clip is added | `docs/demo/pitch-script.md`, `docs/demo/evidence/production/pitch-prod-studio-beat.png` |
| MCP server card for discovery | **VERIFIED LIVE** at `/.well-known/mcp/server-card.json` (draft format, SEP-1649/SEP-2127) | `INTEGRATION_CONTRACTS.md` §9 |
| File uploads, website/brand import, collaborator invitations, unattended publishing grants, template marketplace, realtime push | **DEFERRED** | — |

## Proof that was actually run

| Check | Result |
| --- | --- |
| Unit and contract tests (`corepack pnpm test`) | 187 passed, 0 failed (clean checkout of the deployed commit, 15 Nov) |
| Typecheck, production build incl. API-function and prerender checks | pass |
| Browser suites, Chromium (clean checkout of the deployed commit) | default 72 (includes the accessibility spec), landing 20, live engine 11, onboarding 13, pitch 10: all passed |
| Browser matrix, Chromium + WebKit + Firefox (`tests/browser/browsers.config.ts`) | 342 passed, 6 skipped, each skip with a reason stated in its spec (Chromium-only touch emulation and phone browsers launched once) |
| Migration + RLS in a throwaway local Postgres (`scripts/test-engine-rls.mjs`, `scripts/test-director-rls.mjs`) | pass, including rate-limiter atomicity (8 sessions × 25 hits admitted exactly 100) |
| Live Supabase checks (`corepack pnpm smoke:engine`) | 32/32 |
| Production: health, studio API with a real session, MCP with a token, OAuth, Stripe checkout | see `docs/demo/evidence/production/` |

Mocked vs real: Stripe network calls are faked in unit tests (signature verification is real); Google calls are faked in unit tests; the model is stubbed in tests; the browser suite uses an in-memory store. Everything under "VERIFIED LIVE" used the real services.

## Failures found by testing, and fixed

- Production build failed once: a build-time check assumed billing was unconfigured. The check is now environment-independent.
- First production checkout was rejected: the Stripe account has Managed Payments on by default. Sessions now opt out.
- A 5-second poll would have restarted video playback (new signed URL each read). URLs are now stable per media file.
- Operation names were looked up on a plain object, so `POST /v1/studio/operations/constructor` (signed in) reached `Object` instead of an operation and tried to return the engine's dependency object, configuration included. Found in review, not by a report. Now a `Map` of own entries; production answers `404 not_found`. Vercel's log retention is too short to rule out earlier use, so rotating the server keys after the hackathon is recommended (`SECURITY.md`).
- Customer Portal cancellations were not shown (Stripe API `2026-10-28` records them as `cancel_at`). Fixed and re-verified on production.
- **Writes took 3–6 s, and one MCP call outlasted Claude Code's client timeout.** The functions ran in `iad1` while the database is in Frankfurt. They now run in `fra1`, and writes take about 1–2 s on the server (`evidence/production/terminal-and-interface-e2e.md`).

## What the demo needs from people

| Needed | Who | Unlocks |
| --- | --- | --- |
| Humanlike key + LiveKit + voice + recorder | Minas | Real presenter videos, then scheduling and YouTube upload |
| "YouTube Data API v3" enabled on Google project `741725865286`, then "Connect YouTube" once | Dimitris | A real connected channel |
| A phone | anyone | Checking the installed app and touch behaviour |
| Repository access for judges (it is private) | Dimitris | Judges reading the code |
| A recorded voice-over and the cut demo video | Dimitris | The submission's demo video |

## Honest summary

**Working:** accounts and workspaces, the engine and its API, AI drafting and edits (Gemini), versioned drafting by template or by hand, the agent connection over MCP with tokens and OAuth, credits and Stripe sandbox billing, and the review/approval boundary.
**Needs credentials or external approval:** presenter-video rendering, YouTube (enable the YouTube Data API, then one consent), Instagram/TikTok.
**Known limitations:** five-second polling instead of push; rate limits are per account or connection, not per workspace; OAuth tokens are bound to the Supabase project rather than to `/mcp`; faceful.dtheo.dev remains an alias of the same deployment; everything canonical (docs, OAuth consent, emails, Stripe, MCP) uses faceful.vercel.app.
**Next best action:** enable the YouTube Data API on the Google project and connect a channel.
