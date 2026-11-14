# Demo video — footage and cut list

Recorded 15 November 2026 from production (<https://faceful.vercel.app>) with `scripts/record-demo.ts`, signed in as the password-only demo account (workspace "Quintessential"). Every clip is 1920×1080, 25 fps WebM (VP8), one beat per file, with a visible cursor drawn over the page and human-paced pointer movement and typing. Files live in the local, gitignored `demo-footage/` folder; `demo-footage/manifest.json` lists each clip's length and notes.

```bash
node --env-file=.env.local --import tsx scripts/record-demo.ts          # clips 1–9 (checkout last)
node --env-file=.env.local --import tsx scripts/record-demo.ts 4 6      # re-record single clips
node --env-file=.env.local --import tsx scripts/record-demo.ts --no-checkout
DEMO_ORIGIN=http://127.0.0.1:6377 node --env-file=.env.local --import tsx scripts/record-demo.ts 0   # /pitch, opt-in
```

**Trim the head of every clip by about 1 second**: Playwright starts recording on a blank page before the first paint (`usableFrom` in the manifest). Durations below are recorded lengths, rounded.

**What a run changes in the demo workspace** (all intended): clip 3 sends one request to the director, which answers that AI writing isn't connected; clip 4 saves one exact script edit, so the sample draft "Find your next moment" gains a version each run (this recording: version 3 → 4); clip 9 starts a Stripe **sandbox** subscription with the test card (this recording: credits 3 → 33, "Demo plan · Active"). To record clip 9 again, cancel the test subscription first (Billing → "Manage billing on Stripe", or the Stripe sandbox dashboard); while a subscription is active the clip records the billing page only and says so. Nothing creates, reveals or revokes an agent token; no environment values appear. Stripe's page shows the demo account's own email address (not a credential) — blur it in the edit if you prefer.

## Clips

| # | File | Length | What it shows | Suggested voice-over |
| --- | --- | --- | --- | --- |
| 00 | `00-pitch.webm` | 63 s | The `/pitch` page from 0:00 to its end card, as a fallback video for the one-minute pitch (recorded from the local dev server, illustration presenter, honest "Illustration" label). Screen-capture smoothness is lower than the live page; use it only if the page cannot run. | Use `docs/demo/pitch-script.md`. |
| 01 | `01-landing.webm` | 32 s | Landing hero, cursor over "Start creating", scroll to the illustrated studio demo, one full loop (prompt → drafts → presenter chosen → version 2 → posting time needs approval → an agent adds a draft), then the "From a sentence to a campaign you approve" section. | "Faceful is a video studio for short presenter-led videos — and it's built so your own AI agent can work in it with you." |
| 02 | `02-sign-in.webm` | 10 s | The sign-in card: "Continue with Google", a placeholder address typed into the email field. **Not submitted.** | "Sign in with an email code or with Google. Your workspace is ready the first time." |
| 03 | `03-studio-home.webm` | 36 s | "What will we create today?" composer; Format → Reel, Length → 15s, Language → Greek pills; a typed request; the director's honest reply "AI writing isn't connected to this deployment yet…" (basic mode) and the **"Your own Claude Code can write this"** hand-off card with the exact prompt and "Copy prompt". The reply docks into the most recent project's chat. | "You start with one sentence — format, length, language. This deployment doesn't have AI writing connected, and Faceful says so plainly. Then it hands the exact request to your own Claude Code." |
| 04 | `04-bewell-edit.webm` | 41 s | Sample project "A week of BeWell" (labelled Sample), open "Find your next moment", type `Set script: …` in the AI Chat, the reviewable diff (old script struck through, new one in green), **Apply changes** → "Saved · v4", Details → Versions list (Version 4 current, earlier versions with "Restore … as new"). | "Edits are proposals I approve. An exact script change shows me the diff; I apply it, and it's saved as a new version — every earlier version stays." |
| 05 | `05-brand-kit.webm` | 26 s | Brand kit: colour, voice, audience, guardrails, sources; scroll; "Add source" sheet (title, optional link, pasted text, "Faceful never fetches links") → **Cancel**. | "The brand kit — voice, audience, guardrails and sources — is what every draft is written against." |
| 06 | `06-schedule-review.webm` | 23 s | Schedule week view for the sample (Mon/Wed/Fri 09:00 Europe/Athens, every row a **Draft time**; "No channel connected"), then **Review schedule**: "Not ready to schedule" — Videos rendered 0 of 3, Posting times and channels 0 of 3, Your approval (owner only); "Approve exact schedule" disabled. | "Posting times are drafts until a person approves them. The review says exactly what's missing — no rendered video, no connected channel — and approval is owner-only." |
| 07 | `07-agents.webm` | 24 s | Agents grid (Claude Code and Codex "Tested", others "Standard MCP"), then Connect Claude Code: workspace token step (already active; **no token created**), the `claude mcp add …` command with a `paste-your-token` placeholder, "Ask your agent: List my Faceful projects", Your connections. | "Connect Claude Code, Codex or any MCP client — with a workspace token or OAuth. Same projects, same rules." |
| 08 | `08-agent-project.webm` | 27 s | "BeWell — Monday Morning Instagram Reel (15s, Greek)", the project a connected Claude Code agent created: three Greek drafts (A/B/C hooks); **Campaign activity** shows every step attributed to **Claude Code** ("Created drafts from a supplied brief", "Set script language", "Added a draft"); then draft A's editor. | "And this is a project my agent made from that hand-off — three Greek drafts, every step attributed to Claude Code in the activity log." |
| 09 | `09-billing-checkout.webm` | 56 s | Billing and usage (3 credits, Free) → **Upgrade with Stripe test checkout** → Stripe's hosted page ("Faceful sandbox · Sandbox", €19.00/month demo plan) → Card row → 4242 4242 4242 4242 · 12/34 · 123 → **Pay and subscribe** → back in the studio: "Stripe confirmed your subscription", **33 credits**, **Demo plan · Active**, "Test mode — no real charges". | "Rendering uses credits — one balance for you and your agents. You pay on Stripe's own page; this is sandbox mode with a test card. The plan changes only when Stripe's signed webhook confirms it." |

## A 2½-minute demo video

| Time | Clip (in → out) | Notes |
| --- | --- | --- |
| 0:00–0:12 | 01 (0:01 → 0:13) | Hero, then cut into the demo loop. |
| 0:12–0:17 | 02 (0:01 → 0:06) | Optional; drop it if you are long. |
| 0:17–0:40 | 03 (0:03 → 0:26) | Hold on the reply and the hand-off card. |
| 0:40–1:00 | **Terminal recording** (see below) | Claude Code takes the hand-off prompt and calls `create_project` / `create_draft`. |
| 1:00–1:12 | 08 (0:02 → 0:14) | The agent's project and its activity log. |
| 1:12–1:35 | 04 (0:08 → 0:31) | Exact edit → diff → Apply → version list. |
| 1:35–1:45 | 05 (0:04 → 0:14) | Brand kit, one scroll. |
| 1:45–1:58 | 06 (0:05 → 0:18) | The honest review. |
| 1:58–2:06 | 07 (0:03 → 0:11) | Agents grid and the Claude Code steps. |
| 2:06–2:28 | 09 (0:04 → 0:12, 0:24 → 0:38, 0:46 → 0:52) | Billing → Stripe card entry → active plan, credits 33. |
| 2:28–2:35 | `/pitch` end card (00 at 0:55 → 1:02) | "Faceful — the video studio you and your AI agent share", faceful.vercel.app. |

## In the 60-second pitch

The pitch is the `/pitch` page itself (`docs/demo/pitch-script.md`). If the page cannot run on the venue machine, play `00-pitch.webm`. If you want real product footage instead of the illustrated studio beats, the matching clips are: beat a (edit → version 2) → 04 at 0:16–0:32; beat b (agent over MCP) → the terminal recording plus 08 at 0:04–0:14; beat c (needs your approval) → 06 at 0:08–0:18; the Stripe line → 09 at 0:46–0:52.

## The Claude Code part — record this yourself

A terminal cannot be recorded headlessly. Record your own screen (macOS: ⇧⌘5, "Record Selected Portion", 1920×1080; a large terminal font, 18–20 pt, light theme to match the studio).

**Off camera** (keeps the token out of the recording):

```bash
# 1. Create a workspace token in the studio (Agents → Claude Code → Create another token) — off camera.
# 2. Put it in the environment without echoing it:
read -rs FACEFUL_TOKEN && export FACEFUL_TOKEN
# 3. A config file with no secret in it; Claude Code reads the token from the environment:
cat > faceful.mcp.json <<'JSON'
{"mcpServers":{"faceful":{"type":"http","url":"https://faceful.vercel.app/mcp","headers":{"Authorization":"Bearer ${FACEFUL_TOKEN}"}}}}
JSON
clear
```

**On camera**, the hand-off prompt exactly as the studio wrote it in clip 03 (copy it with "Copy prompt"; this is the text from the recording):

```bash
claude -p "Using the Faceful tools, create a project for this request: A friendly Greek presenter introduces BeWell’s Monday morning sessions, ready for Monday at 09:00. — an Instagram Reel, 15 seconds, in Greek.
Write 1–3 short presenter scripts (about 15 seconds each) and save them as drafts with create_project and create_draft. Don't render, schedule or publish anything. Tell me what you created." \
  --mcp-config faceful.mcp.json --strict-mcp-config \
  --allowedTools "mcp__faceful__list_projects,mcp__faceful__create_project,mcp__faceful__create_draft"
```

Then, still recording, switch to the studio: the new project appears in the sidebar within about five seconds (the studio polls). Optional follow-up shot:

```bash
claude -p "List my Faceful projects." --mcp-config faceful.mcp.json --strict-mcp-config --allowedTools "mcp__faceful__list_projects"
```

For a more visual take, run it interactively so each MCP call is shown and approved on screen: `claude --mcp-config faceful.mcp.json --strict-mcp-config`, paste the prompt, and answer "Yes" to each `faceful` tool call. The `claude -p … --mcp-config … --strict-mcp-config --allowedTools …` shape above is the one already tested against this server (`docs/demo/evidence/engine/mcp-client-trials.md`, `docs/demo/evidence/production/mcp-and-oauth.md`). Revoke the token afterwards in Agents → Your connections.

Say over it: "Here my own Claude Code takes that hand-off and calls Faceful's tools — create project, create draft. It can draft; it can't render, schedule or approve. Only I can."

## Wording to keep honest in the edit

- Production runs the director in basic mode: say "AI writing isn't connected on this deployment" if it comes up; the drafts in clip 08 were written by Claude Code through Faceful's tools.
- Nothing in the footage is rendered or published; the review in clip 06 shows that, and the voice-over should not contradict it.
- Billing is Stripe's sandbox: say "test mode" or "sandbox", never "paid".
