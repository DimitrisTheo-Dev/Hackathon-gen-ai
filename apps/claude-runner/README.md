# Claude Code runner

Runs the official Claude Code CLI on your own VPS or on a per-user cloud machine, signed in with your own Claude subscription. The page at `/claude-login-test/` connects to it, signs in on the server and streams sessions.

- `server.ts`: zero-dependency Node 24 service. Every `/v1` call needs `Authorization: Bearer $RUNNER_ACCESS_KEY` and an origin listed in `RUNNER_ALLOWED_ORIGINS`.
- Sign-in runs `claude auth login --claudeai` on the server. The page shows the claude.com link and sends back the code. Credentials stay in the container's home volume. A pasted `claude setup-token` token is the fallback (stored `0600`).
- `ANTHROPIC_API_KEY` is stripped from Claude's environment, so usage always goes to the subscription, never API billing.
- Runs use `claude -p --output-format stream-json`; the prompt goes in on stdin. One run at a time; closing the page or pressing Stop ends it.
- The image builds for another CPU without emulation: stage 1 downloads the official binary on the build machine, stage 2 only copies files.

## On a VPS

1. Install Docker, point a domain (for example `claude.yourdomain.com`) at the server, and open ports 80 and 443.
2. Copy this folder to the server, then `cp .env.example .env`, set `RUNNER_ACCESS_KEY` (`openssl rand -hex 32`), `RUNNER_DOMAIN`, and the page origins.
3. `docker compose --profile https up -d --build`. Caddy gets the HTTPS certificate.
4. Open `/claude-login-test/`, paste `https://<your domain>` and the key, then press **Sign in with Claude**.

## One machine per user (Cloudflare Containers)

`apps/machines` runs this same image as one container per user and puts a gateway in front: it checks who is calling, wakes their machine, and records machines, projects and saves in D1. The container's disk is fresh on every wake, so on boot the runner restores Claude's sign-in and history, and each project comes back on its first run. The design is in [docs/architecture/claude-machines.md](../../docs/architecture/claude-machines.md).

## Projects and cloud saves

With `STORE_URL` and `STORE_TOKEN` set (the token opens only that user's R2 folder through `apps/workspace-store`):

- `POST /v1/run {prompt, project}` works in `work/<project>` and autosaves it to `projects/<project>/autosave.tar.gz` after every run.
- `POST /v1/workspace/save` keeps a version under `projects/<project>/saves/`; `POST /v1/workspace/restore` swaps the files, after saving the current ones as a new version.
- Claude's sign-in and session history are saved to `private/claude-home.tar.gz` after sign-in and after every run, sealed with AES-256-GCM when `CLAUDE_HOME_KEY` is set (cloud machines always set it; Claude never sees the key).
- `POST /v1/sync` saves everything; the gateway calls it before a machine sleeps.

Mint a token for a standalone runner with `node apps/workspace-store/mint-token.mjs <user-id> [ttl]` (needs `FACEFUL_STORE_SIGNING_KEY`; the lifetime defaults to 30 days, at most 90). Cloud machines don't need one: the gateway gives each a 12-hour token and renews it.

## Locally

```sh
cd apps/claude-runner && cp .env.example .env   # set RUNNER_ACCESS_KEY; RUNNER_PORT if 8787 is busy
docker compose up -d --build runner
```

Then open `http://127.0.0.1:5173/claude-login-test/` with `pnpm dev` running and use `http://127.0.0.1:<RUNNER_PORT>`.

Full access mode lets Claude run any command inside the container, which can also read this runner's key and sign-in. Keep the runner for your own subscription and your own use.
