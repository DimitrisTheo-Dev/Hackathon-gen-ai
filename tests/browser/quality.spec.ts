import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Products in the brand kit and the content review, end to end in the local sample studio (basic mode, no network):
 * add a product with a photo and approved facts, check a health draft, use a suggested wording and undo it, check
 * again, approve it by name, see the readiness checklist's Claims step, and put a product photo on the timeline.
 * Nothing here may read as "verified"; every status is a word with an icon, never colour alone.
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
/** A 1 × 1 PNG: enough for the browser to decode, hash and store as a product photo. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** Opens the sample health draft ("A familiar feeling") on Details → Review, checked once unless told not to. */
async function openReview(page: Page, check = true) {
  await page.goto('/dev/studio/?view=canvas');
  await expect(page.locator('.content-card')).toHaveCount(3);
  await page.locator('.content-select').nth(2).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const row = page.locator('#detail-review-trigger');
  await expect(row).toHaveAccessibleDescription('Not reviewed');
  await row.click();
  if (check) {
    await page.getByRole('button', { name: 'Check this draft' }).click();
    await expect(row).toHaveAccessibleDescription('2 to fix');
  }
  return row;
}

test('brand kit: a product is added with a photo, a kind and approved facts, and it stays', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/studio/?view=brand');
  const products = page.locator('section[aria-labelledby="bk-products-title"]');
  await expect(products.getByRole('heading', { name: 'Products' })).toBeVisible();
  // The sample product: its photo, a quiet Health chip with its word, and its approved facts.
  const omega = products.locator('article', { hasText: 'BeWell Omega' });
  await expect(omega.getByRole('img', { name: 'Photo of BeWell Omega' })).toBeVisible();
  await expect(omega.locator('.domain-chip')).toHaveText('Health');
  await expect(omega.getByRole('list')).toContainText('Each capsule has 500 mg of omega-3 from fish oil.');

  await products.getByRole('button', { name: 'Add product' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add a product' });
  await expect(sheet).toBeVisible();
  // A name is required, and the error says how to fix it, next to the field.
  await sheet.getByRole('button', { name: 'Add product' }).click();
  await expect(sheet.getByText('Give the product a name, like “BeWell Omega”.')).toBeVisible();
  await expect(sheet.getByLabel('Name')).toBeFocused();
  await sheet.locator('input[type="file"]').setInputFiles({ name: 'bottle.png', mimeType: 'image/png', buffer: PNG });
  await expect(sheet.getByRole('button', { name: 'Replace photo' })).toBeVisible();
  await sheet.getByLabel('Name').fill('BeWell Sleep');
  await sheet.getByLabel('Description').fill('Magnesium tablets.');
  await sheet.getByRole('radio', { name: 'Health' }).check();
  await expect(sheet).toContainText('Scripts that name it need a qualified person’s approval before they can be scheduled.');
  const fact = sheet.getByLabel('New approved fact');
  await fact.fill('Each tablet has 200 mg of magnesium.');
  await fact.press('Enter');
  await fact.fill('Each tablet has 200 mg of magnesium.');
  await fact.press('Enter');
  await expect(sheet.getByText('That fact is already on the list.')).toBeVisible();
  await fact.fill('Take one tablet in the evening.');
  await fact.press('Enter');
  await expect(sheet.getByRole('list', { name: 'Approved facts' }).getByRole('listitem')).toHaveCount(3);
  await sheet.getByRole('button', { name: 'Add product' }).click();
  await expect(sheet).toHaveCount(0);

  const sleep = products.locator('article', { hasText: 'BeWell Sleep' });
  await expect(sleep.getByRole('img', { name: 'Photo of BeWell Sleep' })).toBeVisible();
  await expect(sleep.locator('.domain-chip')).toHaveText('Health');
  await expect(sleep.getByRole('list', { name: '2 approved facts' }).getByRole('listitem')).toHaveCount(2);
  await page.reload();
  await expect(products.locator('article', { hasText: 'BeWell Sleep' }).getByRole('list', { name: '2 approved facts' })).toContainText('Take one tablet in the evening.');

  // Removing asks once, inline, and says what changes.
  await products.getByRole('button', { name: 'Remove BeWell Sleep' }).click();
  await expect(products.getByRole('group', { name: 'Remove BeWell Sleep' })).toContainText('Scripts that name it lose its approved facts.');
  await expect(products.getByRole('button', { name: 'Keep product' })).toBeFocused();
  await products.getByRole('button', { name: 'Remove product' }).click();
  await expect(products.locator('article', { hasText: 'BeWell Sleep' })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('review: a health draft shows blocking claims as words, a suggestion applies and undoes through the editor', async ({ page }) => {
  const row = await openReview(page);
  const panel = page.locator('#detail-review-panel');
  const claims = panel.getByRole('region', { name: 'Claims' });
  // Status is a chip with an icon and a word, plus what it asks of a person; never colour alone, never "verified".
  const risky = claims.getByRole('listitem').filter({ hasText: 'It cures joint pain' });
  await expect(risky.locator('.claim-chip')).toHaveText('Risky wording');
  await expect(risky).toContainText('To fix');
  await expect(risky).toContainText('Your brand kit says: “Avoid medical or wellbeing guarantees.”');
  const supported = claims.getByRole('listitem').filter({ hasText: 'Each capsule has 500 mg of omega-3.' });
  await expect(supported.locator('.claim-chip')).toHaveText('Matches a fact');
  await expect(supported).toContainText('Approved fact · BeWell Omega');
  await expect(panel.getByRole('region', { name: 'Voice & captions' })).toContainText('needs an on-screen disclaimer');
  await expect(panel.getByRole('region', { name: 'On screen' })).toContainText('Use “Show product”');
  await expect(panel.getByRole('region', { name: 'What was checked' })).toContainText('Checked against your approved facts and wording rules, not by AI.');
  await expect(panel.getByRole('region', { name: 'What was checked' })).toContainText('The rendered video: not checked');
  await expect(panel).not.toContainText(/verified|fact-checked|accurate/i);

  const script = page.locator('#script');
  await risky.getByRole('button', { name: 'Use this wording' }).click();
  await expect(script).toHaveValue(/It may help with joint pain\./);
  await expect(script).not.toHaveValue(/cures/);
  await expect(risky).toContainText('Replaced in the script. Save to keep it.');
  await expect(risky.getByRole('button', { name: 'Undo' })).toBeFocused();
  await risky.getByRole('button', { name: 'Undo' }).click();
  await expect(script).toHaveValue(/It cures joint pain, with no side effects\./);
  await expect(risky.getByRole('button', { name: 'Use this wording' })).toBeFocused();
  // The editor's own Undo works on it too: the replacement is an ordinary edit in the history.
  await risky.getByRole('button', { name: 'Use this wording' }).click();
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Undo last edit' }).click();
  await expect(script).toHaveValue(/cures joint pain/);
  await expect(row).toHaveAccessibleDescription('2 to fix');
});

test('review: after the fix is saved the review is out of date; checked again, it is approved by name and credential', async ({ page }) => {
  const row = await openReview(page);
  const panel = page.locator('#detail-review-panel');
  await panel.getByRole('button', { name: 'Use this wording' }).click();
  // The check reads the saved script, so unsaved edits hold it back and say so.
  await expect(panel.getByRole('button', { name: 'Check again' })).toBeDisabled();
  await expect(panel).toContainText('Save your edits first. The check reads the saved script.');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.locator('.save-state')).toContainText('Saved · v2');
  await expect(row).toHaveAccessibleDescription('Out of date');
  await expect(panel).toContainText('The script changed after this review.');
  await expect(panel.getByRole('button', { name: /Approve version/ })).toHaveCount(0);

  await panel.getByRole('button', { name: 'Check again' }).click();
  await expect(row).toHaveAccessibleDescription('1 to fix');
  await expect(panel.getByRole('region', { name: 'Claims' }).locator('.claim-chip')).toHaveText(['Matches a fact']);
  // Health needs a name and a credential; an item left to fix needs a written reason.
  const approve = panel.getByRole('button', { name: 'Approve version 2' });
  await panel.getByLabel('Approver’s name').fill('Dr. Eleni Papadopoulou');
  await approve.click();
  await expect(panel.getByText('Add the approver’s qualification, like “MD, cardiologist”.')).toBeVisible();
  await expect(panel.getByLabel('Credential')).toBeFocused();
  await panel.getByLabel('Credential').fill('MD, cardiologist');
  await approve.click();
  await expect(panel.getByText('Say why the items to fix are acceptable, in at least 20 characters.')).toBeVisible();
  await panel.getByLabel('Why the items to fix are acceptable').fill('The disclaimer is added in the video edit before it renders.');
  await approve.click();
  await expect(panel.locator('.cr-approved')).toContainText(/^Approved by Dr\. Eleni Papadopoulou, MD, cardiologist · \d{1,2} \w{3} \d{4}$/);
  await expect(row).toHaveAccessibleDescription('Approved · Dr. Eleni Papadopoulou');
  await page.reload();
  await page.locator('.content-select').nth(2).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.locator('#detail-review-trigger')).toHaveAccessibleDescription('Approved · Dr. Eleni Papadopoulou');
});

test('readiness: an unapproved health draft adds a Claims step whose fix opens that draft’s review', async ({ page }) => {
  await openReview(page);
  if (!(await page.locator('#workspace-content').getByRole('button', { name: 'Review schedule', exact: true }).isVisible()))
    await page.getByRole('button', { name: 'Return to campaign' }).click();
  await page.locator('#workspace-content').getByRole('button', { name: 'Review schedule', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review schedule' });
  const claims = dialog.locator('.review-step').first();
  await expect(claims).toContainText('Claims');
  await expect(claims).toContainText('2 of 3');
  await expect(claims).toContainText('2 items to fix, or an approver’s written reason.');
  await expect(claims).not.toContainText('Claims review:');
  await expect(claims.locator('.blocker-scope')).toHaveText('A familiar feeling');
  await claims.getByRole('button', { name: 'Open its review' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#detail-review-trigger')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#detail-review-trigger')).toBeFocused();
  await expect(page.locator('.director-selected')).toContainText('A familiar feeling');
});

test('video studio: Show product places the photo on the saved timeline, and the review then finds it on screen', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/studio/?view=video&item=fixture-video-3');
  await expect(page.locator('.video-body')).toBeVisible();
  await page.getByRole('button', { name: 'Show product' }).click();
  const sheet = page.getByRole('dialog', { name: 'Show a product' });
  await expect(sheet.getByRole('radio', { name: /BeWell Omega/ })).toBeChecked();
  await expect(sheet.getByRole('radio', { name: 'Window' })).toBeChecked();
  await expect(sheet.getByRole('checkbox', { name: /Add an end card/ })).toBeChecked();
  await expect(sheet).toContainText('where the script first names it, for 3 seconds');
  await sheet.getByRole('radio', { name: 'Split' }).check();
  await sheet.getByRole('button', { name: 'Show product' }).click();
  await expect(sheet).toHaveCount(0);
  // The script names the product in its first words, so the photo starts when the opening title card ends.
  await expect(page.locator('.success-note')).toContainText('BeWell Omega is on screen at 0:02.5 and on the end card. Saved as version 1.');
  const placed = page.locator('.clip-list li').filter({ hasText: 'Overlay · Image · BeWell Omega.jpg' });
  await expect(placed).toHaveCount(1);
  await expect(placed.getByRole('group', { name: 'Where it sits' }).getByRole('radio', { name: 'Split screen' })).toBeChecked();
  await expect(page.getByRole('toolbar', { name: 'Edit' }).getByRole('button', { name: /^Cards/ })).toContainText('2');

  // With the photo on screen, the visual pass no longer asks for it.
  await page.getByRole('button', { name: 'Canvas', exact: true }).first().click();
  await page.locator('.content-select').nth(2).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.locator('#detail-review-trigger').click();
  await page.getByRole('button', { name: 'Check this draft' }).click();
  await expect(page.locator('#detail-review-panel').getByRole('region', { name: 'On screen' })).not.toContainText('is named at');
  expect(errors).toEqual([]);
});

test('video studio: Render MP4 sits beside Save and says why it waits, platform links are refused, and a selected overlay shows where it sits', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dev/studio/?view=video&item=fixture-video-3');
  await expect(page.locator('.video-body')).toBeVisible();
  // The development role cannot render; the reason sits beside the button instead of a mysteriously disabled control.
  const renderButton = page.getByRole('button', { name: 'Render MP4' });
  await expect(renderButton).toBeDisabled();
  await expect(page.locator('.render-action')).toContainText('Your role can’t render');
  // A YouTube page is not a media file: refused at input with the way forward.
  await page.getByLabel('Media link').fill('https://www.youtube.com/shorts/V0morSTvZVI');
  await page.getByRole('button', { name: 'Add at playhead' }).click();
  const problem = page.locator('#link-problem');
  await expect(problem).toContainText('That’s a YouTube page, not a media file');
  await expect(problem.getByRole('link', { name: 'Templates → Clone a video you like' })).toHaveAttribute('href', /view=templates&tab=clone/);
  await expect(page.locator('.timeline-clip.video.overlay')).toHaveCount(0);
  // A direct image link is accepted; selecting it outlines its place on the preview.
  await page.getByLabel('Media link').fill('https://images.unsplash.com/photo-1506126613408-eca07ce68773?w=1080');
  await page.getByLabel('Use the link as').selectOption('image');
  await page.getByRole('button', { name: 'Add at playhead' }).click();
  await expect(problem).toHaveCount(0);
  await page.locator('.timeline-clip.video.overlay').first().click();
  await expect(page.locator('.placement-outline')).toContainText('Overlay · Split screen');
  await page.locator('.clip-row.selected').getByRole('radio', { name: 'Window' }).check();
  await expect(page.locator('.placement-outline')).toContainText('Overlay · Window');
  await expect(page.locator('.clip-summary')).toHaveText('1 main clip · 1 overlay');
  expect(errors).toEqual([]);
});

for (const width of [1440, 390, 320]) test(`${width}px: products, the product sheet, Review and readiness fit without side scroll and pass axe`, async ({ page }) => {
  await page.setViewportSize({ width, height: width < 761 ? 844 : 900 });
  const axe = async (label: string, include: string) => {
    // Colours are read at rest: entrance fades (sheets, panels) finish first.
    await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
    const { violations } = await new AxeBuilder({ page }).withTags(TAGS).include(include).analyze();
    const blocking = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(blocking.map((v) => `${label}: ${v.id} ${v.nodes.map((n) => `${n.target.join(' ')} (${n.failureSummary?.split('\n')[1]?.trim()})`).join(', ')}`)).toEqual([]);
  };
  await page.goto('/dev/studio/?view=brand');
  await expect(page.locator('section[aria-labelledby="bk-products-title"] article')).toHaveCount(1);
  expect(await noSideScroll(page)).toBe(true);
  await axe('products', 'section[aria-labelledby="bk-products-title"]');
  await page.getByRole('button', { name: 'Edit BeWell Omega' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit product' })).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await axe('product sheet', '.bk-product-sheet');
  await page.keyboard.press('Escape');

  await openReview(page);
  expect(await noSideScroll(page)).toBe(true);
  // Nothing inside the panel is wider than the panel.
  expect(await page.locator('.cr').evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await axe('review', '#detail-review-panel');
  if (width < 1001) await page.getByRole('button', { name: 'Return to campaign' }).click();
  await page.locator('#workspace-content').getByRole('button', { name: 'Review schedule', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Review schedule' }).locator('.review-step').first()).toContainText('Claims');
  expect(await noSideScroll(page)).toBe(true);
  await axe('readiness', '.review-sheet');
});
