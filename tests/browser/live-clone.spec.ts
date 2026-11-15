import { test, expect, type Page } from '@playwright/test';

/**
 * Clone a video end to end: the built app, the REAL engine routes (GET /v1/studio/clone/source, GET
 * /v1/studio/clone/jobs, POST /v1/studio/operations/create_clone_job) on the in-memory store. YouTube's oEmbed is
 * a stand-in in the harness, and the platforms' players are stood in for here, so nothing reaches YouTube,
 * TikTok or Instagram. Run with:
 *   corepack pnpm exec playwright test -c tests/browser/live.config.ts live-clone
 */
test.skip(!process.env.FACEFUL_LIVE_E2E, 'Needs the in-memory engine server from tests/browser/live.config.ts');

const SUPABASE = 'https://hgsgvdujzatfhsjoojll.supabase.co';
const PLAYER = (name: string) => `<!doctype html><meta charset="utf-8"><title>${name}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#15161a;color:#fff;font:14px sans-serif">${name} player stand-in</body>`;

async function signIn(page: Page) {
  const id = `e2e-${crypto.randomUUID()}`;
  const user = { id, aud: 'authenticated', role: 'authenticated', email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const token = `${[{ alg: 'none', typ: 'JWT' }, { iss: 'faceful-e2e', sub: id, email: user.email, exp, aud: 'authenticated', role: 'authenticated' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.e2e`;
  const stored = { access_token: token, refresh_token: 'e2e-not-a-credential', token_type: 'bearer', expires_in: 31_536_000, expires_at: exp, user };
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['sb-hgsgvdujzatfhsjoojll-auth-token', JSON.stringify(stored)]);
  await page.route(`${SUPABASE}/**`, (route) => (new URL(route.request().url()).pathname === '/auth/v1/user' ? route.fulfill({ json: user }) : route.fulfill({ status: 404, json: {} })));
  for (const [host, name] of [['https://www.youtube-nocookie.com', 'YouTube'], ['https://www.tiktok.com', 'TikTok'], ['https://www.instagram.com', 'Instagram']])
    await page.route(`${host}/**`, (route) => route.fulfill({ contentType: 'text/html', body: PLAYER(name) }));
  return token;
}

test('Clone a video: a link shows the platform player, a brief and toggles start a real queued job', async ({ page }) => {
  const token = await signIn(page);
  await page.goto('/studio/');
  // Clone a video is the second way to start on the Templates page, not a sidebar item of its own.
  const nav = page.getByRole('navigation', { name: 'Studio' });
  await expect(nav.getByRole('button', { name: 'Clone a video' })).toHaveCount(0);
  await nav.getByRole('button', { name: 'Templates' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  const formatsTab = page.getByRole('tab', { name: 'Start from a format' });
  const cloneTab = page.getByRole('tab', { name: 'Clone a video you like' });
  await expect(formatsTab).toHaveAttribute('aria-selected', 'true');
  await cloneTab.click();
  await expect(cloneTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/view=templates&tab=clone/);
  await expect(page.getByRole('tabpanel', { name: 'Clone a video you like' })).toBeVisible();
  // The tabs are one keyboard stop; the arrow keys move between them and the address follows.
  await cloneTab.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(formatsTab).toBeFocused();
  await expect(formatsTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).not.toHaveURL(/tab=clone/);
  await page.keyboard.press('ArrowRight');
  await expect(cloneTab).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/view=templates&tab=clone/);
  // The empty result frame names the workspace's brand kit, which the new version is made in.
  await expect(page.locator('.cv-result')).toContainText('shows here once a worker has made it.');

  const link = page.getByLabel('Video link');
  // Other sites are refused by the shared link reader, before any request.
  await link.fill('https://vimeo.com/123456');
  await link.blur();
  await expect(page.getByText('Faceful can clone videos from YouTube, TikTok and Instagram. Paste a link from one of those.')).toBeVisible();
  // A video the platform does not know is refused by the engine, and gets no player.
  await link.fill('https://youtu.be/AAAAAAAAAAA');
  await expect(page.getByText('YouTube could not find this video. Check the link; the video may be private or removed.')).toBeVisible();
  await expect(page.locator('.cv-source iframe')).toHaveCount(0);

  // TikTok and Instagram: their own embed players, straight from the address.
  await link.fill('https://www.tiktok.com/@doc.maria/video/7300000000000000001?is_from_webapp=1');
  await expect(page.locator('.cv-source iframe')).toHaveAttribute('src', 'https://www.tiktok.com/player/v1/7300000000000000001?music_info=1&description=1&rel=0');
  await link.fill('https://www.instagram.com/reel/C5Yy3Kqr0Qm/?igsh=abc');
  await expect(page.locator('.cv-source iframe')).toHaveAttribute('src', 'https://www.instagram.com/reel/C5Yy3Kqr0Qm/embed/');

  // A Short: YouTube's privacy-enhanced player at once, then title and author from the engine's oEmbed lookup.
  await link.fill('https://www.youtube.com/shorts/jNQXAC9IVRw?feature=share');
  const player = page.locator('.cv-source iframe');
  await expect(player).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/jNQXAC9IVRw?rel=0&playsinline=1');
  await expect(player).toHaveAttribute('title', 'YouTube video: Stand-in video: five tips in thirty seconds');
  await expect(page.locator('.cv-source-meta')).toContainText('Stand-in Channel');
  await expect(page.frameLocator('.cv-source iframe').getByText('YouTube player stand-in')).toBeVisible();

  // Starting needs a brief.
  await page.getByRole('button', { name: 'Start job' }).click();
  await expect(page.getByText('Say what your version should be about.')).toBeVisible();
  await expect(page.getByLabel('What should your version be?')).toBeFocused();
  await page.getByLabel('What should your version be?').fill('Keep the hook and the quick cuts. Make it about checking blood pressure at home, in Greek, for my cardiology practice.');

  // Toggles: plain on/off check boxes with sensible defaults.
  await expect(page.getByRole('checkbox', { name: 'Pacing and cuts' })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Music' })).not.toBeChecked();
  // The whole tile is the toggle.
  await page.locator('.cv-trait', { hasText: 'Music' }).click();
  await expect(page.getByRole('checkbox', { name: 'Music' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Sound effects' }).uncheck();

  await page.getByRole('button', { name: 'Start job' }).click();
  const result = page.locator('.cv-result');
  await expect(result).toContainText('Queued, waiting for a worker');
  await expect(result).toContainText('Nothing has been made yet.');
  await expect(result.locator('video')).toHaveCount(0);
  const row = page.locator('.cv-job');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Stand-in video: five tips in thirty seconds');
  await expect(row).toContainText('Queued, waiting for a worker');
  await expect(row.locator('.cv-job-traits')).toHaveText('Hook and structure, Pacing and cuts, Transitions, Caption style, Graphics, Music');

  // The job is a real record in the engine, still queued: nothing was made or published.
  const listed = await page.request.get('/v1/studio/clone/jobs', { headers: { Authorization: `Bearer ${token}` } });
  expect(listed.ok()).toBe(true);
  const jobs = (await listed.json()) as Array<{ state: string; resultUrl: string | null; clone: string[]; source: { url: string } }>;
  expect(jobs).toHaveLength(1);
  expect(jobs[0]).toMatchObject({ state: 'queued', resultUrl: null, source: { url: 'https://www.youtube.com/shorts/jNQXAC9IVRw' } });
  expect(jobs[0].clone).toEqual(['structure', 'pacing', 'transitions', 'captions', 'graphics', 'music']);

  // A brief in progress survives a look at the formats: the tab's panel stays mounted.
  await page.getByLabel('Video link').fill('https://youtu.be/jNQXAC9IVRw');
  await formatsTab.click();
  await cloneTab.click();
  await expect(page.getByLabel('Video link')).toHaveValue('https://youtu.be/jNQXAC9IVRw');

  // The tab and the job survive a reload.
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Clone a video you like' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.cv-job')).toHaveCount(1);
  await expect(page.locator('.cv-job')).toContainText('Queued, waiting for a worker');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('the old Clone a video address opens the Templates page on its Clone tab', async ({ page }) => {
  await signIn(page);
  await page.goto('/studio/?view=clone');
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Clone a video you like' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Video link')).toBeVisible();
  await expect(page).toHaveURL(/view=templates&tab=clone/);
  // Templates is the sidebar item that is current.
  await expect(page.getByRole('navigation', { name: 'Studio' }).getByRole('button', { name: 'Templates' })).toHaveAttribute('aria-current', 'page');
  // Leaving Templates drops the tab from the address.
  await page.getByRole('navigation', { name: 'Studio' }).getByRole('button', { name: 'Schedule' }).click();
  await expect(page).toHaveURL(/view=schedule/);
  await expect(page).not.toHaveURL(/tab=/);
});

test('Clone a video at phone width: one column in reading order, no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/studio/?view=templates&tab=clone');
  await expect(page.getByRole('heading', { level: 1, name: 'Templates' })).toBeVisible();
  // Both ways to start fit in one row, at a touch-sized height.
  for (const name of ['Start from a format', 'Clone a video you like']) {
    const box = await page.getByRole('tab', { name }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390 - 16 + 1);
  }
  // No link yet: the original's empty frame is not shown on a phone.
  await expect(page.locator('.cv-source')).toBeHidden();
  await page.getByLabel('Video link').fill('youtu.be/jNQXAC9IVRw');
  await expect(page.locator('.cv-source iframe')).toBeVisible();
  // Reading order: link, original, brief, what to clone, your version (the Start row sticks to the bottom).
  const order = await page.evaluate(() => ['.cv-link', '.cv-source', '.cv-brief', '.cv-traits', '.cv-result'].map((selector) => Math.round(document.querySelector(selector)!.getBoundingClientRect().top)));
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  // Start job stays in reach at the bottom of the screen while the form is in view, above the dock.
  const start = await page.getByRole('button', { name: 'Start job' }).boundingBox();
  const dock = await page.locator('.mobile-dock').boundingBox();
  expect(start!.height).toBeGreaterThanOrEqual(44);
  expect(start!.y + start!.height).toBeLessThanOrEqual(dock!.y);
  expect(start!.y).toBeGreaterThan(dock!.y - 140);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
