import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Sign-in, agent connection, consent, billing and templates against the real engine logic on an
 * in-memory store.   corepack pnpm exec playwright test -c tests/browser/onboarding.config.ts
 * Builds into its own folder and listens on its own port, so it never disturbs another suite.
 */
const port = Number(process.env.ONBOARDING_E2E_PORT ?? 4473);
const out = process.env.ONBOARDING_DIST ?? join(tmpdir(), 'faceful-onboarding-dist');
process.env.FACEFUL_ONBOARDING_E2E = '1';
export default defineConfig({
  testDir: '.',
  testMatch: /onboarding\.spec\.ts/,
  timeout: 45_000,
  workers: 2,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: {
    command: `CASTROOM_ENABLE_FIXTURES=true corepack pnpm exec vite build --config apps/web/vite.config.ts --outDir ${JSON.stringify(out)} --emptyOutDir && ONBOARDING_DIST=${JSON.stringify(out)} PORT=${port} corepack pnpm exec tsx tests/browser/support/onboarding-server.ts`,
    url: `http://127.0.0.1:${port}`,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
