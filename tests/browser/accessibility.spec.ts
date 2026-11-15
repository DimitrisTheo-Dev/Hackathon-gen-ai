import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Automated WCAG 2.2 A/AA checks (axe-core) on every public page and studio surface, at desktop and phone
 * widths, plus the keyboard-only path through create → edit → review, visible focus and reduced motion.
 * Runs in the default suite and in every engine of tests/browser/browsers.config.ts.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/**
 * The one exception, for one rule: a canvas card is a single button around a storyboard poster (a picture of the
 * video, with the title drawn on it), a status pill and a date. Its label is its visible title, and its name is
 * "Edit <title>", so WCAG 2.5.3 (Label in Name) holds; status, video and date are its description. axe's
 * label-content-name-mismatch counts every visible word inside the button as label, the poster included, which
 * no reasonable name could repeat. Only that rule skips only these buttons; every other rule still checks them.
 */
const CARD = /^<button class="content-select"/;

/** Opens the first draft in the editor, on the AI chat or on Details (one header toggle switches between them). */
async function editor(page: Page, tab: 'AI Chat' | 'Details') {
  await page.goto('/dev/studio/?view=canvas');
  await expect(page.locator('.content-card')).toHaveCount(3);
  const toggles = page.getByRole('button', { name: /^(Details|AI Chat)$/ });
  if (!(await toggles.first().isVisible())) await page.locator('.content-select').first().click();
  if (tab === 'Details') {
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.getByRole('button', { name: 'AI Chat', exact: true })).toBeVisible();
  } else {
    if (await page.getByRole('button', { name: 'AI Chat', exact: true }).isVisible()) await page.getByRole('button', { name: 'AI Chat', exact: true }).click();
    await expect(page.getByLabel('Direction for your content')).toBeVisible();
  }
}

const surfaces: Array<{ name: string; open: (page: Page) => Promise<unknown> }> = [
  { name: 'landing', open: async (page) => { await page.goto('/'); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); } },
  { name: 'docs', open: async (page) => { await page.goto('/docs/mcp/'); await expect(page.getByRole('heading', { level: 1 })).toBeVisible(); } },
  { name: 'sign-in', open: async (page) => { await page.goto('/studio/'); await expect(page.getByLabel('Email address')).toBeVisible(); } },
  { name: 'studio home', open: async (page) => { await page.goto('/dev/studio/'); await expect(page.getByRole('heading', { name: 'What will we create today?' })).toBeVisible(); } },
  { name: 'canvas with the chat open', open: (page) => editor(page, 'AI Chat') },
  { name: 'canvas with Details open', open: (page) => editor(page, 'Details') },
  { name: 'brand kit', open: async (page) => { await page.goto('/dev/studio/?view=brand'); await expect(page.getByRole('heading', { name: 'Brand kit', level: 1 })).toBeVisible(); } },
  { name: 'schedule', open: async (page) => { await page.goto('/dev/studio/?view=schedule'); await expect(page.locator('.day-card').first()).toBeVisible(); } },
  { name: 'billing', open: async (page) => { await page.goto('/dev/studio/?view=billing'); await expect(page.getByRole('heading', { name: 'Billing and usage' })).toBeVisible(); } },
  { name: 'agents', open: async (page) => { await page.goto('/dev/studio/?view=connect'); await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible(); } },
  { name: 'creation dialog', open: async (page) => { await page.goto('/dev/studio/'); await page.getByRole('button', { name: 'Create with my own script' }).click(); await expect(page.getByRole('dialog')).toBeVisible(); } },
  { name: 'Claude Code runner', open: async (page) => { await page.goto('/claude-login-test/'); await expect(page.getByRole('heading', { name: 'Connect your Claude subscription' })).toBeVisible(); } },
];

for (const width of [1440, 390]) {
  for (const surface of surfaces) {
    test(`axe ${width}px: ${surface.name} has no serious or critical WCAG 2.2 AA violations`, async ({ page }) => {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
      await surface.open(page);
      // Let entrance transitions and the boot cross-fade finish, so colours are read at their resting values.
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('.boot')).toHaveCount(0);
      await page.waitForTimeout(350);
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
      const blocking = results.violations
        .map((violation) => violation.id !== 'label-content-name-mismatch' ? violation : { ...violation, nodes: violation.nodes.filter((node) => !CARD.test(node.html)) })
        .filter((violation) => violation.nodes.length && (violation.impact === 'serious' || violation.impact === 'critical'));
      const report = blocking.map((violation) => `${violation.impact} ${violation.id}: ${violation.help}\n${violation.nodes.slice(0, 6).map((node) => `    ${node.target.join(' ')} — ${node.failureSummary?.split('\n').slice(1, 2).join(' ').trim()}`).join('\n')}`);
      expect(report, report.join('\n\n')).toEqual([]);
    });
  }
}

/**
 * The key that walks every control. Safari moves between buttons with Option-Tab unless the person has turned on
 * Full Keyboard Access, so WebKit is driven the way a Safari keyboard user drives it. (Firefox gets the same
 * all-controls order from the `accessibility.tabfocus` preference in tests/browser/browsers.config.ts.)
 */
const tabKey = (browserName: string) => (browserName === 'webkit' ? 'Alt+Tab' : 'Tab');

test('keyboard only: create a draft, edit it, save, and reach the guarded review', async ({ page, browserName }) => {
  const TAB = tabKey(browserName);
  await page.goto('/dev/studio/?view=canvas');
  await expect(page.locator('.content-card')).toHaveCount(3);
  const tabTo = async (name: RegExp | string, backwards = false, limit = 80) => {
    for (let step = 0; step < limit; step++) {
      await page.keyboard.press(backwards ? `Shift+${TAB}` : TAB);
      const label = await page.evaluate(() => { const el = document.activeElement as HTMLElement | null; return el ? `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.trim() : ''; });
      if (typeof name === 'string' ? label.includes(name) : name.test(label)) return;
    }
    throw new Error(`Tab never reached ${name}`);
  };
  // Create: the new-project button (back from the open editor into the sidebar), then the guided steps by keyboard.
  await tabTo('Create a campaign', true);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'What is this video about?' })).toBeVisible();
  await expect(page.locator('#np-brief')).toBeFocused();
  await page.keyboard.type('Make room for a reusable lunch box in your everyday bag. It keeps food fresh until lunch.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('heading', { name: 'Who appears in the video?' })).toBeVisible();
  await page.getByRole('radio', { name: /No face/ }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByRole('heading', { name: 'How should it be made?' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.locator('.np-beat-text').first()).toHaveValue(/reusable lunch box/);
  await page.locator('#np-title-input').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Keyboard week');
  // Script is the last step: its action is Create. The development studio cannot make videos, so Create saves the
  // draft and opens the project instead of promising one.
  await expect(page.locator('.np-foot').getByRole('button', { name: 'Create', exact: true })).toBeVisible();
  await expect(page.locator('.np-rail li')).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+Enter');
  // The project and its first video share the title the person typed: the page heading is the project's.
  await expect(page.getByRole('heading', { level: 1, name: 'Keyboard week', exact: true })).toBeVisible();
  // Edit: open the draft, switch to Details and change the title with keys alone.
  await page.locator('.content-select').first().focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Details', exact: true }).focus();
  await page.keyboard.press('Enter');
  // The flow may already have saved the video's language and colour, so the edit is one version past whatever is shown.
  await expect(page.locator('.save-state')).toContainText(/version \d+/);
  const before = Number((await page.locator('.save-state').innerText()).match(/version (\d+)/)![1]);
  await page.locator('#item-title').focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Typed without a mouse');
  await page.getByRole('button', { name: 'Save changes', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.save-state')).toContainText(`version ${before + 1}`);
  // Review: the schedule review opens from the keyboard, holds focus inside, and Escape returns it.
  const review = page.getByRole('button', { name: 'Review schedule', exact: true });
  await review.focus();
  await page.keyboard.press('Enter');
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: /Approve/ })).toBeDisabled();
  // Focus stays inside the review: Tab past its last control leaves the page for the browser, never for the studio behind.
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press(TAB);
    // (On the page, focus "parked" in the browser's controls reads as the body.)
    expect(await sheet.evaluate((node) => node.contains(document.activeElement) || document.activeElement === document.body)).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(review).toBeFocused();
});

const focusPages: Array<[string, (page: Page) => Promise<void>]> = [
  ['/', (page) => expect(page.getByRole('heading', { level: 1 })).toBeVisible()],
  ['/dev/studio/', (page) => expect(page.getByRole('heading', { name: 'What will we create today?' })).toBeVisible()],
  ['/dev/studio/?view=canvas', (page) => expect(page.locator('.content-card')).toHaveCount(3)],
  ['/studio/', (page) => expect(page.getByLabel('Email address')).toBeVisible()],
];
for (const [path, ready] of focusPages) test(`focus is visible on every stop of the tab order: ${path}`, async ({ page, browserName }) => {
  await page.goto(path);
  await ready(page);
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('.boot')).toHaveCount(0);
  const missing: string[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < 45; step++) {
    await page.keyboard.press(tabKey(browserName));
    const stop = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const style = getComputedStyle(el);
      const ring = (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none';
      // A field may show focus through its container (`:focus-within` on a composer, for example).
      const host = el.closest('.director-composer, .home-composer, .composer, .field, .ob-field, label');
      const hostRing = host && host !== el && (getComputedStyle(host).outlineStyle !== 'none' || getComputedStyle(host).boxShadow !== 'none' || getComputedStyle(host).borderColor !== 'rgba(0, 0, 0, 0)');
      const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}"`;
      return { name, visible: ring || Boolean(hostRing), offscreen: el.getBoundingClientRect().width === 0 };
    });
    if (!stop) continue;
    if (seen.has(stop.name)) break;
    seen.add(stop.name);
    if (!stop.visible && !stop.offscreen) missing.push(stop.name);
  }
  expect(seen.size).toBeGreaterThan(3);
  expect(missing, `No visible focus on: ${missing.join(', ')}`).toEqual([]);
});

test('reduced motion: studio surfaces run no movement animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const open of [surfaces[3], surfaces[4], surfaces[10]]) {
    await open.open(page);
    await page.waitForTimeout(100);
    const moving = await page.evaluate(() => document.getAnimations().flatMap((animation) => {
      const effect = animation.effect as KeyframeEffect | null;
      if (!effect || animation.playState !== 'running') return [];
      const keyframes = effect.getKeyframes();
      const moves = keyframes.some((frame) => (frame.transform && frame.transform !== 'none') || frame.translate || frame.scale);
      const target = effect.target as HTMLElement | null;
      return moves ? [`${target?.className ?? '?'} ${(animation as CSSAnimation).animationName ?? 'transition'}`] : [];
    }));
    expect(moving, `${open.name}: ${moving.join(', ')}`).toEqual([]);
  }
});
