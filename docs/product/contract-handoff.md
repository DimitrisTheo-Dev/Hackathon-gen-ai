# Contract checkpoint for Minas

Status: proposed v0.1, not yet agreed. Baseline: `7714fbd`. Branch: `work/dimitris-studio`.

The existing React/Vite app is preserved under `apps/web`; root pnpm scripts and lockfile remain Dimitris-owned. No API, migration or engine files are changed. Shared runtime schemas live in `packages/contracts/src/index.ts` and are exported as `@castroom/contracts`.

Please review the proposed read models before integrating. In particular: context/capability booleans, campaign with ordered items, `revision` versus `renderRevision`, jobs with polling hints, immutable manifests, connections with server-observed `lastSeenAt`, and bounded grants. All missing values are explicit `null`; IDs are opaque strings; exact timestamps use UTC ISO 8601 with workspace IANA timezone retained. The browser never submits actor identity or approval booleans for manual approvals.

The studio will use a single `StudioClient` interface. Proposed HTTP adapter: bearer human session, `/v1/studio/context`, `/v1/studio/campaigns`, `/v1/studio/campaigns/:id`, and POST `/v1/studio/operations/:name`. Routes are provisional implementation details; changing the adapter must not change components. Errors are `{ error: { code, message, retryAfterSeconds, reviewUrl } }`. Non-2xx never falls back to fixtures. Backend derives workspace membership and actor from authentication and enforces all revisions, scopes, quotas and permissions.

Required operations for the next slice: `start_campaign` (supplied company context and 1–3 explicit scripts; draft-only), `revise_content`, `render_content`, `prepare_schedule`, `approve_schedule` (human session only, exact manifest hash), `commit_schedule`, `cancel_jobs`, `create_agent_connection`, `revoke_agent_connection`, `create_run_grant`. These are frontend adapter names, not a claim that the endpoints exist. MCP calls invoke the same domain service.

Render-affecting edits invalidate the render. Copy/title edits increment revision but retain render identity; all edits invalidate approvals. The backend must keep a stable render version distinct from the mutable content revision so copy edits can reuse media. Never publish merely because a browser button was enabled.

Fixture transport is opt-in at `/dev/studio/`, local development or explicitly enabled preview builds only, persistent in this browser and labeled on every view. It does not render, issue tokens, connect accounts, approve publication or simulate provider progress. Production `/studio/` requires a human Supabase session and configured API. No silent fixture fallback.

Open blockers: backend origin/contract agreement; Humanlike authorized avatar and composition; publishing provider/accounts; real MCP auth/transport and client trials. Supply dependency requests to Dimitris instead of modifying the root lockfile concurrently.

## Compatible additions in the studio branch

`Campaign.companyContext` is nullable and records supplied company description, audience, tone, source text/reference and missing information. It does not claim extraction/verification. `capabilities.canCreateCampaign` defaults false when absent. The new start input is strict and bounded to three explicit scripts; engine derives actor/workspace and persists before returning. Source URLs are references only; no fetching is requested.

The editor needs optional source/job read models and submitted-destination restrictions. `ContentPatch.targets` only accepts platform/account/requested instant/timezone, never workflow state or provider evidence. HTTP(S) URLs forbid embedded credentials; timezone schemas reject invalid IANA names. Setup currently requests `campaign:read`, `content:edit`, `render:write`, `schedule:prepare`; confirm these names before enabling token issuance. No publication authority is granted by setup.

Review UI cross-checks current revision and media ID/hash against manifest before enabling approval, but all checks must also run server-side. Unknown submissions retain the same browser retry identity; backend must additionally deduplicate publication intent across recreated approvals and reconnects.
