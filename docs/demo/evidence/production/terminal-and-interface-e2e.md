# End to end on production: terminal (Claude Code over MCP) and interface

15 November 2026, late morning (Athens). Both runs used <https://faceful.vercel.app> with the seeded demo workspace "Quintessential". Nothing was mocked.

## Terminal: Claude Code through the production MCP server

**Setup:**
- The demo account, signed in as itself, created a workspace token through the production API, the same call "Connect your agent" makes. The token is named "Claude Code · terminal demo", expires in three hours, and carries agent scopes only: `campaign:read`, `content:edit`, `render:write`, `schedule:prepare`, `billing:read`, `billing:checkout`.
- The token was kept in a private file and passed through an environment variable. It was never printed.

**Command:**

```bash
FACEFUL_TOKEN=$(cat token) claude -p "<the nine-step request below>" \
  --mcp-config faceful.mcp.json --strict-mcp-config --allowedTools "mcp__faceful__*"
# faceful.mcp.json: {"mcpServers":{"faceful":{"type":"http","url":"https://faceful.vercel.app/mcp",
#                   "headers":{"Authorization":"Bearer ${FACEFUL_TOKEN}"}}}}
```

**The request:**
1. List my projects.
2. Create a project for a 15-second Instagram Reel.
3. Write an English and a Greek presenter script (at most 35 words each).
4. Make the English opening warmer.
5. List the presenters.
6. Try to render the English draft.
7. Propose YouTube on Monday at 09:00 Europe/Athens.
8. Try to approve.
9. Check billing.

Claude Code 2.1.325 was told to report each real tool result and never to retry a refused step.

**Result of the second run, after the region fix below:** 11 turns, no errors, 64 s end to end.

| Step | Tool | Real result | Server time |
| --- | --- | --- | --- |
| 1 | `list_projects` | Workspace and its projects | 259 ms |
| 2 | `create_project` | "Terminal demo · BeWell winter" created, with the English draft | 1286 ms |
| 3 | `create_draft` | Greek draft saved | 1128 ms |
| 4 | `revise_draft` | English draft saved as a new revision with a warmer opening | 955 ms |
| 5 | `list_avatars` | No presenters; `renderingAvailable: false` with the reason | 0 ms |
| 6 | `start_render` | `provider_unavailable`: rendering isn't connected. Not retried; no credit held | 203 ms |
| 7 | `propose_schedule` | Draft time saved for Mon 16 Nov 09:00 Athens, listing its blockers (no video, no channel, approval) | 1964 ms |
| 8 | `approve_schedule` | `approval_required`: a signed-in member must approve; review link returned | 66 ms |
| 9 | `get_billing_status` | Sandbox demo plan, active, 33 credits | 127 ms |

Server times come from the engine's own `mcp_tool` log lines on Vercel.

Claude Code's closing summary said "Nothing has been rendered, scheduled or published". It named the three blockers (a renderer, a connected YouTube channel, a member's approval) and linked the studio review. It also noted that the scripts contain no date or venue because none was given.

### A problem this run found, and its fix

The first run, with functions in `iad1`, also completed, but `create_draft` returned "The operation timed out." The engine never says that: Claude Code's HTTP client gave up while the server was still working. The draft was saved once, and Claude Code confirmed this by listing the project instead of retrying.

The cause: Supabase runs in `eu-central-1` (Frankfurt) while the functions ran in Washington (`x-vercel-id: fra1::iad1`), so every query crossed the Atlantic.

The fix (PR #26) was `"regions": ["fra1"]` in `vercel.json`. Production now answers `fra1::fra1`.

| Tool | Before (`iad1`) | After (`fra1`) |
| --- | --- | --- |
| `list_projects` | 1267 ms | 259 ms |
| `create_draft` | client timed out | 1128 ms |
| `revise_draft` | 2984 ms | 955 ms |
| `propose_schedule` | 6230 ms | 1964 ms |
| Whole run | 86 s | 64 s (mostly model time) |

## Interface: the same workspace in the studio (Playwright, signed in as the demo account)

| Step | Result | Screenshot |
| --- | --- | --- |
| Open the studio | Signed in, workspace "Quintessential" | — |
| Open the project Claude Code made | Both drafts are on the canvas; the English one shows "Mon 16 Nov, 09:00" | `e2e/01-agent-project-canvas.png` |
| Campaign activity | Each step is credited to "Claude Code · terminal demo" | `e2e/02-agent-activity.png` |
| Review schedule | "Not ready to schedule · 3 steps left": videos rendered 0 of 2 (rendering not connected), posting times and channels 0 of 2 (connect a YouTube channel), your approval (owner only) | `e2e/03-agent-project-review.png` |
| Create a project by hand ("Create with my own script", three steps) | "Interface demo · Sunday reset" with one draft | `e2e/04-create-dialog.png`, `e2e/05-created-canvas.png` |
| Review schedule for it | The same three honest steps | `e2e/06-created-review.png` |

There were no page errors.

## What is still missing for a real post (and who supplies it)

1. **A renderer that produces a video file:** a Humanlike secret key, LiveKit credentials and a voice, plugged into `scripts/render-worker.ts` (Minas). Until then `start_render` refuses honestly, and no credit is held.
2. **A connected YouTube channel:** the YouTube Data API v3 enabled on the Google project behind the OAuth client, with the presenter's Google account allowed on its consent screen (Minas). Then one person clicks "Connect YouTube" in the studio. Uploads stay private until Google audits the API project.
3. **A person's approval** in the studio. This is by design: agents can propose, never approve.

When 1 and 2 exist, the same terminal request continues past step 6: the render job produces a file, the schedule becomes approvable, the owner approves once, and the publisher uploads to YouTube.
