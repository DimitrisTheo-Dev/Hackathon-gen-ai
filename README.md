# Castroom

A shared content studio for people and their external AI agents. Frontend work lives on `work/dimitris-studio`; Minas implements the engine separately. The repository is private.

## Run locally

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env.local
# Add only the Supabase publishable key; never a secret/service-role key.
npm run dev
```

Open `http://127.0.0.1:5173/dev/studio/` for the explicitly labeled development transport. Three sample BeWell drafts are editable and persist in that browser. You can also create drafts from your own supplied company brief. No provider calls, video generation, connection handshakes, approvals or publications are simulated.

`/studio/` uses Supabase Auth and `VITE_CASTROOM_API_URL`. The typed client never falls back to fixtures on live errors. Until Minas connects the API, invited users can authenticate but no live workspace is claimed. Supabase project: `hgsgvdujzatfhsjoojll`; the public Auth API was checked, database permissions were not.

```sh
npm test
npm run build
```

## Integration boundary

- `apps/web`: studio, focused editor, agent onboarding, static public docs.
- `packages/contracts`: proposed Zod read/write schemas, pending Minas agreement.
- `apps/web/src/data/client.ts`: one typed interface; `live.ts` is the route adapter.
- `docs/product/contract-handoff.md`: proposed operations and integration blockers.
- `docs/demo/verification.md`: executed checks and live acceptance gaps.

Manual creation saves supplied context and 1–3 scripts. It does not infer business facts, fetch URLs, generate scripts or authorize publication. Human edits carry optimistic revisions. Retry identities store only hashes and operation UUIDs in session storage; server idempotency and publication-intent reconciliation remain required.

## Deployment

The Vercel project is linked to this private GitHub repository. Preview builds enable `CASTROOM_ENABLE_FIXTURES=true`; the production environment forcibly excludes the fixture module. Public docs have initial HTML. Private studio routes require authentication before requesting live data and are excluded from indexing; the backend must authorize every object and operation.

- [Production](https://hackathon-gen-ai-nine.vercel.app)
- [Studio development preview](https://hackathon-gen-khh4z973p-my-team-29ecd279.vercel.app/dev/studio/) (Vercel team access; sample drafts only)
- [Private repository](https://github.com/DimitrisTheo-Dev/Hackathon-gen-ai)
- [Shared contract handoff](docs/product/contract-handoff.md)

## Attribution and limits

React/Vite placeholder, GitHub/Vercel setup and Supabase API wiring predate this studio implementation (`7714fbd`). The hackathon work adds the studio, contracts, transport, docs and tests. Moonjar inspired the spatial composition; no Moonjar assets or code are redistributed. Original CSS storyboards are labeled as such. BeWell facts link to Quintessential’s published case study; no partnership or media permission is implied. Humanlike is the intended rendering integration, supplied by Minas. Dependencies retain their upstream licenses through npm.

Real MCP client authentication, Humanlike video/audio, final composition, publishing receipts, tenant/RLS denial tests and uncoached teammate trials remain blocked on engine/provider access. No time-saved, engagement, security certification or two-minute setup claim is made.
