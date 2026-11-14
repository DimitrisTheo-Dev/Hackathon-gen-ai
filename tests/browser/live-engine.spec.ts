import { test, expect, type Page } from '@playwright/test';

/**
 * The live transport end to end: the built app talks to the REAL engine logic on an in-memory
 * store (see support/memory-engine.ts). Supabase is the only thing answered by the test itself.
 * Run with: corepack pnpm exec playwright test -c tests/browser/live.config.ts
 */
test.skip(!process.env.FACEFUL_LIVE_E2E, 'Needs the in-memory engine server from tests/browser/live.config.ts');

const SUPABASE = 'https://hgsgvdujzatfhsjoojll.supabase.co';
function session(id: string) {
  const user = { id, aud: 'authenticated', role: 'authenticated', email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const token = `${[{ alg: 'none', typ: 'JWT' }, { iss: 'faceful-e2e', sub: id, email: user.email, exp, aud: 'authenticated', role: 'authenticated' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.e2e`;
  return { token, user, stored: { access_token: token, refresh_token: 'e2e-not-a-credential', token_type: 'bearer', expires_in: 31_536_000, expires_at: exp, user } };
}
/** A fresh person per test: their own workspace, their own conversation store. */
async function signIn(page: Page, extra: Record<string, (path: string, method: string) => unknown> = {}) {
  const who = session(`e2e-${crypto.randomUUID()}`);
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['sb-hgsgvdujzatfhsjoojll-auth-token', JSON.stringify(who.stored)]);
  const entries: Array<{ campaign_id: string; body: unknown }> = [];
  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    for (const [prefix, answer] of Object.entries(extra)) if (url.pathname.startsWith(prefix)) return route.fulfill({ json: answer(url.pathname, method) });
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: who.user });
    if (url.pathname === '/rest/v1/castroom_director_entries') {
      if (method === 'POST') { entries.push(route.request().postDataJSON()); return route.fulfill({ status: 201, json: [] }); }
      const campaign = url.searchParams.get('campaign_id')?.replace(/^eq\./, '');
      return route.fulfill({ json: entries.filter((entry) => entry.campaign_id === campaign).reverse().map((entry) => ({ body: entry.body })) });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  const api = async (path: string, data?: unknown) => {
    const response = await page.request.fetch(path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${who.token}` }, data });
    return { status: response.status(), json: await response.json().catch(() => null) };
  };
  return { ...who, api };
}
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const PROMPT = 'Create a 15-second Instagram Reel for BeWell with a friendly Greek-speaking presenter for Monday morning.';

test('a new person lands on the composer; the first request docks the conversation beside a saved draft; refresh, revise and restore all hold', async ({ page }) => {
  const me = await signIn(page);
  await page.goto('/studio/');
  await expect(page.getByRole('heading', { name: 'What will we create today?' })).toBeVisible();
  await expect(page.locator('.content-card')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose a template' })).toBeVisible();
  const idea = page.getByLabel('What would you like to create?');
  await idea.fill(PROMPT);
  await idea.press('Enter');
  // The same conversation is now docked on the right, next to the draft it produced.
  await expect(page.locator('.content-card')).toHaveCount(1);
  await expect(page.locator('.content-card')).toContainText('Γνώρισε το BeWell');
  await expect(page.locator('.card-state')).toContainText('Draft');
  const turn = page.locator('.director-turn').last();
  await expect(turn).toContainText(PROMPT);
  await expect(turn).toContainText('I drafted a 15-second reel for BeWell.');
  await expect(turn).toContainText('nothing has been rendered or scheduled');
  const editor = await page.locator('.editor').boundingBox();
  const card = await page.locator('.content-card').boundingBox();
  expect(editor!.x).toBeGreaterThan(card!.x + card!.width - 1);
  await expect(page.getByLabel('Direction for your content')).toBeFocused();
  expect(await page.locator('.editor').evaluate((el) => el.getAnimations().length)).toBe(0); // reduced motion: no docking animation
  expect((await me.api('/__e2e/render-jobs')).json.count).toBe(0);
  const url = new URL(page.url());
  expect(url.searchParams.get('view')).toBe('canvas');
  const campaignId = url.searchParams.get('campaign');
  expect(campaignId).toBeTruthy();

  // Refresh: same project, same item, same conversation.
  await page.reload();
  await expect(page.locator('.content-card')).toContainText('Γνώρισε το BeWell');
  expect(new URL(page.url()).searchParams.get('campaign')).toBe(campaignId);
  await expect(page.locator('.director-turn').last()).toContainText('I drafted a 15-second reel for BeWell.');

  // A revision arrives as a proposal; applying it saves version 2 and keeps version 1.
  await page.getByLabel('Direction for your content').fill('Shorten the opening');
  await page.getByLabel('Direction for your content').press('Enter');
  await expect(page.locator('.director-plan')).toContainText('Update draft');
  expect((await me.api(`/v1/studio/campaigns/${campaignId}`)).json.items[0].revision).toBe(1);
  await page.getByRole('button', { name: 'Apply changes', exact: true }).click();
  await expect(page.locator('.director-result')).toContainText('Saved version 2');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Versions', exact: true }).click();
  await expect(page.locator('.version-list li')).toHaveCount(2);
  await expect(page.locator('.version-list li').first()).toContainText('Current');
  await page.getByRole('button', { name: 'Restore version 1 as new' }).click();
  await expect(page.locator('.version-list li')).toHaveCount(3);
  const restored = (await me.api(`/v1/studio/campaigns/${campaignId}`)).json.items[0];
  expect(restored.revision).toBe(3);
  expect(restored.script).toContain('Οργάνωσε τη μέρα σου');
});

test('“find … and play it” opens the saved video without a new render, and polling never swaps the player source', async ({ page }) => {
  test.setTimeout(60_000);
  const me = await signIn(page);
  await me.api('/v1/studio/context');
  const sample = (await me.api('/v1/studio/operations/create_sample_project', { operationKey: crypto.randomUUID() })).json;
  const item = sample.items[0];
  await me.api('/v1/studio/operations/revise_content', { contentId: item.id, expectedRevision: 1, operationKey: crypto.randomUUID(), patch: { avatarId: 'minas_kontis' } });
  const render = await me.api('/v1/studio/operations/render_content', { campaignId: sample.id, itemIds: [item.id], expectedRevisions: { [item.id]: 2 }, operationKey: crypto.randomUUID() });
  expect(render.json.state).toBe('accepted');
  expect((await me.api('/__e2e/complete-renders', {})).json.completed).toBe(1);

  await page.goto('/studio/');
  await expect(page.locator('.sample-chip').first()).toBeVisible();
  await page.getByLabel('Direction for your content').fill('Find my latest BeWell video and play it.');
  await page.getByLabel('Direction for your content').press('Enter');
  await expect(page.locator('.content-card')).toHaveCount(3);
  // Details opens on the saved video; the conversation keeps the honest record of what happened.
  const player = page.locator('.editor-preview video');
  await expect(player).toBeVisible();
  await page.getByRole('button', { name: 'AI Chat', exact: true }).click();
  await expect(page.locator('.director-turn').last()).toContainText('No new render was requested');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.locator('.content-card').first().locator('.card-state')).toContainText('Ready for review');
  expect((await me.api('/__e2e/render-jobs')).json.count).toBe(1);

  // The server signs a different URL on every read…
  const first = (await me.api(`/v1/studio/campaigns/${sample.id}`)).json.items[0].media.url;
  const second = (await me.api(`/v1/studio/campaigns/${sample.id}`)).json.items[0].media.url;
  expect(first).not.toBe(second);
  // …but the player keeps the one it started with across live polls.
  const before = await player.getAttribute('src');
  await page.waitForResponse((response) => response.url().includes(`/v1/studio/campaigns/${sample.id}`) && response.ok(), { timeout: 15_000 });
  await page.waitForResponse((response) => response.url().includes(`/v1/studio/campaigns/${sample.id}`) && response.ok(), { timeout: 15_000 });
  expect(await player.getAttribute('src')).toBe(before);
});

test('templates and the labelled sample create editable drafts without a model', async ({ page }) => {
  const me = await signIn(page);
  await me.api('/v1/studio/context');
  await me.api('/__e2e/planner', { mode: 'none' });
  await page.goto('/studio/');
  await page.getByRole('button', { name: 'Choose a template' }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a template' });
  await dialog.getByRole('button', { name: /15-second introduction/ }).click();
  const form = page.getByRole('dialog', { name: '15-second introduction' });
  await form.getByLabel('Script language').selectOption('el');
  await form.getByLabel('Brand or product').fill('BeWell');
  await form.getByLabel('What it helps people do').fill('οργανώσεις τη μέρα σου');
  await form.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.locator('.content-card')).toHaveCount(1);
  await expect(page.locator('.content-card')).toContainText('Γνώρισε το BeWell');
  const created = (await me.api('/v1/studio/campaigns')).json[0];
  expect(created.templateId).toBe('product-intro-15');
  expect(created.items[0].script).toContain('Σε βοηθά να οργανώσεις τη μέρα σου');
  expect((await me.api('/__e2e/render-jobs')).json.count).toBe(0);
});

test('without a model the first-run composer says so plainly and offers real ways to start; the sample is labelled', async ({ page }) => {
  const me = await signIn(page);
  await me.api('/v1/studio/context');
  await me.api('/__e2e/planner', { mode: 'none' });
  await page.goto('/studio/');
  await page.getByLabel('What would you like to create?').fill('Create a video about our launch');
  await page.getByRole('button', { name: 'Start creating' }).click();
  await expect(page.locator('.home-turn')).toContainText('Create a video about our launch');
  await expect(page.locator('.home-turn')).toContainText('AI writing isn’t connected');
  await expect(page.locator('.content-card')).toHaveCount(0);
  await expect(page.locator('.home-suggestions').getByRole('button', { name: 'Choose a template' })).toBeVisible();
  expect((await me.api('/v1/studio/campaigns')).json).toHaveLength(0);
  await page.getByRole('button', { name: 'Try the BeWell sample' }).click();
  await expect(page.locator('.content-card')).toHaveCount(3);
  await expect(page.locator('.campaign-meta .sample-chip')).toHaveText('Sample');
  await expect(page.locator('.success-note')).toContainText('seeded demonstration content');
});

test('running out of credits is explained and links to billing, which reports the not-configured state honestly', async ({ page }) => {
  const me = await signIn(page);
  await me.api('/v1/studio/context');
  const sample = (await me.api('/v1/studio/operations/create_sample_project', { operationKey: crypto.randomUUID() })).json;
  await me.api('/v1/studio/operations/revise_content', { contentId: sample.items[0].id, expectedRevision: 1, operationKey: crypto.randomUUID(), patch: { avatarId: 'minas_kontis' } });
  await me.api('/__e2e/credits', { balance: 0 });
  await page.goto(`/studio/?view=canvas&campaign=${sample.id}&item=${sample.items[0].id}`);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.getByRole('button', { name: 'Regenerate', exact: true }).click();
  const alert = page.locator('.feedback .notice.error');
  await expect(alert).toContainText('no render credits left');
  expect((await me.api('/__e2e/render-jobs')).json.count).toBe(0);
  await alert.getByRole('button', { name: 'Open billing' }).click();
  await expect(page.getByRole('heading', { name: 'Billing and usage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Upgrades aren’t available yet' })).toBeVisible();
  await expect(page.locator('.billing-view')).toContainText('Stripe sandbox keys have not been added to this deployment.');
  await expect(page.locator('.billing-view')).toContainText('Nothing can be charged');
  await expect(page.locator('.billing-number').first()).toHaveText('0');
  await expect(page.getByRole('button', { name: /Upgrade with Stripe/ })).toHaveCount(0);
  // Returning from a cancelled checkout is neutral, and nothing is ever marked paid by a redirect.
  await page.goto('/studio/?view=billing&checkout=cancelled');
  await expect(page.locator('.billing-view .success-note')).toContainText('Nothing was charged');
  expect((await me.api('/v1/studio/billing')).json.status).toBe('free');
});

for (const width of [390, 320]) test(`phone ${width}px: first request, docked chat and billing fit without horizontal scrolling`, async ({ page }) => {
  await page.setViewportSize({ width, height: 800 });
  await signIn(page);
  await page.goto('/studio/');
  await expect(page.getByRole('heading', { name: 'What will we create today?' })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  const idea = page.getByLabel('What would you like to create?');
  expect(await idea.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  await idea.fill(PROMPT);
  await page.getByRole('button', { name: 'Start creating' }).click();
  await expect(page.getByRole('dialog', { name: 'Content editor' })).toBeVisible();
  await expect(page.locator('.director-turn').last()).toContainText('I drafted a 15-second reel for BeWell.');
  expect(await noOverflow(page)).toBe(true);
  await page.getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.content-card')).toHaveCount(1);
  expect(await noOverflow(page)).toBe(true);
  await page.goto('/studio/?view=billing');
  await expect(page.getByRole('heading', { name: 'Billing and usage' })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});

test('the whole first-run path works from the keyboard', async ({ page }) => {
  await signIn(page);
  await page.goto('/studio/');
  await expect(page.getByRole('heading', { name: 'What will we create today?' })).toBeVisible();
  const idea = page.getByLabel('What would you like to create?');
  for (let presses = 0; presses < 40 && !(await idea.evaluate((el) => el === document.activeElement)); presses++) await page.keyboard.press('Tab');
  await expect(idea).toBeFocused();
  await page.keyboard.type('Create a short video for BeWell');
  await page.keyboard.press('Enter');
  await expect(page.locator('.content-card')).toHaveCount(1);
  await expect(page.getByLabel('Direction for your content')).toBeFocused();
  await page.keyboard.type('Shorten the opening');
  await page.keyboard.press('Enter');
  const apply = page.getByRole('button', { name: 'Apply changes', exact: true });
  await expect(apply).toBeVisible();
  await apply.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.director-result')).toContainText('Saved version 2');
});

test('agent consent: shows who is asking and what access means, then follows the server’s redirect for Allow and Deny', async ({ page }) => {
  const answers: string[] = [];
  await signIn(page, {
    '/auth/v1/oauth/authorizations/': (path, method) => {
      if (method === 'GET') return { authorization_id: 'auth-123', redirect_uri: 'http://127.0.0.1:53999/callback', client: { id: 'client-1', name: 'Claude Code', uri: '', logo_uri: '' }, user: { id: 'u', email: 'u@e2e.test' }, scope: 'openid email' };
      answers.push(path);
      return { redirect_url: `${new URL(page.url()).origin}/docs/mcp/?consent=recorded` };
    },
  });
  let action = '';
  page.on('request', (request) => { if (request.url().includes('/consent') && request.method() === 'POST') action = request.postDataJSON()?.action; });
  await page.goto('/oauth/consent?authorization_id=auth-123');
  await expect(page.getByRole('heading', { name: 'Connect Claude Code to Faceful?' })).toBeVisible();
  await expect(page.locator('.consent-card')).toContainText('127.0.0.1:53999');
  await expect(page.locator('.consent-card')).toContainText('Request renders within your credits');
  await expect(page.locator('.consent-card')).toContainText('Approve or publish posts');
  await page.getByRole('button', { name: 'Allow access' }).click();
  await page.waitForURL(/consent=recorded/);
  expect(action).toBe('approve');
  await page.goto('/oauth/consent?authorization_id=auth-123');
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page.waitForURL(/consent=recorded/);
  expect(action).toBe('deny');
  expect(answers).toHaveLength(2);
});

test('agent consent without a request id explains what to do instead of failing silently', async ({ page }) => {
  await signIn(page);
  await page.goto('/oauth/consent');
  await expect(page.getByRole('heading', { name: 'This connection can’t continue' })).toBeVisible();
  await expect(page.locator('.consent-card')).toContainText('Start the connection again from your agent');
});
