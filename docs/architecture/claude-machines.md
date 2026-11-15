# Claude Code machines: one container per user

Status, 15 Nov 2026: built, deployed on Cloudflare and tested on real machines (see "Tested live"). The runner, store, gateway, database and the `/claude-login-test/` page are live. boxd was dropped when its signups ran out; the same runner image still works on any VPS.

## Shape

```
 Browser  /claude-login-test  ── POST /v1/studio/machines/token (Faceful engine): session in, 10-minute token out
   │  Bearer: machines token fgs1.…  or  personal token fgw2.…  (never the Faceful session)
   ▼
 Worker  faceful-machines  ── verifies who is calling, never trusts a user id from the request,
   │                         lets in only MACHINE_ALLOWED_USERS, within per-user wake and awake-time limits
   │                         D1 faceful-machines: machines · projects · saves · machine_wakes
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
| Gateway | `apps/machines` (Worker `faceful-machines`) | Identifies the caller, admits only listed accounts within their limits, routes them to their own container, records machines, projects, saves and wakes in D1. |
| Machine | `UserMachine` Durable Object + Cloudflare Container | Runs the runner image. Its id is the runner's access key, so only the gateway can reach it. |
| Runner | `apps/claude-runner` | Zero-dependency Node 24 service: Claude sign-in, one run at a time, per-project folders, autosave, restore. |
| Store | `apps/workspace-store` (Worker `faceful-workspace-store`) | The only way into R2. A token `fst2.…` (12 hours, renewed while the machine is awake) opens `users/<uid>/` and nothing else, within a quota. |
| Bucket | R2 `faceful-workspaces` (WEUR) | The durable copy of every project and of Claude's sign-in. |
| Database | D1 `faceful-machines` (`apps/machines/schema.sql`) | `machines`, `projects`, `saves`, `machine_wakes`. |

## How many machines

The Cloudflare account's own limits (read from the API on 15 Nov 2026): 15,000 vCPU, 60 TiB memory and 300 TB disk running at once; at most 4 vCPU, 12 GiB and 20 GB per container.

| Size | vCPU | Memory | Disk | Awake at once (account limit) | Cost while awake |
|---|---|---|---|---|---|
| basic | 1/4 | 1 GiB | 4 GB | about 60,000 | about $0.03/h |
| standard-1 (used) | 1/2 | 4 GiB | 8 GB | about 15,000 (memory-bound) | about $0.07/h |
| standard-2 | 1 | 6 GiB | 12 GB | about 10,000 | about $0.13/h |

Sleeping machines cost nothing and don't count. `max_instances` in `apps/machines/wrangler.jsonc` is the account-wide spend guard, set to 25; raise it there. Per user, `MACHINE_WAKES_PER_HOUR` (6) and `MACHINE_AWAKE_MINUTES_PER_DAY` (240, per UTC day) in the same file cap what one account can use; over the daily limit an awake machine takes no more work and sleeps once idle. Hourly costs are list prices at full use, after the amounts the Workers Paid plan includes.

## Flows

1. **Who is calling.** The page never sends the gateway the Faceful session. It asks the engine (`POST /v1/studio/machines/token`, `packages/engine/src/machines.ts`) for a token that only the gateway accepts: `fgs1.<key version>.<uid>.<issued>.<expires>.<HMAC>`, audience `faceful-machines`, ten minutes, signed with `MACHINES_GATEWAY_KEY`, for signed-in people only (never an agent). The other credential is a personal token, `node apps/machines/mint-token.mjs <uid> [ttl]` (7 days unless told, at most 30), signed with `GATEWAY_SIGNING_KEY`. The user id comes only from the verified token. Both sides check `MACHINE_ALLOWED_USERS`: an account not on it gets `403 machine_not_enabled` before any route.
2. **Wake.** Any `/v1/*` call other than `/v1/machine` and `/v1/projects` starts that user's container, unless it has used its wakes for the hour or its time for the day (`429 wake_limit` or `daily_limit`, with `Retry-After`). The container gets a 12-hour `STORE_TOKEN`, renewed halfway while it stays awake, and `CLAUDE_HOME_KEY`, the user's own key for Claude's saved sign-in. On boot the runner restores Claude's sign-in and session history from `private/claude-home.tar.gz`, if it opens with that key.
3. **Run.** `POST /v1/run {prompt, project}` works in `/home/node/work/<project>`. The first run of a project on a fresh disk restores `projects/<project>/autosave.tar.gz`.
4. **Autosave.** After every run, even if the page has gone, the runner saves the project and Claude's home to R2 and emits a `saved` event. The gateway reads that event from the stream and updates D1.
5. **Versions.** "Save a version" writes `projects/<project>/saves/<iso>.tar.gz`. Restore swaps the files, after saving the current ones as a new version. A project keeps its newest 30 versions: the oldest makes room for a new one.
6. **Sleep.** After 15 idle minutes (or "Save and sleep") the gateway calls the runner's `/v1/sync`, then sends the container a stop signal. The runner exits on it; a container still up 10 seconds later is ended by the gateway, since everything is saved by then. A run still working keeps the machine awake, and "Save and sleep" is refused until it ends.
7. **Deploy.** A deploy sends every awake machine the same stop signal: a run in progress is stopped and autosaved, and the machine takes the new gateway code and runner image on its next wake.

## Where data lives

- **R2, per user:** `users/<uid>/projects/<project>/autosave.tar.gz`, `…/saves/<iso>.tar.gz`, and `users/<uid>/private/claude-home.tar.gz` (Claude's sign-in, settings, session history; sealed with AES-256-GCM under the user's own key). Nothing else is accepted, and each folder holds at most 5 GB, 100 projects and 30 versions per project (`apps/workspace-store/wrangler.toml`). `revocations/<uid>` sits outside every folder: see Operate.
- **D1 `faceful-machines`:** `machines` (state, starts, last seen, signed in), `projects` (title, the Claude session to resume, last run, last autosave), `saves` (one row per R2 object), `machine_wakes` (one row per wake, for the per-user limits; pruned after a week).
- **Engine database (Supabase, Dimitris):** briefs, scripts, content items. The reel timeline is in `video_compositions`, owned by the Remotion studio work, and its media in the separate `faceful-media` bucket. Nothing here writes to Supabase; rows link by the same user id and project id.

Project ids are an engine project UUID or a slug, so a workspace can sit next to an engine project without copying its data.

## Security

- One container per user, and it holds only that user's secrets: their Claude sign-in, their store token and the key to their saved sign-in.
- Default deny: only user ids in `MACHINE_ALLOWED_USERS` (a secret on the gateway, the same list in the engine's env) reach any route, and each has its own wake and awake-time limits.
- The Faceful session stays with Faceful. The gateway runs on another Cloudflare account and only ever sees ten-minute `fgs1` tokens; a raw Supabase session is refused.
- Every token expires and carries a key version: `fgs1` (10 minutes), `fgw2` personal tokens (at most 30 days), `fst2` store tokens (12 hours for a machine, at most 90 days for your own server). Each key may be a keyring, `"2:<new>,1:<old>"`: the first entry signs, every entry verifies, and removing a version revokes everything it signed. Format and checks: `apps/workspace-store/src/signed-token.ts`.
- Claude never gets the store token or the home key: the runner keeps both out of Claude's environment (with `RUNNER_ACCESS_KEY` and `ANTHROPIC_API_KEY`) and saves projects itself.
- Claude's saved sign-in is sealed before upload with a per-user key derived from `HOME_ENCRYPTION_KEY`, which only the gateway holds. The store, its logs and a leaked store token see ciphertext, and an archive that doesn't open with the key is never unpacked.
- The store takes only the keys the runner writes, within a per-user quota.
- The gateway strips the caller's `Authorization` and `Origin` and talks to the container with the Durable Object's id as the key. A caller can't name another user's machine, or reach the runner's store-token route.
- Account-wide secrets (`STORE_SIGNING_KEY`, `GATEWAY_SIGNING_KEY`, `MACHINES_GATEWAY_KEY`, `HOME_ENCRYPTION_KEY`, the Cloudflare token) live only as Worker or Vercel secrets and in the gitignored `.env.local`.
- `ANTHROPIC_API_KEY` is removed from Claude's environment, so usage goes to the signed-in subscription.
- Not yet a hard wall: Claude runs as the same Unix user as the runner, so in full-access mode it could still read the runner's own environment (`/proc/1/environ`). Running Claude as a separate user is the next step.

## Claude accounts

Running Claude Code on your own machine with your own subscription is normal use. Offering claude.ai subscription sign-in to other people inside a product needs Anthropic's approval; for other users plan on an Anthropic API key per user.

## Operate

```sh
cd apps/machines
CLOUDFLARE_API_TOKEN=… npm run deploy                                   # Worker + container image (needs Docker)
npx wrangler d1 execute faceful-machines --remote --file schema.sql     # schema (idempotent; adds machine_wakes)
npx wrangler d1 execute faceful-machines --remote --command "select * from machines"
npx wrangler tail                                                        # live logs
```

Gateway secrets (`wrangler secret put <name>`): `STORE_SIGNING_KEY` (same as the store's), `HOME_ENCRYPTION_KEY` (gateway only), `GATEWAY_SIGNING_KEY`, `MACHINES_GATEWAY_KEY` (same as the engine's on Vercel), `MACHINE_ALLOWED_USERS` (same list as the engine's). A machine doesn't start without `HOME_ENCRYPTION_KEY`; changing it means everyone signs in to Claude again.

- **Give someone a machine:** add their user id to `MACHINE_ALLOWED_USERS` on the gateway and in Vercel. **Take it away:** remove it from both.
- **Revoke one user's store tokens** (one leaked): `echo revoked | npx wrangler r2 object put faceful-workspaces/revocations/<uid> --pipe --remote`. Tokens issued before it are refused; an awake machine can't save until it next wakes, which mints a new one.
- **Revoke every personal token, or every token of any kind:** put a new key version in front (`"2:<new>,1:<old>"`), then drop the old one.

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
- The Faceful-session path (page → engine token → gateway) is covered by tests but not yet tried in a browser.
- Production (`faceful.dtheo.dev`) needs `VITE_CLAUDE_GATEWAY_URL`, `MACHINES_GATEWAY_KEY` and `MACHINE_ALLOWED_USERS` set in Vercel for the page to connect by itself.
- The gateway only accepts the page on `faceful.dtheo.dev` and on local port 5173 (`ALLOWED_ORIGINS` in `wrangler.jsonc`).
- No admin view of all machines.
- Deleting a user's machine and folder is manual.
