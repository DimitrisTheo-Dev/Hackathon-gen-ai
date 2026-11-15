# Security

Faceful lets people and their AI agents draft, render, schedule and pay for short avatar videos. Everything that changes state goes through one domain engine (`packages/engine/src`), reached three ways: the studio (`/v1/studio/*`), external agents over MCP (`/mcp`), and machines (render worker, scheduler, Stripe). This page says what we defend against, how, where the code is, and what is not covered yet.

## Threat model

| Actor | Holds | Can | Must never be able to |
| --- | --- | --- | --- |
| Anonymous visitor | nothing | read public pages, `/v1/health`, OAuth discovery metadata | read or change any workspace; run up cost; flood the API |
| Signed-in member | Supabase session (ES256 JWT) | act in workspaces they belong to, within their role (owner, admin, editor, reviewer) | reach another workspace; exceed their role; read tokens, ledgers or billing internals |
| Connected agent | `fct_…` workspace token, or a Supabase OAuth token carrying `client_id` | draft, revise, render, propose schedules, read billing, open a Stripe test checkout link | approve or publish, manage billing, create tokens, connect channels; treat content as instructions |
| Render worker | `RENDER_WORKER_TOKEN` | claim render jobs, upload to a server-chosen path, report results | mark a job done without a verified stored file; touch anything else |
| Scheduler | `CRON_SECRET` | sweep stuck jobs, send approved posts | anything a person has not approved |
| Stripe | webhook signing secret | report checkout, subscription and invoice events | grant access with an unsigned, replayed or live-mode event |
| Compromised or malicious client | whatever it was given | send any bytes to any route | escalate beyond its credential; exhaust memory, database or model budget; make the server fetch arbitrary URLs |

## Controls

**Tenancy comes from the credential.** `authenticate` and `resolveContext` (`packages/engine/src/access.ts`) derive the principal and organization from a verified token only; an `organizationId` in a body is never authority. Every query filters on `org_id`, and a resource in another workspace is reported as `not_found`. Supabase JWTs are verified against the project JWKS (signature, issuer, `aud`, expiry, asymmetric algorithms only; `runtime.ts`).

**Row-level security behind the API.** Every table has RLS on (`supabase/migrations/`). Browsers can `SELECT` their own organization's projects, items, versions, jobs and audit trail, and can write nothing. Tokens, ledgers, idempotency records, billing, Stripe events and rate-limit counters have no browser access at all. `scripts/test-engine-rls.mjs` applies the migrations to a throwaway Postgres and proves each of these.

**Agent credentials are scoped, hashed and short-lived.** Workspace tokens are 256-bit random, shown once, stored only as SHA-256, expire within 90 days and are revocable (`http.ts` `createConnection`). Agents can hold at most `campaign:read`, `content:edit`, `render:write`, `schedule:prepare`, `billing:read` and `billing:checkout` (`AGENT_GRANTABLE_SCOPES`). Everything arriving through `/mcp` is treated as an agent, even a bare member session (`mcp.ts`).

**People keep the decisions.** Approving a schedule, opening the billing portal, creating or revoking tokens and connecting or disconnecting a channel all require a human principal (`requireHuman`). Approval binds to a SHA-256 hash of the exact versions, files, accounts, times and copy (`schedule.ts`), and any later edit invalidates it. An agent calling `approve_schedule` gets a review link.

**Retries are safe.** Every side effect takes an operation key: the same key and request replays the recorded result, and a different request under the same key is refused (`idempotent` in `access.ts`). Revisions use compare-and-swap; one active render per item revision, unique credit-ledger references, unique publication intents and Stripe event IDs back this up in the schema.

**Payments are sandbox-only and webhook-driven.** Live Stripe keys are refused at configuration, and live-mode objects are refused at runtime (`config.ts`, `billing-stripe.ts`). Clients choose a plan key, never a price ID or amount. Return URLs come from `APP_BASE_URL`, never from the request. Plan and credits change only inside the webhook handler, after signature verification on the raw body, deduplicated by event ID, and with subscription state re-read from Stripe. Credits are granted once per invoice.

**Rate limits.** These live in `packages/engine/src/ratelimit.ts`, backed by `engine_rate_limit_hit` in `supabase/migrations/20261115010000_rate_limit_buckets.sql`. One atomic Postgres statement counts each request in fixed one-minute windows, so limits hold across all function instances. The table is unlogged, has RLS on and no grants, and the function is `security definer` and callable only by `service_role`. Each call also deletes up to 20 expired buckets, so the table stays bounded.

| Bucket | Applies to | Keyed by | Default per minute | Override |
| --- | --- | --- | --- | --- |
| `principal` | every authenticated `/v1/studio/*` request; every JSON-RPC message to `/mcp` | user, OAuth agent or workspace token | 240 | `RATE_LIMIT_PRINCIPAL_PER_MINUTE` |
| `director` | `POST /v1/studio/director/turn` (model calls cost money) | principal | 10 | `RATE_LIMIT_DIRECTOR_PER_MINUTE` |
| `costly` | `render_content`, `create_checkout`, `connect_channel`, `create_clone_job`, `request_file_upload`, `persona_image_upload_url`, `POST /v1/studio/likeness/upload-url`; MCP `start_render`, `create_checkout_link`, `request_file_upload` | principal | 10 | `RATE_LIMIT_COSTLY_PER_MINUTE` |
| `anonymous` | requests with no credential | client network | 120 | `RATE_LIMIT_ANONYMOUS_PER_MINUTE` |
| `failed_auth` | requests whose credential is refused (studio, MCP, worker, scheduler) | client network | 60 | `RATE_LIMIT_FAILED_AUTH_PER_MINUTE` |

- **Rejections** return HTTP 429 with the standard error body (`quota_exceeded`, `retryAfterSeconds`) and `Retry-After`. Limited responses carry the IETF draft `RateLimit-Policy` and `RateLimit` headers, for exactly the buckets that request was counted against.
- **Exemptions.** The Stripe webhook is signature-verified, and dropping a delivery would lose a billing event. An authorized scheduler tick and the render worker are trusted service credentials; wrong secrets for either count as failed authentication.
- **Client network.** This is the left-most `x-forwarded-for` entry, used only behind Vercel's edge, which overwrites that header with the connecting client (`TRUST_PROXY_HEADERS` defaults to `VERCEL=1`). IPv6 is grouped by /64, and only a SHA-256 of the network is stored. Where the client address cannot be trusted (local development), per-network limits are skipped rather than shared by everyone. A valid credential is never refused by a per-network bucket, so people behind a shared venue IP keep working.
- **If the limiter's database call fails,** requests are let through with one structured `rate_limit_unavailable` log per policy every 10 seconds. A broken limiter must not take the product down. The `failed_auth` bucket instead falls back to a per-instance counter: that traffic is never a working session, so throttling it cannot lock anyone out, and it is exactly the traffic to keep throttled under stress.
- `RATE_LIMIT_ENABLED=false` switches every bucket off.

**Input is bounded and strict.** Bodies are capped at 256 KB, counted in bytes and refused with 413 before a larger body is buffered (`body.ts`). Inputs are parsed with strict Zod schemas (`packages/contracts/src/index.ts`), plus engine-side bounds on loosely typed patch fields. `/mcp` accepts at most 10 JSON-RPC messages per request. Operations dispatch through a `Map` and lookups use own keys only, so names like `constructor` cannot reach inherited properties.

**Upload links accept one file.** Draft files, face scans, persona photos and rendered reels go from the client straight to private R2 through a presigned PUT link (`r2.ts`) that lasts minutes and signs the object key, content type, SHA-256 and byte size. R2 refuses any other body, so a link cannot store a different file or more bytes than were declared. Before a link is issued for a draft file, face scan or persona photo, the workspace's pending and ready draft files must leave room for it under `STORAGE_QUOTA_BYTES` (default 5 GiB), and a workspace can have at most 20 draft-file uploads in progress (`assertUploadAllowed` in `files.ts`).

**Content is data, never instructions.** The Creative Director model has no tools and no credentials (`llm.ts`). Source excerpts, the brand kit, existing scripts, other projects and earlier messages are passed as JSON inside tagged blocks, with `<`, `>` and `&` escaped, so no text can close its block or forge the `<request>` block (`director.ts` `dataJson`). The system prompt names `<request>` as the only instruction. Output is schema-validated: edits may touch only items in the open project, presenters must be authorized for the workspace and language, and edits, renders, schedules and checkout come back as proposals a person applies through the normal permission checks. Model turns are capped per workspace per day, on top of the `director` burst limit. Source URLs are references and are never fetched.

**Outbound calls go to fixed hosts.** These are Stripe (SDK), Google OAuth and YouTube (`providers/youtube.ts`), Humanlike (`HUMANLIKE_API_URL` may only name a `humanlike.co` HTTPS host), Google's Gemini API, Anthropic or the Vercel AI Gateway (`llm.ts`), and Supabase. A YouTube resumable-upload session URL must be HTTPS on `googleapis.com` before any bytes are sent. Nothing fetches a user-supplied URL.

**Secrets stay on the server.** Server keys are read from environment variables only. A production build of the web app contains only the Supabase URL and publishable key; we verify this by building into a private folder and searching the output for every server-side value. YouTube refresh tokens are sealed with AES-256-GCM (`channels.ts`) and accepted only after Google confirms they were issued to this deployment's client. Shared secrets (worker token, cron secret) are compared in constant time on SHA-256 digests (`constantTimeEqual`). Error responses never forward database, Stripe, Google or model text, and unexpected failures return a correlation ID. Logs carry routes, IDs, outcomes and durations, never bodies, prompts, tokens or query strings.

**Browser and transport headers.** `vercel.json` sets a Content-Security-Policy (scripts limited to `self` plus one hash-pinned inline script, `frame-ancestors 'none'`, `object-src 'none'`), `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, a restrictive `Permissions-Policy` and `Cross-Origin-Opener-Policy`. API responses are `private, no-store`. `/v1` sends no CORS headers, so browsers allow it same-origin only. `/mcp` allows any origin because it authenticates with a bearer header only, never cookies. The public MCP server card (`/.well-known/mcp/server-card.json`) is read-only and carries no configuration values.

**OAuth consent.** The consent page (`OAuthConsent.tsx`) shows the requesting client and the host of its callback before asking. It refuses callbacks with script-bearing schemes (`javascript:`, `data:`, `vbscript:`, `blob:`, `file:`) twice: before Allow is offered, and again on the redirect Supabase returns. Loopback http(s) and app schemes such as `cursor://` still work.

## Not covered yet

- **OAuth audience.** Supabase OAuth access tokens carry `aud: "authenticated"`. They are bound to this Supabase project, not to `/mcp` specifically (no RFC 8707 resource indicator). Telling an OAuth agent apart from a person on `/v1` relies on Supabase putting `client_id` in OAuth-issued tokens.
- **Token lifecycle after membership changes.** A workspace token is not re-checked against its creator's current role. There is no member-removal flow yet, so revoke tokens by hand.
- **Rate-limit limits.** Fixed windows allow up to twice the limit across a window boundary. Per-network limits depend on Vercel's edge headers. Volumetric DDoS protection is left to the platform, and limits fail open during a database outage (by design).
- **Prompt injection is contained, not eliminated.** Text in a source can still sway the model's wording, but it cannot act: every effect is a proposal that a person reviews. Agents with `content:edit` can edit the workspace brand kit, which every later draft reads as data.
- **Storage limits are coarse.** Only draft files count toward the storage quota: face-scan recordings and persona photos are bounded per file and by the `costly` rate limit, not by the quota. The check is not atomic, so concurrent requests can overshoot it by a few files. Archived drafts keep their bytes (history stays playable) but leave the quota. Bytes uploaded through a link and never completed or saved stay in R2 until lifecycle rules remove them.
- **Public health endpoint.** `/v1/health` lists which integrations are configured, with no values. The Stripe webhook body is bounded only by the platform limit (4.5 MB).
- **Not in place:** MFA policy beyond Supabase defaults, audit-log export, automated dependency scanning in CI, or a formal penetration test.

## Reporting a vulnerability

Open a private GitHub security advisory on this repository (Security → Report a vulnerability). Please include the affected route or tool, steps to reproduce, and what an attacker gains. Test only against workspaces you own; do not access other people's data or disrupt the service. Please give us a chance to fix the issue before disclosing it publicly.

## Verifying

```bash
corepack pnpm test                    # includes tests/security.test.ts and tests/ratelimit.test.ts
node scripts/test-engine-rls.mjs      # migrations on a throwaway local Postgres: RLS, grants, limiter atomicity
corepack pnpm run check:api
```
