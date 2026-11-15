import { test, expect, type Page } from '@playwright/test';

/**
 * The Templates tab end to end: the built app, the REAL engine route (GET /v1/studio/templates/library) on the
 * in-memory store, signed media links served by the harness. Run with:
 *   corepack pnpm exec playwright test -c tests/browser/live.config.ts live-templates
 */
test.skip(!process.env.FACEFUL_LIVE_E2E, 'Needs the in-memory engine server from tests/browser/live.config.ts');

const SUPABASE = 'https://hgsgvdujzatfhsjoojll.supabase.co';
async function signIn(page: Page) {
  const id = `e2e-${crypto.randomUUID()}`;
  const user = { id, aud: 'authenticated', role: 'authenticated', email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const token = `${[{ alg: 'none', typ: 'JWT' }, { iss: 'faceful-e2e', sub: id, email: user.email, exp, aud: 'authenticated', role: 'authenticated' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.e2e`;
  const stored = { access_token: token, refresh_token: 'e2e-not-a-credential', token_type: 'bearer', expires_in: 31_536_000, expires_at: exp, user };
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['sb-hgsgvdujzatfhsjoojll-auth-token', JSON.stringify(stored)]);
  await page.route(`${SUPABASE}/**`, (route) => (new URL(route.request().url()).pathname === '/auth/v1/user' ? route.fulfill({ json: user }) : route.fulfill({ status: 404, json: {} })));
  const seeded = await page.request.post('/__e2e/templates', { headers: { Authorization: `Bearer ${token}` }, data: {} });
  expect(seeded.ok()).toBe(true);
}

test('the Templates tab lists the library by family and opens a template with its sample video', async ({ page }) => {
  await signIn(page);
  await page.goto('/studio/');
  await page.getByRole('navigation', { name: 'Studio' }).getByRole('button', { name: 'Templates' }).click();
  await expect(page).toHaveURL(/view=templates/);
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  // The formats are the first of the page's two ways to start.
  await expect(page.getByRole('tab', { name: 'Start from a format' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Clone a video you like' })).toHaveAttribute('aria-selected', 'false');
  await expect(page.getByRole('heading', { name: 'With a presenter' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Without a face' })).toBeVisible();
  const cards = page.locator('.tl-card');
  expect(await cards.count()).toBeGreaterThanOrEqual(2);
  // Posters come from signed links and load.
  await expect.poll(() => page.locator('.tl-poster img').first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);

  await cards.first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'What a new video needs' })).toBeVisible();
  await expect(dialog.locator('video')).toHaveAttribute('src', /\/__e2e\/media\/templates%2F/);
  await expect(dialog.locator('.tl-script li').first()).not.toBeEmpty();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(dialog).toBeHidden();

  // The tab survives a reload, like every other studio view.
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
