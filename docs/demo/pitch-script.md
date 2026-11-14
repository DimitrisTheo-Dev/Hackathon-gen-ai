# Faceful — one-minute pitch script

Prepared 15 November 2026 for the page at `/pitch` (production: <https://faceful.vercel.app/pitch>). The page plays the sequence by itself in exactly 60 seconds; this script is timed to it. About 140 spoken words, so there is room to breathe.

## Before you go on

1. Open `/pitch` on the presenting laptop, press **F** for full screen, then **R** to restart at 0:00 the moment you start. The page has its own clock; you follow it, not the other way round.
2. Check the top-right label. **"Illustration"** means no real clip is deployed and Eleni is the drawn presenter. Any other label means `/pitch/presenter.mp4` was found and is playing. It reads "Presenter clip" unless `/pitch/presenter.json` states the real credit, for example `{"credit": "Written in Faceful · performed by Humanlike"}`; write that file only with a credit that is true for the clip. Pick variant A or B below to match.
3. Real clip only: press **M** to unmute before you start (sound plays only in the opening eight seconds). Captions come from `/pitch/presenter.vtt`; replace its cues if the clip's timing differs.
4. Controls: **Space** pause/play · **→ / PageDown** next beat · **← / PageUp** previous beat (twice to go back a full beat) · **1–7** jump to a beat · **R** restart · **B** or **.** blank the screen · **F** full screen. A presentation clicker's forward/back keys work as next/previous. Moving the mouse shows the control strip; it hides itself after two seconds.

## The script

| Time | On screen | Say | Stage direction |
| --- | --- | --- | --- |
| 0:00–0:08 | Eleni full screen, reel caption: "Hi, I'm Eleni. An hour ago I was a sentence in a chat box." | *(nothing)* | Stand to the side, look at the screen, let the room read the caption. With a real clip, let her speak. |
| 0:08 | The camera pulls back: she is one 9:16 draft on the Faceful canvas; the AI Director chat shows the prompt. | **A (real clip):** "This is Faceful. Eleni was written and directed in Faceful and performed by Humanlike — and that is the sentence that made her." **B (illustration):** "This is Faceful. Eleni is one draft on the canvas — and that is the sentence that made her." | Turn to the room. Point at the highlighted prompt on the right. |
| 0:14 | "Make the opening warmer" → the exact change → "Saved as version 2". | "I direct it by chatting. I see the exact change, I apply it — version two. Nothing changes without my say-so." | Gesture at the diff, then at the v2 badge on the card. |
| 0:22 | A terminal slides in: Claude Code runs Faceful's `create_draft` tool; a fourth card lands, "via MCP · Claude Code". | "And my own AI agent works here too. Claude Code calls Faceful's tools, and its draft lands in the same studio, live." | Let the card land before you say "live". |
| 0:30 | Review schedule: "Mon 09:00 · Needs your approval — nothing posts without you". | "When it's time to post, there's a review. Monday, nine o'clock — needs my approval. Nothing posts without me." | Slow down on the last sentence. |
| 0:38 | Why it matters, line 1 | "Why it matters: one prompt to an editable presenter video." | One line per beat; the lines arrive with you. |
| 0:43 | line 2 | "Your own agent works in the same studio, under the same rules." | |
| 0:47 | line 3 | "And one credit balance for you and your agents, billed through Stripe." | |
| 0:52 | Back to Eleni full screen; end card. | "Faceful — the video studio you and your AI agent share. faceful.vercel.app." | Face the room. Hold still until the page stops at 1:00. |

If you run long, press **→** to move on; if you run short, press **Space** to hold a beat and talk over it.

## 15-second fallback

For a cut slot, or if the page cannot be shown:

> "Faceful is the video studio you share with your AI agent. You describe a presenter video, direct it by chatting, and every change is a version you approve. Your own Claude Code works in the same projects over MCP, under the same rules — and nothing posts without you. faceful.vercel.app."

(About 50 words. If the screen works, jump to the end card with **End** while you say it.)

## Honest-wording rules

- **Say "written and directed in Faceful, performed by Humanlike"** for any presenter clip, unless that clip truly came out of Faceful's own render path (a render job in the studio that produced the file). Today it cannot: rendering is not connected (`DEMO_READINESS.md`). Only say "written in Faceful" if the script really was drafted in Faceful — by the AI Director with a model connected, or by your own agent through Faceful's MCP tools — otherwise say "directed in Faceful".
- **With the drawn presenter, she is an illustration.** The page labels her "Illustration"; do not call her a video, an avatar render or AI-generated footage.
- **Never say rendered, published, scheduled or paid** about anything on screen. The studio frames are an interface illustration with sample content; the schedule waits for approval; the "why" line about billing says the demo uses Stripe's sandbox.
- **Do not claim AI writing works on production.** On faceful.vercel.app the director answers "AI writing isn't connected" and offers the Claude Code hand-off. The pitch shows the product as designed; if asked, say exactly that.
- **Name only tested agents.** Claude Code and Codex are tested against this server; other MCP clients "speak the standard", nothing more.
