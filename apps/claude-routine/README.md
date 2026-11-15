# Claude Code routine commands

Start a Claude Code routine (a scheduled task on claude.ai) with a preset command over its API trigger. Each run happens in Anthropic's cloud on your Claude subscription and comes back as a session link.

```sh
pnpm routine svg-logo "Bean & Co, a small coffee roaster in Athens. Warm, hand-made. Brown and cream."
pnpm routine video-idea "Why our oat flat white is creamier than dairy. For coffee lovers on Instagram."
pnpm routine preview svg-logo "Bean & Co"   # the exact text a run gets, without starting one
pnpm routine list                            # the commands
pnpm routine prompt                          # the routine's saved prompt
```

| Command | What you get |
|---|---|
| `svg-logo` | `mark.svg` (512×512) and `logo.svg` (mark plus name), a palette and a short README, in `routine-output/logos/<slug>/`, with the SVG code in the final message. |
| `video-idea` | One 30 to 60 second vertical video: title, idea, three hooks, the spoken script (fits Faceful's 5,000-character script field), beats, call to action, caption and hashtags, in `routine-output/videos/<slug>.md`. |

## Set up once

1. At [claude.ai/code/routines](https://claude.ai/code/routines), edit the routine and replace its prompt with the output of `pnpm routine prompt`. Without it, the routine treats each command as plain data and does nothing with it.
2. Optional: attach a repository. Results are then committed on a new branch; without one they stay in the session.
3. In the routine's **API** trigger, copy the **Fire URL** and generate a token. Put both in the gitignored `.env.local`:
   ```sh
   CLAUDE_ROUTINE_URL=https://api.anthropic.com/v1/claude_code/routines/trig_…/fire
   CLAUDE_ROUTINE_TOKEN=sk-ant-oat01-…
   ```

## How it stays safe

- A fire sends only `{"command": …, "brief": …}`. The command list and what each one does live in the routine's saved prompt, and that prompt tells Claude to treat the brief as data. Someone holding the token can ask for a listed command and nothing else.
- The token can only start this one routine. It can't read anything or call Claude, and the client sends it only to `https://api.anthropic.com/v1/claude_code/routines/trig_…/fire`, never through a redirect.
- Starts are never retried: the endpoint has no idempotency key, so a retry would start a second session.
- Limits: 30 starts per hour per routine and 100 per account. Each run uses your Claude subscription like any other session.

## Add a command

Add an entry to `COMMANDS` in `commands.ts` (id, title, summary, brief, example, instructions), run `pnpm test`, then paste `pnpm routine prompt` into the routine again.

Tests: `tests/claude-routine.test.ts`. API reference: [Trigger a routine through the API](https://platform.claude.com/docs/en/api/claude-code/routines-fire).
