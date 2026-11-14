# Claude Code runner

Runs the official Claude Code CLI on your own VPS, signed in with your own Claude subscription. The page at `/claude-login-test/` connects to it, signs in on the server and streams sessions.

- `server.ts`: zero-dependency Node 24 service. Every `/v1` call needs `Authorization: Bearer $RUNNER_ACCESS_KEY` and an origin listed in `RUNNER_ALLOWED_ORIGINS`.
- Sign-in runs `claude auth login --claudeai` on the server. The page shows the claude.com link and sends back the code. Credentials stay in the container's home volume. A pasted `claude setup-token` token is the fallback (stored `0600`).
- `ANTHROPIC_API_KEY` is stripped from Claude's environment, so usage always goes to the subscription, never API billing.
- Runs use `claude -p --output-format stream-json`; the prompt goes in on stdin. One run at a time; closing the page or pressing Stop ends it.

## On a VPS

1. Install Docker, point a domain (for example `claude.yourdomain.com`) at the server, and open ports 80 and 443.
2. Copy this folder to the server, then `cp .env.example .env`, set `RUNNER_ACCESS_KEY` (`openssl rand -hex 32`), `RUNNER_DOMAIN`, and the page origins.
3. `docker compose --profile https up -d --build`. Caddy gets the HTTPS certificate.
4. Open `/claude-login-test/`, paste `https://<your domain>` and the key, then press **Sign in with Claude**.

## Locally

```sh
cd apps/claude-runner && cp .env.example .env   # set RUNNER_ACCESS_KEY; RUNNER_PORT if 8787 is busy
docker compose up -d --build runner
```

Then open `http://127.0.0.1:5173/claude-login-test/` with `pnpm dev` running and use `http://127.0.0.1:<RUNNER_PORT>`.

Full access mode lets Claude run any command inside the container, which can also read this runner's key and sign-in. Keep the runner for your own subscription and your own use.
