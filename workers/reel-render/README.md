# Reel render worker

Turns a saved reel timeline into an MP4 with Remotion, using the same `Reel` component the studio previews (`apps/web/src/video/Reel.tsx`), and uploads it back as a `render` draft file.

Run as many workers as you like, on any VPS, boxd machine or container. Each polls the engine, claims one job at a time under a 10 minute lease, reports progress (which renews the lease), and uploads the result. A worker that goes silent loses its lease; another worker picks the job up. After three lost leases the job fails with a reason. Cancelling a render in the studio stops the worker at its next progress report.

This folder is outside the pnpm workspace on purpose: the web deployment never installs the renderer.

## How it talks to the engine

```
worker ── POST /v1/worker/reel/claim          {workerId}            → one job: composition snapshot + signed media links
       ── POST /v1/worker/reel/:id/progress    {workerId, progress}  → renews the lease
       ── POST /v1/worker/reel/:id/upload-url  {workerId, sha256, bytes} → one-time R2 PUT link
       ── PUT  <R2 link>   (x-amz-checksum-sha256: storage refuses any other bytes)
       ── POST /v1/worker/reel/:id/complete    {workerId, sha256, bytes, durationSeconds}
       ── POST /v1/worker/reel/:id/fail        {workerId, error}
```

Every call carries `Authorization: Bearer $REEL_WORKER_TOKEN`. The worker never holds a database or storage key.

## Voice

A video always has a voice. The engine reads the script aloud when a render is queued and the timeline has nobody speaking in it (`packages/engine/src/voice.ts`), so most jobs arrive with a voice clip. A job that still has none (the engine has no speech keys, or predates voiceovers) is read aloud here, with the worker's own keys: Microsoft Text to Speech (`AZURE_SPEECH_KEY` with `AZURE_SPEECH_REGION` or `AZURE_SPEECH_ENDPOINT`), then the optional ElevenLabs or Cartesia stock voices. The claim says what to read (`job.narration`: script and language); an older engine says nothing, and the captions are read. When a voice is needed and none can be made, the job fails with the reason rather than rendering a silent video. Setup: `docs/product/microsoft-tts.md`.

## Run it

Engine side (Vercel env): `REEL_WORKER_TOKEN` (32+ characters) and the `FACEFUL_R2_*` settings for draft files.

On a server with Docker, from the repository root:

```sh
cd workers/reel-render && cp .env.example .env    # set FACEFUL_API_URL and REEL_WORKER_TOKEN
docker compose up -d --build --scale worker=2
```

Without Docker (Node 22.18 or newer):

```sh
cd workers/reel-render && npm ci
FACEFUL_API_URL=https://faceful.dtheo.dev REEL_WORKER_TOKEN=... node src/worker.ts
```

On a Mac you can use the installed Chrome instead of downloading Chrome Headless Shell:
`CHROME_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" CHROME_MODE=chrome-for-testing`.
`--once` claims at most one job and exits.

### On Cloudflare Containers

`cloudflare/` deploys the same image to Cloudflare: a Worker (`faceful-reel-render`) claims waiting jobs every minute and starts one container per job (`standard-4`, up to 4 at once). The container renders, uploads and exits, so it only runs while it renders. Settings are Worker secrets, passed to the container as its environment:

```sh
cd workers/reel-render/cloudflare && npm ci
npx wrangler secret put REEL_WORKER_TOKEN        # the engine's REEL_WORKER_TOKEN
npx wrangler secret put SUPABASE_URL             # the engine's Supabase URL (media host)
npx wrangler secret put FACEFUL_R2_ACCOUNT_ID    # the engine's R2 account (draft files host)
npx wrangler secret put AZURE_SPEECH_KEY         # voiceovers; plus AZURE_SPEECH_REGION or AZURE_SPEECH_ENDPOINT
npx wrangler deploy                              # needs Docker running; builds ../Dockerfile for linux/amd64
```

`FACEFUL_API_URL` is in `wrangler.jsonc`. Set the var `RENDERING` to `off` to stop claiming new jobs. `GET https://faceful-reel-render.<subdomain>.workers.dev/health` says whether it renders and which voices it has. Logs: `npx wrangler tail`.

## Safety

- Draft files arrive as short-lived signed links from the engine. Media linked by URL is only fetched from exact hosts: the engine's own Supabase project (`SUPABASE_URL`), its R2 account endpoint (`FACEFUL_R2_ACCOUNT_ID`) and `MEDIA_HOST_ALLOWLIST`. The worker downloads each file itself, checks every redirect against the same list, and serves the copy to Chrome locally; anything else fails the job with a reason. Run workers where they cannot reach private networks or cloud metadata endpoints.
- The output is H.264 `yuv420p`, BT.709, AAC.
- Do not render or upload a person's face or voice without their consent. Keep the "AI avatar" label on for avatar presenters.

## Checked

A local run against a mock engine with synthetic media (ffmpeg test pattern and tones): claimed, bundled in 1.3 to 3.6 s, rendered 6 s of 1080x1920 at 25 fps in about 19 s on an Apple Silicon Mac with desktop Chrome, uploaded with the checksum header, completed. Frames checked: title card, word-timed caption highlight, split screen, statement card, labels, and a 3-frame lip-sync delay. The Docker image has not been built here.
