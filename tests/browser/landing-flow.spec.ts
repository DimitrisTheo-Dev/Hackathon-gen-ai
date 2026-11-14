import { test, expect, type Locator, type Page } from '@playwright/test';

const AGENTS = ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'VS Code', 'Windsurf', 'Zed'];
const TESTED_NOTE = 'Tested with Claude Code and Codex. Any MCP client connects the same way.';
const COMMAND = 'codex mcp add faceful --url https://faceful.vercel.app/mcp --bearer-token-env-var FACEFUL_TOKEN';

/** Advances the page's fake clock until the locator matches, so steps are asserted in the order they happen. */
async function until(page: Page, locator: Locator, label: string, maxMs = 14_000) {
  for (let elapsed = 0; elapsed <= maxMs; elapsed += 100) {
    if (await locator.count()) return;
    await page.clock.runFor(100);
  }
  throw new Error(`The demo never reached: ${label}`);
}

test('hero says what Faceful does, offers both ways in, and shows no play or pause control', async ({ page }) => {
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!['GET', 'HEAD'].includes(request.method())) mutations.push(request.url()); });
  await page.goto('/');
  const hero = page.locator('.landing-hero');
  await expect(page.getByRole('heading', { level: 1 })).toHaveAttribute('aria-label', 'What if your agent made your next video campaign?');
  await expect(hero.getByRole('link', { name: 'Start creating' })).toHaveAttribute('href', '/studio/');
  await expect(hero.getByRole('link', { name: 'Connect your agent' })).toHaveAttribute('href', '#agents');
  await expect(hero).toContainText(TESTED_NOTE);
  await expect(page.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/studio/');
  // The demo simply plays; nothing on the page offers to play or pause a video.
  await expect(page.locator('.landing-demo')).toBeVisible();
  await expect(page.getByRole('button', { name: /play|pause/i })).toHaveCount(0);
  await expect(page.locator('video')).toHaveCount(0);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('the agent name rotates quickly through every client, hugging each name with no gap or headline shift', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.goto('/');
  const title = page.getByRole('heading', { level: 1 });
  const slot = page.locator('.landing-agent-slot');
  const current = page.locator('.landing-agent-name.is-current');
  await expect(slot).toHaveClass(/is-measured/);
  const height = (await title.boundingBox())!.height;
  for (const name of [...AGENTS, AGENTS[0]]) {
    await expect(current).toHaveText(name);
    // Once the 280ms width ease settles, the chip is exactly as wide as the name inside it.
    await expect.poll(async () => Math.abs((await slot.boundingBox())!.width - (await current.boundingBox())!.width)).toBeLessThanOrEqual(1);
    expect(Math.abs((await title.boundingBox())!.height - height)).toBeLessThan(1);
    expect(await current.locator('img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.clock.runFor(2000);
  }
  // A pause exists for anyone who needs it, out of sight until hover or keyboard focus.
  const pause = page.getByRole('button', { name: 'Pause agent rotation' });
  await expect(pause).toHaveCSS('opacity', '0');
  await pause.focus();
  await expect(pause).toHaveCSS('opacity', '1');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Resume agent rotation' })).toHaveAttribute('aria-pressed', 'true');
  const held = await current.textContent();
  await page.clock.runFor(6000);
  await expect(current).toHaveText(held!);
});

test('reduced motion keeps one name, a static client list and the composed demo frame', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const current = page.locator('.landing-agent-name.is-current');
  await expect(current).toHaveText('Claude Code');
  await page.clock.runFor(8000);
  await expect(current).toHaveText('Claude Code');
  await expect(page.getByRole('button', { name: /agent rotation|demo animation/ })).toHaveCount(0);
  const demo = page.locator('.landing-demo');
  await expect(demo).toHaveAttribute('data-playing', 'false');
  await expect(demo.locator('.fd-card.is-in')).toHaveCount(4);
  await expect(demo.locator('.fd-slot.is-in')).toContainText('needs your approval');
  await expect(demo.locator('.fd-proposal')).toHaveClass(/is-applied/);
  await expect(page.getByRole('list', { name: 'MCP clients' }).getByRole('listitem')).toHaveText(AGENTS);
  // Nothing waits below the fold for an entrance that reduced motion would never play.
  await expect(page.locator('.is-waiting')).toHaveCount(0);
});

test('the demo plays by itself, tells the studio story in order, loops, and holds when tapped or out of view', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.goto('/');
  const demo = page.locator('.landing-demo');
  await demo.scrollIntoViewIfNeeded();
  await expect(demo).toHaveAttribute('data-playing', 'true');
  const stage = demo.locator('.fd');
  await until(page, demo.locator('.fd.is-home'), 'the empty studio with a centred composer');
  await until(page, demo.locator('.fd-composer-typed', { hasText: 'Create a 15-second Reel for BeWell' }), 'the request being typed');
  await until(page, demo.locator('.fd.is-docked'), 'the composer docking into the chat on the right');
  await expect(demo.locator('.fd-user.is-in').first()).toContainText('friendly Greek presenter');
  await until(page, demo.locator('.fd-pill.is-in:not(.is-ready)'), 'drafting in progress');
  await until(page, demo.locator('.fd-pill.is-ready'), 'drafts ready');
  await expect(demo.locator('.fd-card.is-in')).toHaveCount(3);
  await until(page, demo.locator('.fd-proposal.is-in:not(.is-applied)'), 'a reviewable change');
  await until(page, demo.locator('.fd-proposal.is-applied'), 'the change saved as version 2');
  await expect(demo.locator('.fd-version.is-v2')).toHaveCount(1);
  await until(page, demo.locator('.fd-slot.is-in'), 'a posting time waiting for approval');
  await until(page, demo.locator('.fd-cursor.is-on'), 'the connected agent arriving');
  await until(page, demo.locator('.fd.has-agent-card'), 'the agent adding a draft');
  await expect(demo.locator('.fd-card.is-in')).toHaveCount(4);
  await until(page, demo.locator('.fd.is-home'), 'the loop starting again');
  // The illustration never claims a render or a publication.
  await expect(stage).not.toContainText(/published|rendered video|posted/i);

  // Tapping the illustration holds it; tapping again resumes.
  await demo.locator('.fd').click({ position: { x: 40, y: 40 } });
  await expect(demo).toHaveAttribute('data-playing', 'false');
  await expect(demo.locator('.landing-demo-badge')).toHaveText('Paused');
  const step = await demo.getAttribute('data-step');
  await page.clock.runFor(4000);
  await expect(demo).toHaveAttribute('data-step', step!);
  await demo.locator('.fd').click({ position: { x: 40, y: 40 } });
  await expect(demo).toHaveAttribute('data-playing', 'true');

  // Out of view, it stops spending frames.
  await page.locator('.landing-footer').scrollIntoViewIfNeeded();
  await expect(demo).toHaveAttribute('data-playing', 'false');
});

test('the Codex setup command is real text that copies exactly', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  const agents = page.locator('#agents');
  await expect(agents.locator('pre')).toContainText(COMMAND);
  await expect(agents).toContainText(TESTED_NOTE);
  await agents.getByRole('button', { name: 'Copy the Codex setup command' }).click();
  await expect(agents.getByRole('button', { name: 'Copy the Codex setup command' })).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(COMMAND);
  await expect(agents.getByRole('link', { name: 'Agent setup guide' })).toHaveAttribute('href', '/docs/mcp/');
});

test('copy is true to today’s product: live features stated, rendering rolling out, publishing not connected', async ({ page }) => {
  await page.goto('/');
  const main = page.locator('main');
  for (const stale of ['Live authentication is pending', 'Agent setup pending', 'Live connections are pending', 'Interactive demo']) await expect(main).not.toContainText(stale);
  await expect(main).toContainText('Presenter video rendering with Humanlike');
  await expect(main).toContainText('Rolling out');
  await expect(main).toContainText('Publishing to social accounts is not connected yet');
  await expect(main).toContainText('Stripe test mode');
  await expect(main).not.toContainText(/€|\$\s?\d/);
  // The closing band keeps its text readable over the warm artwork.
  const band = page.locator('.landing-companion');
  await expect(band.getByRole('link', { name: 'Start creating' })).toHaveAttribute('href', '/studio/');
  await expect(band.getByRole('link', { name: 'Connect your agent' })).toHaveAttribute('href', '/docs/mcp/');
});

test('the page reads completely without JavaScript', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL });
  const page = await context.newPage();
  await page.goto('/');
  const main = page.locator('main');
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  for (const text of ['From a sentence to a campaign you approve.', 'Your agent works in the same studio.', 'Nothing posts without you.', COMMAND, 'needs your approval', 'Do I need an AI agent?', 'Your next video starts with a sentence.'])
    await expect(main).toContainText(text);
  await expect(page.locator('.landing-agent-name.is-current')).toHaveText('Claude Code');
  await expect(page.locator('.is-waiting')).toHaveCount(0);
  await context.close();
});

for (const width of [1440, 1024, 768, 390, 320]) test(`${width}px: no sideways scroll, the demo fits, and navigation works`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const frame = (await page.locator('.landing-demo-frame').boundingBox())!;
  expect(frame.x).toBeGreaterThanOrEqual(0);
  expect(frame.x + frame.width).toBeLessThanOrEqual(width);
  // The slot still hugs the name at this size, and the headline stays one h1.
  const slot = (await page.locator('.landing-agent-slot').boundingBox())!;
  const name = (await page.locator('.landing-agent-name.is-current').boundingBox())!;
  expect(Math.abs(slot.width - name.width)).toBeLessThanOrEqual(1);
  for (const link of await page.locator('.landing-hero .landing-button').all()) expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  if (width <= 760) {
    const open = page.getByRole('button', { name: 'Open navigation', exact: true });
    expect((await open.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await open.click();
    const menu = page.getByRole('dialog', { name: 'Explore Faceful' });
    await expect(menu.getByRole('link', { name: 'For agents' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Log in' })).toHaveAttribute('href', '/studio/');
    await page.keyboard.press('Escape');
    await expect(open).toBeFocused();
  } else {
    await expect(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'How it works' })).toBeVisible();
  }
  // Every section below still fits once scrolled into view.
  for (const selector of ['#how', '#agents', '.landing-faq', '.landing-companion', '.landing-footer']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), selector).toBe(true);
  }
});
