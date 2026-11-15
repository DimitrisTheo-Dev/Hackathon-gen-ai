import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
/**
 * New project → Script → Create → a video with a voice (create-video.spec.ts). Two ways to run it:
 *
 *   In-memory (default; CI): the real engine logic on an in-memory store with FACEFUL_E2E_REEL=1. Microsoft Text to
 *   Speech is a stand-in, and the test plays the render worker through the real worker protocol.
 *     corepack pnpm exec playwright test -c tests/browser/create.config.ts
 *
 *   Live: point it at a running studio whose engine talks to the real services and has a real render worker
 *   (workers/reel-render). The test waits for the real MP4, downloads it and checks its audio track with ffprobe.
 *     FACEFUL_CREATE_E2E_URL=http://127.0.0.1:5199 corepack pnpm exec playwright test -c tests/browser/create.config.ts
 *   The engine behind that URL must accept the test's stand-in session for one real user (see the spec).
 */
const live = process.env.FACEFUL_CREATE_E2E_URL?.replace(/\/+$/, '');
const port = Number(process.env.CREATE_E2E_PORT ?? 4275);
process.env.FACEFUL_CREATE_E2E = live ? 'live' : 'memory';
export default defineConfig({
  testDir: '.',
  testMatch: /create-video\.spec\.ts/,
  // A real render of a 30-second video takes a few minutes on a laptop.
  timeout: live ? 15 * 60_000 : 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: live ?? `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', trace: 'retain-on-failure', ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) },
  webServer: live
    ? undefined
    : {
        command: `CASTROOM_ENABLE_FIXTURES=true corepack pnpm run build && FACEFUL_E2E_ENGINE=memory FACEFUL_E2E_REEL=1 PORT=${port} corepack pnpm exec tsx scripts/serve-built.ts`,
        url: `http://127.0.0.1:${port}`,
        cwd: fileURLToPath(new URL('../..', import.meta.url)),
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        env: { FACEFUL_E2E_ENGINE: 'memory', FACEFUL_E2E_REEL: '1' },
      },
});
