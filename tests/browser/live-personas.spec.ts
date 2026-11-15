import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';

/**
 * The Personas tab end to end against the real engine on an in-memory store (support/memory-engine.ts).
 * The face scan needs a camera, so the consent is recorded through the same engine routes the scan uses.
 * Run with: corepack pnpm exec playwright test -c tests/browser/live.config.ts live-personas
 */
test.skip(!process.env.FACEFUL_LIVE_E2E, 'Needs the in-memory engine server from tests/browser/live.config.ts');

const SUPABASE = 'https://hgsgvdujzatfhsjoojll.supabase.co';
/** A 2×2 PNG, so photos render with a real size. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGPYuqAKiBggFAAzngc9tZ7ZYgAAAABJRU5ErkJggg==', 'base64');

async function signIn(page: Page) {
  const id = `e2e-${crypto.randomUUID()}`;
  const user = { id, aud: 'authenticated', role: 'authenticated', email: `${id}@e2e.test`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
  const exp = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
  const token = `${[{ alg: 'none', typ: 'JWT' }, { iss: 'faceful-e2e', sub: id, email: user.email, exp, aud: 'authenticated', role: 'authenticated' }].map((part) => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.')}.e2e`;
  const stored = { access_token: token, refresh_token: 'e2e-not-a-credential', token_type: 'bearer', expires_in: 31_536_000, expires_at: exp, user };
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), ['sb-hgsgvdujzatfhsjoojll-auth-token', JSON.stringify(stored)]);
  await page.route(`${SUPABASE}/**`, (route) => (new URL(route.request().url()).pathname === '/auth/v1/user' ? route.fulfill({ json: user }) : route.fulfill({ status: 404, json: {} })));
  const api = async (path: string, data: unknown) => {
    const response = await page.request.post(path, { headers: { Authorization: `Bearer ${token}` }, data });
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  };
  /** Stores one recording the way the face scan does: a one-file link, then a PUT with the declared checksum. */
  const upload = async (type: string, bytes: Buffer) => {
    const ticket = await api('/v1/studio/likeness/upload-url', { type, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    const put = await page.request.put(ticket.uploadUrl, { headers: ticket.headers, data: bytes });
    expect(put.status()).toBe(200);
    return ticket.key as string;
  };
  return { api, upload };
}

test('a persona is created, gets a look with a photo, is backed by a consent, and can be withdrawn and deleted', async ({ page }, testInfo) => {
  const { api, upload } = await signIn(page);
  await page.goto('/studio/?view=personas');
  await expect(page.getByRole('heading', { name: 'Personas', level: 1 })).toBeVisible();
  await expect(page.getByText('No personas yet.')).toBeVisible();

  await page.getByRole('button', { name: 'New persona' }).click();
  const form = page.getByRole('dialog', { name: 'New persona' });
  await form.getByLabel('Name').fill('Dr. Maria');
  await form.getByLabel(/Who they are/).fill('A calm dietitian who explains one idea per video.');
  await form.getByLabel('Speaks').selectOption('el');
  await form.getByRole('button', { name: 'Create persona' }).click();

  const detail = page.getByRole('dialog', { name: 'Dr. Maria' });
  await expect(detail.getByText('Needs consent')).toBeVisible();
  const href = await detail.getByRole('link', { name: 'Record consent now' }).getAttribute('href');
  expect(href).toMatch(/^\/face-scan\?persona=[0-9a-f-]{36}$/);
  const personaId = new URL(href!, 'http://local').searchParams.get('persona')!;
  await expect(detail.getByText('Greek (Ελληνικά)')).toBeVisible();

  await detail.getByRole('button', { name: 'Add a look' }).click();
  await detail.getByLabel('Look', { exact: true }).fill('Studio, navy blazer');
  await detail.getByLabel(/Wardrobe, hair and setting/).fill('Hair tied back, soft key light, plain grey backdrop.');
  await detail.getByLabel(/Reference photo/).setInputFiles({ name: 'look.png', mimeType: 'image/png', buffer: PNG });
  await detail.getByRole('button', { name: 'Add look' }).click();
  const photo = detail.getByRole('img', { name: 'Reference photo: Studio, navy blazer' });
  await expect(photo).toBeVisible();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await page.screenshot({ path: testInfo.outputPath('1-needs-consent.png') });

  // What /face-scan?persona=<id> saves when the person finishes.
  const stills: Record<string, string> = {};
  for (const pose of ['center', 'left', 'right', 'up', 'down']) stills[pose] = await upload('image/jpeg', PNG);
  const name = 'Maria Papadopoulou';
  const saved = await api('/v1/studio/likeness/consents', {
    subjectName: name,
    language: 'en',
    phrases: ['The quick brown fox.', 'Bright morning sunshine.', `I, ${name}, agree that Faceful may create an avatar of my face and voice.`],
    transcript: 'the quick brown fox bright morning sunshine i agree',
    scanVideoKey: await upload('video/webm', Buffer.from(`scan-${personaId}`)),
    speechVideoKey: await upload('video/mp4', Buffer.from(`speech-${personaId}`)),
    stills,
    report: { passed: true, checks: [{ id: 'poses', label: 'Five head angles', passed: true, required: true, value: 5 }] },
    personaId,
  });
  expect(saved.personaId).toBe(personaId);

  // The scan's "Back to the persona" button lands here.
  await page.goto(`/studio/?view=personas&persona=${personaId}`);
  const back = page.getByRole('dialog', { name: 'Dr. Maria' });
  await expect(back.getByText(`${name} scanned their face`)).toBeVisible();
  await expect(back.getByRole('img', { name: `Face scan of ${name}` })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('2-ready.png') });
  await back.getByRole('button', { name: 'Close dialog' }).click();
  const card = page.getByRole('button', { name: /Dr\. Maria/ });
  await expect(card).toContainText('Ready');
  await expect(card).toContainText('1 look');
  await page.screenshot({ path: testInfo.outputPath('3-grid.png') });

  await card.click();
  await back.getByRole('button', { name: 'Withdraw consent' }).click();
  await back.getByRole('button', { name: 'Withdraw and delete recordings' }).click();
  await expect(back.getByText(/withdrew their consent/)).toBeVisible();
  await expect(back.getByRole('link', { name: 'Record consent now' })).toBeVisible();

  await back.getByRole('button', { name: 'Delete persona' }).click();
  await back.getByRole('group', { name: 'Confirm deletion' }).getByRole('button', { name: 'Delete persona' }).click();
  await expect(page.getByText('No personas yet.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('on a phone the Personas page and its detail fit the screen', async ({ page }, testInfo) => {
  const { api } = await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/studio/?view=personas');
  await expect(page.getByRole('heading', { name: 'Personas', level: 1 })).toBeVisible();
  const persona = await api('/v1/studio/operations/create_persona', { name: 'Nikos', description: 'Upbeat fitness coach', language: 'en', operationKey: crypto.randomUUID() });
  await page.goto(`/studio/?view=personas&persona=${persona.id}`);
  await expect(page.getByRole('dialog', { name: 'Nikos' }).getByText('Needs consent')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('4-phone.png') });
});
