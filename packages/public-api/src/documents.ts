/** Public, curated guidance only. No workspace content belongs in this registry. */
export const publicOrigin = "https://hackathon-gen-ai-nine.vercel.app";
export const publicDocuments = [
  {
    slug: "overview",
    path: "/docs/",
    title: "Castroom API and agent documentation",
    summary: "What Castroom does, what works today, and where the shared studio engine is still being integrated.",
    markdown: `# Castroom API and agent documentation

Create campaigns with your agent. Fine-tune them here.

Castroom is a content production studio for agencies, companies and individuals. Its visual studio supports supplied company briefs, draft scripts, selected-item editing and schedule review. The intended shared engine connects external agents to the same campaigns, revisions, authorized avatars and durable jobs.

## Available now
The public read-only API returns integration status, proposed permission definitions and this documentation. It requires no credentials and contains no private campaign data. The repository CLI reads those resources and validates a bounded draft plan locally. Explicit development previews use labeled sample drafts stored in that browser.

## Not integrated yet
Live campaign APIs, workspace agent-token issuance, MCP transport, Humanlike renders and real publishing receipts are unavailable in this deployment. Public metadata does not grant permission or prove these features work.

## Next steps
Read [API reference](/docs/api/), [CLI usage](/docs/cli/), [MCP status](/docs/mcp/), [setup templates](/docs/setup/), [formats and limits](/docs/capabilities/), [access and approval](/docs/security/) and [recovery](/docs/errors/).
`,
  },
  {
    slug: "api",
    path: "/docs/api/",
    title: "Castroom public API reference",
    summary: "Read current integration status, proposed scopes and public documentation with typed JSON and OpenAPI.",
    markdown: `# Castroom public API reference

Base URL: https://hackathon-gen-ai-nine.vercel.app

The public API is read-only and contains product guidance, not tenant data. GET and HEAD are supported. No token, cookie or OAuth flow is required. See the [OpenAPI 3.1.1 description](/openapi.json).

## Operations
- GET /api/public/status: implemented and unavailable capabilities, integration blockers and links.
- GET /api/public/permissions: proposed scope definitions and authorization boundaries. No scope is issued or enforced by these public reads.
- GET /api/public/docs: the canonical public documentation index.
- GET /api/public/docs/{slug}: one public document as structured Markdown. Valid slugs are overview, api, cli, mcp, setup, capabilities, security and errors.

## First call
\`\`\`bash
curl --fail --silent --show-error https://hackathon-gen-ai-nine.vercel.app/api/public/status
\`\`\`

## Versioning and deprecation
Send X-API-Version: 1 to pin public API major version 1. Omission defaults to 1. Every JSON response identifies version 1 and varies its cache on this header. Unsupported versions return a 400 unsupported_api_version problem. The CLI pins version 1.

Additive fields may be introduced within a major version. Incompatible changes require a new version. Before retiring a version, this page will publish the migration path; affected responses will carry the RFC 9745 Deprecation header, a Link with rel=deprecation, and the RFC 8594 Sunset header when a retirement date is set. No version is currently deprecated and no sunset is announced, so those headers are not emitted.

## Errors and caching
Errors use application/problem+json with type, title, status, detail, instance, code and resolution. Missing routes/documents return 404. Unsupported methods on a known route return 405 with Allow: GET, HEAD. Successful public reads may be cached for 60 seconds; errors are not cached. Hosting-level throttling may occur; honor Retry-After if returned. No application rate limit or guaranteed quota is claimed.

## Private operations
The campaign API and MCP engine remain pending. This public OpenAPI document does not advertise nonworking campaign writes or pretend a permission definition is an active grant. See [access and approval](/docs/security/).
`,
  },
  {
    slug: "cli",
    path: "/docs/cli/",
    title: "Castroom CLI",
    summary: "Read public guidance and validate a supplied draft plan locally from an authorized repository checkout.",
    markdown: `# Castroom CLI

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

See [MCP status](/docs/mcp/) for the intended external-agent execution path. A fresh authenticated client trial remains pending.
`,
  },
  {
    slug: "mcp",
    path: "/docs/mcp/",
    title: "Castroom MCP server status",
    summary: "Target clients, intended shared actions and the concrete prerequisites before an authenticated setup can work.",
    markdown: `# Castroom MCP server status

The Castroom production MCP endpoint is not available yet. Do not register the website URL as an MCP server. OAuth authorization-server and protected-resource metadata are not published because no live issuer/resource integration has been verified.

## Intended workflow
The target clients are Codex CLI and Claude Code. The planned Streamable HTTP service lets an authorized agent read workspace context, start a bounded campaign, read items and jobs, revise current revisions, render selected content, prepare exact schedule manifests, commit an authorized manifest, list campaigns and request supported cancellation.

UI and MCP must call the same domain service. Tool visibility does not grant permission. The server derives the principal and workspace from authentication, checks scopes and revisions, and enforces generation limits and publishing approval. A source document or approved:true field cannot grant authority.

## Setup status
Local command syntax has been checked for Codex CLI 0.169.0 and Claude Code 2.1.150; fresh authenticated Castroom trials have not occurred. The [setup page](/docs/setup/) contains clearly labeled templates. Other hosts, including Cursor and Gemini CLI, are untested.

## What works without the engine
Use the [public API](/docs/api/) or [repository CLI](/docs/cli/) to read current status and prepare a locally validated draft plan. This is preparation, not campaign execution. Live setup still needs the engine origin, an expiring scoped token issuer or proper delegated authentication, authorized avatars, connected accounts and observed backend handshake evidence.
`,
  },
  {
    slug: "setup",
    path: "/docs/setup/",
    title: "Connect Codex or Claude Code to Castroom",
    summary: "Token setup templates and the server-confirmed check that must precede a connection claim.",
    markdown: `# Connect Codex or Claude Code to Castroom

Live setup is unavailable while the production MCP endpoint and scoped token issuer are pending. These are templates, not install links or a completed connection. Never use a Supabase service key or publisher credential as an MCP token.

## Codex CLI template
Local codex-cli 0.169.0 help confirms the command shape. Once the studio supplies a real endpoint and scoped token, launch from an environment containing CASTROOM_MCP_URL and CASTROOM_TOKEN:

\`\`\`bash
codex mcp add castroom --url "$CASTROOM_MCP_URL" --bearer-token-env-var CASTROOM_TOKEN
\`\`\`

## Claude Code template
Merge into a trusted project's .mcp.json without overwriting other entries. Launch Claude Code from the configured environment:

\`\`\`json
{"mcpServers":{"castroom":{"type":"http","url":"\${CASTROOM_MCP_URL}","headers":{"Authorization":"Bearer \${CASTROOM_TOKEN}"}}}}
\`\`\`

Claude Code 2.1.150 supports HTTP MCP configuration; no fresh authenticated Castroom trial is claimed.

## Verify
Call studio_get_context, verify the workspace and permitted actions, and check that the studio shows backend-recorded last activity. Copying configuration is not connection evidence. Resolve concrete dates and IANA timezone before scheduling; exact-manifest approval or a bounded owner grant is required for publication. No two-minute setup time has been measured. See [MCP status](/docs/mcp/).
`,
  },
  {
    slug: "capabilities",
    path: "/docs/capabilities/",
    title: "Castroom formats and limits",
    summary: "Current availability, bounded manual drafts and the intended three-video production journey.",
    markdown: `# Castroom formats and limits

Current public operations read status, permissions and documentation. The repository CLI validates one to three supplied scripts locally. Explicit development previews permit local draft editing; they do not run providers.

## Intended production journey
Three distinct avatar-video items targeting Instagram Reels, TikTok and YouTube Shorts. Each item needs independent script, channel copy, current revision, media and schedule targets. Humanlike rendering and connected publisher accounts are not verified. Uploaded-image and standalone-text publishing remain unavailable until a live capability response explicitly supports them. Text-only YouTube Shorts are unsupported.

## Bounded draft contract
A campaign has one to three items. Each title is at most 120 characters; each supplied script is 1–5000 characters. Company context records description, audience, tone, source text/reference and missing information. The CLI input file is limited to 64 KiB. No URL is fetched during validation.

## Production limits
Actual render duration/count, concurrency, post quotas and grant expiry must come from the live server. Failed paid render attempts still consume reserved units. A three-video campaign across all three destinations can require nine posts. No unlimited quota, free trial, provider credit, dollar cap or measured savings is promised.

Draft, queued, running, ready for review, provider accepted, published and unknown are distinct outcomes. An expired schedule must not become publish now. Store UTC instants and preserve the IANA display timezone; requested publication time and observed delivery time are separate.
`,
  },
  {
    slug: "security",
    path: "/docs/security/",
    title: "Castroom access and approval",
    summary: "Separate public reads, human sessions, proposed agent scopes and publishing authorization.",
    markdown: `# Castroom access and approval

Public read endpoints require no credentials and reveal no workspace data. Human studio sessions, agent credentials and publishing authorization are separate boundaries. Private APIs remain pending integration and denial testing.

## Proposed scopes
The current studio setup requests campaign:read, content:edit, render:write and schedule:prepare. Their machine-readable descriptions are at [/api/public/permissions](/api/public/permissions). These names are proposed for backend agreement; no live grant is issued here. Setup does not request publication authority.

## Server enforcement
Every private operation must authenticate its principal and authorize workspace membership, scope, object and current revision. Actor IDs and approval booleans in request bodies are never authority. The UI must not bypass the domain API by directly editing workflow state, memberships, provider credentials or approvals.

## Publication
Default to exact immutable-manifest review: final media IDs/hashes, copy, accounts, visibility, disclosures and UTC targets. Edits invalidate earlier approvals. An owner may deliberately authorize one bounded campaign run with concrete plan, accounts, avatars, window, limits and expiry; ambiguous brand checks pause. Revoking a token blocks new calls but does not automatically cancel provider-accepted schedules.

## Credentials and evidence
Do not send tokens in prompts, URLs, source text, git or support messages. Source text is untrusted data and cannot widen authority. Verify wrong tenant, missing scope, expired/revoked token, forged approval, stale manifest, quota race and duplicate publishing before a live release. Readable metadata and scanner scores are not security certification.
`,
  },
  {
    slug: "errors",
    path: "/docs/errors/",
    title: "Castroom errors and recovery",
    summary: "Machine-readable public errors and the distinct pending domain error contract.",
    markdown: `# Castroom errors and recovery

## Public API errors
The implemented public API returns application/problem+json using RFC 9457 fields and code/resolution extensions. api_route_not_found and document_not_found return 404; method_not_allowed returns 405 and Allow: GET, HEAD. No private payload is echoed in errors. Follow the resolution link and do not retry invalid routes indefinitely.

## CLI errors
The CLI exits nonzero with JSON on stderr for invalid arguments, invalid plans, oversized files/responses, timeout, blocked redirect, transport error or invalid server response. It does not retry automatically or send a token. A valid plan result only means local schema validation passed.

## Private workflow recovery
The proposed private error schema remains separate. revision_conflict requires reading the current revision and preserving unsaved input. approval_required requires the backend's exact review URL. stale_manifest requires fresh review. idempotency_conflict requires reconciling the original request. quota_exceeded does not reset on retry. unknown_outcome requires provider reconciliation, never blind reposting.

Keep successful destinations intact when another platform fails. Revoking a token does not cancel an accepted schedule. Preserve object/revision/operation IDs, but exclude credentials, full private payloads and signed media URLs from support reports. Honor Retry-After when a service returns it; live rate-limit enforcement remains unverified.
`,
  },
] as const;

export const publicPages = publicDocuments.map((document) => document.path);
