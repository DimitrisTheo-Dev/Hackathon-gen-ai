# MCP and OAuth on production — 14 November 2026

Environment: https://faceful.vercel.app (production), real Supabase project, the dedicated smoke account as workspace owner.

## Claude Code 2.1.325 against the production MCP endpoint (scoped workspace token)

`claude -p … --mcp-config <http server entry for https://faceful.vercel.app/mcp with an Authorization header> --strict-mcp-config`. The client was asked to list projects, read billing, add a draft, propose a YouTube time and try to approve. The CLI's own printed report was lost to a stdin warning line, so the outcome below is taken from the **server's records**, read afterwards through the studio API with the owner's session:

- New draft "Production check" exists in the agent-created project (item revision 2 after the schedule proposal).
- Its requested time is YouTube 2026-11-20 09:00 Europe/Athens → stored as `2026-11-20T07:00:00.000Z`, state `draft`.
- Activity (actor "Production client trial (agent)"): "Added a draft — Saved", "Proposed posting times; schedule needs review — Saved", "Prepared a schedule for review — 0 ready · 6 blockers".
- The connection's `lastSeenAt` advanced to 17:41:11Z.
- No approval was recorded: agents cannot approve (unit-tested; the refusal writes nothing).

## OAuth 2.1 + PKCE, scripted client (not a Claude Code/Codex session)

1. `GET /.well-known/oauth-protected-resource/mcp` → resource `https://faceful.vercel.app/mcp`, authorization server = the Supabase Auth issuer.
2. Authorization-server metadata → authorize, token and registration endpoints; PKCE `S256`.
3. Dynamic client registration → 201, public client (`token_endpoint_auth_method: none`), loopback redirect.
4. Authorization request → Supabase redirected the signed-in member to **`https://faceful.dtheo.dev/oauth/consent`** (the project's Site URL). The page read: "Connect Faceful OAuth trial client to Faceful? … wants to work in your Faceful workspace as engine-smoke@…. After you answer, you’ll return to 127.0.0.1:53682. It will be able to Read your projects, drafts and videos …" (`oauth-consent.png`).
5. Allow → authorization code returned to the loopback redirect, `state` matched.
6. Token exchange with the PKCE verifier → 200; access token (1 h) and refresh token. Claims: `iss` = the issuer, `aud: authenticated`, `client_id` present.
7. With that access token: `POST /mcp tools/list` → 13 tools; `list_projects` → the workspace's project; `get_billing_status` → `active`, 31 credits.
8. `refresh_token` grant → 200, new access token.

## Limits of this evidence

- The OAuth run used a purpose-written client, not the OAuth UI of Claude Code, Codex or another host.
- Consent is served on the Site URL origin (`faceful.dtheo.dev`); the member must be signed in on that origin.
- Access tokens are audience-bound to the Supabase project (`aud: authenticated`), not to `/mcp` specifically.
- Token revocation from the studio for OAuth clients is not built (workspace tokens can be revoked; OAuth grants are managed in Supabase).
