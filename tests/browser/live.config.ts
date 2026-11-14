import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
/**
 * Browser tests of the live transport against the real engine logic on an in-memory store.
 *   corepack pnpm exec playwright test -c tests/browser/live.config.ts
 * Uses its own port so it never collides with the default suite's server.
 */
const port = Number(process.env.LIVE_E2E_PORT ?? 4273);
// Specs matching live-*.spec.ts skip themselves unless this is set, so the default suite is unaffected.
process.env.FACEFUL_LIVE_E2E = '1';
export default defineConfig({
  testDir: '.',
  testMatch: /live-.*\.spec\.ts/,
  timeout: 45_000,
  workers: 2,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: {
    command: `CASTROOM_ENABLE_FIXTURES=true corepack pnpm run build && FACEFUL_E2E_ENGINE=memory PORT=${port} corepack pnpm exec tsx scripts/serve-built.ts`,
    url: `http://127.0.0.1:${port}`,
    // Commands run from the repository root, not from this file's folder.
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: { FACEFUL_E2E_ENGINE: 'memory' },
  },
});
