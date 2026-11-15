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
| `GET /v1/studio/context` | Workspace, role, scopes, brand, avatars, channels, capabilities, connections, workspaces |
| `GET /v1/studio/campaigns`, `/campaigns/:id` | Projects with items, jobs and activity (also sweeps timed-out render jobs) |
| `GET /v1/studio/items/:id/versions` | Immutable version history |
| `GET /v1/studio/jobs/:id` | Render job status and event trail |
| `GET /v1/studio/templates` | Curated templates |
| `GET /v1/studio/billing` | Plan status and credit balance from server truth |
| `GET /v1/studio/clone/source?url=` | What a YouTube, TikTok or Instagram link points to: canonical link, the platform's embed player, title and author from its oEmbed (Instagram: embed only). Follows TikTok short links. Counts against the `costly` limit; stores nothing |
| `GET /v1/studio/clone/jobs` | The workspace's latest clone jobs with state; `resultUrl` is a signed link once a worker has made the video |
| `POST /v1/studio/director/turn` | AI Creative Director turn (see §8) |
| `POST /v1/studio/workspace/select` | Remember the active organization |
| `POST /v1/studio/operations/:name` | Typed side-effecting operations (below) |
| `POST /v1/stripe/webhook` | Stripe webhook (raw-body signature verification) |
| `POST /v1/worker/render/*` | Render worker protocol (§7) |
| `GET /v1/cron/tick` | Sweep stuck renders; process due publish jobs |

Operations: `start_campaign`, `add_draft`, `revise_content`, `restore_version`, `update_brand`, `add_source`, `remove_source`, `render_content`, `cancel_jobs`, `prepare_schedule`, `approve_schedule`, `commit_schedule`, `create_agent_connection`, `revoke_agent_connection`, `create_from_template`, `create_sample_project`, `create_clone_job`, `create_checkout`, `create_portal`, `connect_channel`, `disconnect_channel`. `create_run_grant` answers `unsupported`. Names are looked up in a `Map` of own entries, so inherited names such as `constructor` or `__proto__` are `not_found` (verified on production, 15 Nov 2026).

**Limits.** JSON bodies on `/v1` and `/mcp` are capped at 256 KB (`413 validation_error`; a declared `Content-Length` over the cap is refused before reading). Requests are rate limited in fixed one-minute windows counted in Postgres (`engine_rate_limit_hit`), so limits hold across function instances:

| Bucket | Default per minute | Keyed by |
| --- | --- | --- |
| `principal` | 240 | user, OAuth agent or workspace token (IDs only) |
| `director` | 10 | principal, for Director turns |
| `costly` | 10 | principal, for `render_content`, `create_checkout`, `connect_channel` |
| `anonymous` | 120 | client network, requests without a credential |
| `failed_auth` | 60 | client network, requests whose credential was refused |

An exceeded limit is `429 quota_exceeded` with `retryAfterSeconds`, a `Retry-After` header, and the IETF `RateLimit-Policy` / `RateLimit` headers (for example `"principal";q=240;w=60` and `"principal";r=237;t=53`). The Stripe webhook, an authorized cron tick and the render worker are exempt. If the limiter's database call fails, requests are let through with a structured log (fail open), except `failed_auth`, which falls back to a per-instance counter. Limits are set with `RATE_LIMIT_*` variables (`.env.example`).

Mapping from the brief's suggested action contract: `StartDraft` → `start_campaign` / `director/turn` / `create_from_template`; `EditDraft` → `revise_content` (version-checked patch) or a director proposal; `ListAvatars` → `context.avatars`; `StartRender` → `render_content`; `RenderResult` → `GET /jobs/:id` plus `item.media`; `GetAsset` → `campaigns/:id` and `versions`; `ProposeSchedule` → `revise_content` (`patch.targets`) then `prepare_schedule`; `ApproveSchedule` → `approve_schedule`; `BillingStatus` → `GET /billing`; `CreateCheckout` → `create_checkout`.

**Idempotency.** Every operation takes an `operationKey` (UUID). The same key with the same request replays the recorded result; the same key with a different request is `idempotency_conflict`. The ledger is per organization and shared by the UI and MCP. Side effects also carry their own guards: revision compare-and-swap, one active render per item revision (partial unique index), unique credit-ledger references, a unique publication-intent key, and Stripe event IDs.

## 5. Lifecycles (kept separate)

**Content item.** `draft → queued → rendering → ready`, or `failed`. Every save writes an immutable `content_versions` row and increments `revision`. Edits to script, avatar, language or style clear `renderRevision` (the old file stays attached as an explicitly older render). Every edit clears `approved_revision`, marks open schedule manifests `stale` and cancels not-yet-sent publish jobs for that item. Restoring a version writes a *new* revision; if that exact content was already rendered, its file is reused.

**Render job.** `queued → running → succeeded | failed`, plus `cancel_requested → cancelled`. A job can become `succeeded` only after the engine finds the uploaded object in private storage, checks its size and computes its SHA-256. Queued jobs nobody claims (default 60 min) and running jobs that stop reporting (default 20 min) fail visibly. Failure, cancellation and timeout return the held credit exactly once.

**Publish.** Draft times on items → `schedule_manifests` (`required → approved → committed`, or `stale`) → `publish_jobs` (`scheduled → processing → submitted → verified_published | failed | cancelled`). The manifest hash covers exact versions, file hashes, accounts, times and copy. At send time the worker re-checks the approved revision, the file hash and the account. **YouTube is the only publisher adapter, and only where the deployment is configured for it (§12).** Instagram and TikTok always carry a blocker, so nothing can be posted there.

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
- Without `ANTHROPIC_API_KEY` the director runs in `basic` mode: lookups, credits and schedule review work, and it says plainly that it cannot write.

Model: `claude-opus-5-5` through the Anthropic SDK, structured output, low effort, with server-side refusal fallback enabled (`fallbacks: "default"`). Override with `DIRECTOR_MODEL`.

## 9. MCP

`POST /mcp` — Streamable HTTP, stateless, protocol `2025-11-25` (`@modelcontextprotocol/sdk` 1.32.2). The 2026-07-28 revision is not implemented; a client offering it is answered `2025-11-25`. Protected-resource metadata is at `/.well-known/oauth-protected-resource[/mcp]`; the authorization server is Supabase Auth.

Tools: `list_projects`, `create_project`, `create_draft`, `revise_draft`, `list_avatars`, `start_render`, `get_render_status`, `list_assets`, `get_asset`, `propose_schedule`, `approve_schedule`, `get_billing_status`, `create_checkout_link`. Each maps to one engine function and inherits its checks. Side-effecting tools accept `idempotencyKey`.

A POST may carry 1–10 JSON-RPC messages (otherwise `-32600`); every message counts against the caller's `principal` bucket, and `start_render` / `create_checkout_link` also count against `costly`. Going over `principal` refuses the whole POST with `429` and the headers above; going over `costly` inside a call returns a tool error with `quota_exceeded` and `retryAfterSeconds`; the server's `instructions` tell agents to wait that long rather than retry at once. Unauthenticated calls get `401` with the protected-resource metadata link and count against `anonymous` or `failed_auth`.

## 10. Data model

Tables (all with RLS enabled): `organizations`, `memberships`, `user_state`, `brand_profiles`, `projects`, `content_items`, `content_versions`, `media_assets`, `render_jobs`, `job_events`, `audit_events`, `operations`, `schedule_manifests`, `publish_jobs`, `provider_connections`, `agent_connections`, `billing_customers`, `billing_state`, `checkout_sessions`, `stripe_events`, `credit_ledger`, plus the earlier `castroom_director_access` / `castroom_director_entries`.

Browsers can `SELECT` their own organization's projects, items, versions, media rows, jobs, events, audit, manifests and publish jobs. Browsers cannot write any engine table, and cannot read ledgers, tokens, idempotency records, billing or Stripe events. All writes go through the engine with the server secret key. Project chat access (`castroom_director_access`) is granted by the engine when a project is created.

## 11. Not implemented

- A Humanlike recorder (needs credentials; Minas's seam).
- Instagram and TikTok publishing (each needs the platform’s app review). YouTube is implemented; see §12.
- File uploads, website import and brand extraction.
- Collaborator invitations (the role model and checks exist; there is no invite flow).
- Unattended publishing grants (`create_run_grant`).
- Realtime push; the studio polls every five seconds.
- Per-workspace (as opposed to per-principal) rate limits; edge/WAF rules in front of the functions.

## 12. Publishing: YouTube

YouTube is the one real publishing destination. Instagram and TikTok have no adapter (each needs the platform's app review) and every schedule that names them carries the blocker "Instagram and TikTok publishing need each platform’s app review; not available yet."

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
