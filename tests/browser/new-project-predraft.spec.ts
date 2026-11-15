import { expect, test, type Page } from '@playwright/test';

/**
 * The development workspace writes a script at once; a model takes seconds. Here its script writer takes SLOW ms and
 * starts each draft's first line with who it was written for ("[camera] …"), by rewriting the fixture module as Vite
 * serves it. So these tests run only against the dev server their own config starts.
 */
test.skip(!process.env.FACEFUL_DEV_E2E, 'Needs the Vite dev server: playwright test -c tests/browser/predraft.config.ts');

const SLOW = 2500;
const BRIEF = 'Make room for a reusable lunch box in your everyday bag. It keeps food fresh until lunch.';

async function slowScriptWriter(page: Page) {
  await page.addInitScript((delay) => {
    const scope = window as unknown as { scriptsAsked: string[]; slowScript: (raw: { brief: string; presenter: string }) => Promise<unknown> };
    scope.scriptsAsked = [];
    scope.slowScript = async (raw) => {
      scope.scriptsAsked.push(raw.presenter);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { ...raw, brief: `[${raw.presenter}] ${raw.brief}` };
    };
  }, SLOW);
  await page.route(/\/src\/data\/fixture\.ts(\?|$)/, async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const slowed = source.replace('draftScript: async (raw) => {', 'draftScript: async (raw) => { raw = await window.slowScript(raw);');
    if (slowed === source) throw new Error('The fixture script writer was not found; update the rewrite in this spec.');
    await route.fulfill({ response, body: slowed });
  });
}
/** Every first-line value the script step shows from now on, and whether its "Writing your script…" state appeared. */
async function watchScript(page: Page) {
  await page.evaluate(() => {
    const scope = window as unknown as { linesSeen: string[]; sawWriting: boolean };
    scope.linesSeen = [];
    scope.sawWriting = false;
    const look = () => {
      if (document.querySelector('.np-writing')) scope.sawWriting = true;
      const first = document.querySelector<HTMLTextAreaElement>('.np-beat-text');
      if (first && scope.linesSeen.at(-1) !== first.value) scope.linesSeen.push(first.value);
    };
    new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    setInterval(look, 25);
  });
}
const seen = (page: Page) =>
  page.evaluate(() => {
    const scope = window as unknown as { linesSeen?: string[]; sawWriting?: boolean; scriptsAsked?: string[] };
    return { linesSeen: [...(scope.linesSeen ?? [])], sawWriting: Boolean(scope.sawWriting), scriptsAsked: [...(scope.scriptsAsked ?? [])] };
  });

async function describe(page: Page) {
  await slowScriptWriter(page);
  await page.goto('/dev/studio/');
  await page.getByRole('button', { name: 'Create a campaign' }).first().click();
  await expect(page.getByRole('dialog', { name: 'What is this video about?' })).toBeVisible();
  await page.locator('#np-brief').fill(BRIEF);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Who appears in the video?' })).toBeVisible();
}
const firstLine = (page: Page) => page.locator('.np-beat-text').first();

test('the script is written while the person chooses, so Write the script opens it with no wait', async ({ page }) => {
  await describe(page);
  // A few seconds choosing who appears and how it is made: longer than the model takes.
  await page.waitForTimeout(SLOW + 1000);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should it be made?' })).toBeVisible();
  await watchScript(page);
  const clicked = Date.now();
  await page.getByRole('button', { name: 'Write the script' }).click();
  await expect(firstLine(page)).toHaveValue(/^\[(persona|avatar|none)\] Make room for a reusable lunch box/, { timeout: 1000 });
  expect(Date.now() - clicked).toBeLessThan(1000);
  const { sawWriting, scriptsAsked } = await seen(page);
  expect(sawWriting, 'no "Writing your script…" wait').toBe(false);
  expect(scriptsAsked.length, 'one draft for the settled choices').toBe(1);
});

test('a draft written for an earlier choice never shows, and choosing it again brings it back at once', async ({ page }) => {
  await describe(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'How should it be made?' })).toBeVisible();
  await page.waitForTimeout(SLOW + 1000);
  const [aiSpeaker] = (await seen(page)).scriptsAsked;
  expect(aiSpeaker).toMatch(/^(persona|avatar|none)$/);

  // Recording yourself changes who speaks; Write the script is pressed before the new draft can be ready.
  await page.getByRole('radio', { name: /Record myself/ }).click();
  await watchScript(page);
  await page.getByRole('button', { name: 'Write the script' }).click();
  await expect(page.locator('.np-writing')).toBeVisible();
  await expect(firstLine(page)).toHaveValue(/^\[camera\] Make room/, { timeout: SLOW + 3000 });
  const camera = await seen(page);
  expect(camera.linesSeen.every((line) => line.startsWith('[camera]')), `only the camera draft was shown: ${JSON.stringify(camera.linesSeen)}`).toBe(true);
  expect(camera.scriptsAsked).toEqual([aiSpeaker, 'camera']);

  // Back to the AI presenter: its draft was kept, so it is there again with no new request and no wait.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('radio', { name: /presents it|made by AI/ }).click();
  await watchScript(page);
  await page.getByRole('button', { name: 'Write the script' }).click();
  await expect(firstLine(page)).toHaveValue(new RegExp(`^\\[${aiSpeaker}\\] Make room`), { timeout: 1000 });
  const again = await seen(page);
  expect(again.sawWriting).toBe(false);
  expect(again.scriptsAsked).toEqual([aiSpeaker, 'camera']);
});

test('lines the person edited are never replaced when a choice changes later', async ({ page }) => {
  await describe(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForTimeout(SLOW + 1000);
  await page.getByRole('button', { name: 'Write the script' }).click();
  await firstLine(page).fill('My own opening line.');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('radio', { name: /Record my voice only/ }).click();
  await page.waitForTimeout(SLOW + 1000);
  await page.getByRole('button', { name: 'Write the script' }).click();
  await expect(firstLine(page)).toHaveValue('My own opening line.');
  await expect(page.getByText('changed since this script was written')).toBeVisible();
  expect((await seen(page)).scriptsAsked).toHaveLength(1);
});
