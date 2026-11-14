import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
/**
 * The default browser suite on its own port with a freshly started server, for machines where
 * another session already holds :4173 (a long-running server keeps serving an older request handler).
 * Build first with fixtures enabled, then run:
 *   CASTROOM_ENABLE_FIXTURES=true corepack pnpm build
 *   corepack pnpm exec playwright test -c tests/browser/fresh.config.ts
 * Suites with their own configs (live engine, onboarding, landing) are excluded here.
 */
const port = Number(process.env.FRESH_E2E_PORT ?? 4873);
export default defineConfig({
  testDir: '.',
  testIgnore: [/live-.*\.spec\.ts/, /onboarding\.spec\.ts/, /landing-flow\.spec\.ts/],
  timeout: 30_000,
  workers: 2,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', trace: 'retain-on-failure' },
  webServer: {
    command: `PORT=${port} corepack pnpm exec tsx scripts/serve-built.ts`,
    url: `http://127.0.0.1:${port}`,
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
