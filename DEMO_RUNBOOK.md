# Faceful demo runbook

Updated 15 November 2026. Read `DEMO_READINESS.md` first: it says which steps below are live, which are blocked and why. Never narrate a blocked step as if it worked; each blocked step has an honest on-screen state you can show instead.

Origin: <https://faceful.vercel.app>. Pitch surface: <https://faceful.vercel.app/pitch> (not linked from the product, `noindex`; script in `docs/demo/pitch-script.md`, cut list in `docs/demo/demo-video-cut-list.md`).

## Before the demo (once)

1. **Deploy with server environment variables** (Vercel → Project → Settings → Environment Variables; names in `.env.example`). Minimum for the live studio: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `APP_BASE_URL`, `CRON_SECRET`. For AI drafting add `GEMINI_API_KEY` (or `ANTHROPIC_API_KEY`). For billing add the three `STRIPE_*` values (`STRIPE_SANDBOX_SETUP.md`). For rendering add `RENDER_WORKER_TOKEN` and start the recorder worker (`INTEGRATION_CONTRACTS.md` §7).
2. **Check what is live**: open `<origin>/v1/health`. It reports `director` (`ai`/`basic`), `rendering.connected`, `billing.mode` and `scheduler` for that deployment. Say only what this endpoint confirms.
3. **Prepare the demo workspace** with the seed script. It goes through the same engine operations the studio uses and touches only that person's personal workspace:
   ```bash
   # Your own account (sign in once first so the workspace exists):
   node --env-file=.env.local --import tsx scripts/demo-seed.ts --email you@example.com --workspace-name "Quintessential"
   # The password-only recording account (DEMO_USER_EMAIL / DEMO_USER_PASSWORD in .env.local):
   node --env-file=.env.local --import tsx scripts/demo-seed.ts --demo-account
   ```
   It saves the BeWell brand kit, adds the labelled BeWell sample project with its source, and sets draft posting times for next Monday, Wednesday and Friday at 09:00 Europe/Athens (drafts, never scheduled). Add `--reset` to delete that workspace's projects and agent tokens first. The production recording account is seeded today: workspace "Quintessential", BeWell brand kit, the sample project and one agent-written Greek project.
4. **Agent connection** (for Journeys B and C): in the studio open "Connect your agent", create a workspace token, and export it as `FACEFUL_TOKEN` in the terminal you will demo from. The token is shown once.
5. **Use a fresh email** instead when you want to show first-run sign-in and onboarding.

Two dedicated test accounts are used for automated checks (not for the demo). Their addresses and passwords live only in the maintainer's local `.env.local`.

## Journey A — studio (90–120 seconds)

| Time | Do | Say | If blocked |
| --- | --- | --- | --- |
| 0:00 | Open the public page. | "Faceful is a studio where you describe a video and a presenter-led draft appears — and your own AI agent can work in the same studio." | — |
| 0:10 | Start creating → sign in. You land on the composer: "What will we create today?" | "No setup. One prompt." | — |
| 0:20 | Type: *Create a 15-second Instagram Reel for BeWell with a friendly Greek-speaking presenter. Make the opening energetic and prepare it for Monday morning.* | "The same conversation docks to the right and the draft opens in the middle." | **Director in basic mode** (no model key): the director says it cannot write yet. Use "Choose a template" → "15-second introduction" in Greek, or the BeWell sample. Say: "AI drafting needs a model key on this deployment; templates produce the same editable draft." |
| 0:40 | Show the saved script, language, proposed Monday time (Europe/Athens) and the Draft badge. | "This is saved, versioned state — refresh and it is still here. The time is a draft proposal, not a scheduled post." | — |
| 0:55 | Ask: *Shorten the first line and keep the outro.* Review the diff, apply. Open Versions. | "Edits are proposals I approve. Each one is a new version; the old one stays." | Basic mode: use `Set script: …` or edit in Details; versions work the same. |
| 1:10 | Choose a presenter and start the render. | "Rendering holds one credit and runs as a durable job." | **Rendering not connected**: the control is disabled with the reason. Say: "Humanlike gives us realtime avatar sessions; the recorder that turns one into a file is the remaining integration. The job pipeline, storage and playback are in place." Do not show a video unless a real render exists. |
| 1:25 | Ask: *Find my latest BeWell video and play it.* | "Retrieval is instant and never starts a new render." | With no rendered video it opens the draft and says so. |
| 1:35 | Review schedule. | "Publishing needs an exact review and a person's approval. Nothing is posted from chat." | Always blocked today: the review lists "no publishing destination is connected". Show the blockers; that is the honest state. |
| 1:45 | Billing → Upgrade → Stripe test Checkout with card `4242 4242 4242 4242` → return. | "Payment happens on Stripe's page. Credits change only when Stripe's signed webhook arrives." | **Stripe not configured**: the Billing page says so. Show the credit balance and the blocked state. |

## Journey B — external agent (45–60 seconds)

```bash
# Codex CLI 0.169.0
codex mcp add faceful --url "<origin>/mcp" --bearer-token-env-var FACEFUL_TOKEN
# Claude Code 2.1.325: add to .mcp.json
# {"mcpServers":{"faceful":{"type":"http","url":"<origin>/mcp","headers":{"Authorization":"Bearer ${FACEFUL_TOKEN}"}}}}
```

1. Ask the agent: *List my Faceful projects.* It shows the project you just made in the studio.
2. Ask: *Add a draft titled "Agent angle" to that project with a one-sentence script.* Switch to the studio: the new draft appears within five seconds.
3. Ask: *Start a render for it.* The agent reports the same result the studio would (queued, or `provider_unavailable` with the reason).
4. Ask: *Approve the schedule.* The agent is told a person must approve in the studio and is given the review link.

Say: "Same projects, same rules, same answers — the agent cannot approve, publish or manage billing."

Recorded trials of this journey: `docs/demo/evidence/production/mcp-and-oauth.md` (Claude Code against production) and `docs/demo/evidence/engine/mcp-client-trials.md` (Codex and Claude Code against a local engine on the real database).

## Journey C — "use your own Claude" hand-off (30–45 seconds)

While AI writing is not connected on the server, the composer offers **"Your own Claude Code can write this"** with a ready-to-paste prompt.

1. Type the BeWell request in the composer and send it. The card appears with the prompt and a Copy button.
2. Paste it into Claude Code (connected as in Journey B). It creates the project and writes 1–3 short presenter scripts through Faceful's tools; it is told not to render, schedule or publish.
3. Switch back: the project and drafts appear in the studio within five seconds, marked as written by the agent connection.

Say: "Your subscription, your agent, our studio. Faceful never holds your Claude credentials." Verified on production: `docs/demo/evidence/production/mcp-and-oauth.md` § Hand-off prompt.

## Reset

- `node --env-file=.env.local --import tsx scripts/demo-seed.ts --email you@example.com --reset` (or `--demo-account --reset`) deletes that workspace's projects (items, versions, jobs and media rows cascade) and revokes its agent tokens, then re-seeds. Or sign in with a fresh email for a clean first-run.
- Stripe: cancel the test subscription in the Customer Portal or the sandbox Dashboard. Billing then shows "Ends <date>" instead of "Renews <date>", once Stripe's signed webhook arrives.

## If something goes wrong

| Symptom | Meaning | Do |
| --- | --- | --- |
| "We couldn’t open your workspace" / engine not configured | Server environment variables are missing on that deployment | Check `<origin>/v1/health`; use the labelled local preview at `/dev/studio/` only as a clearly named fallback |
| Director answers in basic mode | No model key | Use templates and exact edits |
| Render stays queued | No worker is claiming jobs | It fails by itself after the queue timeout and returns the credit; say so |
| Checkout succeeded but the plan did not change | The webhook has not arrived | Wait a few seconds; check Stripe Workbench → Webhooks. The redirect alone never changes the plan |
| Agent gets 401 | Token expired or revoked | Create a new token |
| `429 quota_exceeded` | A rate limit (`INTEGRATION_CONTRACTS.md` §4); the response says how many seconds to wait | Wait `Retry-After` seconds. Director turns are limited to 10 a minute per person |

Every API response carries `X-Correlation-Id`; the same ID is in the function logs and the project's Activity list.
