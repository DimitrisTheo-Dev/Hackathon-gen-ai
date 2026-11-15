import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Settings end to end: the built app, the REAL socials routes (GET /v1/socials, connect, sync, disconnect, remove)
 * on the in-memory store, and the harness's stand-in Buffer (support/memory-engine.ts). Run with:
 *   corepack pnpm exec playwright test -c tests/browser/live.config.ts live-settings
 */
test.skip(!process.env.FACEFUL_LIVE_E2E, 'Needs the in-memory engine server from tests/browser/live.config.ts');

const SUPABASE = 'https://hgsgvdujzatfhsjoojll.supabase.co';
/** The one key the stand-in Buffer accepts. */
const BUFFER_KEY = 'e2e-buffer-key-not-a-credential';
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function signIn(page: Page) {
  const id = `e2e-${crypto.randomUUID()}`;
  const user = { id, aud: 'authenticated', role: 'authenticated', email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const token = `${[{ alg: 'none', typ: 'JWT' }, { iss: 'faceful-e2e', sub: id, email: user.email, exp, aud: 'authenticated', role: 'authenticated' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.e2e`;
  const stored = { access_token: token, refresh_token: 'e2e-not-a-credential', token_type: 'bearer', expires_in: 31_536_000, expires_at: exp, user };
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['sb-hgsgvdujzatfhsjoojll-auth-token', JSON.stringify(stored)]);
  await page.route(`${SUPABASE}/**`, (route) => (new URL(route.request().url()).pathname === '/auth/v1/user' ? route.fulfill({ json: user }) : route.fulfill({ status: 404, json: {} })));
}

async function noBlockingViolations(page: Page) {
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).include('.settings-view').analyze();
  const blocking = violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical');
  const report = blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`);
  expect(report, report.join('\n')).toEqual([]);
}

test('Settings connects Buffer, lists and removes its accounts, and has no webhook settings to fill in', async ({ page }) => {
  await signIn(page);
  await page.goto('/studio/');
  // A workspace setting: in the sidebar's footer, beside Brand kit, Agents and Credits.
  await page.getByRole('complementary', { name: 'Studio' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/view=settings/);
  await expect(page).toHaveTitle('Settings · Faceful');
  await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();
  await expect(page.getByText('No accounts are connected yet.')).toBeVisible();
  // Webhooks are connected by the engine on its own: no tab, no address to copy, nothing to register.
  await expect(page.locator('.settings-view').getByRole('radio')).toHaveCount(0);
  await expect(page.locator('.settings-view')).not.toContainText(/webhook/i);

  const add = page.getByRole('region', { name: 'Add an account' });
  // Instagram's own sign-in needs the Meta app, which this deployment does not have; YouTube is connected in Schedule.
  await expect(add.getByRole('listitem').filter({ hasText: 'Instagram' })).toContainText('Not set up yet');
  await expect(add.getByRole('button', { name: 'Open Schedule to connect YouTube' })).toBeVisible();
  await noBlockingViolations(page);

  // Too short to be a key: said in the studio, before anything is sent.
  await add.getByRole('button', { name: 'Connect Buffer' }).click();
  const form = page.getByRole('form', { name: 'Connect Buffer' });
  await expect(form.getByLabel('Buffer API key')).toBeFocused();
  await form.getByLabel('Buffer API key').fill('not-the-key');
  await form.getByRole('button', { name: 'Connect Buffer' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'That’s shorter than a Buffer API key.' })).toBeVisible();
  // A key Buffer refuses: the engine's own sentence, and nothing is connected.
  await form.getByLabel('Buffer API key').fill('e2e-a-key-buffer-refuses-0000');
  await form.getByRole('button', { name: 'Connect Buffer' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Buffer did not accept this API key.' })).toBeVisible();
  await expect(page.getByText('No accounts are connected yet.')).toBeVisible();

  await form.getByLabel('Buffer API key').fill(BUFFER_KEY);
  await form.getByRole('button', { name: 'Connect Buffer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Connected Buffer: 2 accounts ready.' })).toBeVisible();
  await expect(form).toHaveCount(0);
  const connected = page.getByRole('region', { name: 'Connected accounts' });
  const rows = connected.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'BeWell on TikTok' })).toContainText('TikTok · through Buffer');
  await expect(rows.filter({ hasText: 'Instagram · through Buffer' }).getByRole('link', { name: 'BeWell' })).toHaveAttribute('href', 'https://www.instagram.com/bewell.app');
  await expect(add.getByRole('listitem').filter({ hasText: 'Buffer' })).toContainText('2 accounts connected');
  // Buffer only posts: its accounts carry no comments or messages, so their rows promise none.
  await expect(connected.locator('.settings-activity')).toHaveCount(0);

  await add.getByRole('button', { name: 'Refresh Buffer accounts' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Buffer accounts are up to date.' })).toBeVisible();

  // Removing asks first, and keeping it changes nothing.
  await connected.getByRole('button', { name: 'Remove BeWell on TikTok' }).click();
  const confirm = page.getByRole('group', { name: 'Remove BeWell on TikTok' });
  await expect(confirm.getByRole('button', { name: 'Keep connected' })).toBeFocused();
  await confirm.getByRole('button', { name: 'Keep connected' }).click();
  await expect(rows).toHaveCount(2);
  await connected.getByRole('button', { name: 'Remove BeWell on TikTok' }).click();
  await page.getByRole('group', { name: 'Remove BeWell on TikTok' }).getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Removed BeWell on TikTok.' })).toBeVisible();
  await expect(rows).toHaveCount(1);

  await noBlockingViolations(page);
  await page.reload();
  await expect(rows).toHaveCount(1);

  // Disconnecting the provider removes what is left of it.
  await add.getByRole('button', { name: 'Disconnect Buffer' }).click();
  await page.getByRole('group', { name: 'Disconnect Buffer' }).getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Disconnected Buffer.' })).toBeVisible();
  await expect(page.getByText('No accounts are connected yet.')).toBeVisible();
});
