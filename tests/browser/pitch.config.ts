import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The /pitch presentation page on its own Vite dev server and port, so it runs beside other sessions
 * and never builds into the shared dist/ folder:
 *   corepack pnpm exec playwright test -c tests/browser/pitch.config.ts
 * PITCH_E2E_PORT picks the port (6300–6399; default 6378). An already running server on that port is reused.
 */
const port = Number(process.env.PITCH_E2E_PORT ?? 6378);
export default defineConfig({
  testDir: '.',
  testMatch: /pitch\.spec\.ts/,
  timeout: 60_000,
  workers: 2,
  reporter: 'list',
  outputDir: join(tmpdir(), 'faceful-pitch-results'),
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1920, height: 1080 }, trace: 'retain-on-failure' },
  webServer: {
    command: `corepack pnpm exec vite --config apps/web/vite.config.ts --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/pitch`,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    reuseExistingServer: true,
    timeout: 90_000,
  },
});
