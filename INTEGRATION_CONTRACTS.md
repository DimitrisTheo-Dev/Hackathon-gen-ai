# Faceful integration contracts

Updated 14 November 2026. This file records what the shared engine actually implements. It replaces the proposal in `docs/product/contract-handoff.md` as the working contract; that file is kept for history. Runtime schemas live in `packages/contracts/src/index.ts` (Zod) and are the source of truth for field shapes.

The product is named **Faceful** in the repository and on the public site. The demo brief calls it Castroom; they are the same product.

## 1. Ownership

| Area | Files | Owner |
| --- | --- | --- |
| Domain engine, HTTP API, tenancy, jobs, schedule, director | `packages/engine/**`, `api/engine.ts`, `supabase/migrations/20261114190000_engine_core.sql` | Engine workstream (this change) |
| MCP server | `packages/engine/src/mcp.ts`, `api/mcp.ts` | Engine workstream |
| Stripe sandbox | `packages/engine/src/billing*.ts`, `STRIPE_SANDBOX_SETUP.md` | Engine workstream |
| Shared schemas | `packages/contracts/**` | Shared; additive changes only, announce them |
| Studio UI, landing, design system | `apps/web/**`, `DESIGN.md` | Dimitris / UI workstream |
| Public discovery API and docs | `packages/public-api/**`, `apps/web/public/docs/**`, `proxy.ts` | UI / readiness workstream |
| **Humanlike recorder** (session → video file) | not in this repository | **Minas** — plugs in through the render worker protocol in §7 |

No separate backend from Minas exists on `origin` (branches: `main`, `work/dimitris-studio`) and the hosted database held only the two conversation tables before this change. Nothing of his was overwritten or duplicated. The engine does not implement a Humanlike recorder; it exposes the seam for one.

## 2. One platform, three entry points

```text
Studio UI (Supabase session)      External agent (MCP)            Render worker / scheduler
        │  /v1/studio/*                  │  /mcp                         │  /v1/worker/*, /v1/cron/tick
        └──────────────┬─────────────────┘                               │
                       ▼                                                 ▼
        authenticate → resolve organization → scope check → typed domain function
                       │                (packages/engine/src/{studio,render,schedule,billing,director}.ts)
                       ▼
        Supabase Postgres (RLS on every table) · private Storage bucket `media` · append-only ledgers
```

The UI, the AI Creative Director and every MCP tool call the same functions. There is no second service, no mock toolchain and no path that writes state without going through them. Every function works without a model.

## 3. Authentication and authorization

| Caller | Credential | Becomes |
| --- | --- | --- |
| Person in the studio | Supabase access token (ES256, verified against the project JWKS: signature, issuer, `aud=authenticated`, expiry) | `human` principal; role from `memberships` |
| Agent, token mode | `fct_…` workspace token created by an owner/admin in the studio. Shown once; only its SHA-256 is stored; expires ≤ 90 days; revocable | `agent` principal bound to one organization with the scopes chosen at creation |
| Agent, OAuth mode | Supabase OAuth 2.1 access token (carries `client_id`) | `agent` principal acting for that member, limited to agent-grantable scopes |
| Render worker | `RENDER_WORKER_TOKEN` (constant-time compare) | worker; can only claim/complete render jobs |
| Scheduler | `CRON_SECRET` | may run `/v1/cron/tick` |

The organization is always resolved server-side from the credential. An `organizationId` in a request body is never authority. A resource in another organization is reported as `not_found`.

**Scopes.** `campaign:read`, `content:edit`, `render:write`, `schedule:prepare`, `schedule:approve`, `schedule:commit`, `billing:read`, `billing:manage`, `billing:checkout`, `connections:manage`.

| Role | Scopes |
| --- | --- |
| owner, admin | all |
| editor | read, edit, render, prepare, billing:read |
| reviewer | read, prepare, approve, billing:read |
| agent (either mode) | at most read, edit, render, prepare, billing:read, billing:checkout — **never** approve, commit, billing:manage or connections:manage |

Approving a schedule, opening the customer portal and creating or revoking tokens additionally require a `human` principal. An agent calling `approve_schedule` receives `approval_required` with a review URL.

**First sign-in.** The first authenticated request idempotently provisions a personal organization, an owner membership, an empty brand profile, a `free` billing state and the starter render credits. Concurrent first requests converge on one organization (unique `personal_owner_id`).

**Known limitation.** Supabase access tokens carry `aud: "authenticated"`; they are bound to the Faceful Supabase project, not to `/mcp` specifically (no RFC 8707 resource audience).

## 4. HTTP API (`/v1`)

Errors are always `{ "error": { code, message, retryAfterSeconds, reviewUrl } }` with the codes in `errorSchema`. Every response carries `X-Correlation-Id`; responses are `private, no-store`.

| Route | Purpose |
| --- | --- |
| `GET /v1/health` | Which integrations are configured (booleans and safe sentences only) |
| `GET /v1/studio/context` | Workspace, role, scopes, brand, brand kit products, avatars, channels, capabilities, connections, workspaces |
| `GET /v1/studio/campaigns`, `/campaigns/:id` | Projects with items, jobs and activity (also sweeps timed-out render jobs) |
| `GET /v1/studio/items/:id/versions` | Immutable version history |
| `GET /v1/studio/items/:id/review` | The item's latest content review, or `null` (§13) |
| `GET /v1/studio/jobs/:id` | Render job status and event trail |
| `GET /v1/studio/templates` | Curated templates |
| `GET /v1/studio/personas` | Personas with their consent status and looks; photo links are signed for 15 minutes and only for signed-in people |
| `GET /v1/studio/billing` | Plan status and credit balance from server truth |
| `GET /v1/studio/clone/source?url=` | What a YouTube, TikTok or Instagram link points to: canonical link, the platform's embed player, title and author from its oEmbed (Instagram: embed only). Follows TikTok short links. Counts against the `costly` limit; stores nothing |
| `GET /v1/studio/clone/jobs` | The workspace's latest clone jobs with state; `resultUrl` is a signed link once a worker has made the video |
| `POST /v1/studio/director/turn` | AI Creative Director turn (see §8) |
| `POST /v1/studio/workspace/select` | Remember the active organization |
| `POST /v1/studio/operations/:name` | Typed side-effecting operations (below) |
| `POST /v1/stripe/webhook` | Stripe webhook (raw-body signature verification) |
| `POST /v1/worker/render/*` | Render worker protocol (§7) |
| `GET /v1/cron/tick` | Refresh sign-in credentials; sweep stuck renders; process due publish jobs and confirm submitted ones with their provider; renew YouTube webhook subscriptions |
| `GET /v1/socials`, `/v1/socials/:platform` | Platforms, providers and this workspace's connected accounts (below) |
| `POST /v1/socials/providers/:provider/connect`, `/sync` | Connect a provider: with the workspace's own credentials (answers its accounts), or by signing in (answers `{ authorizeUrl }`); re-read a credentials provider's accounts |
| `GET /v1/socials/providers/:provider/callback` | Where a platform returns the person after sign-in; passes them on to `/studio/connect/:provider` (no member session) |
| `POST /v1/socials/providers/:provider/complete` | `{ code, state }`: the signed-in person finishes the sign-in they started |
| `DELETE /v1/socials/providers/:provider`, `/v1/socials/accounts/:id` | Disconnect a provider, or remove one account connected through a provider; posts still waiting for it are cancelled (`cancelledPosts`) |
| `POST /v1/socials/:platform/webhook` | Signed delivery of account activity, in the platform's own format or the generic one (no member session) |
| `GET /v1/socials/:platform/webhook` | The check a platform makes when the address is registered |
| `GET /v1/socials/events` | Stored activity, newest first; signed-in members only |

Operations: `start_campaign`, `add_draft`, `revise_content`, `restore_version`, `update_brand`, `draft_brand_from_website` (input `{ url, operationKey }`, `content:edit`, rate limited as costly: reads one public https page and returns a brand kit proposal it never saves; see SECURITY.md for its outbound-request guards), the brand kit's products and the content review (§13: `create_product`, `update_product`, `delete_product`, `product_image_upload_url`, `place_product`, `review_content`, `approve_review`), `add_source`, `remove_source`, `render_content`, `cancel_jobs`, `prepare_schedule`, `approve_schedule`, `commit_schedule`, `create_agent_connection`, `revoke_agent_connection`, `create_from_template`, `create_sample_project`, `create_clone_job`, `create_checkout`, `create_portal`, `connect_channel`, `disconnect_channel`, and for personas (signed-in members with `content:edit`, never agents) `create_persona`, `update_persona`, `delete_persona`, `withdraw_persona_consent`, `persona_image_upload_url`, `create_persona_look`, `update_persona_look`, `delete_persona_look`. A persona's consent is recorded by the person, with the face scan running inside the studio's Personas tab (or at `/face-scan?persona=<id>` on their own device); the studio and `/face-scan` are the only pages whose headers allow the camera, microphone and WebAssembly. `POST /v1/studio/likeness/consents` with `personaId` links it when the persona has no live consent, and answers `personaId: null` otherwise. `create_run_grant` answers `unsupported`. Names are looked up in a `Map` of own entries, so inherited names such as `constructor` or `__proto__` are `not_found` (verified on production, 15 Nov 2026).

**Limits.** JSON bodies on `/v1` and `/mcp` are capped at 256 KB (`413 validation_error`; a declared `Content-Length` over the cap is refused before reading). Requests are rate limited in fixed one-minute windows counted in Postgres (`engine_rate_limit_hit`), so limits hold across function instances:

| Bucket | Default per minute | Keyed by |
| --- | --- | --- |
| `principal` | 240 | user, OAuth agent or workspace token (IDs only) |
| `director` | 10 | principal, for Director turns |
| `costly` | 10 | principal, for `render_content`, `create_checkout`, `connect_channel`, `create_clone_job`, `review_content`, and a social provider's `connect`, `sync` and `complete` |
| `anonymous` | 120 | client network, requests without a credential |
| `failed_auth` | 60 | client network, requests whose credential was refused |

An exceeded limit is `429 quota_exceeded` with `retryAfterSeconds`, a `Retry-After` header, and the IETF `RateLimit-Policy` / `RateLimit` headers (for example `"principal";q=240;w=60` and `"principal";r=237;t=53`). The Stripe webhook, social deliveries with a valid signature, an authorized cron tick and the render worker are exempt; a social delivery whose signature is refused counts against `failed_auth`, and the address check (`GET /v1/socials/:platform/webhook`) and the sign-in return (`GET /v1/socials/providers/:provider/callback`) against `anonymous`. If the limiter's database call fails, requests are let through with a structured log (fail open), except `failed_auth`, which falls back to a per-instance counter. Limits are set with `RATE_LIMIT_*` variables (`.env.example`).

Mapping from the brief's suggested action contract: `StartDraft` → `start_campaign` / `director/turn` / `create_from_template`; `EditDraft` → `revise_content` (version-checked patch) or a director proposal; `ListAvatars` → `context.avatars`; `StartRender` → `render_content`; `RenderResult` → `GET /jobs/:id` plus `item.media`; `GetAsset` → `campaigns/:id` and `versions`; `ProposeSchedule` → `revise_content` (`patch.targets`) then `prepare_schedule`; `ApproveSchedule` → `approve_schedule`; `BillingStatus` → `GET /billing`; `CreateCheckout` → `create_checkout`.

**Idempotency.** Every operation takes an `operationKey` (UUID). The same key with the same request replays the recorded result; the same key with a different request is `idempotency_conflict`. The ledger is per organization and shared by the UI and MCP. Side effects also carry their own guards: revision compare-and-swap, one active render per item revision (partial unique index), unique credit-ledger references, a unique publication-intent key, and Stripe event IDs.

### Social accounts (`/v1/socials`)

Three lists in `packages/engine/src` drive this area, and each grows by one entry: `SOCIAL_PLATFORMS` (`tiktok`, `instagram`, `linkedin`, `youtube`, and `whatsapp` marked `kind: "messaging"`), `socialProviders` (how a platform is reached: `buffer`, `humanlike` as Humanlike's partner, and `instagram` and `tiktok` for direct connections) and `SOCIAL_EVENT_TYPES`.

**Off by default.** Without `SOCIALS_CREDENTIAL_KEY` no account can be connected and nothing can be posted; without `SOCIALS_WEBHOOK_SECRET` generic deliveries are refused; each platform's own format needs that platform's credentials. `GET /v1/health` reports all three.

**Accounts.** A connected account is a `provider_connections` row naming its platform and provider. Connecting is a signed-in owner's or admin's act (`connections:manage`); agents cannot. For Buffer the body is `{ "apiKey": "…", "organizationId"?: "…" }`: the key is checked against Buffer, its channels on the platforms above become accounts, and the key is stored encrypted (AES-256-GCM, bound to the workspace and provider) and never returned. A YouTube channel connected in the studio with Google (§12) is provider `direct` and is managed there; the same account connected through Buffer, or Instagram directly (provider `instagram`), is a separate row. The studio schedules to Instagram, TikTok and YouTube only; accounts on other platforms are listed here but are not schedule targets yet.

**In the studio.** Settings (`/studio/?view=settings`, hidden in the local fixture) lists every connected account with how it is reached, removes the ones connected through a provider, connects Buffer with its API key and starts the Instagram sign-in; a YouTube channel connected with Google is listed and managed in Schedule. Webhooks are not a setting: nobody copies or registers an address. Each account is subscribed to its platform's activity by the engine when it connects (below), and its row only says whether that activity comes in yet (`webhookSubscribedAt`). `GET /v1/socials` also answers `canManage` (a signed-in owner or admin), which decides whether the view offers its buttons.

**Instagram, directly** (`socials-instagram.ts`, "Instagram API with Instagram Login"). Needs `INSTAGRAM_LOGIN_APP_ID`, `INSTAGRAM_LOGIN_APP_SECRET`, `APP_BASE_URL` and `SOCIALS_CREDENTIAL_KEY`; the Meta app lists `<APP_BASE_URL>/v1/socials/providers/instagram/callback` as an OAuth redirect URI. The person starts at `/studio/connect/instagram`: `connect` answers Instagram's authorize address with a `state` signed by the engine (workspace, person, 15 minutes). Instagram returns their browser to `callback`, which has no session to trust and only forwards the one-time code to the studio page after `#`; the page calls `complete` with the person's session, and the engine refuses unless that person started that sign-in in that workspace. The code is traded for a 60-day token (stored encrypted, renewed by the scheduler once under 30 days are left; an account Instagram refuses becomes `expired`), the account is stored under the ID Instagram's webhooks name, and its comments and messages are subscribed (`webhookSubscribedAt` on the account says whether that worked). A subscription Instagram did not take is asked for again on the scheduler tick, at most every six hours, until it does; one that took does not lapse and is not asked again. Only professional accounts can connect.

**TikTok, directly** (`socials-tiktok.ts`, Login Kit and the Content Posting API). Needs `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `APP_BASE_URL` and `SOCIALS_CREDENTIAL_KEY`; the TikTok app lists `<APP_BASE_URL>/v1/socials/providers/tiktok/callback` as a Login Kit redirect URI and has `video.publish` approved. Signing in works like Instagram's (start at `/studio/connect/tiktok`, signed `state`, the code finished by the same person). The code is traded for a 24-hour access token and a 365-day refresh token (stored encrypted); the account is stored under its `open_id`, the ID TikTok's webhooks name. Tokens are renewed on the scheduler tick and, because that tick may run once a day, also right before a post or a status check uses them; a refresh token TikTok refuses marks the account `expired`. Posting: `creator_info` is asked first (the visibility must be one the account allows, and the video within its longest length), then a Direct Post is started with the approved caption, the visibility (public is `PUBLIC_TO_EVERYONE`, private `SELF_ONLY`, unlisted is refused), comments, duets and stitches off, nothing declared commercial and `is_aigc` from the AI disclosure. The file is uploaded from the server (`FILE_UPLOAD`, one piece up to 64 MB, else 10 MB pieces), so no domain is verified with TikTok. A failure before the last piece is retried as a new post (nothing was published); a last piece whose answer is lost is left to TikTok's status. The scheduler waits about half a minute for `PUBLISH_COMPLETE`, then leaves it to later checks. Until TikTok audits the app, it can only post privately to accounts set to private; TikTok's refusal is shown in those words.

**Humanlike, as a partner** (`socials-humanlike.ts`). Faceful is one of Humanlike's partner apps, like kanesite.gr and dikio.gr: Humanlike holds the TikTok and Instagram accounts under its own reviewed platform apps, in a Humanlike workspace that belongs to one Faceful workspace, and Faceful never sees a platform token. Every call sends the workspace key (`x-humanlike-key: hlpk_…`); Humanlike pins it to that workspace whatever the body says. `connect` takes either `{ "apiKey": "hlpk_…" }` (a workspace Humanlike made by hand) or, where the deployment has `HUMANLIKE_PARTNER_CLIENT_ID` / `_SECRET`, an empty body: the engine calls `POST /partners/tenants` with `faceful-<workspace id>@<HUMANLIKE_TENANT_EMAIL_DOMAIN>` and `rotate: true`, so each Faceful workspace has its own Humanlike workspace and connecting again replaces the key on every row (`GET /v1/socials` shows `provisioned: true` on the provider when that works). Accounts come from `POST /integrations/content/accounts` (TikTok and Instagram only: Humanlike keeps YouTube data away from partners, and its LinkedIn path posts text only); an account is stored under its Humanlike connection id (`external_account_id` is `humanlike:<id>`, so platform webhooks do not match it). A post is saved with `POST /integrations/content/save`, due now, under a UUID derived from the publish job, and Humanlike's 30-second publisher sends it; later checks read `POST /integrations/content/list` until the platform's result is in. Saving the same job again updates that one post, and Humanlike answers 409 once it is sending or sent, so a network failure is retried safely. Instagram: public only, AI disclosure passed as `is_ai_generated`, the video fetched from the signed link. TikTok: the video is first copied into the Humanlike workspace (`/integrations/content/upload`, up to 250 MB, MP4, MOV or WebM), `creator-info` must allow the privacy level (public is `PUBLIC_TO_EVERYONE`, private `SELF_ONLY`, unlisted is refused) and the video's length, and the post carries Humanlike's checked TikTok choices: comments, duets and stitches off, nothing declared commercial, and a fingerprint over the reviewed account, caption, file and choices. A TikTok post approved with an AI disclosure is refused, because Humanlike cannot set TikTok's AI-generated label yet. A video TikTok leaves in the account's inbox counts as failed.

*Connecting accounts into the Humanlike workspace* is still Humanlike's side. Its `POST /partners/connect` (approved partners only, a `redirect` on the partner's allowed origins) starts Google Business Profile only. Until it takes `tiktok` and `instagram`, a Humanlike member of that workspace connects the accounts on humanlike.co with workspace (not personal) visibility, and the workspace is found in Humanlike by its `faceful-<workspace id>@…` address. kanesite.gr works the same way: one partner workspace, accounts connected there by staff, each post sent with `publish-now`.

**Posting.** There is no "create post" route: a post goes out only through an approved schedule (§5). An account connected through Buffer posts through Buffer: the scheduler hands the post over on its first tick at or after the approved time. Buffer is told to share immediately, fetches the video from a signed URL with at least an hour left, and is asked again on later ticks (and, at most once a minute, when an open project is read) until it reports the post sent or refused. Buffer has no idempotency key, so an unclear answer fails the post instead of retrying it. Instagram directly is two steps: a Reel container is created from the video link (with the AI disclosure flag), then published once Instagram has processed it. The scheduler waits up to a minute for that; a video that takes longer is published by a later check (a scheduler tick, or an open project), within the day Instagram keeps a container. One check at a time holds a post, so it is published once. An unclear publish is not repeated: the container itself reports whether it was published. Both providers refuse a post approved as private, because neither platform path can post privately.

**Activity.** Each platform has one delivery address, `/v1/socials/:platform/webhook`, which takes two formats. Events are stored once per workspace that has the account connected (`social_events`, unique on platform, type and the sender's `id`); events for unknown accounts are counted and dropped. Types: `post.created`, `post.failed`, `post.deleted`, `story.created`, `comment.created`, `comment.deleted`, `like.created`, `like.removed`, `share.created`, `mention.created`, `follower.created`, `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, `message.deleted`, `account.disconnected` (which also marks the account `expired`). Buffer sends no webhooks; the scheduler records `post.created` or `post.failed` itself when Buffer settles a post.

*The generic format* is marked by its header: `X-Faceful-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">` with `SOCIALS_WEBHOOK_SECRET`, valid for five minutes. The body is `{ "source"?: "…", "events": [ { "id", "type", "accountId" | "externalAccountId", "occurredAt"?, "actor"?, "subject"?, "text"?, "data"? } ] }`. It is what Faceful's own provider, or any automation, sends, and a malformed one is refused.

*The platform's own format* is anything without that header (`socials-webhooks.ts`). Each is switched on by its credentials and listed in `GET /v1/health` (`socials.nativeWebhooks`). Anything in a genuine delivery that has no place in the list above is skipped, never refused.

| Platform | Credentials | Address check (`GET`) | Delivery signature | Becomes |
| --- | --- | --- | --- | --- |
| Instagram | `INSTAGRAM_APP_SECRET`, `INSTAGRAM_WEBHOOK_VERIFY_TOKEN` | `hub.verify_token` matches → echo `hub.challenge` | `X-Hub-Signature-256: sha256=` HMAC of the body | Comments (also live), mentions, messages received/sent/deleted/read, message reactions as `like.*` |
| WhatsApp | `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Same as Instagram | Same as Instagram | Messages received, reactions as `like.*`, sent/delivered/read/failed receipts. The account is the business phone number ID |
| TikTok | `TIKTOK_CLIENT_SECRET` | None | `TikTok-Signature: t=…,s=` HMAC-SHA256 of `"<t>.<body>"` | `post.created` (video published), `post.failed`, `account.disconnected`. The account is the user's open ID |
| YouTube | `YOUTUBE_WEBHOOK_SECRET` | Echo `hub.challenge` only to subscribe a connected channel or unsubscribe one that is not | `X-Hub-Signature: sha1=` HMAC of the body | `post.created` for an upload. The account is the channel ID |
| LinkedIn | `LINKEDIN_CLIENT_SECRET` | `challengeCode` (hex and dashes only) → its HMAC-SHA256 | `X-LI-Signature`: hex HMAC-SHA256 of `"hmacsha256=" + body` | Page likes, comments, shares, mentions. The account is the organization URN |

No platform reports a like on a post or a new story, and TikTok and YouTube report no comments. Instagram, WhatsApp, TikTok and LinkedIn deliver only to an app registered with them that the account has authorized; that authorization is still a manual step in each platform's console, except for an Instagram account connected directly, which is subscribed when it connects (and again until that takes). YouTube needs no app: the engine subscribes each connected channel (connected in the studio or through Buffer) at Google's hub when it is connected and again on the scheduler tick once the subscription is two days old (`provider_connections.webhook_renewed_at`).

## 5. Lifecycles (kept separate)

**Content item.** `draft → queued → rendering → ready`, or `failed`. Every save writes an immutable `content_versions` row and increments `revision`. Edits to script, avatar, language or style clear `renderRevision` (the old file stays attached as an explicitly older render). Every edit clears `approved_revision`, marks open schedule manifests `stale` and cancels not-yet-sent publish jobs for that item. Restoring a version writes a *new* revision; if that exact content was already rendered, its file is reused.

**Render job.** `queued → running → succeeded | failed`, plus `cancel_requested → cancelled`. A job can become `succeeded` only after the engine finds the uploaded object in private storage, checks its size and computes its SHA-256. Queued jobs nobody claims (default 60 min) and running jobs that stop reporting (default 20 min) fail visibly. Failure, cancellation and timeout return the held credit exactly once.

**Publish.** Draft times on items → `schedule_manifests` (`required → approved → committed`, or `stale`) → `publish_jobs` (`scheduled → processing → submitted → verified_published | failed | cancelled`). The manifest hash covers exact versions, file hashes, accounts, times and copy. At send time the worker re-checks the approved revision, the file hash and the account. A destination is reached through its account: **a YouTube channel connected in the studio uses the YouTube adapter, only where the deployment is configured for it (§12); an account connected through a social provider (Buffer, or Instagram directly) posts through that provider, only where `SOCIALS_CREDENTIAL_KEY` is set (§4, Social accounts).** Otherwise the entry carries a blocker and nothing is posted.

**Billing.** `free | checkout_pending | trialing | active | past_due | unpaid | paused | incomplete | cancelled`, or `not_configured` when Stripe keys are absent. Only verified webhooks change it. See `STRIPE_SANDBOX_SETUP.md`.

**Credits.** Append-only `credit_ledger`; balance is the sum. A render holds `RENDER_CREDIT_COST` atomically (`engine_hold_credits`, advisory-locked) at admission, for the UI and MCP alike. Paid invoices grant `STRIPE_DEMO_PLAN_CREDITS` once per invoice.

## 6. Humanlike — what is verified

Source: <https://humanlike.co/docs/avatars>, read 14 November 2026, and one unauthenticated call to the live API.

| Question | Answer | Evidence |
| --- | --- | --- |
| Asynchronous script-to-video, or realtime? | **Realtime only**, as documented: `POST /v1/avatar/sessions` starts an avatar in a LiveKit room; `DELETE …/{id}` ends it. No script-to-file endpoint, job status, webhook or export is documented. | Docs |
| Does the API exist and how does it authenticate? | Yes. `GET https://api.humanlike.co/v1/avatar/avatars` without a key returns `401 {"error":{"code":"missing_api_key",…}}`. Secret keys `hk_live_…`; publishable keys are refused. | Live call |
| Avatars | Head: `minas_kontis` (client and video render modes). Many full-body avatars render in the browser only (`render_unsupported` for video). | Docs; not yet confirmed with a key |
| Models | `humanlike/loco-1` available; `head-1`, `homo-1` "coming soon"; `homo-1-pro` not live. | Docs |
| Output | Video mode publishes 512×512 at 25 fps into the LiveKit room; "works with room recording". No file URL is returned. | Docs |
| Voices and Greek | Not documented. The avatar lip-syncs supplied audio; language depends on the text-to-speech voice the recorder uses. **Greek quality is unverified.** | — |
| Cost and limits | Billed per started minute from Humanlike credits; price not stated. 60 requests/min per key. Sessions auto-stop after 120 minutes. `Idempotency-Key` returns the same session. | Docs |

**Consequence.** A playable file needs a recorder around a session: a LiveKit room, a text-to-speech voice, the Humanlike avatar in video mode, and an egress or recorder that writes MP4/WebM. That needs a Humanlike secret key, LiveKit credentials and a voice provider. None of these has been supplied to this workstream, so **no Humanlike render has been produced or claimed**.

Implemented here: `packages/engine/src/providers/humanlike.ts` (list avatars, start/end session, normalized errors — exercised against documented shapes only), avatar listing in `context.avatars` when `HUMANLIKE_API_KEY` is set (video-capable avatars only), and the worker protocol below.

**Open questions for Minas.** (1) Is there, or will there be, a prerecorded/export endpoint? (2) Which voice provider and which Greek voice? (3) Exact session response fields in video mode. (4) Per-minute price and concurrency. (5) Whether `homo-1-pro` ("for recorded video") will be offered and with what job semantics.

## 7. Render worker protocol

Authenticated with `Authorization: Bearer <RENDER_WORKER_TOKEN>`. Reference client: `scripts/render-worker.ts`.

| Call | Body | Result |
| --- | --- | --- |
| `POST /v1/worker/render/claim` | `{ workerId }` | `{ job: { id, itemId, revision, avatarId, script, language, settings, attempt, correlationId } \| null }` — one worker wins each job |
| `POST …/:id/progress` | `{ providerStatus, providerJobId? }` | `{ cancelRequested }` — heartbeat; also how a worker learns of a cancellation |
| `POST …/:id/upload-url` | `{ mime: "video/mp4" \| "video/webm" }` | `{ uploadUrl, method: "PUT", headers, path }` — signed, server-chosen path |
| `POST …/:id/complete` | `{ durationSeconds, hasAudio, width?, height?, providerJobId? }` | `{ state: "succeeded", mediaAssetId }` — refused unless the object exists; replay-safe |
| `POST …/:id/fail` | `{ code, message }` | `{ state: "failed" \| "cancelled" }` — returns the held credit |

`scripts/render-worker.ts run --exec <recorder>` loops claim → recorder → upload → complete, passing `FACEFUL_SCRIPT`, `FACEFUL_AVATAR_ID`, `FACEFUL_LANGUAGE` and `FACEFUL_OUTPUT`. Rendering is reported as connected (`capabilities.canRender`) only when `RENDER_WORKER_TOKEN` is set; otherwise `render_content` answers `provider_unavailable` and holds no credit.

Media is stored at `media/<org>/<item>/r<revision>-<job>.<ext>` in a private bucket and served through signed URLs that expire after one hour.

## 8. AI Creative Director

`POST /v1/studio/director/turn` takes `{ campaignId, itemId, scope, instruction, sourceIds, history, operationKey }` and returns `{ mode, summary, plan, created, open, assets, suggestions }`.

- **Retrieval** ("find / show / play / open / list …") is answered by fixed rules, never by a model, and never starts generation.
- **Create** saves a project and its drafts immediately (free and reversible). Nothing is rendered or scheduled.
- **Edit, schedule, render, schedule review, checkout** come back as a `plan` of typed actions (`revise`, `render`, `review_schedule`, `checkout`). A person applies each one; each runs through the normal operation with its scope, revision and quota checks.
- The model has no tools and no credentials. Its output is schema-validated; item IDs outside the current project are dropped; presenters that are not authorized for the workspace and language are dropped. Source text, earlier messages and workspace content are passed as data.
- Without a model key (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY` or the AI Gateway) the director runs in `basic` mode: lookups, credits and schedule review work, and it says plainly that it cannot write.

Model: with `GEMINI_API_KEY`, `gemini-4-hydrogen` through Google's `generateContent` API (key in the `x-goog-api-key` header), the plan's JSON Schema as `responseJsonSchema`, thinking level `low`, one retry on a server error. With `ANTHROPIC_API_KEY`, `claude-opus-5-5` through the Anthropic SDK, structured output, low effort, with server-side refusal fallback enabled (`fallbacks: "default"`); if both keys are set, Anthropic is used unless `DIRECTOR_PROVIDER=gemini`. Override the model with `DIRECTOR_MODEL`. Either way the reply is validated against the same plan schema before anything is saved.

## 9. MCP

`POST /mcp` — Streamable HTTP, stateless, protocol `2025-11-25` (`@modelcontextprotocol/sdk` 1.32.2). The 2026-07-28 revision is not implemented; a client offering it is answered `2025-11-25`. Protected-resource metadata is at `/.well-known/oauth-protected-resource[/mcp]`; the authorization server is Supabase Auth.

Tools (25):
- **Drafting, rendering, schedule and billing:** `list_projects`, `create_project`, `create_draft`, `revise_draft`, `list_avatars`, `start_render`, `get_render_status`, `list_assets`, `get_asset`, `propose_schedule`, `approve_schedule`, `get_billing_status`, `create_checkout_link`.
- **Reel production** (`docs/agents/reel-production.md`): `list_draft_files`, `save_text_draft`, `request_file_upload`, `complete_file_upload`, `get_video_timeline`, `save_video_timeline`, `queue_video_render`, `get_video_renders`. Draft files need the files store, and `queue_video_render` needs a Remotion render worker. Neither is configured on production yet (`/v1/health`: `files.connected` and `reelRendering.connected` are false).
- **Products and review** (§13): `list_products`, `place_product`, `review_content`, `get_review`. No tool approves a review.

Each tool maps to one engine function and inherits its checks. Side-effecting tools accept `idempotencyKey`.

A POST may carry 1–10 JSON-RPC messages (otherwise `-32600`); every message counts against the caller's `principal` bucket, and `start_render` / `create_checkout_link` / `review_content` also count against `costly`. Going over `principal` refuses the whole POST with `429` and the headers above; going over `costly` inside a call returns a tool error with `quota_exceeded` and `retryAfterSeconds`; the server's `instructions` tell agents to wait that long rather than retry at once. Unauthenticated calls get `401` with the protected-resource metadata link and count against `anonymous` or `failed_auth`.

## 10. Data model

Tables (all with RLS enabled): `organizations`, `memberships`, `user_state`, `brand_profiles`, `projects`, `content_items`, `content_versions`, `media_assets`, `render_jobs`, `job_events`, `audit_events`, `operations`, `schedule_manifests`, `publish_jobs`, `provider_connections`, `agent_connections`, `billing_customers`, `billing_state`, `checkout_sessions`, `stripe_events`, `credit_ledger`, `social_events`, `likeness_consents`, `personas`, `persona_looks` (one consent backs at most one persona; looks hold private R2 photo keys), `brand_products`, `content_reviews` (§13; server only, like personas), plus the earlier `castroom_director_access` / `castroom_director_entries`.

Browsers can `SELECT` their own organization's projects, items, versions, media rows, jobs, events, audit, manifests and publish jobs. Browsers cannot write any engine table, and cannot read ledgers, tokens, idempotency records, billing or Stripe events. All writes go through the engine with the server secret key. Project chat access (`castroom_director_access`) is granted by the engine when a project is created.

## 11. Not implemented

- A Humanlike recorder (needs credentials; Minas's seam).
- TikTok publishing with Faceful's own TikTok app (needs the platform’s app review). YouTube is implemented (§12); Instagram can be connected directly, through Buffer or through Humanlike, TikTok through Buffer or Humanlike (§4, Social accounts).
- Connecting TikTok and Instagram accounts into a Humanlike partner workspace from Faceful (needs Humanlike's `/partners/connect` to take those providers), and TikTok's AI-generated label through Humanlike.
- Direct connections other than Instagram (and YouTube, §12): TikTok, LinkedIn and WhatsApp are reached through Buffer or not at all. Their own webhooks are accepted, but subscribing an account to them is automated only for YouTube and for a directly connected Instagram account.
- Replying to comments or messages; activity is stored and listed, nothing is sent back.
- Scheduling to LinkedIn or WhatsApp (accounts connect; the studio's destinations are still Instagram, TikTok and YouTube).
- A studio screen for reading activity (comments, messages). Settings lists and connects accounts and shows the webhook addresses; stored events are only available from `GET /v1/socials/events`.
- Website import and brand extraction. (Draft file uploads exist for reel production, through signed upload links to the files store, which is not configured on production yet.)
- Collaborator invitations (the role model and checks exist; there is no invite flow).
- Unattended publishing grants (`create_run_grant`).
- Realtime push; the studio polls every five seconds.
- Per-workspace (as opposed to per-principal) rate limits; edge/WAF rules in front of the functions.

## 12. Publishing: YouTube

YouTube channels are connected and published to here, with Google. Instagram and TikTok are reached only through accounts connected under `/v1/socials` (§4, Social accounts: Buffer, or Instagram directly). Where no provider can reach them (no `SOCIALS_CREDENTIAL_KEY`), a schedule that names them carries the blocker "Instagram and TikTok publishing need each platform’s app review; not available yet."; otherwise it asks for a connected account to be chosen.

**Configuration.** `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` (the same Google OAuth client Supabase Auth uses) and `CONNECTIONS_ENCRYPTION_KEY` (32 random bytes, base64). Without all three, `GET /v1/studio/channels` reports YouTube as `not_configured` with the reason, `capabilities.canConnectChannels` is false and `connect_channel` answers `unsupported`. `GET /v1/health` lists `publishing.adapters`.

**Connecting (people only: owner or admin, never an agent).** The studio starts Supabase Auth identity linking for Google with the scopes `youtube.upload` and `youtube.readonly`, `access_type=offline` and `prompt=consent` (Supabase project setting `security_manual_linking_enabled` is on). Google shows its own account and channel chooser and returns through Supabase's registered callback. The browser then holds a Google access token and refresh token once; it posts them to `connect_channel` and refreshes its session so they do not stay in browser storage. If Google signed a different Faceful account in, the studio signs out instead of continuing.

`POST /v1/studio/operations/connect_channel` `{ platform: "youtube", accessToken, refreshToken, operationKey }` verifies, in order, before storing anything: (1) Google's `tokeninfo` says the access token was issued to this deployment's client and includes `youtube.upload`; (2) the refresh token can be exchanged with this client's secret; (3) `channels.list?mine=true` with that fresh token names the channel. The channel ID and title come from Google, never from the request. The refresh token is stored in `provider_connections.credentials_ciphertext` as `v1.<iv>.<tag>.<ciphertext>` (AES-256-GCM, random IV). Tokens are sent to Google only in form bodies or an `Authorization` header, never in a URL, and are never logged or returned. `disconnect_channel` `{ connectionId, operationKey }` cancels that channel's unsent posts, revokes the grant at Google (best effort) and deletes the row.

**Publishing.** The schedule path is unchanged: draft times → `prepare_schedule` → a person's `approve_schedule` → `commit_schedule`. With a connected channel chosen on the item, a YouTube entry becomes approvable. Because YouTube holds a private video until `publishAt`, `commit_schedule` uploads immediately (at most three per request; the scheduler takes the rest): a **public** post is uploaded `private` with `publishAt` = the approved instant; private and unlisted posts are uploaded with that privacy and no release time. Metadata: title (the YouTube variant's, else the item's, ≤ 100 chars), description = caption, `selfDeclaredMadeForKids: false`, `containsSyntheticMedia` = the variant's AI disclosure.

| Publish job state | Meaning | Studio target state |
| --- | --- | --- |
| `scheduled` | Waiting to be sent (or waiting to retry after a definite refusal) | `queued` |
| `processing` | Being sent; if the outcome is unknown it stays here and is failed after 15 minutes — never re-sent automatically | `queued` |
| `submitted` | YouTube returned a video ID (`providerId`). Uploaded, and scheduled when public. **Not** published | `accepted` |
| `verified_published` | `videos.list` reported `uploadStatus: processed` and `privacyStatus: public` | `published`, with `publishedUrl` |
| `failed` | Refused, rejected by YouTube, channel access revoked, or outcome unknown | `failed`, with the reason |

Verification runs on the scheduler tick and, throttled to once a minute per post, when an open project is read. `publishedUrl` is exposed only for `verified_published`; an uploaded-but-private video is identified by `providerId` (open it at `https://studio.youtube.com/video/<providerId>/edit`).

**The audit restriction.** Google keeps videos uploaded through API projects that have not passed YouTube's API audit locked to private. Until the Google project behind this client is audited, a "public" post is uploaded and scheduled but can remain private after its release time; the job then stays `submitted` and the target shows why. Nothing is reported as published without YouTube saying so.

**Failure handling.** `invalid_grant` on refresh marks the connection `expired` and fails the job with "Reconnect YouTube; the approved post was not sent." Transient refusals before any upload retry with backoff (1, 5, 15, 60 minutes). An edit after approval cancels unsent posts. A send whose result cannot be determined is never retried.

**Verified without a user:** Google's real responses for an invalid access token (`tokeninfo` 400 `invalid_token`, Data API 401 `authError`), `invalid_grant` for an invalid refresh token with this client ID and secret (so the pair is valid), and that Supabase returns a Google authorization URL carrying the YouTube scopes, `access_type=offline`, `prompt=consent select_account` and the registered callback. **Not verified:** a person completing Google consent, whether the YouTube Data API is enabled on the Google project, a real upload, and the audit status.

## 13. Products and content review

Contract: `packages/contracts/src/quality.ts` (schemas, routes, statuses) and `quality-rules.ts` (the deterministic rules the engine and the studio's local fixture share, English and Greek). Engine: `products.ts`, `review.ts`, `review-model.ts`. Tables: `brand_products` and `content_reviews` (`supabase/migrations/20261115160000_products_reviews.sql`; RLS on, no policies, no browser grants).

**Products.** Up to 24 per workspace, each with a name, a description, a domain (`general`, `health` or `finance`), up to 12 approved facts and an optional photo. A script may restate an approved fact; any other product claim needs a source or an expert. Same permission as `update_brand`: `content:edit`, for people and agents.
- `create_product`, `update_product` (only the fields sent change; `imageKey: null` removes the photo), `delete_product`.
- `product_image_upload_url` `{ type, size, sha256 }` → `{ key, uploadUrl, headers, expiresAt }`: one PUT of exactly those bytes to `orgs/<org>/products/<uuid>.<jpg|png|webp>`, then pass `key` as `imageKey`. The engine accepts only a key in this workspace's products folder that exists, is at most 15 MB and is not another product's; replaced and removed photos are deleted.
- `context.products` lists them in order. `imageUrl` is a 15-minute link for signed-in people and `null` for agents (like persona photos). The context never fails over products: where the table is missing it answers `products: []`.

**`place_product`** `{ itemId, productId, expectedCompositionRevision, layout, at, seconds, endCard, operationKey }` → `{ itemId, compositionRevision, fileId, placedAt, matchedMention }`. Copies the photo into the item's project as an `image` draft file (`meta: { productId, source: "brand_kit" }`; content-addressed, reused when the same photo is placed again), then adds a layer-1 image clip for `seconds`: at `at`, else where the script first names the product (`matchedMention: true`), else one third in, always inside the timeline. With `endCard`, a closing `cta` card shows the photo (once per photo). It saves through `save_composition`, so a newer timeline is `revision_conflict` and is never overwritten. Needs a product photo and the files store.

**`review_content`** `{ itemId, operationKey }` → `ContentReview`. Run by anyone with `content:edit` (people and agents) and by reviewers; counted against `costly`; idempotent by key; audited as "Reviewed the content". It reads the item's current script, revision and language, the project's sources, the brand rules, the products, the saved timeline and its revision, the project's draft files (`avatar_clip` ids; images by `meta.productId`) and the item's target platforms.
- `domain = detectDomain(script, products)`.
- **Claims, basic mode:** `basicClaims`. **AI mode**, when the deployment has a model (`ANTHROPIC_API_KEY` or the AI Gateway, `DIRECTOR_MODEL`, low effort, structured output, server-side refusal fallback): the model reads the script as sentences, the products with their approved facts, the sources' titles and excerpts and the brand rules, all as data, and is told to support a claim only from that material, quoting it exactly, never from outside knowledge, and that any unsourced health or finance benefit is `needs_expert`. The engine then re-checks its answer: claims whose quote is not in the script word for word are dropped; `supported` without an exactly quoted provided fact or source becomes `needs_expert` (health, finance) or `unsupported`; severities may rise above the shared rule's but never fall below it; and every rule-based blocking claim the model's output does not cover (by quote) is kept, a rule's `risky_wording` unless the model flags the same words as blocking too. If the model fails, or the workspace has used its daily allowance (`DIRECTOR_DAILY_TURNS`, counted separately), the review runs in basic mode with a note saying why. `mode` is `ai` only when the model pass succeeded.
- **Findings:** `deliveryFindings` and `visualFindings`. Without a saved timeline both are empty.
- **What was examined:** `checked = { claims: true, timeline: a saved timeline was read, transcript: it has word timings, renderedVideo: false }`. `notes` says what was not examined: the rendered video's frames and audio are never inspected in this build; without a timeline the voice, caption and on-screen checks wait for one; no word timings; the model was not used, or was unavailable and why; claims the model's answer lost or had corrected; and that a review flags wording and does not confirm that a claim is true. Nothing is ever called verified.
- `status = reviewStatus(domain, claims, findings, false)`: blocking items → `needs_changes`; else health or finance → `needs_approval`; else `passed`.

**`approve_review`** `{ reviewId, by, credential, note, operationKey }` → the review with `status: "approved"` and `approval { by, credential, note, principalId, at }`. Signed-in owners, admins and reviewers only. The review must be the item's latest and describe its current revision. Health and finance need the approver's qualification; a review with blocking items needs a note of at least 20 characters saying why they are acceptable. Audited as "Approved a content review".

**`GET /v1/studio/items/:itemId/review`** → the latest review or `null` (`campaign:read`).

**Schedule gate.** `prepare_schedule` adds a blocker for every health or finance item (by `detectDomain` on its current script, with the products) that has no approved review of its current revision. Messages start with `REVIEW_BLOCKER_PREFIX` (`Claims review:`), so the readiness checklist files them under Claims:
- `Claims review: this health script needs an approved review. Open Details → Review.` (or `finance`)
- `Claims review: the script changed after its last review. Run a new review and have it approved. Open Details → Review.`
- `Claims review: reviews are not set up on this deployment yet.` when the reviews (or products) table cannot be read. Scheduling never fails over the gate.

General items are not gated. A blocked item adds no manifest entries, and `approve_schedule` refuses while any blocker remains.

**Director.** The planner's `<workspace>` block carries the products as data (name, description, domain, approved facts). The system prompt says a script may say only what a product's approved facts say, and that health and finance scripts make no cure, treatment or guaranteed-return promise and carry no diagnosis.

**MCP.** `list_products` and `get_review` (read; `get_review` also says whether the review is stale), `place_product` and `review_content` (`content:edit`; `review_content` counts against `costly`). Their descriptions say that approval is a human act in the studio; there is no approve tool, and `approve_review` answers `approval_required` to every agent.

**Errors a client shows.**

| Operation | Code | Message |
| --- | --- | --- |
| `approve_review` by an agent | `approval_required` (403) | Approving a content review must be confirmed by a signed-in workspace member in the studio. Agents cannot do this. |
| `approve_review` by an editor | `forbidden` (403) | Only workspace owners, admins and reviewers can approve a content review. |
| `approve_review`, script changed | `revision_conflict` (409) | The script changed after this review. Run a new review. |
| `approve_review`, newer review exists | `revision_conflict` (409) | A newer review of this item exists. Open it and approve that one. |
| `approve_review`, health/finance without credential | `validation_error` (400) | Add the approver’s qualification, for example “MD, cardiologist”. Health scripts need a qualified approver. (finance: “Certified financial adviser”) |
| `approve_review`, blocking items, short note | `validation_error` (400) | This review still has N blocking items. Write at least 20 characters saying why they are acceptable. |
| `review_content`, `approve_review`, `GET …/review` where the tables are missing | `provider_unavailable` (503) | Content reviews aren’t available on this deployment yet: its database has not been updated for them, or could not be reached. Nothing was changed. |
| `place_product`, timeline changed | `revision_conflict` (409) | This video edit changed after you opened it. Reload the latest version before placing the product. |
| `place_product`, product without photo | `validation_error` (400) | Add a photo to this product in the brand kit before placing it on a video. |
| `place_product`, photo unreadable | `provider_unavailable` (503) | The product photo could not be read from storage. Nothing was changed; try again. |
| `create_product`, 25th product | `validation_error` (400) | A brand kit holds up to 24 products. Delete one to add another. |
| `create_product` / `update_product`, photo key | `validation_error` (400) | That photo does not belong to this workspace’s products. Upload it again. · The photo did not finish uploading. Try again. · That photo is too large. Use one under 15 MB. · That photo is already used by another product. Upload it again. |
| product photo without a files store | `provider_unavailable` (503) | Private file storage isn’t connected on this deployment yet, so a product photo can’t be saved. Add the FACEFUL_R2_* settings. |
| any product or review id from another workspace | `not_found` (404) | This product was not found in your brand kit. · This review was not found in your workspace. |

**On production today.** The migration is not applied to the hosted database yet, so until the owner applies it the context lists no products (each read logs a `store_error` for `brand_products`), product operations answer the database's 503, reviews answer the 503 above, and `prepare_schedule` blocks every health and finance item with "reviews are not set up on this deployment yet". There is no model key, so reviews run in basic mode and say so. The files store is not connected, so product photos and `place_product` answer `provider_unavailable`.
