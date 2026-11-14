# MCP client trials — 14 November 2026

Scope of this evidence: two real MCP clients against the Faceful MCP endpoint served by the **local** engine process (`corepack pnpm dev:api`, `http://127.0.0.1:8787/mcp`) backed by the **real** hosted Supabase project. It does **not** cover the deployed endpoint or the OAuth flow; both remain to be recorded after deployment.

Authorization: a scoped workspace token created through `POST /v1/studio/operations/create_agent_connection` by a signed-in owner (the dedicated smoke account), scopes `campaign:read, content:edit, render:write, schedule:prepare, billing:read`, two-hour expiry. The token was passed as a Bearer header from a file/environment variable and is not recorded here.

Server: `@modelcontextprotocol/sdk` 1.32.2, Streamable HTTP, stateless. `initialize` with `2025-11-25` → `protocolVersion: 2025-11-25`, `serverInfo: { name: "faceful", title: "Faceful studio", version: "0.1.0" }`. `tools/list` → 13 tools: `list_projects, create_project, create_draft, revise_draft, list_avatars, start_render, get_render_status, list_assets, get_asset, propose_schedule, approve_schedule, get_billing_status, create_checkout_link`.

Without a token: `401`, `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"`, JSON-RPC error `-32001`.

## Claude Code 2.1.325

Command shape: `claude -p "<task>" --mcp-config <file> --strict-mcp-config --allowedTools "mcp__faceful__…"` (HTTP server entry with an `Authorization` header). Result: `is_error: false`, 7 turns.

Client's own report, verbatim excerpts:

- Tool calls in order: `list_projects` (empty list for the workspace "Engine smoke's studio") → `create_project` (succeeded) → `list_projects` (1 project) → `start_render` (failed) → `get_billing_status` (succeeded).
- New project `fd2f5796-cfb8-4892-b6c6-b7d469a92fcc`; draft "Hello from Claude Code" status `draft`, revision 1, `avatarId: null`, `hasVideo: false`.
- Render result: code `provider_unavailable` — "Video rendering isn’t connected yet. Humanlike provides realtime avatar sessions; the recording worker that turns a session into a video file has not been attached to this workspace."
- Billing: credit balance 2, plan status `free`, mode `not_configured` — "Stripe sandbox keys have not been added to this deployment."; `canCheckout: false`.

(The balance was 2 rather than the starter 3 because the earlier storage smoke test consumed one credit for its verified test upload.)

## Codex CLI 0.169.0

Command shape: `codex exec -c 'mcp_servers.faceful.url="…/mcp"' -c 'mcp_servers.faceful.bearer_token_env_var="FACEFUL_TOKEN"' "<task>"`.

Client's own report: "Called Faceful tools in order: `list_projects` → `create_draft` → `list_projects`. Created “Hello from Codex” with script “A second draft, added by Codex.” “MCP interop check (Claude Code)” now has **2 items**."

## Same backend truth as the studio transport

`GET /v1/studio/campaigns` with the owner's own Supabase session (the transport the studio UI uses) returned the same project: title "MCP interop check (Claude Code)", `origin: agent`, the draft "Hello from Claude Code" (`draft`, revision 1), and activity "Interop check (agent) · Created drafts from a supplied brief".

## Not covered

- A Claude Code or Codex **client session** against a deployed URL (a deployed preview was exercised with raw JSON-RPC only; see the last section).
- OAuth 2.1 authorization (dynamic registration, consent page, refresh, reconnect) with a real client.
- Token expiry/reconnect in a real client session (expiry and revocation are covered by unit tests only).
- Cursor, Gemini CLI or any other host.

## Deployed preview check (same day)

A backend-only snapshot of this change was deployed as a Vercel **preview** (`hackathon-gen-r5ubb6olk-my-team-29ecd279.vercel.app`, behind Vercel deployment protection, reached with `vercel curl`). Against that deployment, with the real Supabase project:

- `GET /v1/health` → `engine: true, database: true, director: "basic", rendering.connected: false, billing.mode: "not_configured"`.
- `GET /v1/studio/context` without a credential → 401 contract error; with the smoke account's Supabase session → workspace, role `owner`, `mode: live`.
- `GET /v1/studio/campaigns` and `/campaigns/:id` → the same agent-created project (2 items) seen in the local trials.
- `POST /v1/studio/director/turn` (retrieval) → answered in basic mode, no generation.
- `GET /.well-known/oauth-protected-resource/mcp` → resource = that deployment's `/mcp`, authorization server = the Supabase issuer.
- `POST /mcp` without a token → 401 with `WWW-Authenticate: Bearer resource_metadata=…`; with the scoped token → `tools/list` returned 13 tools and `tools/call list_projects` returned the project.

This proves the Vercel routing (rewrites into the two functions, POST bodies, nested paths) and the deployed MCP transport with token authorization via raw JSON-RPC. It is not a Claude Code/Codex client session against the deployed URL, and not an OAuth trial.
