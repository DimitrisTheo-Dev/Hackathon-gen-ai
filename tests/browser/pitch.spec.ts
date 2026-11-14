import { expect, test, type Page } from '@playwright/test';

/**
 * /pitch — the one-minute presenter-led pitch page.
 * Runs under its own config (tests/browser/pitch.config.ts, Vite dev server) and also under the default
 * suite against the built app: every test sets its own motion preference and mocks the presenter clip.
 */
const BEATS = ['intro', 'reveal', 'edit', 'agent', 'review', 'why', 'end'];

test.use({ reducedMotion: 'no-preference' });

/** No clip deployed: the probe answers 404, as production does until a real clip is dropped in. */
async function withoutClip(page: Page) {
  await page.route('**/pitch/presenter.mp4', (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: '' }));
}

/** A real, decodable clip (made here with MediaRecorder) served where the page looks for one. */
async function withFakeClip(page: Page) {
  const scratch = await page.context().newPage();
  await scratch.goto('about:blank');
  const base64 = await scratch.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 180, height: 320 });
    const context = canvas.getContext('2d')!;
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    let frame = 0;
    const draw = setInterval(() => { context.fillStyle = `hsl(${(frame += 9) % 360} 60% 60%)`; context.fillRect(0, 0, 180, 320); }, 33);
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.stop();
    await stopped;
    clearInterval(draw);
    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = '';
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary);
  });
  await scratch.close();
  const body = Buffer.from(base64, 'base64');
  await page.route('**/pitch/presenter.mp4', (route) => route.fulfill({ status: 200, contentType: 'video/webm', body }));
  await page.route('**/pitch/presenter.vtt', (route) => route.fulfill({ status: 200, contentType: 'text/vtt', body: 'WEBVTT\n\n00:00:00.000 --> 00:00:08.000\nHi, I’m Eleni.\n' }));
}

/** Console errors and uncaught exceptions, except the expected 404 from probing for a clip that is not there. */
function collectErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/404/.test(message.text()) && /\/pitch\/presenter\./.test(message.location().url)) return;
    errors.push(message.text());
  });
  return errors;
}

const scaleOf = (transform: string) => {
  if (!transform || transform === 'none') return 1;
  const values = transform.match(/matrix\(([^)]+)\)/)?.[1].split(',').map(Number);
  return values ? Math.hypot(values[0], values[1]) : 1;
};

test('opens on the presenter with a reel caption and an honest Illustration label', async ({ page }) => {
  await withoutClip(page);
  const errors = collectErrors(page);
  await page.goto('/pitch?autoplay=0&t=3');
  const root = page.locator('.pitch');
  await expect(root).toHaveAttribute('data-beat', 'intro');
  await expect(root).toHaveAttribute('data-presenter', 'illustration');
  await expect(page.getByTestId('presenter-label')).toHaveText('Illustration');
  await expect(page.locator('.ph-eleni')).toHaveCount(1);
  await expect(page.locator('.ph-line.is-in')).toHaveText('An hour ago');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/the video studio you and your AI agent share/i);
  await expect(page).toHaveTitle(/pitch/i);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  expect(errors).toEqual([]);
});

test('auto-advances through all seven beats to the end card without console errors', async ({ page }) => {
  await withoutClip(page);
  const errors = collectErrors(page);
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __beats: string[] }).__beats = seen;
    new MutationObserver(() => {
      const beat = document.querySelector('.pitch')?.getAttribute('data-beat');
      if (beat && seen[seen.length - 1] !== beat) seen.push(beat);
    }).observe(document, { subtree: true, attributes: true, attributeFilter: ['data-beat'], childList: true });
  });
  await page.goto('/pitch?speed=10');
  await expect(page.locator('.pitch')).toHaveClass(/is-ended/, { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { __beats: string[] }).__beats)).toEqual(BEATS);
  await expect(page.locator('.pitch')).toHaveAttribute('data-playing', 'false');
  await expect(page.locator('.pend')).toHaveClass(/is-in/);
  await expect(page.locator('.pend-line')).toHaveText('The video studio you and your AI agent share.');
  await expect(page.locator('.pend-url')).toHaveText('faceful.vercel.app');
  // Truthful states only: nothing claims to be rendered, published, scheduled or paid.
  const text = await page.locator('.pitch').innerText();
  expect(text).not.toMatch(/\b(Rendered|Published|Scheduled|Paid)\b/);
  expect(errors).toEqual([]);
});

test('keyboard and clicker controls: play/pause, beats, restart, full screen', async ({ page }) => {
  await withoutClip(page);
  await page.addInitScript(() => {
    (window as unknown as { __fullscreen: number }).__fullscreen = 0;
    Element.prototype.requestFullscreen = function () { (window as unknown as { __fullscreen: number }).__fullscreen++; return Promise.resolve(); };
  });
  await page.goto('/pitch?autoplay=0');
  const root = page.locator('.pitch');
  await expect(root).toHaveAttribute('data-playing', 'false');
  await page.keyboard.press('Space');
  await expect(root).toHaveAttribute('data-playing', 'true');
  await page.keyboard.press('Space');
  await expect(root).toHaveAttribute('data-playing', 'false');

  await page.keyboard.press('ArrowRight');
  await expect(root).toHaveAttribute('data-beat', 'reveal');
  await page.keyboard.press('PageDown');
  await expect(root).toHaveAttribute('data-beat', 'edit');
  await page.keyboard.press('ArrowLeft');
  await expect(root).toHaveAttribute('data-beat', 'reveal');
  await page.keyboard.press('PageUp');
  await expect(root).toHaveAttribute('data-beat', 'intro');
  await page.keyboard.press('5');
  await expect(root).toHaveAttribute('data-beat', 'review');
  await page.keyboard.press('End');
  await expect(root).toHaveAttribute('data-beat', 'end');

  await page.keyboard.press('r');
  await expect(root).toHaveAttribute('data-beat', 'intro');
  await expect(root).toHaveAttribute('data-playing', 'true');

  await page.keyboard.press('f');
  expect(await page.evaluate(() => (window as unknown as { __fullscreen: number }).__fullscreen)).toBe(1);

  // The control strip is hidden until the pointer moves, then works with a click.
  const controls = page.getByRole('toolbar', { name: 'Pitch controls' });
  await page.mouse.move(400, 400);
  await page.mouse.move(420, 420);
  await expect(controls).toBeVisible();
  await controls.getByRole('button', { name: 'Pause' }).click();
  await expect(root).toHaveAttribute('data-playing', 'false');
  await controls.getByRole('button', { name: 'Next beat' }).click();
  await expect(root).toHaveAttribute('data-beat', 'reveal');
  await expect(controls).toHaveCSS('opacity', '0', { timeout: 5000 });
});

test('a deployed clip replaces the illustration and its label', async ({ page }) => {
  await withFakeClip(page);
  const errors = collectErrors(page);
  await page.goto('/pitch?autoplay=0&t=2');
  const root = page.locator('.pitch');
  await expect(root).toHaveAttribute('data-presenter', 'clip', { timeout: 15_000 });
  await expect(page.locator('video.ph-video')).toHaveClass(/is-ready/);
  await expect(page.locator('.ph-eleni')).toHaveCount(0);
  const label = page.getByTestId('presenter-label');
  await expect(label).not.toHaveText('Illustration');
  // Without presenter.json the label claims nothing about who made the clip.
  await expect(label).toHaveText('Presenter clip');
  await expect(page.getByRole('button', { name: 'Unmute presenter' })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('the clip credit comes only from presenter.json', async ({ page }) => {
  await withFakeClip(page);
  await page.route('**/pitch/presenter.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ credit: 'Written in Faceful · performed by Humanlike' }) }));
  await page.goto('/pitch?autoplay=0&t=2');
  await expect(page.locator('.pitch')).toHaveAttribute('data-presenter', 'clip', { timeout: 15_000 });
  await expect(page.getByTestId('presenter-label')).toHaveText('Written in Faceful · performed by Humanlike');
});

test('without a clip the illustration label stays, and the page never guesses one exists', async ({ page }) => {
  // An SPA fallback answers any path with HTML; that is not a clip.
  await page.route('**/pitch/presenter.mp4', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('/pitch?autoplay=0');
  await expect(page.locator('.pitch')).toHaveAttribute('data-presenter', 'illustration');
  await expect(page.getByTestId('presenter-label')).toHaveText('Illustration');
  await expect(page.locator('video')).toHaveCount(0);
});

test('full motion: the reveal is one continuous zoom', async ({ page }) => {
  await withoutClip(page);
  await page.goto('/pitch?t=7.7');
  await page.locator('.pw').waitFor();
  const scales = await page.evaluate(async () => {
    const world = document.querySelector<HTMLElement>('.pw')!;
    const samples: string[] = [];
    const end = performance.now() + 2600;
    while (performance.now() < end) {
      samples.push(getComputedStyle(world).transform);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return samples;
  });
  const values = scales.map(scaleOf);
  const start = Math.max(...values);
  expect(start).toBeGreaterThan(1.8);
  expect(values[values.length - 1]).toBeCloseTo(1, 2);
  const between = values.filter((value) => value > 1.05 && value < start - 0.05);
  expect(between.length).toBeGreaterThan(10);
});

test('reduced motion: the reveal cuts through a crossfade instead of zooming', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await withoutClip(page);
  await page.goto('/pitch?t=7.7');
  await page.locator('.pw').waitFor();
  await expect(page.locator('.pitch')).toHaveAttribute('data-motion', 'reduced');
  const result = await page.evaluate(async () => {
    const world = document.querySelector<HTMLElement>('.pw')!;
    const root = document.querySelector<HTMLElement>('.pitch')!;
    const samples: string[] = [];
    let curtain = false;
    const end = performance.now() + 2600;
    while (performance.now() < end) {
      samples.push(getComputedStyle(world).transform);
      curtain ||= root.classList.contains('is-curtain');
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return { samples, curtain, idle: getComputedStyle(document.querySelector('.pe-breath')!).animationName };
  });
  const values = result.samples.map(scaleOf);
  const start = Math.max(...values);
  expect(start).toBeGreaterThan(1.8);
  expect(values[values.length - 1]).toBeCloseTo(1, 2);
  // Every sample is either the presenter framing or the studio: no in-between frames.
  for (const value of values) expect(Math.abs(value - start) < 0.01 || Math.abs(value - 1) < 0.01).toBe(true);
  expect(result.curtain).toBe(true);
  expect(result.idle).toBe('none');
});

for (const viewport of [{ width: 1280, height: 720 }, { width: 1920, height: 1080 }]) {
  test(`no horizontal overflow at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await withoutClip(page);
    await page.setViewportSize(viewport);
    for (const t of [3, 11, 20, 28, 34, 50, 57]) {
      await page.goto(`/pitch?autoplay=0&t=${t}`);
      await page.waitForTimeout(900);
      const report = await page.evaluate(() => {
        const width = innerWidth;
        const outside = [...document.querySelectorAll<HTMLElement>('.p-label, .pitch-controls, .pw-shell, .pwhy.is-in .pwhy-list > li, .pend.is-in .pend-block')]
          .map((node) => ({ name: node.className, box: node.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && (box.left < -1 || box.right > width + 1))
          .map(({ name, box }) => `${name}: ${Math.round(box.left)}–${Math.round(box.right)}`);
        return { doc: document.documentElement.scrollWidth, body: document.body.scrollWidth, width, outside, beat: document.querySelector('.pitch')?.getAttribute('data-beat') };
      });
      expect(report.doc, `document at t=${t}`).toBeLessThanOrEqual(report.width);
      expect(report.body, `body at t=${t}`).toBeLessThanOrEqual(report.width);
      // At the studio beats the whole app shell fits; on the presenter beats it is deliberately off-screen.
      const allowed = report.beat === 'intro' || report.beat === 'end' ? report.outside.filter((entry) => !entry.startsWith('pw-shell')) : report.outside;
      expect(allowed, `elements outside the viewport at t=${t}`).toEqual([]);
    }
  });
}
