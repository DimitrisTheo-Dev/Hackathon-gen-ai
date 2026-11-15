# Faceful

A shared content studio for people and their external AI agents: describe a presenter-led video, shape the draft, and let your own agent work in the same projects. The studio UI, the AI Creative Director, the MCP server and the scheduler all call one domain engine (`packages/engine`). The repository is private.

Status, blockers and proof: [`DEMO_READINESS.md`](DEMO_READINESS.md) · contracts: [`INTEGRATION_CONTRACTS.md`](INTEGRATION_CONTRACTS.md) · demo script: [`DEMO_RUNBOOK.md`](DEMO_RUNBOOK.md) · billing: [`STRIPE_SANDBOX_SETUP.md`](STRIPE_SANDBOX_SETUP.md).

## Run locally

Use Node.js 24 and pnpm 12 (pinned via Corepack).

```sh
corepack pnpm install --frozen-lockfile
cp .env.example .env.local   # fill in the values you have; every integration degrades to an honest "not connected" state
corepack pnpm dev:api        # domain API + MCP on http://127.0.0.1:8787 (reads .env.local)
corepack pnpm dev            # studio on http://127.0.0.1:5173; proxies /v1 and /mcp to the API
```

`.env.local` is gitignored. Only `VITE_`-prefixed values reach the browser; `SUPABASE_SECRET_KEY`, Stripe, model and worker credentials are server-only.

Open `http://127.0.0.1:5173/dev/studio/` for the explicitly labeled development transport. Three sample BeWell drafts are editable and persist in that browser. You can also create drafts from your own supplied company brief. No provider calls, video generation, connection handshakes, approvals or publications are simulated.

`/studio/` uses Supabase Auth and the engine on the same origin (`/v1/*`; override with `VITE_CASTROOM_API_URL`). The first sign-in provisions a personal workspace. The typed client never falls back to fixtures on live errors. Supabase project: `hgsgvdujzatfhsjoojll`.

```sh
corepack pnpm test            # unit and contract tests (engine, billing, MCP, studio transport, public surface)
corepack pnpm smoke:engine    # live check against the configured Supabase project (Auth, RLS, Storage)
node scripts/test-engine-rls.mjs   # migration + RLS guarantees in a throwaway local Postgres database
corepack pnpm build
corepack pnpm exec playwright install chromium
corepack pnpm test:ui
```

## Integration boundary

- `apps/web`: studio, focused editor, agent onboarding, static public docs.
- `packages/contracts`: shared Zod read/write schemas used by the studio, the engine and MCP.
- `packages/engine`: the domain engine — tenancy and scopes, projects and immutable versions, render jobs and the renderer worker protocol, schedule review and approval, credits, Stripe sandbox billing, the AI Creative Director and the MCP server. `api/engine.ts` and `api/mcp.ts` are its Vercel Function entries; `supabase/migrations` holds its schema and RLS.
- `scripts/render-worker.ts`: client for the Humanlike recorder seam (claim a job, upload the file, report the outcome).
- `apps/web/src/data/client.ts`: one typed interface; `live.ts` is the route adapter.
- `packages/public-api`: public read-only discovery API and OpenAPI. It reports what the current deployment has configured; it is separate from the authenticated domain API.
- `packages/cli`: repository CLI for public reads and local plan validation. Run `corepack pnpm --silent castroom --help`.
- `apps/web/src/likeness` + `packages/engine/src/likeness.ts`: "Scan my face" at `/face-scan/` — a guided face scan (head turns tracked on-device by MediaPipe), three phrases read aloud and followed by live transcription, and a spoken consent. Recordings go from the browser straight to private R2 (`FACEFUL_R2_*`); the consent is a row in `likeness_consents`. It is the only page whose headers allow the camera and microphone (`vercel.json`).
- `apps/claude-runner`, `apps/machines`, `apps/workspace-store`: Claude Code on one cloud machine per user (Cloudflare Containers), with projects autosaved to R2 and tracked in D1; the page is `/claude-login-test/`. See `docs/architecture/claude-machines.md`.
- `docs/product/contract-handoff.md`: the earlier proposal, kept for history; `INTEGRATION_CONTRACTS.md` is the working contract.
- `docs/demo/verification.md`: executed checks and live acceptance gaps.

Manual creation saves supplied context and 1–3 scripts. It does not infer business facts, fetch URLs or authorize publication. Every edit is version-checked and saved as a new immutable version. Side effects are idempotent on an operation key enforced by the server.

## Deployment

The Vercel project is linked to this private GitHub repository. The engine needs the server environment variables listed in `.env.example`; `GET /v1/health` shows what a deployment has configured. Preview builds enable `CASTROOM_ENABLE_FIXTURES=true`; the production environment forcibly excludes the fixture module. Public docs have initial HTML. Private studio routes require authentication before requesting live data and are excluded from indexing; the backend must authorize every object and operation.

- [Production](https://faceful.vercel.app) (also served at faceful.dtheo.dev)
- [Studio development preview](https://hackathon-gen-98b7cqknx-my-team-29ecd279.vercel.app/dev/studio/) (Vercel team access; sample drafts only)
- [Private repository](https://github.com/DimitrisTheo-Dev/Hackathon-gen-ai)
- [Shared contract handoff](docs/product/contract-handoff.md)

## Attribution and limits

React/Vite placeholder, GitHub/Vercel setup and Supabase API wiring predate this studio implementation (`7714fbd`). The hackathon work adds the studio, contracts, transport, docs and tests. Moonjar inspired the spatial composition; no Moonjar assets or code are redistributed. Original CSS storyboards are labeled as such. BeWell facts link to Quintessential’s published case study; no partnership or media permission is implied. Humanlike is the rendering provider; its documented API offers realtime avatar sessions, and the recorder that turns a session into a file is supplied by Minas through the worker protocol. Dependencies retain their upstream licenses in the pnpm dependency graph. Inter Variable is self-hosted with its SIL Open Font License in `apps/web/public/fonts/LICENSE.txt`.

No Humanlike video has been rendered, no post has been published and no Stripe payment has been taken by this build; see `DEMO_READINESS.md` for exactly what is verified. No time-saved, engagement, security certification or two-minute setup claim is made.
