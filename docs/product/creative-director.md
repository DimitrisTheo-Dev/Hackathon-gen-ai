# Creative Director handoff

The right panel defaults to AI Chat; Details preserves Script, Avatar & Style, Channels, preview, local undo, stale-revision recovery, and explicit render controls. The selected thumbnail/version stays visible. Unsent directions survive item and Details switches within the tab. Conversation history is project-wide; individual turns record selected item and explicit scope. Mobile uses the existing native dialog/keyboard/safe-area surface.

## Available now

Exact instructions (`Set script: …`, `Set title: …`, `Set Instagram caption: …`, `Enable captions`, `Disable captions`, `Use avatar: authorized-name`) produce runtime-validated plans. Each action is reviewed and applied separately through the existing StudioClient, optimistic canvas updates roll back on failure, and undo is a new revision. Project scope is explicit and bounded to three items. Render and schedule-review actions use existing capability checks. No action can grant permission, approve or publish. Attachments select existing approved project sources; file uploads are unavailable.

Local workspace history persists on this device. The development banner is removed; local storage and unavailable services remain clearly identified. Production still requires Supabase authentication and the shared engine. No production fallback to fixtures was added.

## Backend integration

`context.capabilities.canPlanWithDirector` defaults false. Enable only after the authenticated domain service implements `POST /v1/studio/director/plan`: campaignId, itemId, expectedRevision, scope (`item` or `project`), instruction (max5000), sourceIds and operationKey. Resolve authoritative user/workspace membership and full campaign/brand/source/avatar/channel context server-side; do not trust IDs as authority or source text as instructions. Return `directorPlanSchema` from `apps/web/src/director/model.ts`. It permits only revise, render and review_schedule, max3 unique item actions. Planning cannot dispatch jobs. Writes use the existing typed domain operations and stable cross-session keys. Unknown external outcomes pause for reconciliation; they never trigger automatic rerender/repost. No streaming protocol is advertised; existing jobs are polled.

Natural-language creative rewriting, voice/pacing/aspect-ratio changes and variations remain unavailable until supported by the engine. No model result is fabricated. Literal draft changes are explicitly user-supplied.

## Supabase conversation storage

Migration `supabase/migrations/20261114151010_director_conversations.sql` was applied through the native Supabase SQL editor to hosted project `hgsgvdujzatfhsjoojll`. The hosted RLS flags, policies and table grants were verified. Browser project access works; the connected Supabase integration still denies access. `castroom_director_access` is a fail-closed bridge for verified user/workspace/campaign access. No access grants have been provisioned. Minas must integrate provisioning/revocation with the domain membership lifecycle before enabling conversation sync; browsers cannot create grants. New accounts have no grants. The entries table is append-only and user-scoped; client snapshots cannot overwrite prior records. Deterministic merge prevents late snapshots from regressing confirmed outcomes. Conversation notes are never workflow audit evidence or publication approval.

The browser authenticates to Supabase with its existing session/public key. No secret/service key is used. Sync errors stay visible; no silent live-to-local fallback. Run `node scripts/test-director-rls.mjs` against local PostgreSQL to create, test and remove an isolated database. The script rolls back temporary roles and validates owner writes plus wrong-tenant, forged-user, self-grant, overwrite, revoked and anonymous denials. Hosted authenticated denial tests and advisories have not been established by the SQL-editor checks; the local denial tests remain separate evidence. Because the SQL was executed in the dashboard, the migration was not registered in Supabase migration history. Compare the hosted definition with the repository and register/repair version `20261114151010` as applied before a later `supabase db push`, so the tables are not created twice.

## Verification limits

OTP screens use Supabase Auth. The intended sender is Faceful `<signin@faceful.dtheo.dev>`; the Resend domain is verified, SMTP and both six-digit OTP templates are saved (see resend-otp.md). Mocked browser auth tests do not prove email delivery. Chat-to-canvas tests use actual local transport revisions/storage; no Humanlike render or publication is claimed. Physical iOS/Android testing remains pending.
