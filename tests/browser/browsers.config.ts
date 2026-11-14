import { defineConfig, devices, type Project } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * Every browser suite (default, landing, live engine, onboarding, accessibility) in Chromium, WebKit and Firefox,
 * against a build in its own folder on its own ports, so it never touches the shared `dist/` or another session's server.
 *   corepack pnpm exec playwright test -c tests/browser/browsers.config.ts                 # all three engines
 *   corepack pnpm exec playwright test -c tests/browser/browsers.config.ts --project='webkit*'
 * The first server builds (with the local fixture), prerenders exactly as the deploy does, then serves. Screenshots
 * the specs take go to each test's own output folder here, so other engines never replace the committed evidence.
 */
const repo = fileURLToPath(new URL('../..', import.meta.url));
const root = process.env.FACEFUL_MATRIX_ROOT ?? join(tmpdir(), 'faceful-browser-matrix');
const base = Number(process.env.FACEFUL_MATRIX_PORT ?? 6101);
const ports = { app: base, live: base + 1, onboarding: base + 2 };
const bin = (name: string) => JSON.stringify(join(repo, 'node_modules/.bin', name));
const tsx = `${bin('tsx')} --tsconfig ${JSON.stringify(join(repo, 'tsconfig.json'))}`;
const script = (path: string) => JSON.stringify(join(repo, path));

// Specs that need a particular server skip themselves unless these are set; each project below points at its server.
process.env.FACEFUL_LIVE_E2E = '1';
process.env.FACEFUL_ONBOARDING_E2E = '1';
process.env.FACEFUL_E2E_ORIGIN = `http://127.0.0.1:${ports.app}`;
process.env.FACEFUL_PRIVATE_EVIDENCE = '1';

// The deploy's prerender and the verification server both read `dist/` under their working folder.
const build = [
  `CASTROOM_ENABLE_FIXTURES=true ${bin('vite')} build --config ${script('apps/web/vite.config.ts')} --outDir ${JSON.stringify(join(root, 'dist'))} --emptyOutDir --logLevel warn`,
  `cd ${JSON.stringify(root)}`,
  `${tsx} ${script('scripts/prerender.ts')}`,
].join(' && ');

const engines = [
  { name: 'chromium', use: devices['Desktop Chrome'] },
  { name: 'webkit', use: devices['Desktop Safari'] },
  // macOS keyboard default: Tab reaches only text fields unless Full Keyboard Access is on. The keyboard specs
  // walk every control, as people who use the keyboard set it up (WebKit uses Option-Tab, see accessibility.spec.ts).
  { name: 'firefox', use: { ...devices['Desktop Firefox'], launchOptions: { firefoxUserPrefs: { 'accessibility.tabfocus': 7 } } } },
];
const suites = [
  { suffix: '', port: ports.app, testIgnore: [/live-.*\.spec\.ts/, /onboarding\.spec\.ts/, /landing-flow\.spec\.ts/, /pitch.*\.spec\.ts/], reducedMotion: 'reduce' as const },
  { suffix: '-landing', port: ports.app, testMatch: /landing-flow\.spec\.ts/, reducedMotion: 'reduce' as const },
  { suffix: '-live', port: ports.live, testMatch: /live-.*\.spec\.ts/, reducedMotion: 'reduce' as const },
  { suffix: '-onboarding', port: ports.onboarding, testMatch: /onboarding\.spec\.ts/ },
];
const projects: Project[] = engines.flatMap(engine => suites.map(suite => ({
  name: `${engine.name}${suite.suffix}`,
  testMatch: suite.testMatch,
  testIgnore: suite.testIgnore,
  use: {
    ...engine.use,
    baseURL: `http://127.0.0.1:${suite.port}`,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    ...(suite.reducedMotion ? { reducedMotion: suite.reducedMotion } : {}),
  },
})));

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: Number(process.env.FACEFUL_MATRIX_WORKERS ?? 3),
  reporter: [['list'], ['json', { outputFile: join(root, 'results.json') }]],
  outputDir: join(root, 'test-results'),
  use: { trace: 'retain-on-failure' },
  projects,
  // FACEFUL_MATRIX_SERVERS=app,onboarding starts only those (for a run limited to some projects).
  webServer: [
    { name: 'app', command: `mkdir -p ${JSON.stringify(root)} && ${build} && PORT=${ports.app} ${tsx} ${script('scripts/serve-built.ts')}`, url: `http://127.0.0.1:${ports.app}`, cwd: repo, reuseExistingServer: true, timeout: 240_000 },
    { name: 'live', command: `cd ${JSON.stringify(root)} && FACEFUL_E2E_ENGINE=memory PORT=${ports.live} ${tsx} ${script('scripts/serve-built.ts')}`, url: `http://127.0.0.1:${ports.live}`, cwd: repo, reuseExistingServer: true, timeout: 60_000 },
    { name: 'onboarding', command: `ONBOARDING_DIST=${JSON.stringify(join(root, 'dist'))} PORT=${ports.onboarding} ${tsx} ${script('tests/browser/support/onboarding-server.ts')}`, url: `http://127.0.0.1:${ports.onboarding}`, cwd: repo, reuseExistingServer: true, timeout: 60_000 },
  ].filter(server => !process.env.FACEFUL_MATRIX_SERVERS || process.env.FACEFUL_MATRIX_SERVERS.split(',').includes(server.name)),
});
