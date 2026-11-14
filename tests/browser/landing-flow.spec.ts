import { test, expect } from '@playwright/test';

test('illustrated production flow carries draft, avatar and caption choices into the schedule example', async ({ page }) => {
  const errors: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => { if (!['GET', 'HEAD'].includes(request.method())) mutations.push(request.url()); });
  await page.goto('/');
  const demo = page.locator('.landing-demo');
  const tab = (label: string) => demo.getByRole('tab', { name: new RegExp(`^${label}: demo step`) });
  const panel = demo.getByRole('tabpanel');

  await demo.getByRole('button', { name: 'Preview One idea. Two platforms.' }).click();
  await expect(demo.locator('.landing-preview-script')).toHaveValue(/React Native/);
  await tab('Avatar').click();
  await demo.getByRole('button', { name: 'Choose example Presenter B' }).click();
  await expect(demo.getByRole('button', { name: 'Choose example Presenter B' })).toHaveAttribute('aria-pressed', 'true');

  await tab('Generate').click();
  await expect(panel).toContainText('Presenter B');
  await expect(panel).toContainText('no job submitted');
  await tab('Review').click();
  await expect(panel).toContainText('React Native');
  await demo.getByRole('button', { name: 'Expressive', exact: true }).click();
  await expect(demo.locator('.landing-demo-caption-sample')).toHaveClass(/is-expressive/);

  await tab('Schedule').click();
  await expect(panel).toContainText('Presenter B · expressive captions');
  await expect(panel).toContainText('Owner authorization comes first');
  await expect(panel.locator('.landing-demo-schedule-rows > div')).toHaveCount(3);
  await expect(panel).toContainText('Wed 18 Nov · 09:00');
  await expect(panel).toContainText('No accounts are connected or authorized here');

  await tab('Receipt').click();
  await expect(panel).toContainText('Receipt illustration, not provider evidence');
  await expect(panel.locator('.landing-demo-receipt-state')).toHaveCount(3);
  await expect(panel.locator('.landing-demo-receipt-state').nth(1)).toHaveText('Publishedexample state');
  await demo.getByRole('button', { name: 'Back to brief', exact: true }).click();
  await expect(demo.getByRole('button', { name: 'Preview One idea. Two platforms.' })).toHaveAttribute('aria-pressed', 'true');
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('walkthrough keyboard navigation and reduced motion never start an automatic sequence', async ({ page }) => {
  await page.goto('/');
  const demo = page.locator('.landing-demo');
  await expect(demo.getByRole('button', { name: 'Play production walkthrough' })).toBeDisabled();
  await demo.getByRole('tab', { name: 'Brief: demo step 1 of 6' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(demo.getByRole('tab', { name: 'Avatar: demo step 2 of 6' })).toBeFocused();
  await expect(demo.getByRole('tab', { name: 'Avatar: demo step 2 of 6' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(demo.getByRole('tab', { name: 'Receipt: demo step 6 of 6' })).toBeFocused();
  await expect(demo.getByRole('tabpanel')).toContainText('Receipt illustration');
  expect(await demo.locator('.landing-demo-stage-content').evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await page.keyboard.press('Home');
  await expect(demo.getByRole('tab', { name: 'Brief: demo step 1 of 6' })).toBeFocused();
});

test('optional demo playback advances once per step and stops for interaction or reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.install();
  await page.goto('/');
  const demo = page.locator('.landing-demo');
  await demo.getByRole('button', { name: 'Play production walkthrough' }).click();
  await page.clock.fastForward(5_001);
  await expect(demo.getByRole('tab', { name: 'Avatar: demo step 2 of 6' })).toHaveAttribute('aria-selected', 'true');
  await demo.getByRole('button', { name: 'Choose example Presenter B' }).click();
  await expect(demo.getByRole('button', { name: 'Play production walkthrough' })).toHaveAttribute('aria-pressed', 'false');
  await page.clock.fastForward(15_000);
  await expect(demo.getByRole('tab', { name: 'Avatar: demo step 2 of 6' })).toHaveAttribute('aria-selected', 'true');
  await demo.getByRole('button', { name: 'Play production walkthrough' }).click();
  await page.clock.fastForward(5_001);
  await expect(demo.getByRole('tab', { name: 'Generate: demo step 3 of 6' })).toHaveAttribute('aria-selected', 'true');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(demo.getByRole('button', { name: 'Play production walkthrough' })).toBeDisabled();
  await page.clock.fastForward(15_000);
  await expect(demo.getByRole('tab', { name: 'Generate: demo step 3 of 6' })).toHaveAttribute('aria-selected', 'true');
});

for (const width of [390, 320]) test(`production illustration fits ${width}px and keeps every step reachable`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('/');
  const demo = page.locator('.landing-demo');
  for (const name of ['Avatar', 'Generate', 'Review', 'Schedule', 'Receipt']) {
    await demo.getByRole('tab', { name: new RegExp(`^${name}: demo step`) }).click();
    const bounds = await demo.getByRole('tabpanel').boundingBox();
    expect(bounds?.x).toBeGreaterThanOrEqual(0);
    expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await demo.getByRole('button', { name: 'Inspect this draft', exact: true }).click();
  await expect(demo.locator('.landing-preview-script')).toBeVisible();
  expect(await demo.getByRole('tab', { name: 'Receipt: demo step 6 of 6' }).evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
});
