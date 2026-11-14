import { defineConfig } from '@playwright/test';

/**
 * Landing-page specs on their own port, so they can run beside other sessions' servers.
 * Build first (`corepack pnpm build`), then: `corepack pnpm exec playwright test -c tests/browser/landing.config.ts`.
 */
const port = Number(process.env.LANDING_PORT ?? 4373);
export default defineConfig({
  testDir: '.',
  testMatch: 'landing-flow.spec.ts',
  timeout: 45_000,
  workers: 2,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: { command: `PORT=${port} corepack pnpm exec tsx scripts/serve-built.ts`, cwd: '../..', url: `http://127.0.0.1:${port}`, reuseExistingServer: !process.env.CI, timeout: 60_000 },
});
