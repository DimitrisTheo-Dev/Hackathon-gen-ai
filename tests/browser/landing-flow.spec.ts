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

/**
 * The chip's surface is drawn once at the widest name's width and cut to the current name with clip-path,
 * so its visible width is read from that cut, not from an element's box.
 */
async function chipWidths(page: Page) {
  return page.evaluate(() => {
    const name = document.querySelector('.landing-agent-name.is-current')!.getBoundingClientRect();
    const face = document.querySelector('.landing-agent-face')!;
    const cut = /inset\(1px ([\d.]+)px/.exec(getComputedStyle(face).clipPath);
    // The face sits one pixel inside the hairline ring on each side.
    return { name: name.width, surface: face.getBoundingClientRect().width - 2 * (cut ? Number(cut[1]) : 1) + 2, centre: name.x + name.width / 2, viewport: innerWidth };
  });
}

/** The box of every word in the headline (outside the chip) and the subtitle, plus the hero's controls and the demo. */
async function heroBoxes(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const out: Record<string, number[]> = {};
    const rect = (name: string, node: Element) => { const r = node.getBoundingClientRect(); out[name] = [r.x, r.y, r.width, r.height]; };
    const words = (name: string, root: Element) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let index = 0;
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        for (const match of node.data.matchAll(/\S+/g)) {
          const range = document.createRange();
          range.setStart(node, match.index!);
          range.setEnd(node, match.index! + match[0].length);
          const r = range.getBoundingClientRect();
          out[`${name}:${index++}:${match[0]}`] = [r.x, r.y, r.width, r.height];
        }
      }
    };
    words('opening', document.querySelector('.landing-question-opening')!);
    words('outcome', document.querySelector('.landing-question-outcome')!);
    words('subtitle', document.querySelector('.landing-hero-description')!);
    rect('title', document.querySelector('.hero-title')!);
    rect('agent line', document.querySelector('.landing-question-agent')!);
    rect('primary button', document.querySelector('.landing-hero .landing-primary')!);
    rect('secondary button', document.querySelector('.landing-hero .landing-secondary')!);
    rect('status', document.querySelector('.landing-hero-status')!);
    rect('demo', document.querySelector('.landing-demo-frame')!);
    out['page width'] = [document.documentElement.scrollWidth, 0, 0, 0];
    return out;
  });
}

/**
 * Loads the page with the rotation on and the page clock frozen, so each `runFor(2000)` is exactly one turn
 * however long the page took to load. CSS transitions still run in real time.
 */
async function loadWithFrozenClock(page: Page) {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install({ time: new Date('2026-11-14T10:00:00Z') });
  await page.goto('/');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.landing-agent-chip')).toHaveClass(/is-armed/);
  await page.clock.pauseAt(new Date('2026-11-14T10:01:00Z'));
  // Let the morph that the jump may have started finish before anything is measured.
  await page.waitForTimeout(450);
}

/** The largest change, in pixels, of any edge of any box between two samples. */
function movement(before: Record<string, number[]>, after: Record<string, number[]>) {
  let worst = { box: '', px: 0 };
  for (const [box, values] of Object.entries(before)) {
    const now = after[box];
    if (!now) return { box: `${box} (missing)`, px: Infinity };
    const px = Math.max(...values.map((value, index) => Math.abs(value - now[index])));
    if (px > worst.px) worst = { box, px };
  }
  return worst;
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

test('the agent name rotates quickly through every client, each with its own mark, hugging each name', async ({ page }) => {
  await loadWithFrozenClock(page);
  const title = page.getByRole('heading', { level: 1 });
  const chip = page.locator('.landing-agent-chip');
  const current = page.locator('.landing-agent-name.is-current');
  await expect(chip).toHaveClass(/is-measured/);
  const height = (await title.boundingBox())!.height;
  const start = AGENTS.indexOf((await current.textContent())!);
  expect(start).toBeGreaterThanOrEqual(0);
  const turn = (step: number) => AGENTS[(start + step) % AGENTS.length];
  // One full cycle and one more, in the listed order, two seconds apart.
  for (let step = 0; step <= AGENTS.length; step++) {
    const name = turn(step);
    await expect(current).toHaveText(name);
    // Once the 300ms morph settles, the chip's surface is exactly as wide as the name inside it, and centred.
    await expect.poll(async () => { const widths = await chipWidths(page); return Math.abs(widths.surface - widths.name); }).toBeLessThanOrEqual(1);
    const { centre, viewport } = await chipWidths(page);
    expect(Math.abs(centre - viewport / 2)).toBeLessThanOrEqual(1);
    expect((await title.boundingBox())!.height).toBe(height);
    // Every client shows its own mark on an app-icon tile; none is a broken image.
    expect(await current.locator('.agent-icon-tile img').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
    await page.clock.runFor(2000);
  }
  // Pressing the chip moves straight to the next client.
  await expect(current).toHaveText(turn(AGENTS.length + 1));
  await chip.click();
  await expect(current).toHaveText(turn(AGENTS.length + 2));
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

for (const width of [1440, 768, 390, 320]) {
  test(`${width}px: nothing but the chip moves, by even one pixel, through a full rotation`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await loadWithFrozenClock(page);
    const current = page.locator('.landing-agent-name.is-current');
    const base = await heroBoxes(page);
    expect(Object.keys(base).length).toBeGreaterThan(30);
    const seen = new Set<string>();
    for (let turn = 0; turn <= AGENTS.length; turn++) {
      const name = (await current.textContent())!;
      seen.add(name);
      expect(movement(base, await heroBoxes(page)), `settled on ${name}`).toEqual({ box: '', px: 0 });
      await page.clock.runFor(2000);
      // The chip is morphing while these are read: the rest of the page must already be where it stays.
      for (const wait of [40, 90, 120]) {
        await page.waitForTimeout(wait);
        expect(movement(base, await heroBoxes(page)), `mid-transition after ${name}`).toEqual({ box: '', px: 0 });
      }
      await page.waitForTimeout(260);
    }
    expect([...seen].sort()).toEqual([...AGENTS].sort());
  });

  test(`${width}px: no line moves or re-wraps when the web font arrives`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route('**/fonts/InterVariable.woff2', async (route) => { await held; await route.continue(); });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.landing-agent-chip')).toHaveClass(/is-measured/);
    // Vertical position and height of each line and block; letters may redraw, lines may not move.
    const blocks = () => page.evaluate(() => ['.landing-question-opening', '.landing-question-agent', '.landing-question-outcome', '.landing-hero-description', '.landing-hero .landing-primary', '.landing-hero .landing-secondary', '.landing-hero-status', '.landing-demo-frame'].map((selector) => {
      const r = document.querySelector(selector)!.getBoundingClientRect();
      return `${selector} y ${r.y} h ${r.height}`;
    }));
    expect(await page.evaluate(() => document.fonts.check('500 20px InterVariable'))).toBe(false);
    const before = await blocks();
    release();
    await page.waitForFunction(() => document.fonts.check('500 20px InterVariable'));
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    expect(await blocks()).toEqual(before);
  });
}

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
  // Every draft is a presenter with the script as a caption, and a presenter has been chosen.
  await expect(demo.locator('.fd-card.is-in .fd-caption')).toHaveCount(4);
  await expect(demo.locator('.fd-cast.is-in.is-picked')).toHaveCount(1);
  await expect(demo.locator('.fd-card-a .fd-figure.is-picked')).toHaveCSS('opacity', '1');
  await expect(demo.locator('.fd-card-a .fd-caption.is-revised .is-next')).toHaveText('Γεια! Αυτό είναι το BeWell.');
  await expect(demo.locator('.fd-slot.is-in')).toContainText('needs your approval');
  await expect(demo.locator('.fd-proposal')).toHaveClass(/is-applied/);
  const clients = page.getByRole('list', { name: 'MCP clients' }).getByRole('listitem');
  await expect(clients).toHaveText(AGENTS);
  expect(await clients.locator('.agent-icon-tile img').evaluateAll((images: HTMLImageElement[]) => images.filter((image) => image.complete && image.naturalWidth > 0).length)).toBe(AGENTS.length);
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
  // Each draft reads as a presenter video: a figure, a name chip, and the script line as a caption.
  await expect(demo.locator('.fd-card.is-in .fd-figure.is-first')).toHaveCount(3);
  await expect(demo.locator('.fd-card-a .fd-presenter .is-first')).toHaveText('Eleni');
  await expect(demo.locator('.fd-card-a .fd-caption-line').first()).toHaveText('Γεια σου! Καλώς ήρθες στο φεστιβάλ BeWell.');
  await expect(demo.locator('.fd-cast.is-in:not(.is-picked) .fd-face')).toHaveCount(4);
  // A presenter is chosen from the row, and every draft takes that presenter on.
  await until(page, demo.locator('.fd.has-pick .fd-cast.is-picked'), 'a presenter being chosen');
  for (const card of ['a', 'b', 'c']) await expect(demo.locator(`.fd-card-${card} .fd-figure.is-picked`)).toHaveCSS('opacity', '1');
  await expect(demo.locator('.fd-card-a .fd-presenter .is-picked')).toHaveText('Nikos');
  await until(page, demo.locator('.fd-proposal.is-in:not(.is-applied)'), 'a reviewable change');
  await until(page, demo.locator('.fd-proposal.is-applied'), 'the change saved as version 2');
  await expect(demo.locator('.fd-version.is-v2')).toHaveCount(1);
  // The caption on the card changes with the version.
  await expect(demo.locator('.fd-card-a .fd-caption.is-revised .is-next')).toHaveText('Γεια! Αυτό είναι το BeWell.');
  await until(page, demo.locator('.fd-slot.is-in'), 'a posting time waiting for approval');
  await until(page, demo.locator('.fd-cursor.is-on'), 'the connected agent arriving');
  await until(page, demo.locator('.fd.has-agent-card'), 'the agent adding a draft');
  await expect(demo.locator('.fd-card.is-in')).toHaveCount(4);
  await until(page, demo.locator('.fd.is-home'), 'the loop starting again');
  // The illustration never claims a render or a publication, and stays labelled as an illustration.
  await expect(stage).not.toContainText(/published|rendered video|posted/i);
  await expect(demo.locator('.landing-demo-badge')).toHaveText('Illustration');

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
  // Before any script runs the chip already hugs its name, and the demo is the composed presenter frame.
  const widths = await chipWidths(page);
  expect(Math.abs(widths.surface - widths.name)).toBeLessThanOrEqual(1);
  await expect(page.locator('.landing-demo .fd-card.is-in .fd-caption')).toHaveCount(4);
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
  // The chip still hugs the name at this size and stays inside the page.
  await expect(page.locator('.landing-agent-chip')).toHaveClass(/is-measured/);
  const widths = await chipWidths(page);
  expect(Math.abs(widths.surface - widths.name)).toBeLessThanOrEqual(1);
  expect(widths.name).toBeLessThanOrEqual(width - 32);
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
