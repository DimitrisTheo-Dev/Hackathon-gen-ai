# Claude Code machines: one container per user

Status, 15 Nov 2026: built, deployed on Cloudflare and tested on real machines (see "Tested live"). The runner, store, gateway, database and the `/claude-login-test/` page are live. boxd was dropped when its signups ran out; the same runner image still works on any VPS.

## Shape

```
 Browser  /claude-login-test
   │  Bearer: Faceful session (Supabase JWT)  or  personal token fgw1.<uid>.<sig>
   ▼
 Worker  faceful-machines  ── verifies who is calling, never trusts a user id from the request
   │                         D1 faceful-machines: machines · projects · saves
   ▼
 Durable Object + Container  UserMachine(<uid>)        one per user, standard-1, sleeps after 15 min idle
   │   apps/claude-runner  →  claude -p  (official CLI, the user's own Claude sign-in)
   │   /home/node/work/<project>/        fresh disk on every wake
   ▼
 Worker  faceful-workspace-store  ──binding──►  R2 faceful-workspaces / users/<uid>/…
```

## Pieces

| Piece | Where | Job |
|---|---|---|
| Page | `apps/web/src/claude` | Connect, sign in to Claude, pick a project, stream runs, see autosaves, save and restore versions, put the machine to sleep. |
| Gateway | `apps/machines` (Worker `faceful-machines`) | Identifies the caller, routes them to their own container, records machines, projects and saves in D1. |
| Machine | `UserMachine` Durable Object + Cloudflare Container | Runs the runner image. Its id is the runner's access key, so only the gateway can reach it. |
| Runner | `apps/claude-runner` | Zero-dependency Node 24 service: Claude sign-in, one run at a time, per-project folders, autosave, restore. |
| Store | `apps/workspace-store` (Worker `faceful-workspace-store`) | The only way into R2. Token `fst1.<uid>.<hmac>` opens `users/<uid>/` and nothing else. |
| Bucket | R2 `faceful-workspaces` (WEUR) | The durable copy of every project and of Claude's sign-in. |
| Database | D1 `faceful-machines` (`apps/machines/schema.sql`) | `machines`, `projects`, `saves`. |

## How many machines

The Cloudflare account's own limits (read from the API on 15 Nov 2026): 15,000 vCPU, 60 TiB memory and 300 TB disk running at once; at most 4 vCPU, 12 GiB and 20 GB per container.

| Size | vCPU | Memory | Disk | Awake at once (account limit) | Cost while awake |
|---|---|---|---|---|---|
| basic | 1/4 | 1 GiB | 4 GB | about 60,000 | about $0.03/h |
| standard-1 (used) | 1/2 | 4 GiB | 8 GB | about 15,000 (memory-bound) | about $0.07/h |
| standard-2 | 1 | 6 GiB | 12 GB | about 10,000 | about $0.13/h |

Sleeping machines cost nothing and don't count. `max_instances` in `apps/machines/wrangler.jsonc` is the spend guard, set to 25; raise it there. Hourly costs are list prices at full use, after the amounts the Workers Paid plan includes.

## Flows

1. **Who is calling.** The gateway accepts a Faceful session (verified against the Supabase project's public JWKS: signature, issuer, audience, expiry) or a personal token minted with `node apps/machines/mint-token.mjs <uid>`. The user id comes only from the verified credential.
2. **Wake.** Any `/v1/*` call other than `/v1/machine` and `/v1/projects` starts that user's container with its own `STORE_TOKEN`. On boot the runner restores Claude's sign-in and session history from `private/claude-home.tar.gz`.
3. **Run.** `POST /v1/run {prompt, project}` works in `/home/node/work/<project>`. The first run of a project on a fresh disk restores `projects/<project>/autosave.tar.gz`.
4. **Autosave.** After every run, even if the page has gone, the runner saves the project and Claude's home to R2 and emits a `saved` event. The gateway reads that event from the stream and updates D1.
5. **Versions.** "Save a version" writes `projects/<project>/saves/<iso>.tar.gz`. Restore swaps the files, after saving the current ones as a new version.
6. **Sleep.** After 15 idle minutes (or "Save and sleep") the gateway calls the runner's `/v1/sync`, then sends the container a stop signal. The runner exits on it; a container still up 10 seconds later is ended by the gateway, since everything is saved by then. A run still working keeps the machine awake, and "Save and sleep" is refused until it ends.
7. **Deploy.** A deploy sends every awake machine the same stop signal: a run in progress is stopped and autosaved, and the machine takes the new gateway code and runner image on its next wake.

## Where data lives

- **R2, per user:** `users/<uid>/projects/<project>/autosave.tar.gz`, `…/saves/<iso>.tar.gz`, and `users/<uid>/private/claude-home.tar.gz` (Claude's sign-in, settings, session history).
- **D1 `faceful-machines`:** `machines` (state, starts, last seen, signed in), `projects` (title, the Claude session to resume, last run, last autosave), `saves` (one row per R2 object).
- **Engine database (Supabase, Dimitris):** briefs, scripts, content items. The reel timeline is in `video_compositions`, owned by the Remotion studio work, and its media in the separate `faceful-media` bucket. Nothing here writes to Supabase; rows link by the same user id and project id.

Project ids are an engine project UUID or a slug, so a workspace can sit next to an engine project without copying its data.

## Security

- One container per user, and it holds only that user's secrets: their Claude sign-in and their store token.
- The gateway strips the caller's `Authorization` and `Origin` and talks to the container with the Durable Object's id as the key. A caller can't name another user's machine.
- Store tokens and personal tokens are HMACs of the user id; forged, cross-user and `..` cases are tested.
- Account-wide secrets (`STORE_SIGNING_KEY`, `GATEWAY_SIGNING_KEY`, the Cloudflare token) live only as Worker secrets and in the gitignored `.env.local`.
- `ANTHROPIC_API_KEY` is removed from Claude's environment, so usage goes to the signed-in subscription.

## Claude accounts

Running Claude Code on your own machine with your own subscription is normal use. Offering claude.ai subscription sign-in to other people inside a product needs Anthropic's approval; for other users plan on an Anthropic API key per user.

## Operate

```sh
cd apps/machines
CLOUDFLARE_API_TOKEN=… npm run deploy                                   # Worker + container image (needs Docker)
npx wrangler d1 execute faceful-machines --remote --file schema.sql     # schema
npx wrangler d1 execute faceful-machines --remote --command "select * from machines"
npx wrangler tail                                                        # live logs
```

## Tested live

Run on 15 Nov 2026 against the deployed gateway with personal tokens for throwaway users (`live-test`, `live-test-2`):

| Step | Result |
|---|---|
| Wake | First request starts the user's container: 3 to 10 seconds, Claude Code 2.1.325 inside. |
| Run | `POST /v1/run` streams Claude Code's events; the run and its session id land in D1. |
| Autosave | Every run writes `projects/<project>/autosave.tar.gz` to R2 and a `saves` row to D1. |
| Sleep | "Save and sleep" stops the container in about 2 seconds; D1 shows `stopped`. |
| Fresh disk | The next run on a new disk reports `restored: true`; a version saved afterwards is byte-for-byte the files from before the sleep. |
| Idle | Left alone, a machine saved Claude's home to R2 and stopped by itself 15 minutes after its last request (woke 22:54:02, stopped 23:09:04 UTC). |

The first image never slept: Node ran as the container's first process and ignored the stop signal. The runner now handles it, and `tests/claude-runner.test.ts` covers it.

## Not done

- A real Claude run on a cloud machine: it needs one Claude sign-in on that machine, which only the account owner can do.
- No valid Supabase publishable key on this Mac, so the Faceful-session path is covered by tests but not yet tried in a browser. The gateway reads the project's public ES256 signing key without one.
- Production (`faceful.dtheo.dev`) needs `VITE_CLAUDE_GATEWAY_URL` set in Vercel for the page to connect by itself.
- The gateway only accepts the page on `faceful.dtheo.dev` and on local port 5173 (`ALLOWED_ORIGINS` in `wrangler.jsonc`).
- No per-user spend caps or admin view of all machines.
- Deleting a user's machine and folder is manual.
