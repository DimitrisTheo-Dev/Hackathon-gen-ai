/** Public, curated guidance only. No workspace content belongs in this registry. */
export const publicOrigin = "https://faceful.vercel.app";
/**
 * Availability differs per deployment, so these documents never assert that a private capability is on.
 * They point readers at GET /api/public/status, which is derived from the deployment's configuration.
 */
export const publicDocuments = [
  {
    slug: "overview",
    path: "/docs/",
    title: "Faceful API and agent documentation",
    summary: "What Faceful does, how to check what a deployment has switched on, and what is not available yet.",
    markdown: `# Faceful API and agent documentation

Create campaigns with your agent. Fine-tune them here.

Faceful is a content production studio for agencies, companies and individuals. People and their AI agents work on the same projects: briefs, draft scripts, versions, presenters, render jobs and schedule reviews. The studio and the MCP server call one domain engine with the same workspace permissions.

## Check this deployment first
What is switched on depends on how a deployment is configured. GET /api/public/status reports it. engine.campaignApi, engine.agentTokenIssuance and engine.mcp are true when the domain engine has its server credentials. engine.humanlikeRendering, engine.billing and engine.director describe rendering, Stripe sandbox billing and the Creative Director. blockers lists what is missing in plain sentences.

## Available without credentials
The public read-only API returns that status, the agent permission definitions and this documentation. It contains no private campaign data. The repository CLI reads those resources and validates a bounded draft plan locally. Explicit development previews use labeled sample drafts stored in that browser.

## Available where the engine is configured
Signed-in members get a private workspace: projects, drafts with full version history, templates, a seeded sample that is labeled as a sample, posting-time proposals and exact schedule review. An owner or admin can create scoped, expiring workspace tokens, and an external agent can work in the same workspace through the MCP endpoint at /mcp. Creating and editing drafts is free.

## Not available on any deployment yet
Publishing: no destination has approved API access, so schedules can be drafted and reviewed but nothing is posted. Rendering: Humanlike provides realtime avatar sessions, and a separate recording worker turns one into a video file; until that worker is attached, render requests are refused with provider_unavailable rather than simulated. No rendered Humanlike video and no publishing receipt has been recorded. OAuth sign-in for MCP clients is implemented but has not been exercised end to end; the tested path is a workspace token.

## Next steps
Read [Use Faceful with your AI agent](/docs/mcp/), [setup](/docs/setup/), [API reference](/docs/api/), [CLI usage](/docs/cli/), [formats and limits](/docs/capabilities/), [access and approval](/docs/security/) and [recovery](/docs/errors/).
`,
  },
  {
    slug: "api",
    path: "/docs/api/",
    title: "Faceful public API reference",
    summary: "Read a deployment's integration status, agent permission definitions and public documentation with typed JSON and OpenAPI.",
    markdown: `# Faceful public API reference

Base URL: https://faceful.vercel.app

The public API is read-only and contains product guidance, not tenant data. GET and HEAD are supported. No token, cookie or OAuth flow is required. See the [OpenAPI 3.1.1 description](/openapi.json).

## Operations
- GET /api/public/status: what this deployment has configured (campaign API, workspace tokens, MCP endpoint, rendering, billing, Creative Director mode), blockers and links. The values are derived from server configuration on each request.
- GET /api/public/permissions: the permissions an agent credential can carry and the ones reserved for signed-in people. They are reported as enforced only where the engine is configured. Reading them grants nothing.
- GET /api/public/docs: the canonical public documentation index.
- GET /api/public/docs/{slug}: one public document as structured Markdown. Valid slugs are overview, api, cli, mcp, setup, capabilities, security and errors.

## Discover the next resource
Responses include HTTP Link relations for the public OpenAPI description (service-desc), API/MCP/CLI documentation (service-doc), integration status (status), and agent instructions (index). The MCP link leads to setup and availability documentation, not to the transport itself. These links use the canonical Faceful origin and require no credential.

## First call
\`\`\`bash
curl --fail --silent --show-error https://faceful.vercel.app/api/public/status
\`\`\`

## Versioning and deprecation
Send X-API-Version: 1 to pin public API major version 1. Omission defaults to 1. Every JSON response identifies version 1 and varies its cache on this header. Unsupported versions return a 400 unsupported_api_version problem. The CLI pins version 1.

Additive fields may be introduced within a major version. Incompatible changes require a new version. Before retiring a version, this page will publish the migration path; affected responses will carry the RFC 9745 Deprecation header, a Link with rel=deprecation, and the RFC 8594 Sunset header when a retirement date is set. No version is currently deprecated and no sunset is announced, so those headers are not emitted.

## Errors and caching
Errors use application/problem+json with type, title, status, detail, instance, code and resolution. Missing routes/documents return 404. Unsupported methods on a known route return 405 with Allow: GET, HEAD. Successful public reads may be cached for 60 seconds; errors are not cached. Hosting-level throttling may occur; honor Retry-After if returned. No application request quota or remaining-count telemetry is configured for these public reads. RateLimit and RateLimit-Policy are therefore not emitted; static values would not represent an enforced limit. This does not imply unlimited hosting capacity. Reuse cached guidance, avoid concurrent retry loops and check the public status before attempting an unavailable production action.

## Private operations
The authenticated domain API under /v1 and the MCP endpoint at /mcp are separate from this public API. They need a signed-in session, a scoped workspace token or an OAuth access token, and they are not described by this public OpenAPI document. Check engine.campaignApi and engine.mcp in the status response first: a deployment without engine credentials answers those paths with 503. See [Use Faceful with your AI agent](/docs/mcp/) and [access and approval](/docs/security/).
`,
  },
  {
    slug: "cli",
    path: "/docs/cli/",
    title: "Faceful CLI",
    summary: "Read public guidance and validate a supplied draft plan locally from an authorized repository checkout.",
    markdown: `# Faceful CLI

The repository CLI supports public discovery and local draft-plan validation. It does not render, create a persisted campaign, issue tokens or publish. It is not published on npm; use an authorized checkout of the private repository.

## Run
Use Node.js 24 or newer and the pnpm version pinned in package.json. From the repository root:

\`\`\`bash
corepack pnpm install --frozen-lockfile
corepack pnpm --silent castroom status
corepack pnpm --silent castroom scopes
corepack pnpm --silent castroom docs
corepack pnpm --silent castroom docs setup
corepack pnpm --silent castroom validate-plan packages/cli/examples/three-video-plan.json
\`\`\`

Commands print JSON to stdout. Failures print a structured error to stderr and exit nonzero. The --origin option accepts an HTTPS origin without credentials, path, query or fragment; it only changes the public service origin. Requests never send tokens or cookies, never follow redirects, time out after 10 seconds, and reject responses larger than 256 KiB.

## Local validation
validate-plan reads one JSON file up to 64 KiB and uses the shared draft-only runtime contract. Plans contain one to three explicit scripts and supplied company context, including a durable operationKey. Unknown fields, missing context, invalid source URLs and oversized batches are rejected. Validation is not a brand check, rendering acceptance, publishing approval or proof of a working private API. Input scripts are not echoed in the result or sent to a server.

This CLI only reads and validates. To have an agent create and edit real projects, connect it to the MCP endpoint instead: see [Use Faceful with your AI agent](/docs/mcp/).
`,
  },
  {
    slug: "mcp",
    path: "/docs/mcp/",
    title: "Use Faceful with your AI agent",
    summary: "The remote MCP endpoint: how to check it is available, authorize an agent, the 13 tools, limits and what has actually been tried.",
    markdown: `# Use Faceful with your AI agent

Faceful has a remote MCP server. An agent you already use can work in your Faceful workspace: list projects, write and revise drafts, request renders, propose posting times and read plan status. It calls the same domain engine as the studio, so what the agent creates appears in the studio, and what you edit there is what the agent reads next.

You stay in control. You create the credential or approve the sign-in yourself. An agent cannot connect itself, widen its own permissions, approve a schedule, publish or pay.

## Check availability
The server exists only where the domain engine is configured. Check before you set anything up:

\`\`\`bash
curl --fail --silent --show-error https://faceful.vercel.app/api/public/status
\`\`\`

Continue when engine.mcp is true. When it is false, /mcp answers 503 and there is nothing to connect to. The same response reports rendering (engine.humanlikeRendering) and billing (engine.billing), and lists blockers in plain sentences.

## Endpoint
- URL: /mcp on the origin where you use the studio, for example https://faceful.vercel.app/mcp.
- Transport: Streamable HTTP, stateless. Send JSON-RPC with POST. There is no session ID and no server-sent stream; GET and DELETE return 405.
- Protocol: 2025-11-25 through @modelcontextprotocol/sdk 1.32.2, which also accepts earlier revisions such as 2025-06-18. The 2026-07-28 revision is not implemented; a client that offers it is answered with 2025-11-25.
- Authorization: a Bearer token in the Authorization header only. Tokens in URLs or tool arguments are not read.
- Discovery: a public server card at /.well-known/mcp/server-card.json (draft format, SEP-1649/SEP-2127) names the endpoint, protocol and protected-resource metadata where the engine is configured. Tools are listed by tools/list.

## Authorize with a workspace token (the tested path)
1. Sign in to the studio as a workspace owner or admin and open Connect your agent.
2. Create a workspace token. Name it, choose only the permissions the agent needs, and set an expiry of at most 90 days. The token starts with fct_ and is shown once. Faceful stores only its SHA-256 digest.
3. Keep it in an environment variable, not in a prompt, a URL or a committed file:

\`\`\`bash
export FACEFUL_TOKEN='paste the token here'
\`\`\`

Codex CLI:

\`\`\`bash
codex mcp add faceful --url https://faceful.vercel.app/mcp --bearer-token-env-var FACEFUL_TOKEN
\`\`\`

Claude Code, in a trusted project's .mcp.json (merge it; do not overwrite other servers):

\`\`\`json
{"mcpServers":{"faceful":{"type":"http","url":"https://faceful.vercel.app/mcp","headers":{"Authorization":"Bearer \${FACEFUL_TOKEN}"}}}}
\`\`\`

Start the client from the shell that has FACEFUL_TOKEN. You can revoke the token in the studio at any time; new calls with it are refused. Revoking does not undo work that was already accepted.

## Authorize with OAuth (works with a scripted client; host sign-in screens untried)
The server publishes OAuth protected-resource metadata at /.well-known/oauth-protected-resource/mcp, and an unauthenticated request to /mcp returns 401 with a WWW-Authenticate header that points to it. The authorization server is the project's Supabase Auth, using OAuth 2.1 with PKCE; its own metadata is served by that issuer, not by this origin. Dynamic client registration is enabled, and the studio has a consent page where a signed-in member allows or denies the client.

Two things to know before relying on it. No end-to-end OAuth trial with a real client has been recorded yet, so treat this path as untested and prefer a workspace token. And access tokens are audience-bound to the Faceful Supabase project rather than to /mcp specifically: there is no resource-specific audience, although signature, issuer, audience and expiry are verified.

An OAuth-connected agent acts for the member who approved it, with that member's workspace role narrowed to the agent permissions below.

## Permissions
A workspace token carries any subset of campaign:read, content:edit, render:write, schedule:prepare, billing:read and billing:checkout. Agents are never given schedule:approve, schedule:commit, billing:manage or connections:manage. The machine-readable list is at [/api/public/permissions](/api/public/permissions).

## Tools
- list_projects: projects with their items, status, revision and whether a rendered video exists. Read-only.
- create_project: a new project from a brief you supply and one to three scripts. Saves drafts only.
- create_draft: adds one draft to an existing project.
- revise_draft: changes an item's title, script, language or presenter against the revision you last read. Every save is a new version; a stale revision returns revision_conflict.
- list_avatars: the presenters the workspace may render with, their languages, and whether rendering is currently available.
- start_render: requests a render for up to three items and holds render credits. Returns provider_unavailable when no renderer is attached and quota_exceeded when credits run out. Accepted is not finished.
- get_render_status: the real state of one render job, with its error if it failed.
- list_assets: items that have a stored, rendered video.
- get_asset: one item with its script, version history and, if a video exists, a short-lived playback URL. Never starts a render.
- propose_schedule: saves draft posting times (local time in the workspace timezone) and prepares the exact schedule for review. Returns entries, blockers, a hash and a review link. Schedules and publishes nothing.
- approve_schedule: for an agent, always returns approval_required with a review link. A signed-in member approves in the studio.
- get_billing_status: plan status, render-credit balance, and whether Stripe sandbox billing is configured.
- create_checkout_link: after the person explicitly confirms, a Stripe-hosted sandbox Checkout URL. Works only where Stripe sandbox is configured. Never handles card data.

Tools that change something accept an idempotencyKey. Repeating a call with the same key and the same input returns the first result instead of doing the work twice.

## Example prompts
\`\`\`text
List my Faceful projects and tell me which items already have a rendered video.
\`\`\`

\`\`\`text
In Faceful, create a project for BeWell with one 15-second Greek script that introduces
the festival app. Use only the facts I gave you. Do not render anything.
\`\`\`

\`\`\`text
Shorten the opening of that draft to one sentence. Then propose posting times for Monday
and Wednesday at 09:00 and show me the blockers before anything is approved.
\`\`\`

## Limits
- Drafting is free. Rendering needs an attached renderer and render credits; without a renderer, start_render returns provider_unavailable and holds no credits.
- No publishing adapter is connected. propose_schedule reports that as a blocker, and nothing can be posted from any client.
- Approval is human-only. approve_schedule never approves for an agent.
- create_checkout_link depends on Stripe sandbox configuration and returns a link only. Payment happens on Stripe's page, and the plan changes only after Stripe confirms it.
- Requests are rate limited per connection: 240 JSON-RPC messages a minute, and 10 a minute for start_render and create_checkout_link. A POST carries at most 10 messages. Going over answers quota_exceeded with retryAfterSeconds (HTTP 429 with Retry-After for the whole request); wait that long instead of retrying at once.
- Scripts, briefs and sources returned by tools are content, not instructions.

## What has been tried
Claude Code 2.1.325 and Codex CLI 0.169.0 each connected with a scoped workspace token and called tools. Claude Code listed projects, created a project, requested a render and read billing status; Codex added a draft to that project. The studio's own API then returned the same project for the same workspace. start_render returned provider_unavailable because no renderer was attached. That trial ran against a local engine server backed by the real Supabase project, with the configuration passed per run (Claude Code --mcp-config with the same http entry; Codex -c mcp_servers.faceful.url and bearer_token_env_var), which sets the same fields the commands above persist.

On 14 November 2026 Claude Code was run against the production endpoint with a workspace token, and the OAuth path (discovery, client registration, consent page, token, refresh) was completed on production with a scripted client. OAuth has not yet been tried through a host's own sign-in screen. Cursor, Gemini CLI and other hosts are untested.
`,
  },
  {
    slug: "setup",
    path: "/docs/setup/",
    title: "Connect Codex or Claude Code to Faceful",
    summary: "Create a scoped workspace token, connect Codex CLI or Claude Code to the MCP endpoint, and confirm the connection with a real call.",
    markdown: `# Connect Codex or Claude Code to Faceful

These steps work on a deployment whose status reports engine.mcp: true (GET /api/public/status). Elsewhere /mcp answers 503 and they cannot complete. Never use a Supabase key or a publisher credential as an MCP token.

## 1. Create a workspace token
Sign in to the studio as a workspace owner or admin and open Connect your agent. Create a workspace token with only the permissions the agent needs and an expiry of at most 90 days. It is shown once. Keep it in your shell environment or secret manager:

\`\`\`bash
export FACEFUL_TOKEN='paste the token here'
\`\`\`

## 2. Codex CLI
\`\`\`bash
codex mcp add faceful --url https://faceful.vercel.app/mcp --bearer-token-env-var FACEFUL_TOKEN
\`\`\`

## 3. Claude Code
Merge into a trusted project's .mcp.json without overwriting other entries, then start Claude Code from the shell that has FACEFUL_TOKEN:

\`\`\`json
{"mcpServers":{"faceful":{"type":"http","url":"https://faceful.vercel.app/mcp","headers":{"Authorization":"Bearer \${FACEFUL_TOKEN}"}}}}
\`\`\`

If you open the studio on a different origin, use that origin's /mcp instead.

## Verify
Ask the agent to call list_projects and get_billing_status. A real connection returns your workspace's projects and credit balance, and the studio's connection list records when the token was last used. Copying configuration is not connection evidence. Resolve concrete dates and the IANA timezone before proposing a schedule; a signed-in member must approve the exact schedule in the studio. No two-minute setup time has been measured.

## What has been tried
Codex CLI 0.169.0 and Claude Code 2.1.325 connected with a workspace token against a local engine server backed by the real Supabase project. Claude Code has been run against the production endpoint with a workspace token; OAuth works on production with a scripted client and has not yet been tried through a host's own sign-in screen. See [Use Faceful with your AI agent](/docs/mcp/) for the tools, limits and OAuth details.
`,
  },
  {
    slug: "capabilities",
    path: "/docs/capabilities/",
    title: "Faceful formats and limits",
    summary: "What can be drafted, rendered and scheduled today, the bounded draft contract and how render credits behave.",
    markdown: `# Faceful formats and limits

Public operations read status, permissions and documentation. The repository CLI validates one to three supplied scripts locally. Explicit development previews permit local draft editing; they do not run providers. Where the engine is configured (engine.campaignApi in GET /api/public/status), signed-in members and connected agents create and edit real drafts.

## Intended production journey
Three distinct avatar-video items targeting Instagram Reels, TikTok and YouTube Shorts. Each item needs independent script, channel copy, current revision, media and schedule targets. No Humanlike render and no connected publisher account has been verified. Uploaded-image and standalone-text publishing are not part of this build. Text-only YouTube Shorts are unsupported.

## Bounded draft contract
A project created in one request has one to three items, and a project holds at most twelve. Each title is at most 120 characters; each supplied script is 1–5000 characters. Company context records description, audience, tone, source text/reference and missing information. The CLI input file is limited to 64 KiB. No URL is fetched during validation or creation.

## Rendering and credits
Rendering is available only where a recording worker is attached (engine.humanlikeRendering). Otherwise a render request is refused with provider_unavailable and holds nothing. Each admitted render holds render credits (one by default). The hold is returned if the job fails, is cancelled, or is never picked up. A revision that already has a verified video is not rendered again. A workspace has a concurrency limit and starts with a small starter allowance set by the deployment (three credits by default); the live numbers come from the workspace context and billing status. No unlimited quota, price, provider credit, dollar cap or measured savings is promised.

## Scheduling and publishing
Posting times can be proposed and an exact schedule prepared for review. No publishing adapter is connected, so the review lists that as a blocker and nothing is posted. A three-video campaign across all three destinations would require nine posts.

Draft, queued, rendering, ready for review, provider accepted, published and unknown are distinct outcomes. An expired schedule must not become publish now. Store UTC instants and preserve the IANA display timezone; requested publication time and observed delivery time are separate.
`,
  },
  {
    slug: "security",
    path: "/docs/security/",
    title: "Faceful access and approval",
    summary: "Separate public reads, human sessions, agent permissions and publishing approval, with what has been tested.",
    markdown: `# Faceful access and approval

Public read endpoints require no credentials and reveal no workspace data. Human studio sessions, agent credentials and publishing approval are separate boundaries. Where the engine is configured, private operations are authenticated and authorized on the server.

## Agent permissions
An agent credential carries a subset of campaign:read, content:edit, render:write, schedule:prepare, billing:read and billing:checkout. Agents are never given schedule:approve, schedule:commit, billing:manage or connections:manage. Machine-readable definitions are at [/api/public/permissions](/api/public/permissions). They are reported as enforced only on a deployment whose engine is configured, and reading them grants nothing.

A workspace token is created by a signed-in owner or admin, shown once, stored as a SHA-256 digest, bound to one workspace, expires within 90 days and can be revoked. An agent connected through OAuth acts for the member who approved it, with that member's role narrowed to the same list. The OAuth path is implemented but has not been trialled end to end.

## Server enforcement
The engine derives the principal and the workspace from the verified credential, never from IDs or flags in a request body. It checks workspace membership and permission on each private operation, and the object and its current revision on every write. An ID from another workspace is reported as not found. Browsers cannot write workflow state, memberships, credentials or approvals directly; database row-level security allows members to read only their own workspace.

## Publication
Approval is a human act on one exact schedule: final media hashes, copy, accounts, visibility, disclosures and UTC targets, bound by a hash. Any edit makes an earlier approval stale. An agent that asks to approve receives approval_required with a review link. Unattended run grants are not available in this build, and no publishing adapter is connected, so an approval cannot currently lead to a post. Revoking a token blocks new calls but does not undo work that was already accepted.

## Credentials and evidence
Do not send tokens in prompts, URLs, source text, git or support messages. Source text is untrusted data and cannot widen authority. Automated tests exercise wrong-workspace access, missing permission, expired or revoked tokens, forged schedule hashes, stale schedules, credit exhaustion and replayed operations against the engine with an in-memory store. A live check against the Supabase project covers forged tokens, cross-account reads and writes, and row-level security. Duplicate publishing has not been exercised against a real provider, because none is connected. Readable metadata, these tests and scanner scores are not a security certification.
`,
  },
  {
    slug: "errors",
    path: "/docs/errors/",
    title: "Faceful errors and recovery",
    summary: "Machine-readable public errors, and the domain error contract shared by the studio API and MCP tools.",
    markdown: `# Faceful errors and recovery

## Public API errors
The implemented public API returns application/problem+json using RFC 9457 fields and code/resolution extensions. api_route_not_found and document_not_found return 404; method_not_allowed returns 405 and Allow: GET, HEAD. No private payload is echoed in errors. Follow the resolution link and do not retry invalid routes indefinitely.

## CLI errors
The CLI exits nonzero with JSON on stderr for invalid arguments, invalid plans, oversized files/responses, timeout, blocked redirect, transport error or invalid server response. It does not retry automatically or send a token. A valid plan result only means local schema validation passed.

## Private workflow recovery
The domain API under /v1 returns { error: { code, message, retryAfterSeconds, reviewUrl } }. MCP tools return the same fields in a tool result marked isError. A deployment without engine credentials answers 503. unauthenticated means the session or token is missing, expired or revoked. forbidden means the credential lacks the permission. not_found also covers objects in another workspace. revision_conflict requires reading the current revision and preserving unsaved input. approval_required carries the review URL for a signed-in member; over MCP, approve_schedule returns it as a normal result because it is the designed boundary, not a failure. stale_manifest requires a fresh review. idempotency_conflict means the key was already used with different input. quota_exceeded has two causes: a rate limit (HTTP 429 with retryAfterSeconds and Retry-After; wait that long, then retry) or exhausted credits and concurrency (retrying does not help; held render credits come back only when a job fails or is cancelled). provider_unavailable on a render means no renderer is attached: nothing was started and nothing was held. unknown_outcome requires checking the current state before retrying, never blind reposting.

Keep successful destinations intact when another platform fails. Revoking a token does not cancel accepted work. Preserve object/revision/operation IDs and the X-Correlation-Id response header, but exclude credentials, full private payloads and signed media URLs from support reports. Honor Retry-After when a service returns it. /v1 and /mcp are rate limited per account or connection and answer 429 quota_exceeded with retryAfterSeconds, Retry-After and RateLimit headers; wait the stated time rather than retrying in a loop.
`,
  },
] as const;

export const publicPages = publicDocuments.map((document) => document.path);
