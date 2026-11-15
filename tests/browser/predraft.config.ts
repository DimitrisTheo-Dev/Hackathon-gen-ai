import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
/**
 * The New project flow's written-ahead script, against the Vite dev server, where the development workspace's script
 * writer can be slowed to a model's pace (see new-project-predraft.spec.ts). Its own port, so it disturbs no other suite
 * and never touches the shared `dist/`:
 *   pnpm exec playwright test -c tests/browser/predraft.config.ts
 * PLAYWRIGHT_CHANNEL=chrome drives an installed Chrome instead of Playwright's own Chromium.
 */
const port = Number(process.env.PREDRAFT_E2E_PORT ?? 4573);
// The spec skips itself unless this is set, so the default suite (which serves a build) leaves it alone.
process.env.FACEFUL_DEV_E2E = '1';
export default defineConfig({
  testDir: '.',
  testMatch: /new-project-predraft\.spec\.ts/,
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  webServer: {
    command: `node_modules/.bin/vite --config apps/web/vite.config.ts --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}/dev/studio/`,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
