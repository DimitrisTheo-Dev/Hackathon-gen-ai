import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * The Claude Code page's one-button flow against a stand-in machine: Connect Claude opens Claude's sign-in in a
 * window, a pasted code connects without another click, and a message streams back. Nothing leaves the browser:
 * the machine and Claude's sign-in page are answered by page.route.
 */
const MACHINE = 'https://machine.faceful.test';
const CLAUDE = 'https://claude.faceful.test';
const STATE = 'state_e2e_7f3a';
const CODE = `e2eAuthCode0123456789#${STATE}`;

type Seen = { finished: string[]; prompts: string[] };

async function standInMachine(page: Page): Promise<Seen> {
  const seen: Seen = { finished: [], prompts: [] };
  let signedIn = false;
  const auth = () => (signedIn
    ? { loggedIn: true, authMethod: 'claude.ai', email: 'minas@example.com', subscriptionType: 'max', organization: null }
    : { loggedIn: false, authMethod: 'none', email: null, subscriptionType: null, organization: null });
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS' };
  const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  await page.route(`${MACHINE}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    switch (key) {
      case 'GET /v1/machine': return json(route, { gateway: true, user: 'e2e', identity: 'token', instanceType: 'standard-1', sleepAfterMinutes: 15, live: 'healthy', running: true, machine: { starts: 1, last_started_at: null, last_stopped_at: null } });
      case 'GET /v1/projects': return json(route, { projects: [] });
      case 'GET /v1/workspace': return json(route, { configured: true, project: url.searchParams.get('project') ?? 'default', autosave: null, saves: [] });
      case 'GET /v1/status': return json(route, { runner: '2', claudeVersion: '2.1.325', auth: auth(), tokenStored: false, workspace: '/home/node/work', store: true, busy: false, loginPending: false });
      case 'POST /v1/login/start': return json(route, { url: `${CLAUDE}/oauth/authorize?code=true&client_id=e2e&state=${STATE}` });
      case 'POST /v1/login/cancel': return json(route, { ok: true });
      case 'POST /v1/login/finish': {
        const { code } = request.postDataJSON() as { code: string };
        seen.finished.push(code);
        if (code !== CODE) return json(route, { error: { code: 'login_failed', message: "Claude didn't accept that code." } }, 400);
        signedIn = true;
        return json(route, { auth: auth() });
      }
      case 'POST /v1/run': {
        const { prompt } = request.postDataJSON() as { prompt: string };
        seen.prompts.push(prompt);
        const events = [
          { type: 'system', subtype: 'init', session_id: 'e2e-session-1', model: 'claude-e2e' },
          { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'pong' }] } },
          { type: 'result', subtype: 'success', is_error: false, duration_ms: 900, num_turns: 1, result: 'pong', session_id: 'e2e-session-1' },
        ];
        return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/x-ndjson' }, body: events.map((event) => JSON.stringify(event)).join('\n') + '\n' });
      }
      default: return json(route, { error: { code: 'not_found', message: `No stand-in for ${key}` } }, 404);
    }
  });
  // Claude's own page after approval: it shows the code with a copy button.
  await page.context().route(`${CLAUDE}/**`, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html' }, body: `<!doctype html><title>Claude</title><main><p>Paste this into Claude Code:</p><code>${CODE}</code></main>` }));
  return seen;
}

/** The page under test may or may not be built with a cloud gateway; either way, this connects the stand-in machine. */
async function connectStandIn(page: Page) {
  await page.goto('/claude-login-test/');
  const own = page.locator('details.cc-own');
  await expect(own).toBeVisible();
  if ((await own.getAttribute('open')) === null) await own.locator('summary').click();
  await page.getByLabel('Address').fill(MACHINE);
  await page.getByLabel('Access key').fill('e2e-access-key');
  await page.getByRole('button', { name: 'Connect server' }).click();
  await expect(page.getByText(/Your cloud machine · awake/)).toBeVisible();
}

const paste = (page: Page, text: string) => page.locator('#cc-code').evaluate((input, value) => {
  const data = new DataTransfer();
  data.setData('text/plain', value);
  input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, text);

test.beforeEach(async ({ page }) => {
  // A remembered connection from another test must not skip the first step.
  await page.addInitScript(() => { try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage off */ } });
});

test('one button connects the Claude subscription; a paste finishes it', async ({ page }) => {
  const seen = await standInMachine(page);
  await connectStandIn(page);

  const connect = page.getByRole('button', { name: 'Connect Claude' });
  await expect(connect).toBeEnabled();
  const popupOpens = page.waitForEvent('popup');
  await connect.click();
  const popup = await popupOpens;
  await expect(popup).toHaveURL(new RegExp(`^${CLAUDE}/oauth/authorize.*state=${STATE}`));
  await expect(page.getByLabel('Copy the code and paste it here')).toBeVisible();
  await expect(page.getByText('It connects as soon as you paste.')).toBeVisible();

  // A code from an earlier attempt is caught on the page, before the machine is asked.
  await paste(page, 'e2eAuthCode0123456789#an_older_state');
  await expect(page.getByText('That code is from an earlier sign-in.')).toBeVisible();
  expect(seen.finished).toEqual([]);

  // The right code connects by itself: no Finish button.
  await paste(page, CODE);
  await expect(page.getByRole('heading', { name: 'Claude subscription' })).toBeVisible();
  await expect(page.locator('.cc-connect .cc-chip.positive')).toHaveText('Connected');
  await expect(page.getByText('minas@example.com')).toBeVisible();
  expect(seen.finished).toEqual([CODE]);

  // Connected: the composer is live and a run streams back.
  const composer = page.getByLabel('Message Claude Code');
  await expect(composer).toBeEnabled();
  await composer.fill('Reply with exactly: pong');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.locator('.cc-msg.assistant')).toContainText('pong');
  await expect(page.locator('.cc-result')).toContainText('Done');
  expect(seen.prompts).toEqual(['Reply with exactly: pong']);
});

test('a browser that blocks the window gets an Open Claude button instead', async ({ page }) => {
  await page.addInitScript(() => { window.open = () => null; });
  await standInMachine(page);
  await connectStandIn(page);
  await page.getByRole('button', { name: 'Connect Claude' }).click();
  const open = page.getByRole('link', { name: /Open Claude/ });
  await expect(open).toBeVisible();
  await expect(open).toHaveAttribute('href', new RegExp(`^${CLAUDE}/oauth/authorize`));
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Connect Claude' })).toBeVisible();
});

test('with clipboard access, coming back from Claude connects without a paste', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are a Chromium feature in Playwright');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const seen = await standInMachine(page);
  await connectStandIn(page);
  const popupOpens = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Connect Claude' }).click();
  await popupOpens;
  await expect(page.getByLabel('Copy the code and paste it here')).toBeVisible();

  // What Claude's copy button does, then the person switches back to this page.
  await page.evaluate((code) => navigator.clipboard.writeText(code), CODE);
  await page.bringToFront();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator('.cc-connect .cc-chip.positive')).toHaveText('Connected');
  expect(seen.finished).toEqual([CODE]);
});
