import { test, expect, type Page } from '@playwright/test';

/**
 * Getting in and getting connected, against the real engine logic on an in-memory store.
 * Supabase Auth is the only thing answered by the test itself.
 *   corepack pnpm exec playwright test -c tests/browser/onboarding.config.ts
 * Set ONBOARDING_SHOTS=1 to also write docs/demo/evidence/polish/onboarding-*.png.
 */
test.skip(!process.env.FACEFUL_ONBOARDING_E2E, 'Needs the server from tests/browser/onboarding.config.ts');

const SUPABASE = 'https://hgsgvdujzatfhsjoojll.supabase.co';
const SHOTS = Boolean(process.env.ONBOARDING_SHOTS);
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `docs/demo/evidence/polish/onboarding-${name}.png`, animations: 'disabled' }); };
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

function session(id: string) {
  const user = { id, aud: 'authenticated', role: 'authenticated', email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const token = `${[{ alg: 'none', typ: 'JWT' }, { iss: 'faceful-e2e', sub: id, email: user.email, exp, aud: 'authenticated', role: 'authenticated' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.e2e`;
  return { token, user, stored: { access_token: token, refresh_token: 'e2e-not-a-credential', token_type: 'bearer', expires_in: 31_536_000, expires_at: exp, user } };
}
async function signIn(page: Page) {
  const who = session(`e2e-${crypto.randomUUID()}`);
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['sb-hgsgvdujzatfhsjoojll-auth-token', JSON.stringify(who.stored)]);
  await page.route(`${SUPABASE}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/auth/v1/user') return route.fulfill({ json: who.user });
    if (url.pathname === '/rest/v1/castroom_director_entries') return route.fulfill({ json: [] });
    return route.fulfill({ status: 404, json: {} });
  });
  return who;
}
/** Sign-in screens only: every Supabase Auth call is answered here; `verify` decides the outcome. */
async function authMock(page: Page, verify: 'expired' | 'ok') {
  const calls: string[] = [];
  const who = session('11111111-1111-4111-8111-111111111111');
  await page.route(`${SUPABASE}/auth/v1/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    calls.push(path);
    if (path.endsWith('/otp')) return route.fulfill({ json: {} });
    if (path.endsWith('/verify')) return verify === 'ok' ? route.fulfill({ json: { ...who.stored } }) : route.fulfill({ status: 403, json: { error_code: 'otp_expired', msg: 'Token expired' } });
    return route.fulfill({ json: who.user });
  });
  return calls;
}

for (const width of [1440, 390]) test(`sign-in at ${width}px: Google first, then email; one quiet line of help; nothing overflows`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await authMock(page, 'expired');
  await page.goto('/studio/');
  await expect(page.getByRole('heading', { name: 'Sign in to Faceful' })).toBeVisible();
  const google = page.getByRole('button', { name: 'Continue with Google' });
  const email = page.getByLabel('Email address');
  await expect(google).toBeVisible();
  expect((await google.boundingBox())!.y).toBeLessThan((await email.boundingBox())!.y);
  await expect(page.getByText('We’ll email you a 6-digit code.')).toBeVisible();
  // The two lines the owner asked to remove stay removed.
  await expect(page.getByText('Creating an account doesn’t grant access')).toHaveCount(0);
  await expect(page.getByText('Code requested')).toHaveCount(0);
  // Touch targets and iOS zoom: controls are at least 44px tall and the field is 16px.
  for (const control of [google, page.getByRole('button', { name: 'Continue with email' })]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await email.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, `signin-email-${width}`);

  await email.fill('qa@example.com');
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const code = page.getByLabel('Sign-in code');
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
  await expect(page.getByRole('button', { name: /Resend in \d+s/ })).toBeDisabled();
  await code.pressSequentially('123');
  await expect(page.locator('.ob-code-slot[data-filled]')).toHaveCount(3);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, `signin-code-${width}`);
});

test('code entry: a pasted code submits by itself; a rejected code is cleared with focus kept; the email can be changed', async ({ page }) => {
  const calls = await authMock(page, 'expired');
  await page.goto('/studio/');
  await page.getByLabel('Email address').fill('qa@example.com');
  await page.keyboard.press('Enter');
  const code = page.getByLabel('Sign-in code');
  await code.fill('123 456');
  await expect(page.getByRole('alert')).toContainText('expired');
  await expect(code).toHaveValue('');
  await expect(code).toBeFocused();
  expect(calls.filter((path) => path.endsWith('/verify'))).toHaveLength(1);
  // Typing the next code clears the message and submits again on the sixth digit.
  await code.pressSequentially('654321');
  await expect.poll(() => calls.filter((path) => path.endsWith('/verify')).length).toBe(2);
  await page.getByRole('button', { name: 'Use a different email' }).click();
  await expect(page.getByLabel('Email address')).toHaveValue('qa@example.com');
  expect(calls.filter((path) => path.endsWith('/otp'))).toHaveLength(1);
});

test('sign-in works from the keyboard and lands on the composer with no wizard', async ({ page }) => {
  await authMock(page, 'ok');
  await page.route(`${SUPABASE}/rest/v1/**`, (route) => route.fulfill({ json: [] }));
  await page.goto('/studio/');
  await expect(page.getByLabel('Email address')).toBeFocused();
  await page.keyboard.type('qa@example.com');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Sign-in code')).toBeFocused();
  await page.keyboard.type('123456');
  await expect(page.getByRole('heading', { name: 'What will we create today?' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

for (const width of [1440, 390]) test(`connect an agent at ${width}px: choose, create a real token, copy the setup, and see the first call arrive`, async ({ page, context }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  await page.goto('/studio/?view=connect');
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible();
  for (const name of ['Claude Code', 'Codex', 'Cursor', 'Gemini CLI', 'VS Code', 'Any MCP client']) await expect(page.getByRole('button', { name: new RegExp(`^${name}`) })).toBeVisible();
  // Only the two clients that were actually exercised carry the word "Tested".
  await expect(page.locator('.ob-badge-tested')).toHaveCount(2);
  await expect(page.locator('.ob-connect')).toContainText('not yet verified by us');
  expect(await noOverflow(page)).toBe(true);
  await shot(page, `connect-grid-${width}`);

  await page.getByRole('button', { name: /^Claude Code/ }).click();
  await expect(page.getByRole('heading', { name: 'Connect Claude Code' })).toBeFocused();
  const view = page.locator('.ob-connect');
  await expect(view).toContainText('claude mcp add --transport http faceful http://127.0.0.1');
  await expect(view).toContainText('FACEFUL_TOKEN');
  for (const stale of ['castroom', 'CASTROOM_TOKEN', 'studio_get_context']) await expect(view).not.toContainText(stale);

  await page.getByRole('button', { name: 'Create token' }).click();
  const field = page.getByLabel('Your token · shown once');
  await expect(field).toHaveAttribute('type', 'password');
  const token = await field.inputValue();
  expect(token).toMatch(/^fct_/);
  // The token is never printed in the page, even while it is held for copying.
  expect(await view.innerText()).not.toContain(token);
  await page.getByRole('button', { name: 'Copy with token' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain(`export FACEFUL_TOKEN='${token}'`);
  expect(copied).toContain('claude mcp add --transport http faceful');
  await expect(page.locator('.ob-live')).toContainText('Waiting for your agent’s first call');
  expect(await noOverflow(page)).toBe(true);
  await shot(page, `connect-steps-${width}`);

  // Do it yourself shows the config file form, which refers to the variable and never holds the token.
  await page.getByRole('radio', { name: 'Do it yourself' }).check();
  await expect(view).toContainText('"Authorization": "Bearer ${FACEFUL_TOKEN}"');
  await page.getByRole('radio', { name: 'Quick setup' }).check();

  // The agent's first authenticated call, made with the token itself.
  const first = await page.request.get('/v1/studio/context', { headers: { Authorization: `Bearer ${token}` } });
  expect(first.status()).toBe(200);
  await expect(page.locator('.ob-live')).toContainText('Connected · last seen just now', { timeout: 15_000 });
  await expect(page.locator('.ob-step-item[data-state="done"]')).toHaveCount(3);
  await shot(page, `connect-connected-${width}`);

  // Revoking asks first, names what happens, and the token stops working.
  await page.getByRole('button', { name: 'Revoke the Claude Code token' }).click();
  await expect(page.getByRole('group', { name: 'Revoke the Claude Code token?' })).toContainText('stops working at once');
  await page.getByRole('button', { name: 'Revoke token' }).click();
  await expect(page.locator('.ob-past')).toContainText('1 revoked or expired');
  expect((await page.request.get('/v1/studio/context', { headers: { Authorization: `Bearer ${token}` } })).status()).toBe(401);
});

test('other clients get the standard MCP configuration, labelled as not verified', async ({ page }) => {
  await signIn(page);
  await page.goto('/studio/?view=connect');
  await page.getByRole('button', { name: /^Cursor/ }).click();
  const view = page.locator('.ob-connect');
  await expect(view).toContainText('Standard MCP configuration. Not yet verified by us with this client.');
  await expect(view).toContainText('"url": "http://127.0.0.1');
  await page.getByRole('radio', { name: 'Do it yourself' }).check();
  await expect(view).toContainText('Streamable HTTP');
  await page.getByRole('button', { name: 'All agents' }).click();
  await expect(page.getByRole('button', { name: /^Cursor/ })).toBeFocused();
});

const sandbox = { organizationId: 'org', mode: 'sandbox', configurationProblem: null, status: 'free', planKey: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, creditBalance: 3, renderCreditCost: 1, rendersRemaining: 3, plans: [{ key: 'demo', creditsPerPeriod: 30 }], canManage: true, canCheckout: true, hasCustomer: false };
for (const width of [1440, 390]) test(`billing at ${width}px: plan and credits are obvious, test mode is labelled, checkout opens only on a click`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
  await signIn(page);
  // The in-memory engine has no Stripe, so the configured state and the hosted page are answered here.
  await page.route('**/v1/studio/billing', (route) => route.fulfill({ json: sandbox }));
  let checkout: Record<string, unknown> | null = null;
  await page.route('**/v1/studio/operations/create_checkout', (route) => { checkout = route.request().postDataJSON(); return route.fulfill({ json: { checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_e2e', sessionId: 'cs_test_e2e', status: 'created' } }); });
  await page.route('https://checkout.stripe.com/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Stripe test checkout</title>' }));
  await page.goto('/studio/?view=billing');
  const view = page.locator('.billing-view');
  await expect(page.getByRole('heading', { name: 'Billing and usage' })).toBeVisible();
  await expect(view).toContainText('Test mode — no real charges');
  await expect(page.locator('.billing-number')).toHaveText('3');
  await expect(view).toContainText('3 videos left · 1 credit per video');
  await expect(view).toContainText('The studio and your connected agents share this one balance.');
  await expect(view).toContainText('Card details never enter Faceful or the chat');
  // No amount is printed: the price lives in Stripe.
  await expect(view).not.toContainText(/[€$£]\s?\d/);
  expect(checkout).toBeNull();
  expect(await noOverflow(page)).toBe(true);
  await shot(page, `billing-${width}`);
  await page.getByRole('button', { name: 'Upgrade with Stripe test checkout' }).click();
  await page.waitForURL('https://checkout.stripe.com/**');
  expect(checkout).toMatchObject({ priceKey: 'demo', confirmationGranted: true });
});

test('an active subscription shows its renewal and the Stripe portal, not a second upgrade', async ({ page }) => {
  await signIn(page);
  await page.route('**/v1/studio/billing', (route) => route.fulfill({ json: { ...sandbox, status: 'active', planKey: 'demo', currentPeriodEnd: '2026-12-14T10:00:00.000Z', creditBalance: 33, rendersRemaining: 33, hasCustomer: true } }));
  await page.goto('/studio/?view=billing');
  const view = page.locator('.billing-view');
  await expect(view).toContainText('Demo plan');
  await expect(view.locator('.ob-plan-status')).toHaveText('Active');
  await expect(view).toContainText('Renews');
  await expect(page.getByRole('button', { name: 'Manage billing on Stripe' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Upgrade with Stripe/ })).toHaveCount(0);
  await shot(page, 'billing-active-1440');
});

test('template picker: language switches by pointer or through its select and creates a real draft', async ({ page }) => {
  await signIn(page);
  await page.goto('/studio/');
  await page.getByRole('button', { name: 'Choose a template' }).click();
  const list = page.getByRole('dialog', { name: 'Choose a template' });
  await shot(page, 'templates-1440');
  await list.getByRole('button', { name: /15-second introduction/ }).click();
  const form = page.getByRole('dialog', { name: '15-second introduction' });
  const language = form.getByLabel('Script language');
  await form.getByText('Ελληνικά', { exact: true }).click();
  await expect(language).toHaveValue('el');
  // The select is the real control behind the segments: keyboards and assistive technology use it.
  await language.selectOption('en');
  await expect(form.locator('.ob-language button[data-checked]')).toHaveText('English');
  await form.getByLabel('Brand or product').fill('BeWell');
  await form.getByLabel('What it helps people do').fill('plan your festival day');
  await shot(page, 'templates-form-1440');
  await form.getByRole('button', { name: 'Create draft' }).click();
  await expect(page.locator('.content-card')).toHaveCount(1);
});

test('reduced motion keeps the same screens without travel or loops', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await authMock(page, 'expired');
  await page.goto('/studio/');
  await expect(page.getByRole('heading', { name: 'Sign in to Faceful' })).toBeVisible();
  const animation = await page.locator('.ob-step').evaluate((node) => getComputedStyle(node).animationName);
  expect(animation).toBe('ob-fade-in');
});

test('320px: sign-in, connect and billing reflow without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await signIn(page);
  await page.route('**/v1/studio/billing', (route) => route.fulfill({ json: sandbox }));
  await page.goto('/studio/?view=connect');
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await page.getByRole('button', { name: /^Codex/ }).click();
  await expect(page.locator('.ob-connect')).toContainText('codex mcp add faceful --url');
  expect(await noOverflow(page)).toBe(true);
  await page.goto('/studio/?view=billing');
  await expect(page.getByRole('heading', { name: 'Billing and usage' })).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
});
